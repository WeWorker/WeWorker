import test from 'node:test';
import assert from 'node:assert/strict';
import { clearBrowserFrames, recordBrowserFrameEvent, executeFrameScript, evaluateBrowserFrame, withBrowserFrameContext } from '../background/browser-frames.js';
import { createFrameOperation } from '../background/frame-operation.js';

function fixture() {
  clearBrowserFrames(7);
  const calls = [], scripts = [], markers = new Map();
  const documents = [{ frameId: 0, documentId: 'example-main' }, { frameId: 12, documentId: 'example-child' }];
  let failure = false;
  const chrome = {
    scripting: { executeScript: async request => {
      scripts.push(request);
      const doc = request.target.documentIds ? documents.find(item => request.target.documentIds.includes(item.documentId)) : documents.find(item => request.target.frameIds.includes(item.frameId));
      if (!doc) throw Error('No document');
      if (request.args?.length) {
        if (String(request.func).includes('delete this')) markers.delete(doc.frameId);
        else markers.set(doc.frameId, request.args[0]);
      }
      return [{ ...doc, result: null }];
    } },
    debugger: { sendCommand: async (source, method, params) => {
      calls.push({ source, method, params });
      if (method !== 'Runtime.evaluate') return {};
      const frameId = source.sessionId ? 12 : 0;
      if (params.expression.startsWith('this[')) return { result: { value: Boolean(markers.get(frameId) && params.expression.includes(markers.get(frameId))) } };
      if (failure) throw Error('Context disappeared');
      return { result: { value: { frameId, context: params.uniqueContextId } } };
    } },
  };
  const context = async (sessionId, uniqueId) => {
    const source = { tabId: 7, ...(sessionId ? { sessionId } : {}) };
    for (const isDefault of [true, false]) await recordBrowserFrameEvent(chrome, source, 'Runtime.executionContextCreated', {
      context: { id: isDefault ? 1 : 2, uniqueId: uniqueId + (isDefault ? '' : '-isolated'), auxData: { isDefault, frameId: sessionId || 'example-root-frame' } },
    });
  };
  return { chrome, calls, scripts, markers, context, failEvaluation: () => { failure = true; } };
}

test('same context IDs in different targets select only the explicitly marked frame, then clean its document', async () => {
  const f = fixture(); await f.context(null, 'example-main-context'); await f.context('example-child-session', 'example-child-context');
  const result = await evaluateBrowserFrame(f.chrome, 7, { frameId: '12', documentId: 'example-child', expression: 'exampleUserExpression' }, async () => {});
  assert.deepEqual(result, { frameId: 12, documentId: 'example-child', value: { frameId: 12, context: 'example-child-context' } });
  const userCalls = f.calls.filter(call => call.params?.expression === 'exampleUserExpression');
  assert.equal(userCalls.length, 1); assert.equal(userCalls[0].source.sessionId, 'example-child-session');
  assert.equal(f.markers.size, 0);
  assert.ok(f.scripts.every(script => script.world === 'ISOLATED'));
  assert.ok(f.calls.filter(call => call.params?.expression?.startsWith('this[')).every(call => call.params.uniqueContextId.endsWith('-isolated')));
  assert.deepEqual(f.scripts.at(-1).target, { tabId: 7, documentIds: ['example-child'] });
});

test('wrong document/frame pair and malformed frame IDs never execute the provided function', async () => {
  const f = fixture();
  for (const frameId of [-1, 'NaN', '', '1.5', '1e1', true, null, []]) await assert.rejects(executeFrameScript(f.chrome, 7, { frameId }, () => 'user code', []), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.scripts.length, 0);
  await assert.rejects(executeFrameScript(f.chrome, 7, { frameId: 12, documentId: 'example-main' }, () => 'user code', []), { code: 'FRAME_DOCUMENT_CHANGED' });
  assert.equal(f.scripts.length, 1); assert.equal(f.scripts[0].args, undefined);
  await assert.rejects(executeFrameScript(f.chrome, 7, { frameId: 12, documentId: 'example-expired' }, () => 'user code', []), { code: 'FRAME_UNAVAILABLE' });
});

test('navigation during evaluation produces an explicit error without replaying the expression', async () => {
  const f = fixture(); await f.context('example-child-session', 'example-child-context'); f.failEvaluation();
  await assert.rejects(evaluateBrowserFrame(f.chrome, 7, { frameId: 12, expression: 'exampleUserExpression' }, async () => {}), { code: 'FRAME_EVALUATION_INTERRUPTED' });
  assert.equal(f.calls.filter(call => call.params?.expression === 'exampleUserExpression').length, 1);
  assert.equal(f.markers.size, 0);
});

test('attaching a child enables runtime, download events and recursive iframe attachment without pausing the page', async () => {
  const f = fixture();
  await recordBrowserFrameEvent(f.chrome, { tabId: 7, sessionId: 'example-parent' }, 'Target.attachedToTarget', { sessionId: 'example-nested', targetInfo: { type: 'iframe' } });
  assert.deepEqual(f.calls.map(call => call.method), ['Runtime.enable', 'Page.enable', 'Network.enable', 'Target.setAutoAttach']);
  assert.deepEqual(f.calls[0].source, { tabId: 7, sessionId: 'example-nested' });
  assert.equal(f.calls[3].params.waitForDebuggerOnStart, false);
});

