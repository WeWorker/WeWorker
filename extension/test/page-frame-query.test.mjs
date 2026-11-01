import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFramePageQuery } from '../background/page-frame-query.js';

function fixture(options = {}) {
  let time = 0, url = 'https://example.org/child', documentId = 'document-first', loaderId = 'loader-first', listener;
  const calls = [], source = { mode: 'navigate', pathParameters: [], resultOrigin: 'https://example.net', resultPathname: '/result', result: { strategy: 'DOM_STATE', path: ['publicResult'] }, timeoutMs: 1000 };
  const pin = {
    get selected() { return { frameId: 42, documentId }; },
    get leaf() { return { url, isolated: { source: { tabId: 1, sessionId: 'child' } }, context: { source: { tabId: 1, sessionId: 'child' } } }; },
    check() {}, withDeadline: (_, fn) => fn(), run: fn => options.noEvent ? Promise.race([fn(), new Promise((_,reject)=>setImmediate(()=>reject(Object.assign(Error('timeout'),{code:'PAGE_QUERY_TIMEOUT'}))))]) : fn(),
    assertCurrent: async () => { if(options.replaced)throw Object.assign(Error('owner replaced'),{code:'PAGE_FRAME_TARGET_CHANGED'}); },
    assertAncestors: async () => { if(options.replaced)throw Object.assign(Error('owner replaced'),{code:'PAGE_FRAME_TARGET_CHANGED'}); },
    snapshot: async () => ({ url, frameId: 'cdp-child', loaderId, status: 'complete' }),
    script: async () => ({ result: { ok: true, data: { item: 'Example' } } }),
    send: async (target, method, args) => {
      calls.push({ target, method, args });
      if (method === 'Page.navigate') {
        options.onNavigate?.();
        if(!options.noEvent)listener({tabId:1},'Page.frameNavigated',{frame:{id:'cdp-child',url:options.redirect||args.url,loaderId:'loader-next'}});
        if(options.lostReply)return new Promise(()=>{});
      }
      return {};
    },
    refreshLeaf: async accept => { assert.ok(accept(new URL('https://example.net/result'))); calls.push({method:'refresh'});url='https://example.net/result';documentId='document-next';loaderId='loader-next'; },
  };
  const chrome = {
    debugger: { onEvent: { addListener: fn => {listener=fn;}, removeListener: () => {listener=null;} }, sendCommand: pin.send },
    scripting: { executeScript: async request => request.target.frameIds ? [{ frameId:42,documentId:'document-next',result:{url:'https://example.net/result',ready:'complete'} }] : [] },
  };
  return { calls, pin, options, invoke: () => executeFramePageQuery({chrome,tabId:1,payload:{source,expectedOrigin:'https://example.org',expectedPath:'/child'},frameContext:pin,now:()=>time,sleep:async ms=>{time+=ms;options.onSleep?.();},assertRunning:()=>{if(options.cancelled)throw Object.assign(Error('cancelled'),{code:'PAGE_WORKFLOW_CANCELLED'});}}),source };
}
test('explicit child navigation refreshes only the retained leaf once and preserves the document result', async () => {
  const f=fixture(), result=await f.invoke();
  assert.equal(result.ok,true);assert.equal(result.internalWorkflowPage.loaderId,'loader-next');
  assert.deepEqual(f.calls.map(x=>x.method),['Page.navigate','refresh']);assert.equal(f.calls[0].args.frameId,'cdp-child');
});
test('passive frame read performs no navigation or identity refresh', async () => {
  const f=fixture();f.source.mode='read';f.source.resultPathname='/child';
  assert.equal((await f.invoke()).ok,true);assert.equal(f.calls.length,0);
});
test('a navigation event completes a dispatched OOPIF navigation whose old session never replies', async () => {
  const f=fixture({lostReply:true});assert.equal((await f.invoke()).ok,true);
  assert.deepEqual(f.calls.map(x=>x.method),['Page.navigate','refresh']);
});
test('an undeclared destination never refreshes the frame or replays navigation', async () => {
  const f=fixture({redirect:'https://example.com/unexpected'});
  await assert.rejects(f.invoke(),{code:'PAGE_QUERY_ROUTE_CHANGED'});assert.deepEqual(f.calls.map(x=>x.method),['Page.navigate']);
});
test('a replaced owner after dispatch is refused without any replacement resolution', async () => {
  const f=fixture();f.options.onNavigate=()=>{f.options.replaced=true;};
  await assert.rejects(f.invoke(),{code:'PAGE_FRAME_TARGET_CHANGED'});assert.deepEqual(f.calls.map(x=>x.method),['Page.navigate']);
});
test('missing navigation evidence times out without identity refresh or replay', async () => {
  const f=fixture({noEvent:true});await assert.rejects(f.invoke(),{code:'PAGE_QUERY_TIMEOUT'});
  assert.deepEqual(f.calls.map(x=>x.method),['Page.navigate']);
});
test('cancellation during stability polling dispatches no further action', async () => {
  const f=fixture();f.options.onSleep=()=>{f.options.cancelled=true;};
  await assert.rejects(f.invoke(),{code:'PAGE_WORKFLOW_CANCELLED'});assert.deepEqual(f.calls.map(x=>x.method),['Page.navigate','refresh']);
});
