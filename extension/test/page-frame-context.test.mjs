import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePageFrame } from '../background/page-frame-context.js';
import { clearBrowserFrames, recordBrowserFrameEvent } from '../background/browser-frames.js';

const frames = [{ selector: '#chosen', origin: 'https://example.org', pathname: '/child' }];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('a stalled frame enumeration is bounded and a late reply cannot start context attachment', async t => {
  const entered = deferred(), response = deferred(); let attachments = 0;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending = resolvePageFrame({ frames, tabId: 81,
    chrome: { scripting: { executeScript: () => { entered.resolve(); return response.promise; } } },
    ensureCdpAttached: async () => { attachments++; },
  });
  const rejected = assert.rejects(pending, { code: 'PAGE_FRAME_TIMEOUT' });
  await entered.promise; t.mock.timers.tick(30001); await rejected;
  response.resolve([{ frameId: 0, documentId: 'example-main', result: { url: 'https://example.com/' } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attachments, 0);
});

async function fixture() {
  const tabId = 82; clearBrowserFrames(tabId);
  const docs = [
    { frameId: 0, documentId: 'example-main', url: 'https://example.com/' },
    { frameId: 1, documentId: 'example-child', url: 'https://example.org/child' },
  ];
  const markers = new Map(), calls = [];
  const chrome = {
    scripting: { executeScript: async request => {
      const matches = docs.filter(doc => request.target.allFrames || request.target.documentIds?.includes(doc.documentId) || request.target.frameIds?.includes(doc.frameId));
      return matches.map(doc => {
        let result = null;
        if (request.target.allFrames) result = { url: doc.url };
        else if (request.args?.[0]?.startsWith('__weworkerFrame_')) {
          if (String(request.func).includes('delete this')) markers.delete(doc.frameId);
          else markers.set(doc.frameId, request.args[0]);
          result = true;
        } else if (String(request.func).includes('location.href')) result = doc.url;
        return { frameId: doc.frameId, documentId: doc.documentId, result };
      });
    } },
    debugger: { sendCommand: async (source, method, params) => {
      calls.push({ source, method, params });
      if (method === 'Runtime.evaluate' && params.expression.startsWith('this[')) {
        const doc = docs.find(doc => params.uniqueContextId === `example-isolated-${doc.frameId}`);
        return { result: { value: Boolean(doc && markers.get(doc.frameId) && params.expression.includes(markers.get(doc.frameId))) } };
      }
      if (method === 'Runtime.evaluate') return { result: { objectId: 'example-owner' } };
      if (method === 'DOM.describeNode') return { node: { frameId: 'example-cdp-1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: params.arguments ? true : ['https://example.org/child', null] } };
      return {};
    } },
  };
  for (const doc of docs) for (const isDefault of [true, false]) await recordBrowserFrameEvent(chrome, { tabId }, 'Runtime.executionContextCreated', {
    context: { id: doc.frameId * 2 + Number(isDefault), uniqueId: `example-${isDefault ? 'main' : 'isolated'}-${doc.frameId}`, auxData: { isDefault, frameId: `example-cdp-${doc.frameId}` } },
  });
  return { tabId, chrome, calls, docs };
}

test('retained owner cleanup is bounded and idempotent when its renderer never replies', async t => {
  const f = await fixture();
  const pinned = await resolvePageFrame({ ...f, frames, ensureCdpAttached: async () => {} });
  assert.equal(pinned.selected.documentId, 'example-child');
  const entered = deferred(); let releases = 0;
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = (source, method, params) => {
    if (method === 'Runtime.releaseObject') { releases++; entered.resolve(); return new Promise(() => {}); }
    return original(source, method, params);
  };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending = pinned.release();
  await entered.promise; t.mock.timers.tick(1001); await pending;
  await pinned.release();
  assert.equal(releases, 1);
});

test('a changed ancestor document is refused without re-resolving another same-URL child', async () => {
  const f = await fixture();
  const pinned = await resolvePageFrame({ ...f, frames, ensureCdpAttached: async () => {} });
  await recordBrowserFrameEvent(f.chrome, { tabId: f.tabId }, 'Runtime.executionContextDestroyed', { executionContextId: 1 });
  const before = f.calls.length;
  await assert.rejects(pinned.assertCurrent(), { code: 'PAGE_FRAME_DOCUMENT_CHANGED' });
  assert.equal(f.calls.length, before);
  await pinned.release();
});

test('a stalled action uses its shorter step deadline and latches termination', async t => {
  const f = await fixture(), pinned = await resolvePageFrame({ ...f, frames, ensureCdpAttached: async () => {} });
  const entered=deferred(), response=deferred();
  const original=f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand=(source,method,params)=>{
    if(method==='Example.wait'){entered.resolve();return response.promise;}
    return original(source,method,params);
  };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pending=pinned.withDeadline(Date.now()+1000,()=>pinned.send({tabId:f.tabId},'Example.wait'));
  const rejected=assert.rejects(pending,{code:'PAGE_QUERY_TIMEOUT'});
  await entered.promise;t.mock.timers.tick(1001);await rejected;
  response.resolve({});await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(pinned.assertCurrent(),{code:'PAGE_QUERY_TIMEOUT'});await pinned.release();
});

test('leaf refresh refuses an undeclared destination before looking for new contexts', async () => {
  const f = await fixture(), pinned = await resolvePageFrame({ ...f, frames, ensureCdpAttached: async () => {} });
  f.docs[1].url='https://example.net/unexpected';
  const before=f.calls.length;
  await assert.rejects(pinned.refreshLeaf(url=>url.href==='https://example.org/result'),{code:'PAGE_FRAME_ROUTE_CHANGED'});
  assert.equal(f.calls.slice(before).some(x=>x.method==='Runtime.evaluate'),false);
  assert.equal(pinned.selected.documentId,'example-child');await pinned.release();
});
