// Frame selection uses Chrome document identity, never URL matching. CDP context
// IDs belong to a target session; child IDs must not enter the main-page cache.
import { createFrameOperation, settleFrameCleanup } from './frame-operation.js';
const tabs = new Map();
const fail = (code, message) => Object.assign(new Error(message), { code });
const key = source => source.sessionId || '';
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] };
const stateFor = tabId => {
  if (!tabs.has(tabId)) tabs.set(tabId, { contexts: new Map(), children: new Map(), enabled: false });
  return tabs.get(tabId);
};

export function clearBrowserFrames(tabId) { tabs.delete(tabId); }
export async function beginBrowserFrames(chrome, tabId, guard = createFrameOperation()) {
  const state = stateFor(tabId);
  if (!state.enabled) {
    await guard.run(() => chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'));
    try { await guard.run(() => chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', autoAttach)); }
    catch { guard.check(); throw fail('FRAME_CONTEXT_UNAVAILABLE', 'Frame observation requires Chrome child debugging sessions. Update Chrome and reconnect.'); }
    guard.check();
    state.enabled = true;
  }
  return state;
}
export async function recordBrowserFrameEvent(chrome, source, method, params) {
  const state = stateFor(source.tabId), session = key(source);
  if (method === 'Runtime.executionContextCreated') {
    const context = params.context;
    if (context?.auxData?.frameId && context.uniqueId) state.contexts.set(`${session}:${context.id}`, { source: { ...source }, ...context });
  } else if (method === 'Runtime.executionContextDestroyed') state.contexts.delete(`${session}:${params.executionContextId}`);
  else if (method === 'Runtime.executionContextsCleared') {
    for (const [id, context] of state.contexts) if (key(context.source) === session) state.contexts.delete(id);
  } else if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
    const child = { tabId: source.tabId, sessionId: params.sessionId };
    state.children.set(params.sessionId, session);
    try {
      await chrome.debugger.sendCommand(child, 'Runtime.enable');
      await chrome.debugger.sendCommand(child, 'Page.enable');
      await chrome.debugger.sendCommand(child, 'Network.enable', { maxTotalBufferSize: 10485760, maxResourceBufferSize: 524288, maxPostDataSize: 2000 });
      // Auto-attach is not recursive; an OOPIF can itself contain another OOPIF.
      await chrome.debugger.sendCommand(child, 'Target.setAutoAttach', autoAttach);
    } catch { /* Context discovery reports FRAME_CONTEXT_UNAVAILABLE; never use another frame. */ }
  } else if (method === 'Target.detachedFromTarget') {
    const removed = new Set([params.sessionId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [child, parent] of state.children) if (removed.has(parent) && !removed.has(child)) { removed.add(child); changed = true; }
    }
    for (const child of removed) state.children.delete(child);
    for (const [id, context] of state.contexts) if (removed.has(key(context.source))) state.contexts.delete(id);
  }
}

export function browserFrameSelection(tabId, args) {
  const value = args.frameId === undefined ? 0 : args.frameId;
  if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9][0-9]*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail('INVALID_ARGUMENT', 'frameId must be a non-negative integer from browser.frames.');
  const frameId = Number(value);
  if (args.documentId !== undefined && (typeof args.documentId !== 'string' || !args.documentId.trim() || args.documentId.length > 200)) throw fail('INVALID_ARGUMENT', 'documentId must be an ID from browser.frames.');
  return { frameId, target: { tabId, ...(args.documentId === undefined ? { frameIds: [frameId] } : { documentIds: [args.documentId] }) } };
}

export async function executeFrameScript(chrome, tabId, args, func, input, world = 'ISOLATED', guard = createFrameOperation(), injectImmediately = false) {
  const { frameId, target } = browserFrameSelection(tabId, args);
  let results;
  if (args.documentId !== undefined) {
    let documents;
    try { documents = await guard.run(() => chrome.scripting.executeScript({ target, injectImmediately: true, world, func: () => null })); }
    catch { guard.check(); throw fail('FRAME_UNAVAILABLE', 'The selected document is no longer available. Read browser.frames again.'); }
    if (!documents.some(item => item.frameId === frameId && item.documentId === args.documentId)) throw fail('FRAME_DOCUMENT_CHANGED', 'The frame/document pair does not match. Read browser.frames again.');
  }
  try { results = await guard.run(() => chrome.scripting.executeScript({ target, ...(injectImmediately ? { injectImmediately: true } : {}), world, func, args: input })); }
  catch { guard.check(); throw fail('FRAME_UNAVAILABLE', 'The selected frame/document is unavailable or navigation interrupted the operation. Read browser.frames again; do not replay a mutation automatically.'); }
  const result = results.find(item => item.frameId === frameId);
  if (!result || (args.documentId !== undefined && result.documentId !== args.documentId)) throw fail('FRAME_DOCUMENT_CHANGED', 'The frame/document pair no longer matches. Read browser.frames again.');
  return result;
}

export async function withBrowserFrameContext(chrome, tabId, args, ensureCdpAttached, operation, guard = createFrameOperation()) {
  browserFrameSelection(tabId, args);
  await guard.run(() => ensureCdpAttached(tabId));
  const state = await beginBrowserFrames(chrome, tabId, guard);
  const marker = `__weworkerFrame_${crypto.randomUUID().replaceAll('-', '')}`;
  let selected;
  try {
    selected = await executeFrameScript(chrome, tabId, args, function (name) {
      this[name] = true;
      return true;
    }, [marker], 'ISOLATED', guard, true);
    let context, isolated;
    const deadline = Date.now() + 2500;
    while (!context && Date.now() < deadline) {
      for (const candidate of [...state.contexts.values()]) {
        if (candidate.auxData.isDefault) continue;
        try {
          const check = await guard.run(() => chrome.debugger.sendCommand(candidate.source, 'Runtime.evaluate', {
            expression: `this[${JSON.stringify(marker)}] === true`,
            uniqueContextId: candidate.uniqueId, returnByValue: true, timeout: 1000,
          }), deadline);
          if (check.result?.value === true) {
            // The marker lives in the extension's isolated world, inaccessible
            // to page scripts. Chrome supplies its frame ID; use that identity
            // to select MAIN without executing a page-defined getter/function.
            const main = [...state.contexts.values()].filter(item => item.auxData.isDefault
              && item.auxData.frameId === candidate.auxData.frameId && key(item.source) === key(candidate.source));
            context = main.length === 1 ? main[0] : null; isolated = candidate;
            break;
          }
        } catch { guard.check(deadline); /* A disappearing context is not another frame. */ }
      }
      if (!context) await guard.run(() => new Promise(resolve => setTimeout(resolve, 50)));
    }
    if (!context) throw fail('FRAME_CONTEXT_UNAVAILABLE', 'No live execution context matched the selected document. Read browser.frames again.');
    try { await guard.run(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [selected.documentId] }, injectImmediately: true, world: 'ISOLATED', func: function (name) { delete this[name]; }, args: [marker] })); }
    catch { guard.check(); throw fail('FRAME_UNAVAILABLE', 'The selected document navigated before execution. Read browser.frames again.'); }
    guard.check();
    return await operation({ context, isolated, selected, state });
  } finally {
    if (selected) await settleFrameCleanup(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [selected.documentId] }, injectImmediately: true, world: 'ISOLATED', func: function (name) { delete this[name]; }, args: [marker] }));
  }
}

