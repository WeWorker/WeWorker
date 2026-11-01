import { browserResponseEvidence } from './browser-network.js';
const busyTabs = new Set();
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Fixed isolated-world action. Inspect all targets before changing the form. */
export function prepareInterceptAction({ source, expectedOrigin, expectedPath, values, retainTarget }) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  try {
    if (location.origin !== expectedOrigin || location.pathname !== expectedPath) fail('INTERCEPT_ROUTE_CHANGED', 'Open the observed page route before this query.');
    const trigger = source.trigger;
    const visible = node => !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const one = selector => {
      const nodes = [...document.querySelectorAll(selector)].filter(visible);
      if (nodes.length !== 1) fail('INTERCEPT_TARGET_CHANGED', 'Choose one visible query control.');
      const node = nodes[0];
      if (node.disabled || node.readOnly || node.getAttribute('aria-disabled') === 'true') fail('INTERCEPT_TARGET_DISABLED', 'The query control is disabled.');
      return node;
    };
    const label = node => [node.getAttribute('aria-label'), node.getAttribute('placeholder'), ...(node.labels || []), node.tagName === 'INPUT' ? '' : node.textContent].map(part => typeof part === 'string' ? part : part?.textContent || '').join(' ');
    const unsafe = /delete|remove|buy|pay|submit order|publish|approve|save|upload|删除|购买|支付|提交订单|发布|保存|审批|上传/i;
    const node = one(trigger.selector);
    const check = (target, expression) => { const text = label(target); if (!expression.test(text) || unsafe.test(text)) fail('INTERCEPT_UNSAFE_TRIGGER', 'The target no longer has the observed read/query semantics.'); };
    let clickTarget;
    if (trigger.kind === 'search') {
      if (!(node instanceof HTMLInputElement) || !['text', 'search'].includes(node.type)) fail('INTERCEPT_UNSAFE_TRIGGER', 'Search requires a text/search input.');
      check(node, /search|query|搜索|查询|检索/i);
      if (trigger.submitSelector) { clickTarget = one(trigger.submitSelector); check(clickTarget, /search|query|搜索|查询|检索/i); }
    } else if (trigger.kind === 'filter') {
      if (!(node instanceof HTMLSelectElement)) fail('INTERCEPT_UNSAFE_TRIGGER', 'Filter requires a native select.');
      check(node, /filter|category|sort|筛选|分类|排序/i);
      if (![...node.options].some(option => !option.disabled && option.value === values[trigger.parameter])) fail('INTERCEPT_OPTION_MISSING', 'The requested filter option is unavailable.');
    } else if (trigger.kind === 'pagination') { check(node, /next|下一页|下页/i); clickTarget = node; }
    else fail('INTERCEPT_UNSAFE_TRIGGER', 'Unsupported query trigger.');
    let point;
    if (trigger.parameter) {
      const value = values[trigger.parameter];
      if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail('INVALID_INTERCEPT_ARGUMENT', 'Query arguments must be nonempty strings of at most 1000 characters.');
      Object.getOwnPropertyDescriptor(trigger.kind === 'filter' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(node, value);
      node.focus(); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (clickTarget) {
      // Input handlers may synchronously replace or move the submit control.
      clickTarget = one(trigger.submitSelector || trigger.selector);
      check(clickTarget, trigger.kind === 'search' ? /search|query|搜索|查询|检索/i : /next|下一页|下页/i);
      if (!['BUTTON', 'A'].includes(clickTarget.tagName) && clickTarget.getAttribute('role') !== 'button') fail('INTERCEPT_UNSAFE_TRIGGER', 'Choose a query button or link.');
      clickTarget.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = clickTarget.getBoundingClientRect();
      const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2;
      const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== clickTarget && !clickTarget.contains(hit))) fail('INTERCEPT_TARGET_OBSCURED', 'Another element covers the query control.');
      point = { x, y };
    }
    if (retainTarget) {
      if (!/^__weworkerFrameAction_[a-f0-9]{32}$/.test(retainTarget)) fail('INTERCEPT_TARGET_CHANGED', 'Invalid retained query target.');
      const target = clickTarget || node;
      globalThis[retainTarget] = { node: target, selector: trigger.submitSelector || trigger.selector, label: label(target) };
    }
    return { ok: true, point: point || null, pressEnter: trigger.pressEnter === true };
  } catch (error) { return { ok: false, error: { code: error.code || 'INTERCEPT_TARGET_CHANGED', message: error.code ? error.message : 'Invalid query selector.' } }; }
}

function matchesRequest(request, source, values) {
  try {
    const url = new URL(request.url), target = new URL(source.endpoint);
    if (request.method !== source.method || url.origin !== target.origin || url.pathname !== target.pathname) return false;
    for (const [key, parameter] of Object.entries(source.matchQuery || {})) if (url.searchParams.get(key) !== values[parameter]) return false;
    if (Object.keys(source.matchBody || {}).length) {
      if (!request.postData || request.postData.length > 262144) return false;
      const body = source.bodyKind === 'form' ? Object.fromEntries(new URLSearchParams(request.postData)) : JSON.parse(request.postData);
      for (const [path, parameter] of Object.entries(source.matchBody)) {
        let value = body;
        for (const key of path.split('.')) value = value && Object.hasOwn(value, key) ? value[key] : undefined;
        if (value !== values[parameter]) return false;
      }
    }
    return true;
  } catch { return false; }
}
const sensitive = /authorization|cookie|token|password|passwd|secret|credential|api.?key|csrf|xsrf|session|ticket|signature|^w_rid$|^wts$/i;
export function interceptJson(text) {
  if (text.length > 1000000) throw failure('INTERCEPT_TOO_LARGE', 'The matched JSON response exceeds one million characters.');
  let value;
  try { value = JSON.parse(text); } catch { throw failure('INTERCEPT_NOT_JSON', 'The matched response is not complete JSON.'); }
  let nodes = 0;
  const clean = (value, depth = 0) => {
    if (++nodes > 100000 || depth > 20) throw failure('INTERCEPT_TOO_LARGE', 'The matched JSON response is too complex.');
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : clean(item, depth + 1)]));
    return value;
  };
  return clean(value);
}