test('detaching nested targets invalidates their contexts but preserves main-target contexts with reused IDs', async () => {
  const f = fixture();
  await f.context(null, 'example-main-context');
  await recordBrowserFrameEvent(f.chrome, { tabId: 7 }, 'Target.attachedToTarget', { sessionId: 'example-child-session', targetInfo: { type: 'iframe' } });
  await recordBrowserFrameEvent(f.chrome, { tabId: 7, sessionId: 'example-child-session' }, 'Target.attachedToTarget', { sessionId: 'example-inner-session', targetInfo: { type: 'iframe' } });
  await f.context('example-child-session', 'example-child-context'); await f.context('example-inner-session', 'example-inner-context');
  await recordBrowserFrameEvent(f.chrome, { tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 'example-child-session' });
  await assert.rejects(evaluateBrowserFrame(f.chrome, 7, { frameId: 12, expression: 'exampleUserExpression' }, async () => {}), { code: 'FRAME_CONTEXT_UNAVAILABLE' });
  assert.equal(f.calls.some(call => call.params?.expression === 'exampleUserExpression'), false);
  const root = await evaluateBrowserFrame(f.chrome, 7, { frameId: 0, expression: 'exampleRootExpression' }, async () => {});
  assert.equal(root.value.context, 'example-main-context');
});

test('an unresolved page promise cannot retain the browser command forever and is never replayed', async t => {
  const f = fixture(); await f.context('example-child-session', 'example-child-context');
  const original = f.chrome.debugger.sendCommand;
  let resolveStarted; const started = new Promise(resolve => { resolveStarted = resolve; }); let attempts = 0;
  f.chrome.debugger.sendCommand = (source, method, params) => {
    if (params?.expression === 'examplePendingPromise') { attempts++; resolveStarted(); return new Promise(() => {}); }
    return original(source, method, params);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const evaluation = evaluateBrowserFrame(f.chrome, 7, { frameId: 12, expression: 'examplePendingPromise' }, async () => {});
  await started;
  const rejected = assert.rejects(evaluation, { code: 'FRAME_EVALUATION_INTERRUPTED' });
  t.mock.timers.tick(30001);
  await rejected;
  assert.equal(attempts, 1); assert.equal(f.markers.size, 0);
});

test('a stalled context lookup times out, cleans only the pinned document and never runs the operation after a late reply', async t => {
  const f = fixture(); await f.context('example-child-session', 'example-child-context');
  let started, reply;
  const entered = new Promise(resolve => { started = resolve; });
  const original = f.chrome.debugger.sendCommand;
  f.chrome.debugger.sendCommand = (source, method, params) => {
    if (params?.expression?.startsWith('this[')) {
      started(); return new Promise(resolve => { reply = resolve; });
    }
    return original(source, method, params);
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let actions = 0;
  const pending = withBrowserFrameContext(f.chrome, 7, { frameId: 12, documentId: 'example-child' }, async () => {}, async () => { actions++; });
  const rejected = assert.rejects(pending, { code: 'FRAME_OPERATION_TIMEOUT' });
  await entered; t.mock.timers.tick(2501); await rejected;
  reply({ result: { value: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0); assert.equal(f.markers.size, 0);
  assert.deepEqual(f.scripts.at(-1).target, { tabId: 7, documentIds: ['example-child'] });
});

test('a late document preflight cannot dispatch the requested script after timeout', async t => {
  const f = fixture();
  let started, reply;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  f.chrome.scripting.executeScript = () => { calls++; started(); return new Promise(resolve => { reply = resolve; }); };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = executeFrameScript(f.chrome, 7, { frameId: 12, documentId: 'example-child' }, () => 'must not execute', []);
  const rejected = assert.rejects(pending, { code: 'FRAME_OPERATION_TIMEOUT' });
  await entered; t.mock.timers.tick(30001); await rejected;
  reply([{ frameId: 12, documentId: 'example-child' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('identity preflight runs immediately without changing the scheduling of the requested action', async () => {
  const f = fixture();
  await executeFrameScript(f.chrome, 7, { frameId: 12, documentId: 'example-child' }, () => 'example action', []);
  assert.equal(f.scripts[0].injectImmediately, true);
  assert.equal(f.scripts[1].injectImmediately, undefined);
});

test('cancellation interrupts a pending Chrome call and latches even if the cancellation flag is later reset', async t => {
  const f = fixture(); let cancelled = false, started, reply;
  const entered = new Promise(resolve => { started = resolve; });
  const cancellation = Object.assign(new Error('Cancelled'), { code: 'PAGE_WORKFLOW_CANCELLED' });
  const guard = createFrameOperation({ assertRunning: () => { if (cancelled) throw cancellation; } });
  let calls = 0;
  f.chrome.scripting.executeScript = () => { calls++; started(); return new Promise(resolve => { reply = resolve; }); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = executeFrameScript(f.chrome, 7, { frameId: 12, documentId: 'example-child' }, () => 'must not execute', [], 'ISOLATED', guard);
  const rejected = assert.rejects(pending, error => error === cancellation);
  await entered; cancelled = true; t.mock.timers.tick(51); await rejected;
  cancelled = false; reply([{ frameId: 12, documentId: 'example-child' }]);
  await assert.rejects(guard.run(() => { calls++; }), error => error === cancellation);
  assert.equal(calls, 1);
});

test('unresponsive marker cleanup has a separate bounded budget and cannot hide the operation error', async t => {
  const f = fixture(); await f.context('example-child-session', 'example-child-context');
  const original = f.chrome.scripting.executeScript;
  let started, cleanups = 0;
  const entered = new Promise(resolve => { started = resolve; });
  f.chrome.scripting.executeScript = request => {
    if (String(request.func).includes('delete this') && ++cleanups === 2) { started(); return new Promise(() => {}); }
    return original(request);
  };
  const expected = new Error('Example operation failure');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = withBrowserFrameContext(f.chrome, 7, { frameId: 12, documentId: 'example-child' }, async () => {}, async () => { throw expected; });
  const rejected = assert.rejects(pending, error => error === expected);
  await entered; t.mock.timers.tick(1001); await rejected;
  assert.equal(cleanups, 2);
});
