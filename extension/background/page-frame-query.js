import { readPageSource } from './page-source.js';
import { prepareInterceptAction } from './intercept-read.js';
import { executeFramePointer } from './browser-pointer.js';
import { resolvePageDestination, matchesPagePath } from './page-navigation.js';
import { navigationResultValue } from './page-navigation-parameters.js';
import { settleFrameCleanup } from './frame-operation.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const scalar = value => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isFinite(value);

/** Read/query/navigation in one retained owner chain. Never rediscover an owner. */
export async function executeFramePageQuery(options) {
  return options.frameContext.withDeadline(options.now() + options.payload.source.timeoutMs, () => executeRetainedQuery(options));
}
async function executeRetainedQuery({ chrome, ensureCdpAttached, tabId, payload, now, sleep, assertRunning, frameContext: pin }) {
  const { source, values = {}, expectedOrigin, expectedPath, metadataOnly } = payload;
  const deadline = now() + source.timeoutMs;
  const active = () => { assertRunning(); pin.check(); if (now() >= deadline) throw fail('PAGE_QUERY_TIMEOUT', 'Frame query deadline reached; no action was replayed.'); };
  active();
  const initial = await pin.snapshot(), initialUrl = new URL(initial.url), originalDocument = pin.selected.documentId;
  if (initialUrl.origin !== expectedOrigin || !matchesPagePath(initialUrl.pathname, expectedPath)) throw fail('PAGE_QUERY_ROUTE_CHANGED', 'The selected frame no longer matches its workflow route.');
  const navigation = source.mode === 'navigate', hash = source.hashNavigation;
  const destination = navigation ? resolvePageDestination(expectedOrigin, source, values, true) : new URL(expectedOrigin + source.resultPathname);
  const accept = url => url.origin === destination.origin && (navigation ? url.href === destination.href : url.pathname === destination.pathname
    && Object.entries(source.matchQuery || {}).every(([key, name]) => url.searchParams.get(key) === values[name]));
  const read = async (shape = false) => {
    await pin.assertCurrent(); active();
    const url = new URL(pin.leaf.url);
    const row = await pin.script(readPageSource, [{ source: source.result, expectedOrigin: url.origin, expectedPath: url.pathname, metadataOnly: shape }], 'MAIN');
    await pin.assertCurrent(); active();
    return row.result;
  };
  if (source.mode === 'read') {
    const result = await read(metadataOnly);
    if (!result?.ok) throw fail(result?.error?.code || 'PAGE_SOURCE_MISSING', result?.error?.message || 'Frame source is unavailable.');
    return { ...result, internalWorkflowPage: initial };
  }
  let before;
  try { const value = await read(); if (value?.ok) before = value.data; } catch { active(); }
  const sameBase = initialUrl.origin + initialUrl.pathname + initialUrl.search === destination.origin + destination.pathname + destination.search;
  const beforeStamp = hash && sameBase ? navigationResultValue(before, hash.freshnessPath) : undefined;
  if (hash && sameBase && !scalar(beforeStamp)) throw fail('PAGE_HASH_FRESHNESS_UNAVAILABLE', 'The selected frame has no business freshness baseline.');
  let armed = false, version = 0, changedDocument = false, changedUrl = false, eventError, lastEvent, committedLoader;
  let observedNavigation;
  const navigated = new Promise(resolve => { observedNavigation = resolve; });
  const listener = (sender, method, params) => {
    if (!armed || sender.tabId !== tabId) return;
    const document = method === 'Page.frameNavigated' && params.frame?.id === initial.frameId;
    const within = method === 'Page.navigatedWithinDocument' && params.frameId === initial.frameId;
    if (!document && !within) return;
    const url = document ? params.frame.url + (params.frame.urlFragment || '') : params.url;
    const key = JSON.stringify([method, url, params.frame?.loaderId]);
    if (key === lastEvent) return; // The same OOPIF event may be forwarded by two sessions.
    lastEvent = key; version++;
    if (document && params.frame.loaderId !== initial.loaderId) {
      changedDocument = true;
      if (committedLoader && committedLoader !== params.frame.loaderId) eventError = fail('PAGE_FRAME_DOCUMENT_CHANGED', 'The frame navigated again after its declared action.');
      committedLoader = params.frame.loaderId;
    }
    if (url !== initial.url) changedUrl = true;
    try {
      if (source.mode === 'filter' || !accept(new URL(url))) eventError = fail('PAGE_QUERY_ROUTE_CHANGED', 'Frame navigation left its declared destination; it was not replayed.');
    } catch { eventError = fail('PAGE_QUERY_ROUTE_CHANGED', 'Frame navigation returned an invalid URL.'); }
    if (changedDocument || changedUrl || eventError) observedNavigation({ observedNavigation: true });
  };
  chrome.debugger.onEvent.addListener(listener);
  const token = `__weworkerFrameAction_${crypto.randomUUID().replaceAll('-', '')}`;
  const actionDocument = pin.selected.documentId, actionSource = { ...pin.leaf.isolated.source };
  let objectId;
  try {
    await pin.assertCurrent(); active(); armed = true;
    if (navigation) {
      // An OOPIF navigation can destroy its CDP session before Page.navigate
      // replies. The exact frame's navigation event is also an acknowledgement;
      // keep one dispatch, then verify its original owners and new document.
      const response = await pin.run(() => Promise.race([
        hash && initial.url === destination.href
          ? chrome.scripting.executeScript({ target: { tabId, documentIds: [originalDocument] }, injectImmediately: true, world: 'ISOLATED', func: () => { location.reload(); return true; } })
          : chrome.debugger.sendCommand(pin.leaf.context.source, 'Page.navigate', { url: destination.href, frameId: initial.frameId }),
        navigated,
      ]));
      if (response?.errorText || response?.isDownload) throw fail('PAGE_QUERY_NAVIGATION_FAILED', 'Frame navigation failed or started a download.');
    } else {
      await pin.send({ tabId }, 'Page.bringToFront');
      const prepared = await pin.script(prepareInterceptAction, [{ source, expectedOrigin, expectedPath: initialUrl.pathname, values, retainTarget: token }]);
      const action = prepared.result;
      if (!action?.ok) throw fail(action?.error?.code || 'PAGE_QUERY_TARGET_CHANGED', action?.error?.message || 'The declared frame control is unavailable.');
      if (!changedDocument && !changedUrl && (action.point || action.pressEnter)) {
        await pin.assertCurrent(); active();
        const target = await pin.send(actionSource, 'Runtime.evaluate', { expression: `globalThis[${JSON.stringify(token)}]?.node`, uniqueContextId: pin.leaf.isolated.uniqueId });
        objectId = target.result?.objectId;
        if (!objectId) throw fail('PAGE_QUERY_TARGET_CHANGED', 'The retained read control disappeared before dispatch.');
        const verifyTarget = async () => {
          active(); await pin.assertCurrent();
          const checked = await pin.script(function (name, enter) {
            const saved = globalThis[name], node = saved?.node;
            if (!node?.isConnected || node.disabled || node.readOnly || node.getAttribute('aria-disabled') === 'true') return false;
            const nodes = [...document.querySelectorAll(saved.selector)].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
            const label = [node.getAttribute('aria-label'), node.getAttribute('placeholder'), ...(node.labels || []), node.tagName === 'INPUT' ? '' : node.textContent]
              .map(part => typeof part === 'string' ? part : part?.textContent || '').join(' ');
            return nodes.length === 1 && nodes[0] === node && label === saved.label && (!enter || document.activeElement === node && document.hasFocus());
          }, [token, action.pressEnter === true]);
          if (checked.result !== true) throw fail('PAGE_QUERY_TARGET_CHANGED', 'The retained read control changed before dispatch.');
          active();
        };
        if (action.point) await pin.run(() => executeFramePointer(chrome, tabId, 'click', pin.selected, ensureCdpAttached,
          { objectId, contextId: pin.leaf.isolated.uniqueId, assertRunning: active, beforeDispatch: verifyTarget }));
        else {
          await verifyTarget();
          try { await pin.send({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); }
          finally { await settleFrameCleanup(() => chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 })); }
        }
      }
    }
    // Do not inspect the old leaf while a dispatched query/navigation commits.
    // Input acknowledgement can precede Page.frameNavigated and invalidate the
    // old document in that gap. Only the exact retained frame event unlocks it.
    if (source.mode !== 'filter') await pin.run(() => navigated);
    let stable, stableVersion, stableSince;
    while (now() < deadline) {
      active(); if (eventError) throw eventError;
      await pin.assertAncestors();
      if (changedDocument || changedUrl) {
        // Peek only at the original Chrome frame ID, after an observed declared
        // navigation. Do not use selector/URL matching to pick a new owner.
        const rows = await pin.run(() => chrome.scripting.executeScript({ target: { tabId, frameIds: [pin.selected.frameId] }, injectImmediately: true,
          world: 'ISOLATED', func: () => ({ url: location.href, ready: document.readyState }) }));
        const row = rows.find(row => row.frameId === pin.selected.frameId);
        if (!row) throw fail('PAGE_FRAME_DOCUMENT_CHANGED', 'The retained frame was removed.');
        if (row.result.url === initial.url && !accept(new URL(initial.url))) { await sleep(50); continue; }
        if (!accept(new URL(row.result.url))) throw fail('PAGE_FRAME_ROUTE_CHANGED', 'Frame navigation left its exact declared route.');
        if (row.result.ready !== 'complete' || navigation && !hash && row.documentId === originalDocument || hash && initial.url === destination.href && row.documentId === originalDocument) { await sleep(50); continue; }
        if (pin.selected.documentId !== row.documentId || pin.leaf.url !== row.result.url) await pin.refreshLeaf(accept);
      }
      const current = await pin.snapshot();
      const ready = accept(new URL(current.url)) && current.status === 'complete' && (navigation ? hash && initial.url !== destination.href && sameBase ? changedUrl || changedDocument : changedDocument : source.mode === 'filter' || changedUrl || changedDocument);
      if (ready) {
        const observedVersion = version;
        const result = await read();
        if (result?.ok) {
          const serialized = JSON.stringify(result.data);
          const correlated = Object.entries(hash?.matchResult || source.matchResult || {}).every(([path, name]) => navigationResultValue(result.data, path) === values[name]);
          const stamp = hash ? navigationResultValue(result.data, hash.freshnessPath) : undefined;
          const fresh = hash ? scalar(stamp) && (!sameBase || stamp !== beforeStamp) : navigation || changedDocument || source.mode === 'filter' && source.trigger?.parameter || serialized !== JSON.stringify(before);
          if (correlated && fresh && observedVersion === version) {
            if (serialized !== stable || stableVersion !== version) { stable = serialized; stableVersion = version; stableSince = now(); }
            else if (now() - stableSince >= 300) {
              const output = metadataOnly ? await read(true) : result;
              const final = await pin.snapshot(); active();
              if (eventError) throw eventError;
              if (version !== observedVersion || final.url !== current.url || final.loaderId !== current.loaderId) throw fail('PAGE_FRAME_DOCUMENT_CHANGED', 'Frame changed during result extraction.');
              return { ...output, internalWorkflowPage: final };
            }
          } else stable = undefined;
        } else stable = undefined;
      }
      await sleep(50);
    }
    throw fail('PAGE_QUERY_TIMEOUT', 'No fresh stable correlated frame result appeared; no action was replayed.');
  } finally {
    armed = false; chrome.debugger.onEvent.removeListener(listener);
    await settleFrameCleanup(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [actionDocument] }, injectImmediately: true, world: 'ISOLATED', func: name => { delete globalThis[name]; }, args: [token] }));
    if (objectId) await settleFrameCleanup(() => chrome.debugger.sendCommand(actionSource, 'Runtime.releaseObject', { objectId }));
  }
}