export async function evaluateBrowserFrame(chrome, tabId, args, ensureCdpAttached) {
  return withBrowserFrameContext(chrome, tabId, args, ensureCdpAttached, async ({ context, selected }) => {
    // Unique context identity prevents an ID recycled after navigation from
    // receiving user code. No retry is allowed after this single evaluation.
    let result, timer;
    try {
      const execution = chrome.debugger.sendCommand(context.source, 'Runtime.evaluate', {
        expression: args.expression, uniqueContextId: context.uniqueId, returnByValue: true,
        awaitPromise: true, timeout: 30000, allowUnsafeEvalBlockedByCSP: true,
      });
      // CDP's execution timeout does not bound an unresolved awaited Promise.
      // Do not terminate the shared renderer; report uncertainty, never replay.
      result = await Promise.race([execution, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Evaluation deadline exceeded')), 30000); })]);
    } catch { throw fail('FRAME_EVALUATION_INTERRUPTED', 'Frame execution was interrupted or timed out. Its side effects may have happened; inspect state before retrying.'); }
    finally { clearTimeout(timer); }
    if (result.exceptionDetails) throw fail('EVALUATION_FAILED', String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Frame JavaScript failed.').slice(0, 1000));
    if (result.result?.unserializableValue || result.result?.objectId) throw fail('EVALUATION_NOT_SERIALIZABLE', 'Return JSON-compatible data from the expression.');
    return { value: result.result?.value ?? null, frameId: selected.frameId, documentId: selected.documentId };
  });
}
