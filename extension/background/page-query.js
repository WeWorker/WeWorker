import { prepareInterceptAction } from './intercept-read.js';
import { executePageSource } from './page-source.js';
import { executePageNavigation } from './page-navigation.js';
import { executePageWorkflow } from './page-workflow.js';
import { createFrameOperation } from './frame-operation.js';
const busy = new Set();
const cancelled = new Map();
let connectionEpoch = 0;
export function cancelAllPageWorkflows() { connectionEpoch++; }
export function assertPageWorkflowActive(tabId, operationId) {
  if (operationId && cancelled.has(`${tabId}:${operationId}`)) throw fail('PAGE_WORKFLOW_CANCELLED', 'Workflow cancelled; no later step will be dispatched.');
}
const fail = (code, message) => Object.assign(new Error(message), { code });
export function cancelPageWorkflow(tabId, operationId) {
  if (!Number.isInteger(tabId) || typeof operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(operationId)) return false;
  for (const [key, expires] of cancelled) if (expires < Date.now()) cancelled.delete(key);
  if (cancelled.size >= 128) cancelled.delete(cancelled.keys().next().value);
  cancelled.set(`${tabId}:${operationId}`, Date.now() + 60000);
  return true;
}

/** Runs outside the page so a read query can survive document replacement. */
export async function executePageQuery({ chrome, ensureCdpAttached, tabId, payload, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (busy.has(tabId)) return { ok: false, error: { code: 'PAGE_QUERY_BUSY', message: 'A page query is already running.' } };
  busy.add(tabId);
  const epoch = connectionEpoch;
  const assertRunning = () => {
    assertPageWorkflowActive(tabId, payload.operationId);
    if ((payload.source?.mode === 'workflow' || payload.source?.hashNavigation || payload.source?.resultOrigin) && epoch !== connectionEpoch) throw fail('PAGE_WORKFLOW_CANCELLED', 'Bridge disconnected; remaining workflow steps were not dispatched.');
  };
  try { return await executeSinglePageQuery({ chrome, ensureCdpAttached, tabId, payload, now, sleep, assertRunning }); }
  finally { busy.delete(tabId); }
}
async function executeSinglePageQuery({ chrome, ensureCdpAttached, tabId, payload, now, sleep, assertRunning, allowStaticNavigation = false, captureWorkflowPage = false }) {
  let listener;
  try {
    assertRunning();
    const { source, expectedOrigin, expectedPath, values = {}, metadataOnly = false } = payload;
    if (source?.mode === 'workflow') return await executePageWorkflow({ chrome, ensureCdpAttached, tabId, payload, now, sleep, assertRunning }, executeSinglePageQuery);
    if (source?.mode === 'read' && captureWorkflowPage) {
      const guard = createFrameOperation({ assertRunning, deadline: now() + source.timeoutMs });
      const tab = await guard.run(() => chrome.tabs.get(tabId));
      if (new URL(tab.url).origin !== expectedOrigin || new URL(tab.url).pathname !== expectedPath) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Read step route changed.');
      await guard.run(() => ensureCdpAttached(tabId));
      const frame = (await guard.run(() => chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')))?.frameTree?.frame;
      const result = await guard.run(() => executePageSource(chrome, tabId, { source: source.result, expectedOrigin, expectedPath, metadataOnly }));
      const final = (await guard.run(() => chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')))?.frameTree?.frame;
      if (!frame?.loaderId || final?.loaderId !== frame.loaderId || final?.id !== frame.id || (await chrome.tabs.get(tabId)).url !== tab.url) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Read step document changed.');
      return { ...result, internalWorkflowPage: { url: tab.url, frameId: frame.id, loaderId: frame.loaderId } };
    }
    if (!['query', 'navigate', 'filter'].includes(source?.mode) || source.strategy !== 'UI_SELECTOR' || !source.result) throw fail('INVALID_PAGE_QUERY', 'Expected a declared UI query source.');
    const timeoutMs = source.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw fail('INVALID_PAGE_QUERY', 'Invalid page query timeout.');
    if (source.mode === 'navigate') return await executePageNavigation({ chrome, ensureCdpAttached, tabId, payload, now, sleep, allowStaticNavigation, assertRunning, captureWorkflowPage });
    const filter = source.mode === 'filter';
    const destination = new URL(expectedOrigin + source.resultPathname);
    if (destination.origin !== expectedOrigin || destination.pathname !== source.resultPathname || destination.search || destination.hash) throw fail('INVALID_PAGE_QUERY', 'Invalid result route.');
    const initial = await chrome.tabs.get(tabId), initialUrl = new URL(initial.url);
    if (initialUrl.origin !== expectedOrigin || ![expectedPath, source.resultPathname].includes(initialUrl.pathname)) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Open the observed query page.');
    const name = source.trigger?.parameter;
    if (Object.keys(values).some(key => key !== name) || (name && (typeof values[name] !== 'string' || !values[name].trim() || values[name].length > 1000))) throw fail('INVALID_PAGE_QUERY_ARGUMENT', 'Provide the declared query parameter.');
    if (filter && (expectedPath !== source.resultPathname || (name && !Object.keys(source.matchResult || {}).length))) throw fail('INVALID_PAGE_QUERY', 'Filters need a fixed page and parameter/result correlation.');
    const readPayload = { source: source.result, expectedOrigin, expectedPath: source.resultPathname, metadataOnly: false };
    let before;
    try { const observed = await executePageSource(chrome, tabId, readPayload); if (observed.ok) before = JSON.stringify(observed.data); } catch { /* The initial route may differ. */ }
    await ensureCdpAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.bringToFront');
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    const initialFrame = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'))?.frameTree?.frame;
    if (captureWorkflowPage && (!initialFrame?.id || !initialFrame.loaderId)) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Cannot identify the workflow document.');
    let currentLoaderId = initialFrame?.loaderId;
    let documentChanged = false, navigated = false, navigationError, navigationVersion = 0;
    listener = (sender, method, params) => {
      if (sender.tabId !== tabId || sender.sessionId) return;
      if (method === 'Page.frameNavigated' && !params.frame?.parentId && params.frame?.id === initialFrame?.id && (!initialFrame?.loaderId || params.frame.loaderId !== initialFrame.loaderId)) {
        documentChanged = true; navigated = true; navigationVersion++;
        currentLoaderId = params.frame.loaderId;
        try { if (new URL(params.frame.url).origin !== expectedOrigin) navigationError = fail('PAGE_QUERY_ORIGIN_CHANGED', 'Query navigation left the observed origin.'); } catch { navigationError = fail('PAGE_QUERY_ORIGIN_CHANGED', 'Query navigation left the observed origin.'); }
      } else if (method === 'Page.navigatedWithinDocument' && params.frameId === initialFrame?.id && params.url !== initial.url) { navigated = true; navigationVersion++; }
    };
    chrome.debugger.onEvent.addListener(listener);
    const started = now();
    let action;
    try {
      assertRunning();
      [{ result: action } = {}] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: prepareInterceptAction,
        args: [{ source, expectedOrigin, expectedPath: initialUrl.pathname, values }] });
    } catch (error) {
      // A select/input handler can navigate during executeScript. Never rerun
      // the action; only tolerate a destroyed context after observed navigation.
      if (!/frame.*removed|context.*destroyed|document.*unloaded/i.test(error.message || '')) throw error;
      if (!navigated) await sleep(100);
      if (!navigated) throw error;
    }
    if (!navigated && !action?.ok) throw fail(action?.error?.code || 'PAGE_QUERY_TARGET_CHANGED', action?.error?.message || 'The query control is unavailable.');
    assertRunning();
    if (!navigated && action?.point) for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type, ...action.point,
      ...(type !== 'mouseMoved' ? { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 } : {}) });
    if (!navigated && action?.pressEnter) for (const type of ['keyDown', 'keyUp']) await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type, key: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    let stableValue, stableVersion, stableSince = now(), lastError;
    while (now() - started < timeoutMs) {
      assertRunning();
      if (navigationError) throw navigationError;
      if (filter && navigated) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'The filter changed its document or URL; it was not replayed.');
      const current = await chrome.tabs.get(tabId), url = new URL(current.url);
      if (url.origin !== expectedOrigin) throw fail('PAGE_QUERY_ORIGIN_CHANGED', 'Query navigation left the observed origin.');
      const matches = url.pathname === source.resultPathname && Object.entries(source.matchQuery || {}).every(([field, parameter]) => url.searchParams.get(field) === values[parameter]);
      if ((filter || navigated) && matches && current.status === 'complete') {
        let result; const version = navigationVersion;
        try { result = await executePageSource(chrome, tabId, readPayload); } catch { result = null; }
        if (result?.ok && version === navigationVersion) {
          const serialized = JSON.stringify(result.data);
          // SPA URL updates can precede result rendering. Never accept its old
          // rows as fresh evidence; equal results need a document navigation.
          const correlated = Object.entries(source.matchResult || {}).every(([path, parameter]) => {
            let value = result.data;
            for (const key of path.split('.')) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
            return value === values[parameter];
          });
          if ((filter ? correlated && (name || serialized !== before) : documentChanged || serialized !== before)) {
            if (serialized !== stableValue || version !== stableVersion) { stableValue = serialized; stableVersion = version; stableSince = now(); }
            else if (now() - stableSince >= 300) {
              if (metadataOnly) result = await executePageSource(chrome, tabId, { ...readPayload, metadataOnly: true });
              assertRunning();
              const final = new URL((await chrome.tabs.get(tabId)).url);
              if (final.href !== url.href) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Page changed while reading the query result.');
              if (version !== navigationVersion || navigationError) { stableValue = undefined; continue; }
              if (captureWorkflowPage) {
                const frame = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'))?.frameTree?.frame;
                if (frame?.id !== initialFrame.id || frame?.loaderId !== currentLoaderId || version !== navigationVersion) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'Workflow result document changed before completion.');
              }
              return captureWorkflowPage ? { ...result, internalWorkflowPage: { url: final.href, frameId: initialFrame.id, loaderId: currentLoaderId } } : result;
            }
          } else stableValue = undefined;
        } else { lastError = result?.error; stableValue = undefined; }
      } else stableValue = undefined;
      await sleep(100);
    }
    throw fail('PAGE_QUERY_TIMEOUT', lastError ? 'The result page did not expose the declared data before timeout.' : 'No fresh, stable page result matched the query before timeout.');
  } catch (error) { return { ok: false, error: { code: error.code || 'PAGE_QUERY_FAILED', message: error.code ? error.message : 'Unable to complete the page query.' } }; }
  finally { if (listener) chrome.debugger.onEvent.removeListener(listener); }
}