/** Captures only requests starting after this invocation arms its listener. */
export async function executeInterceptRead({ chrome, ensureCdpAttached, tabId, payload, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (busyTabs.has(tabId)) return { ok: false, error: { code: 'INTERCEPT_BUSY', message: 'A page query is already running in this tab.' } };
  busyTabs.add(tabId);
  let listener;
  const requests = new Map(), completed = [];
  let armed = false, pendingBodies = 0, lastMatch = 0, captureError;
  try {
    const { source, values = {}, expectedOrigin, expectedPath, metadataOnly = false } = payload;
    if (source?.strategy !== 'INTERCEPT' || !['GET', 'POST'].includes(source.method)) throw failure('INVALID_INTERCEPT_SOURCE', 'Unsupported intercept source.');
    const timeoutMs = source.timeoutMs || 10000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20000) throw failure('INVALID_INTERCEPT_SOURCE', 'timeoutMs must be 500–20000.');
    const checkRoute = async () => { const tab = await chrome.tabs.get(tabId), url = new URL(tab.url); if (url.origin !== expectedOrigin || url.pathname !== expectedPath) throw failure('INTERCEPT_ROUTE_CHANGED', 'The observed page route changed.'); };
    await checkRoute(); await ensureCdpAttached(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.bringToFront');
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    const initialLoader = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'))?.frameTree?.frame?.loaderId;
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: 262144, maxResourceBufferSize: 2000000, maxTotalBufferSize: 4000000 });
    listener = async (sender, method, params) => {
      if (!armed || sender.tabId !== tabId) return;
      if (method === 'Page.frameNavigated' && !params.frame?.parentId && (!initialLoader || params.frame.loaderId !== initialLoader)) { captureError = failure('INTERCEPT_DOCUMENT_CHANGED', 'The query replaced the page document; use a navigation-aware workflow.'); return; }
      if (method === 'Network.requestWillBeSent') {
        if (requests.has(params.requestId) && params.redirectResponse) { captureError = failure('INTERCEPT_REDIRECT', 'The matched request redirected; inspect the current endpoint.'); requests.delete(params.requestId); return; }
        if (['Fetch', 'XHR'].includes(params.type) && matchesRequest(params.request || {}, source, values)) { if (requests.size + completed.length + pendingBodies >= 2) { captureError = failure('INTERCEPT_AMBIGUOUS', 'Multiple new requests matched; narrow request correlation.'); return; } requests.set(params.requestId, {}); lastMatch = now(); }
      } else if (method === 'Network.responseReceived' && requests.has(params.requestId)) requests.set(params.requestId, { status: params.response.status, contentType: params.response.mimeType });
      else if (method === 'Network.loadingFailed' && requests.has(params.requestId)) { requests.delete(params.requestId); captureError = failure('INTERCEPT_REQUEST_FAILED', 'The matched query request failed.'); }
      else if (method === 'Network.loadingFinished' && requests.has(params.requestId)) {
        const response = requests.get(params.requestId); requests.delete(params.requestId); pendingBodies++;
        try {
          if (!(response.status >= 200 && response.status < 300)) throw failure('INTERCEPT_HTTP_ERROR', `The matched query returned HTTP ${response.status || 'unknown'}.`);
          if (!/json/i.test(response.contentType || '')) throw failure('INTERCEPT_NOT_JSON', 'The matched query did not return JSON.');
          const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId });
          const text = body.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body.body), c => c.charCodeAt(0))) : body.body;
          const data = interceptJson(text);
          if (armed) completed.push({ data, status: response.status });
        } catch (error) { if (armed) captureError = error.code ? error : failure('INTERCEPT_BODY_UNAVAILABLE', 'The matched response body is unavailable.'); }
        finally { pendingBodies--; lastMatch = now(); }
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    armed = true;
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: prepareInterceptAction, args: [payload] });
    if (!result?.ok) throw failure(result?.error?.code || 'INTERCEPT_TARGET_CHANGED', result?.error?.message || 'The query control is unavailable.');
    if (result.point) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type, ...result.point, ...(type !== 'mouseMoved' ? { button: 'left', clickCount: 1 } : {}) });
    }
    if (result.pressEnter) {
      for (const type of ['keyDown', 'keyUp']) await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type, key: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    }
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (captureError) throw captureError;
      if (completed.length > 1) throw failure('INTERCEPT_AMBIGUOUS', 'Multiple new responses matched; narrow request correlation.');
      if (completed.length === 1 && !requests.size && !pendingBodies && now() - lastMatch >= 300) break;
      await sleep(50);
    }
    await checkRoute();
    if (captureError) throw captureError;
    if (completed.length !== 1 || requests.size || pendingBodies) throw failure('INTERCEPT_TIMEOUT', 'No unique completed response matched this page query before timeout.');
    const { data, status } = completed[0];
    return metadataOnly ? { ok: true, shape: browserResponseEvidence(JSON.stringify(data)).bodyShape, status } : { ok: true, data, status };
  } catch (error) { return { ok: false, error: { code: error.code || 'INTERCEPT_FAILED', message: error.code ? error.message : 'Unable to run the page query.' } }; }
  finally { armed = false; if (listener) chrome.debugger.onEvent.removeListener(listener); requests.clear(); busyTabs.delete(tabId); }
}
