/**
 * Content Script: Injector
 *
 * 职责：
 * 1. 暴露 window.__webmcpRegister 供 background 注入的 adapter 调用
 * 2. 维护工具 handler 映射，上报工具元数据给 background
 * 3. 监听来自 background 的工具调用请求，执行 handler 并返回结果
 *
 * 注意：
 * - Chrome MV3 content script 不支持动态 import()
 * - Adapter 文件由 background service worker 通过 chrome.scripting.executeScript 注入
 * - 运行在 isolated world，可访问 DOM，不能访问页面 JS 变量
 */

// 防止重复注入（manifest content_scripts + executeScript 都会加载此文件）
if (window.__webmcpInjectorLoaded) {
  // 已加载过，跳过
} else {
window.__webmcpInjectorLoaded = true;

/** @type {Map<string, Function>} 内部 handler 名 -> handler 函数 */
const handlers = new Map();

/** @type {Array<{url: string, initiatorType: string, startTime: number, duration: number, transferSize: number, decodedBodySize: number}>} */
const recentNetworkEntries = [];
const deepNetworkEntries = [];
const NETWORK_ENTRY_LIMIT = 120;
const NETWORK_PREVIEW_LIMIT = 2000;
let networkObserverStarted = false;
let pageInterceptorInstalled = false;
let snapshotRequestCounter = 0;
const pendingSnapshotResolvers = new Map();
let safeApiProbeSnapshotCounter = 0;
const safeApiProbeCandidates = new Map();
let activeTraceID = null;
const TRACE_PREVIEW_LIMIT = 3000;
const TRACE_RESPONSE_PREVIEW_LIMIT = 800;
const SENSITIVE_TRACE_FIELD = /cookie|authorization|token|ticket|session|password|passwd|secret|csrf|credential/i;

/** 已注册工具的元数据列表（不含 handler） */
const toolDefs = [];

/** 已注册的公开工具名集合，用于去重 */
const registeredToolNames = new Set();

window.__webmcpWecliRuntime = window.__webmcpWecliRuntime || createWecliRuntime();

function truncateTraceText(value, limit = TRACE_PREVIEW_LIMIT) {
  const text = value == null ? '' : String(value);
  return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text;
}

function sanitizeTraceValue(value, key = '') {
  if (value == null) return value;
  if (SENSITIVE_TRACE_FIELD.test(String(key))) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text ? `[redacted length=${text.length}]` : '';
  }
  if (typeof value === 'string') return truncateTraceText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, key));
  if (typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeTraceValue(childValue, childKey);
    }
    return result;
  }
  return value;
}

function summarizeTraceBody(body, encoding, limit = TRACE_PREVIEW_LIMIT) {
  if (body == null) return undefined;
  if (encoding === 'base64') {
    return `[base64 length=${String(body).length}]`;
  }
  const text = String(body);
  try {
    return truncateTraceText(JSON.stringify(sanitizeTraceValue(JSON.parse(text))), limit);
  } catch {
    return truncateTraceText(text, limit);
  }
}

function summarizeTraceData(value, limit = TRACE_PREVIEW_LIMIT) {
  if (value == null) return value;
  if (typeof value === 'string') return truncateTraceText(value, limit);
  return truncateTraceText(JSON.stringify(sanitizeTraceValue(value)), limit);
}

function summarizePrivilegedPayload(action, payload = {}) {
  if (action === 'backend_fetch') {
    const options = payload && typeof payload.options === 'object' && !Array.isArray(payload.options) ? payload.options : payload;
    return {
      url: payload.url,
      method: String(options?.method || 'GET').toUpperCase(),
      headers: sanitizeTraceValue(options?.headers || {}),
      body: summarizeTraceBody(options?.body, options?.bodyEncoding),
    };
  }
  if (action === 'backend_file_read' || action === 'backend_file_write') {
    return sanitizeTraceValue({ ...payload, content: payload?.content ? `[content length=${String(payload.content).length}]` : undefined });
  }
  return sanitizeTraceValue(payload);
}

function summarizePrivilegedResult(action, result) {
  if (action === 'backend_fetch') {
    return {
      status: result?.status,
      ok: result?.ok,
      headers: sanitizeTraceValue(result?.headers || {}),
      body: summarizeTraceBody(result?.body, undefined, TRACE_RESPONSE_PREVIEW_LIMIT),
    };
  }
  if (action === 'cookies_get') {
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
    return {
      count: cookies.length,
      cookies: cookies.map(cookie => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })),
    };
  }
  if (action === 'storage_get') {
    const value = result?.value;
    return {
      value: value == null ? null : `[redacted length=${String(value).length}]`,
    };
  }
  if (action === 'backend_file_read') {
    return sanitizeTraceValue({ ...result, content: result?.content ? `[content length=${String(result.content).length}]` : undefined });
  }
  if (action === 'network_capture_read') {
    return {
      count: Array.isArray(result?.entries) ? result.entries.length : 0,
      entries: (result?.entries || []).map((entry) => ({
        url: entry.url,
        method: entry.method,
        responseStatus: entry.responseStatus,
        responseBodyFullSize: entry.responseBodyFullSize,
        responseBodyError: entry.responseBodyError,
        responseBodyTruncated: entry.responseBodyTruncated,
      })),
    };
  }
  return sanitizeTraceValue(result);
}

async function runHandlerWithTrace(handler, args, traceID, continuation) {
  const previousTraceID = activeTraceID;
  activeTraceID = traceID;
  traceLog(traceID, `[ContentScript] handler args ${JSON.stringify(sanitizeTraceValue(args || {}))}`);
  try {
    return await handler(args, continuation);
  } finally {
    activeTraceID = previousTraceID;
  }
}

function createWecliRuntime() {
  const CONTROL_ARGS = new Set(['__confirmed', 'dry-run']);

  function createRuntimeError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function normalizeArgsForSchema(args = {}, schema = {}) {
    if (!schema || schema.type !== 'object') return args || {};
    const result = { ...(args || {}) };
    const properties = schema.properties || {};
    for (const [name, definition] of Object.entries(properties)) {
      const value = result[name];
      if (definition?.type === 'integer' && typeof value === 'string' && value.trim() !== '') {
        const numberValue = Number(value.trim());
        if (Number.isInteger(numberValue)) result[name] = numberValue;
      }
      if (definition?.type === 'array' && definition?.items?.type === 'integer' && typeof value === 'string') {
        const parts = value.split(',').map(part => part.trim()).filter(Boolean);
        const numberValues = parts.map(part => Number(part));
        if (parts.length > 0 && numberValues.every(Number.isInteger)) result[name] = numberValues;
      }
    }
    return result;
  }

  function validateArgs(args = {}, schema = {}) {
    if (!schema || schema.type !== 'object') return args || {};
    let result = { ...(args || {}) };
    const properties = schema.properties || {};
    const required = schema.required || [];

    for (const [name, definition] of Object.entries(properties)) {
      if (!(name in result) && Object.prototype.hasOwnProperty.call(definition, 'default')) {
        result[name] = definition.default;
      }
    }
    result = normalizeArgsForSchema(result, schema);

    for (const name of required) {
      if (!(name in result) || result[name] === undefined || result[name] === null || result[name] === '') {
        throw createRuntimeError('INVALID_ARGS', `Missing required argument: ${name}`, { argument: name });
      }
    }

    if (schema.additionalProperties === false) {
      for (const name of Object.keys(result)) {
        if (!(name in properties) && !CONTROL_ARGS.has(name)) {
          throw createRuntimeError('INVALID_ARGS', `Unknown argument: ${name}`, { argument: name });
        }
      }
    }

    for (const [name, definition] of Object.entries(properties)) {
      if (!(name in result) || result[name] == null) continue;
      validateValueType(name, result[name], definition);
    }

    return result;
  }

  function validateValueType(name, value, definition = {}) {
    const type = definition.type;
    const ok = type === 'array' ? Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : type === 'boolean' ? typeof value === 'boolean'
      : type === 'object' ? typeof value === 'object' && !Array.isArray(value)
      : type === 'string' ? typeof value === 'string'
      : true;
    if (!ok) {
      throw createRuntimeError('INVALID_ARGS', `Invalid type for argument ${name}: expected ${type}`, { argument: name, expected: type });
    }
    if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
      throw createRuntimeError('INVALID_ARGS', `Invalid value for argument ${name}`, { argument: name, allowed: definition.enum });
    }
  }

  function requireConfirmation(args = {}, toolName = 'this command') {
    if (args.__confirmed === true || args.yes === true) {
      return true;
    }
    if (args['dry-run'] === true || args.dryRun === true) {
      return { confirmed: false, dryRun: true };
    }
    throw createRuntimeError('CONFIRMATION_REQUIRED', `${toolName} requires explicit user confirmation`, { toolName });
  }

  async function fetchJson(input, init = {}) {
    const traceID = activeTraceID;
    const method = String(init.method || 'GET').toUpperCase();
    traceLog(traceID, `[Runtime] fetchJson request ${JSON.stringify({
      method,
      url: String(input),
      headers: sanitizeTraceValue(init.headers || {}),
      body: summarizeTraceBody(init.body),
    })}`);
    const response = await fetch(input, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
    const contentType = response.headers?.get?.('content-type') || '';
    const body = contentType.includes('json') ? await response.json() : await response.text();
    traceLog(traceID, `[Runtime] fetchJson response ${JSON.stringify({
      status: response.status,
      ok: response.ok,
      contentType,
      body: summarizeTraceData(body, TRACE_RESPONSE_PREVIEW_LIMIT),
    })}`);
    if (!response.ok) {
      throw createRuntimeError('HTTP_ERROR', `HTTP ${response.status}`, { status: response.status, body });
    }
    return body;
  }

  async function requestPrivileged(action, payload = {}) {
    const traceID = activeTraceID;
    traceLog(traceID, `[Runtime] ${action} request ${JSON.stringify(summarizePrivilegedPayload(action, payload))}`);
    const message = {
      type: 'wecli_runtime_request',
      action,
      payload,
    };
    if (traceID) message.traceID = traceID;
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      traceLog(traceID, `[Runtime] ${action} error ${JSON.stringify(sanitizeTraceValue(response?.error || response))}`);
      const error = createRuntimeError(response?.error?.code || 'RUNTIME_HELPER_ERROR', response?.error?.message || response?.error || 'Runtime helper failed', response?.error?.details || {});
      throw error;
    }
    traceLog(traceID, `[Runtime] ${action} response ${JSON.stringify(summarizePrivilegedResult(action, response.result))}`);
    return response.result;
  }

  function setFileInput(selector, files) {
    return requestPrivileged('set_file_input', { selector, files });
  }

  /** Report "not logged in"; WeWorker then runs the login flow and retries reads. */
  function authRequired(message = 'Login required') {
    throw createRuntimeError('AUTH_REQUIRED', message, { phase: 'handler' });
  }

  return {
    createRuntimeError,
    validateArgs,
    requireConfirmation,
    fetchJson,
    requestPrivileged,
    setFileInput,
    authRequired,
  };
}

/** Error fields the service worker acts on; values never include page data. */
function errorResponseFields(err) {
  const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(err.code) ? err.code : '';
  if (!code) return {};
  const details = err.details && typeof err.details === 'object' ? err.details : {};
  if (code === 'AUTH_REQUIRED') {
    return { code, details: { phase: details.phase === 'navigation' ? 'navigation' : 'handler' } };
  }
  if (code === 'HTTP_ERROR' && Number.isInteger(details.status)) return { code, details: { status: details.status } };
  return { code };
}

// ─── Trace 日志存储 ──────────────────────────────────────────────────────────

const traceLogs = new Map(); // traceID -> string[]

function traceLog(traceID, message) {
  if (!traceID) return;
  if (!traceLogs.has(traceID)) traceLogs.set(traceID, []);
  const ts = new Date().toISOString(); // Retain the date for diagnostic windows across midnight.
  traceLogs.get(traceID).push(`[${ts}] [${traceID}] ${message}`);
  if (traceLogs.get(traceID).length > 300) {
    traceLogs.get(traceID).shift();
  }
}

function pushNetworkEntry(entry) {
  if (!entry?.url) return;
  const key = `${entry.url}@@${entry.startTime}@@${entry.initiatorType}`;
  if (recentNetworkEntries.some((item) => `${item.url}@@${item.startTime}@@${item.initiatorType}` === key)) {
    return;
  }
  recentNetworkEntries.push(entry);
  if (recentNetworkEntries.length > NETWORK_ENTRY_LIMIT) {
    recentNetworkEntries.splice(0, recentNetworkEntries.length - NETWORK_ENTRY_LIMIT);
  }
}

function collectInitialNetworkEntries() {
  try {
    const resources = performance.getEntriesByType('resource') || [];
    for (const entry of resources) {
      if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
      pushNetworkEntry({
        url: entry.name,
        initiatorType: entry.initiatorType,
        startTime: Math.round(entry.startTime),
        duration: Math.round(entry.duration),
        transferSize: entry.transferSize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
      });
    }
  } catch {
    // ignore
  }
}

function setupNetworkObserver() {
  collectInitialNetworkEntries();
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
        pushNetworkEntry({
          url: entry.name,
          initiatorType: entry.initiatorType,
          startTime: Math.round(entry.startTime),
          duration: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
          decodedBodySize: entry.decodedBodySize || 0,
        });
      }
    });
    observer.observe({ entryTypes: ['resource'] });
  } catch {
    // ignore
  }
}

function pushDeepNetworkEntry(entry) {
  if (!entry?.url) return;
  const key = `${entry.method || "GET"}@@${entry.url}@@${entry.timestamp || 0}@@${entry.kind || "page"}`;
  if (deepNetworkEntries.some((item) => `${item.method || "GET"}@@${item.url}@@${item.timestamp || 0}@@${item.kind || "page"}` === key)) return;
  deepNetworkEntries.push(entry);
  if (deepNetworkEntries.length > NETWORK_ENTRY_LIMIT) {
    deepNetworkEntries.splice(0, deepNetworkEntries.length - NETWORK_ENTRY_LIMIT);
  }
}

function ensurePageNetworkInterceptor() {
  if (pageInterceptorInstalled) return;
  pageInterceptorInstalled = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "__webmcp_network__") return;

    if (data.type === "network_entry" && data.entry) {
      pushDeepNetworkEntry(data.entry);
      return;
    }

    if (data.type === "network_snapshot" && data.requestId) {
      const resolve = pendingSnapshotResolvers.get(data.requestId);
      if (resolve) {
        pendingSnapshotResolvers.delete(data.requestId);
        resolve(Array.isArray(data.entries) ? data.entries : []);
      }
    }
  });

  const script = document.createElement("script");
  script.dataset.webmcp = "network-interceptor";
  script.textContent = `(() => {
    if (window.__webmcpPageNetworkInterceptorInstalled) return;
    window.__webmcpPageNetworkInterceptorInstalled = true;

    const ENTRY_LIMIT = 120;
    const PREVIEW_LIMIT = 2000;
    const entries = [];

    const truncate = (value) => {
      if (value == null) return "";
      const text = typeof value === "string" ? value : String(value);
      return text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) : text;
    };

    const headersToObject = (headers) => {
      if (!headers) return undefined;
      const result = {};
      try {
        if (typeof headers.forEach === "function") {
          headers.forEach((value, key) => { result[key] = value; });
          return result;
        }
      } catch {}
      if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (Array.isArray(pair) && pair.length >= 2) result[String(pair[0])] = String(pair[1]);
        }
        return result;
      }
      if (typeof headers === "object") {
        for (const [key, value] of Object.entries(headers)) result[String(key)] = String(value);
        return result;
      }
      return undefined;
    };

    const bodyToPreview = async (body) => {
      if (body == null) return undefined;
      if (typeof body === "string") return truncate(body);
      if (body instanceof URLSearchParams) return truncate(body.toString());
      if (body instanceof FormData) {
        return truncate(JSON.stringify(Array.from(body.entries()).map(([key, value]) => [key, value instanceof File ? { name: value.name, size: value.size, type: value.type } : value])));
      }
      if (body instanceof Blob) return "[Blob size=" + body.size + " type=" + (body.type || "unknown") + "]";
      if (body instanceof ArrayBuffer) return "[ArrayBuffer byteLength=" + body.byteLength + "]";
      if (ArrayBuffer.isView(body)) return "[TypedArray byteLength=" + body.byteLength + "]";
      if (typeof body === "object") {
        try { return truncate(JSON.stringify(body)); } catch { return truncate(String(body)); }
      }
      return truncate(String(body));
    };

    const remember = (entry) => {
      entries.push(entry);
      if (entries.length > ENTRY_LIMIT) entries.splice(0, entries.length - ENTRY_LIMIT);
      window.postMessage({ source: "__webmcp_network__", type: "network_entry", entry }, "*");
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const request = input instanceof Request ? input : null;
      const url = request ? request.url : String(input);
      const method = init.method || request?.method || "GET";
      const startedAt = Date.now();
      const requestHeaders = headersToObject(init.headers || request?.headers);
      const requestBodyPreview = await bodyToPreview(init.body);

      try {
        const response = await originalFetch(input, init);
        const clone = response.clone();
        let responsePreview = undefined;
        try { responsePreview = truncate(await clone.text()); } catch {}
        remember({
          kind: "page_fetch",
          url,
          method,
          timestamp: startedAt,
          duration: Date.now() - startedAt,
          requestHeaders,
          requestBodyPreview,
          status: response.status,
          ok: response.ok,
          responseHeaders: headersToObject(response.headers),
          responseContentType: response.headers.get("content-type") || "",
          responsePreview,
        });
        return response;
      } catch (error) {
        remember({
          kind: "page_fetch",
          url,
          method,
          timestamp: startedAt,
          duration: Date.now() - startedAt,
          requestHeaders,
          requestBodyPreview,
          error: error?.message || String(error),
        });
        throw error;
      }
    };

    const OriginalXHR = window.XMLHttpRequest;
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let method = "GET";
      let url = "";
      let startedAt = 0;
      let requestHeaders = {};
      let requestBodyPreview = undefined;

      const originalOpen = xhr.open;
      xhr.open = function(nextMethod, nextUrl, ...rest) {
        method = nextMethod || "GET";
        url = String(nextUrl || "");
        return originalOpen.call(this, nextMethod, nextUrl, ...rest);
      };

      const originalSetRequestHeader = xhr.setRequestHeader;
      xhr.setRequestHeader = function(name, value) {
        requestHeaders[String(name)] = String(value);
        return originalSetRequestHeader.call(this, name, value);
      };

      const originalSend = xhr.send;
      xhr.send = function(body) {
        startedAt = Date.now();
        bodyToPreview(body).then((preview) => { requestBodyPreview = preview; }).catch(() => {});
        xhr.addEventListener("loadend", () => {
          let responseHeaders = undefined;
          try {
            const raw = xhr.getAllResponseHeaders();
            if (raw) {
              responseHeaders = {};
              for (const line of raw.trim().split(/[\r\n]+/)) {
                const idx = line.indexOf(":");
                if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
              }
            }
          } catch {}

          let responsePreview = undefined;
          try {
            if (typeof xhr.responseText === "string") responsePreview = truncate(xhr.responseText);
          } catch {}

          remember({
            kind: "page_xhr",
            url,
            method,
            timestamp: startedAt || Date.now(),
            duration: startedAt ? Date.now() - startedAt : undefined,
            requestHeaders: Object.keys(requestHeaders).length ? requestHeaders : undefined,
            requestBodyPreview,
            status: xhr.status,
            ok: xhr.status >= 200 && xhr.status < 400,
            responseHeaders,
            responseContentType: xhr.getResponseHeader("content-type") || "",
            responsePreview,
          });
        }, { once: true });
        return originalSend.call(this, body);
      };

      return xhr;
    }

    WrappedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;

    window.addEventListener("__webmcp_request_network_snapshot__", (event) => {
      const requestId = event?.detail?.requestId;
      window.postMessage({ source: "__webmcp_network__", type: "network_snapshot", requestId, entries: entries.slice(-40) }, "*");
    });
  })();`;

  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

async function getDeepNetworkSnapshot() {
  ensurePageNetworkInterceptor();
  snapshotRequestCounter += 1;
  const requestId = `network-snapshot-${snapshotRequestCounter}`;
  const snapshotPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingSnapshotResolvers.delete(requestId);
      resolve([]);
    }, 300);
    pendingSnapshotResolvers.set(requestId, (entries) => {
      clearTimeout(timer);
      resolve(entries);
    });
  });
  window.dispatchEvent(new CustomEvent("__webmcp_request_network_snapshot__", { detail: { requestId } }));
  const snapshot = await snapshotPromise;
  for (const entry of snapshot) pushDeepNetworkEntry(entry);
  return deepNetworkEntries.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 40);
}

function isVisible(el) {
  if (!(el instanceof Element)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getElementText(el) {
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function getSimpleSelector(el) {
  if (!(el instanceof Element)) return '';
  if (el.id) return `#${el.id}`;
  const parts = [el.tagName.toLowerCase()];
  if (el.getAttribute('name')) parts.push(`[name="${el.getAttribute('name')}"]`);
  if (el.getAttribute('type')) parts.push(`[type="${el.getAttribute('type')}"]`);
  const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (cls.length) parts.push(`.${cls.join('.')}`);
  return parts.join('');
}

function sampleInteractiveElements() {
  const selectors = [
    'button',
    'a[href]',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[onclick]',
    '[tabindex]'
  ];

  const seen = new Set();
  const result = [];
  for (const el of document.querySelectorAll(selectors.join(','))) {
    if (!isVisible(el)) continue;
    const selector = getSimpleSelector(el);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    result.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      text: getElementText(el),
      selector,
      placeholder: el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
    });
    if (result.length >= 40) break;
  }
  return result;
}

function countListCandidates() {
  const selectors = ['table', 'tbody', 'ul', 'ol', '[role="list"]', '[class*="list"]', '[class*="table"]'];
  let count = 0;
  for (const el of document.querySelectorAll(selectors.join(','))) {
    if (!isVisible(el)) continue;
    const childCount = el.querySelectorAll('tr, li, [role="listitem"], .item, .row').length;
    if (childCount >= 3) count++;
  }
  return count;
}

function countPaginationCandidates() {
  const structuralRoots = document.querySelectorAll('.pagination, [class*="pagination"], [class*="pager"], #paging, nav[aria-label*="page" i]');
  let structuralCount = 0;
  for (const root of structuralRoots) {
    if (!(root instanceof Element) || !isVisible(root)) continue;
    const pageLikeNodes = root.querySelectorAll('a, button, li, [role="button"]');
    const numericNodes = Array.from(pageLikeNodes).filter((el) => /^\\d{1,4}$/.test(getElementText(el)));
    if (numericNodes.length >= 2) structuralCount += numericNodes.length;
    else structuralCount += Math.min(pageLikeNodes.length, 4);
    if (structuralCount >= 10) return 10;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!(el instanceof Element) || !isVisible(el)) continue;
    const text = getElementText(el);
    if (!text) continue;
    if (/上一页|下一页|上一頁|下一頁|page\s+\d+|\bprev\b|\bnext\b/i.test(text) || (/^\d{1,4}$/.test(text) && /page|pager|pagination|active|current|pwactive/i.test((el.className || '') + ' ' + (el.parentElement?.className || '')))) {
      count++;
      if (count >= 10) break;
    }
  }
  return structuralCount + count;
}

function detectStateHints() {
  let nextDataScript = false;
  let initialStateText = false;
  let nuxtData = false;
  let apolloStateText = false;

  for (const script of document.scripts) {
    if (script.id === '__NEXT_DATA__') nextDataScript = true;
    const text = (script.textContent || '').slice(0, 12000);
    if (!text) continue;
    if (!initialStateText && text.includes('__INITIAL_STATE__')) initialStateText = true;
    if (!nuxtData && text.includes('__NUXT__')) nuxtData = true;
    if (!apolloStateText && text.includes('__APOLLO_STATE__')) apolloStateText = true;
  }

  return { nextDataScript, initialStateText, nuxtData, apolloStateText };
}

function getPageStateSnapshot() {
  const interactiveElements = sampleInteractiveElements();
  const stateHints = detectStateHints();
  return {
    url: location.href,
    title: document.title,
    interactiveElements,
    forms: document.forms.length,
    dialogs: document.querySelectorAll('dialog,[role="dialog"],.modal,.ant-modal,.el-dialog').length,
    listCandidates: countListCandidates(),
    paginationCandidates: countPaginationCandidates(),
    stateHints,
  };
}

const SAFE_SEARCH_RE = /search|query|keyword|find|搜索|查询|检索|关键字/i;
const SAFE_FILTER_RE = /filter|status|type|category|sort|order|筛选|过滤|状态|类型|分类|排序/i;
const SAFE_DATE_FILTER_RE = /(?:^|[^a-z0-9])(date|day|time|期间|日期|时间)(?:$|[^a-z0-9])|选择日期/i;
const SAFE_NEXT_RE = /^(?:next|next page|下一页|下页|后一页|›|»|>)$/i;
const UNSAFE_ACTION_RE = /approve|book|buy|cancel|commit|create|delete|edit|pay|publish|reject|reserve|save|submit|update|upload|同意|审批|预订|删除|保存|提交|支付|上传|修改|驳回/i;

function safeElementLabelParts(el) {
  if (!(el instanceof Element)) return [];
  const labelledBy = el.getAttribute('aria-labelledby');
  const labelledText = labelledBy
    ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
    : '';
  return [...new Set([
    el.getAttribute('aria-label') || '',
    el.getAttribute('placeholder') || '',
    el.getAttribute('name') || '',
    labelledText,
    getElementText(el),
  ].map((value) => value.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function safeElementLabel(el) {
  const parts = safeElementLabelParts(el);
  return Array.isArray(parts) ? parts.join(' ').slice(0, 160) : '';
}

function nextDateValue(input) {
  const value = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  if (input instanceof HTMLInputElement && input.type === 'datetime-local') {
    return `${year}-${month}-${day}T00:00`;
  }
  return `${year}-${month}-${day}`;
}

function findSafeSearchTrigger(scope, input = null) {
  const roots = [];
  let current = scope instanceof Element ? scope : null;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
    roots.push(current);
  }
  const candidates = [...new Set(roots.flatMap((root) => [
    ...(root.matches('button,input[type="submit"],[role="button"]') ? [root] : []),
    ...root.querySelectorAll('button,input[type="submit"],[role="button"]'),
  ]))];
  const inputRect = input instanceof Element ? input.getBoundingClientRect() : null;
  return candidates
    .map((element) => {
      if (!(element instanceof Element) || element === input || element.contains(input) || !isVisible(element)) return null;
      const triggerLabel = safeElementLabel(element);
      if (!SAFE_SEARCH_RE.test(triggerLabel) || UNSAFE_ACTION_RE.test(triggerLabel)) return null;
      let score = 10;
      if (input instanceof Element) {
        if (element.parentElement === input.parentElement) score += 8;
        if (element.closest('form') && element.closest('form') === input.closest('form')) score += 6;
        const rect = element.getBoundingClientRect();
        const distance = Math.abs(rect.top - inputRect.top) + Math.abs(rect.left - inputRect.right);
        if (distance < 240) score += 6;
        else if (distance < 600) score += 2;
        else score -= 4;
      }
      return { element, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)[0]?.element || null;
}

function registerSafeApiProbe(snapshotId, kind, label, target, details = {}) {
  const id = `safe-api-${snapshotId}-${safeApiProbeCandidates.size + 1}`;
  safeApiProbeCandidates.set(id, { kind, label, target, ...details });
  return {
    id,
    kind,
    label,
    requiresValue: kind === 'search',
    risk: 'read',
    safetyReasons: details.safetyReasons || [],
  };
}

function inspectSafeApiProbeCandidates() {
  safeApiProbeCandidates.clear();
  safeApiProbeSnapshotCounter += 1;
  const snapshotId = safeApiProbeSnapshotCounter;
  const result = [];

  for (const input of document.querySelectorAll('input')) {
    if (!(input instanceof HTMLInputElement) || !isVisible(input) || input.disabled || input.readOnly) continue;
    const inputType = String(input.type || 'text').toLowerCase();
    if (!['search', 'text'].includes(inputType)) continue;
    const label = safeElementLabel(input);
    const isDateFilter = inputType === 'text' && SAFE_DATE_FILTER_RE.test(label);
    if (isDateFilter) continue;
    if (!SAFE_SEARCH_RE.test(label) || UNSAFE_ACTION_RE.test(label)) continue;
    const form = input.form;
    const scope = form || input.closest('[role="search"], header, section, div') || input.parentElement;
    const trigger = findSafeSearchTrigger(scope, input);
    result.push(registerSafeApiProbe(snapshotId, 'search', label || '搜索', input, {
      trigger,
      form,
      safetyReasons: ['strong_search_semantics', trigger ? 'search_labeled_trigger' : 'search_input_only'],
    }));
    if (result.length >= 8) break;
  }

  for (const input of document.querySelectorAll('input')) {
    if (!(input instanceof HTMLInputElement) || !isVisible(input) || input.disabled || input.readOnly) continue;
    const inputType = String(input.type || 'text').toLowerCase();
    const label = safeElementLabel(input);
    const isDateFilter = ['date', 'datetime-local'].includes(inputType)
      || (inputType === 'text' && SAFE_DATE_FILTER_RE.test(label));
    if (!isDateFilter || UNSAFE_ACTION_RE.test(label)) continue;
    const scope = input.form
      || input.closest('.filter-panel, form, [role="search"], section, main')
      || input.parentElement;
    result.push(registerSafeApiProbe(snapshotId, 'filter', label || '日期筛选', input, {
      inputValue: nextDateValue(input),
      trigger: findSafeSearchTrigger(scope, input),
      safetyReasons: ['strong_date_filter_semantics', 'native_input'],
    }));
    if (result.length >= 12) break;
  }

  for (const select of document.querySelectorAll('select')) {
    if (!(select instanceof HTMLSelectElement) || !isVisible(select) || select.disabled) continue;
    const label = safeElementLabel(select);
    if (!SAFE_FILTER_RE.test(label) || UNSAFE_ACTION_RE.test(label)) continue;
    const nextOption = [...select.options].find((option) => !option.disabled && option.value !== select.value && option.value !== '');
    if (!nextOption) continue;
    result.push(registerSafeApiProbe(snapshotId, 'filter', label || '筛选', select, {
      optionValue: nextOption.value,
      optionLabel: (nextOption.textContent || nextOption.value).trim().slice(0, 80),
      safetyReasons: ['strong_filter_semantics', 'existing_select_option'],
    }));
    if (result.length >= 12) break;
  }

  for (const control of document.querySelectorAll('a[href],button,[role="button"]')) {
    if (!(control instanceof Element) || !isVisible(control)) continue;
    const labelParts = safeElementLabelParts(control);
    const label = labelParts.join(' ').slice(0, 160);
    if (!labelParts.some((part) => SAFE_NEXT_RE.test(part)) || UNSAFE_ACTION_RE.test(label)) continue;
    if (control.matches(':disabled,[disabled],[aria-disabled="true"]')) continue;
    result.push(registerSafeApiProbe(snapshotId, 'pagination', label || '下一页', control, {
      safetyReasons: ['strong_next_page_semantics', 'enabled_control'],
    }));
    if (result.length >= 16) break;
  }

  return {
    snapshotId,
    candidates: result,
    policy: {
      allowedKinds: ['search', 'filter', 'pagination'],
      writeActionsBlocked: true,
    },
  };
}

function setNativeControlValue(control, value) {
  const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(control, value);
  else control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function executeSafeApiProbe(candidateId, rawValue) {
  const candidate = safeApiProbeCandidates.get(String(candidateId || ''));
  if (!candidate) throw new Error('SAFE_API_PROBE_STALE');
  if (!(candidate.target instanceof Element) || !candidate.target.isConnected || !isVisible(candidate.target)) {
    throw new Error('SAFE_API_PROBE_STALE');
  }
  if (!['search', 'filter', 'pagination'].includes(candidate.kind)) throw new Error('SAFE_API_PROBE_NOT_ALLOWED');

  if (candidate.kind === 'search') {
    const value = String(rawValue || 'test').trim().slice(0, 80);
    if (!value) throw new Error('SAFE_API_PROBE_VALUE_REQUIRED');
    setNativeControlValue(candidate.target, value);
    candidate.target.focus();
    if (candidate.trigger instanceof HTMLElement && candidate.trigger.isConnected) {
      candidate.trigger.click();
    } else if (candidate.form instanceof HTMLFormElement && String(candidate.form.method || 'get').toLowerCase() === 'get') {
      candidate.form.requestSubmit();
    } else {
      candidate.target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      candidate.target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    }
    return { executed: true, kind: candidate.kind, label: candidate.label, valueLength: value.length };
  }

  if (candidate.kind === 'filter') {
    if (candidate.target instanceof HTMLInputElement && typeof candidate.inputValue === 'string') {
      setNativeControlValue(candidate.target, candidate.inputValue);
      if (candidate.trigger instanceof HTMLElement && candidate.trigger.isConnected) {
        candidate.trigger.click();
      } else {
        candidate.target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        candidate.target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      }
      return { executed: true, kind: candidate.kind, label: candidate.label, valueLength: candidate.inputValue.length };
    }
    setNativeControlValue(candidate.target, candidate.optionValue);
    return { executed: true, kind: candidate.kind, label: candidate.label, optionLabel: candidate.optionLabel };
  }

  candidate.target.click();
  return { executed: true, kind: candidate.kind, label: candidate.label };
}

function ensureNetworkObserver() {
  if (networkObserverStarted) return;
  networkObserverStarted = true;
  setupNetworkObserver();
}

async function getRecentNetworkSnapshot() {
  ensureNetworkObserver();
  collectInitialNetworkEntries();
  const deepEntries = await getDeepNetworkSnapshot();
  const performanceEntries = recentNetworkEntries
    .slice()
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, 40);
  return {
    entries: deepEntries.length > 0 ? deepEntries : performanceEntries,
    deepEntries,
    performanceEntries,
    source: deepEntries.length > 0 ? "page_interceptor" : "performance",
    advice: deepEntries.length > 0
      ? "已捕获页面主线程中的 fetch/XHR 明细。"
      : "当前仅拿到 Performance 摘要。若要看到请求/响应预览，请先在页面执行一次搜索、翻页或进入详情后再重试。",
  };
}

async function runEvaluate(expression) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('expression must be a non-empty string');
  }

  const executor = new Function(`return (async () => { return (${expression}); })();`);
  const result = await executor();
  return JSON.parse(JSON.stringify(result ?? null));
}

// ─── 注册入口（供 adapter 文件调用） ──────────────────────────────────────────

/**
 * Adapter 文件调用此函数来注册工具
 * @param {{
 *   name: string,
 *   adapterId?: string,
 *   routeDomain?: string,
 *   tabDomain?: string,
 *   excludeTabDomain?: string,
 *   tools: Array<{
 *     name: string,
 *     publicName?: string,
 *     handlerName?: string,
 *     adapterId?: string,
 *     routeDomain?: string,
 *     tabDomain?: string,
 *     excludeTabDomain?: string,
 *     description: string,
 *     parameters: object,
 *     generationSource?: object,
 *     handler: Function
 *   }>
 * }} adapter
 */
window.__webmcpRegister = function (adapter) {
  let registered = 0;

  for (const tool of adapter.tools) {
    if (typeof tool.handler !== "function") {
      console.warn(`[WebMCP] Tool "${tool.name}" has no handler, skipping`);
      continue;
    }

    const publicName = tool.publicName ?? tool.name;
    const handlerName = tool.handlerName ?? tool.name;

    // 去重：如果工具已注册，跳过
    if (registeredToolNames.has(publicName)) {
      console.log(`[WebMCP] Tool "${publicName}" already registered, skipping duplicate`);
      continue;
    }

    handlers.set(handlerName, tool.handler);
    // internal 工具只注册 handler，不上报给 background（不暴露给 AI）
    if (!tool.internal) {
      const toolDef = {
        name: publicName,
        publicName,
        handlerName,
        adapterId: tool.adapterId ?? adapter.adapterId,
        routeDomain: tool.routeDomain ?? adapter.routeDomain,
        tabDomain: tool.tabDomain ?? adapter.tabDomain,
        excludeTabDomain: tool.excludeTabDomain ?? adapter.excludeTabDomain,
        description: tool.description,
        parameters: tool.parameters ?? {},
      };
      if (tool.generationSource) toolDef.generationSource = tool.generationSource;
      for (const key of ["adapterId", "routeDomain", "tabDomain", "excludeTabDomain"]) {
        if (toolDef[key] == null || toolDef[key] === "") delete toolDef[key];
      }
      toolDefs.push(toolDef);
    }
    registeredToolNames.add(publicName);
    registered++;
  }

  console.log(`[WebMCP] Adapter "${adapter.name}" registered ${registered} tools (${toolDefs.length} total)`);

  // 每次有新工具注册后，把完整列表上报给 background
  chrome.runtime.sendMessage({ type: "register_tools", tools: toolDefs });
};

// ─── 处理工具调用请求 & 重连时的工具重新上报 ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Service Worker 重连后请求重新上报工具（解决 SW 被挂起后 toolRegistry 丢失的问题）
  if (msg.type === "resync_tools") {
    if (toolDefs.length > 0) {
      chrome.runtime.sendMessage({ type: "register_tools", tools: toolDefs });
    }
    sendResponse({ ok: true });
    return true;
  }

  // Adapter 被删除后，Service Worker 通知清除本页工具
  if (msg.type === "clear_tools") {
    const siteKey = typeof msg.siteKey === "string" ? msg.siteKey.trim() : "";
    if (siteKey) {
      const runtime = window.__webmcpGeneratedRuntime;
      if (runtime && typeof runtime.resetSiteStore === "function") {
        runtime.resetSiteStore(siteKey);
      } else {
        const generatedSupport = window.__webmcpGeneratedSupport;
        if (generatedSupport && typeof generatedSupport === "object") {
          delete generatedSupport[siteKey];
        }
      }
    }
    handlers.clear();
    toolDefs.length = 0;
    registeredToolNames.clear();
    chrome.runtime.sendMessage({ type: "register_tools", tools: [] });
    sendResponse({ ok: true });
    return true;
  }

  // 获取页面尺寸（用于全页截图）
  if (msg.type === "get_page_dimensions") {
    sendResponse({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth
    });
    return true;
  }

  // 滚动到指定位置（用于全页截图）
  if (msg.type === "scroll_to") {
    window.scrollTo(0, msg.y);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'browser_state') {
    sendResponse({ result: getPageStateSnapshot() });
    return true;
  }

  if (msg.type === 'exploration_safe_actions') {
    sendResponse({ result: inspectSafeApiProbeCandidates() });
    return true;
  }

  if (msg.type === 'exploration_safe_probe') {
    Promise.resolve()
      .then(() => executeSafeApiProbe(msg.candidateId, msg.value))
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message ?? String(err) }));
    return true;
  }

  if (msg.type === 'browser_network') {
    Promise.resolve()
      .then(() => getRecentNetworkSnapshot())
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message ?? String(err) }));
    return true;
  }

  if (msg.type === 'browser_eval') {
    Promise.resolve()
      .then(() => runEvaluate(msg.expression))
      .then(result => sendResponse({ result }))
      .catch(err => sendResponse({ error: err.message ?? String(err) }));
    return true;
  }

  // Service Worker 查询 trace 日志
  if (msg.type === "get_trace_logs") {
    sendResponse({ logs: traceLogs.get(msg.traceID) || [] });
    return true;
  }

  if (msg.type !== "call_tool") return;

  const { toolName, args } = msg;
  const traceID = msg.traceID || null;
  const tracePrefix = traceID ? `[${traceID}] ` : '';
  const handler = handlers.get(toolName);

  if (!handler) {
    // Tool not found — adapter may still be injecting after page navigation.
    // Poll for up to 8 seconds before giving up.
    console.log(`${tracePrefix}[WebMCP] call_tool: ${toolName} — handler not ready, polling...`);
    traceLog(traceID, `[ContentScript] call_tool: ${toolName} — handler 未就绪，等待中`);
    const deadline = Date.now() + 8000;
    const poll = () => {
      const h = handlers.get(toolName);
      if (h) {
        console.log(`${tracePrefix}[WebMCP] call_tool: ${toolName} — handler found, executing`);
        traceLog(traceID, `[ContentScript] call_tool: ${toolName} — handler 已找到，开始执行`);
        Promise.resolve()
          .then(() => runHandlerWithTrace(h, args, traceID, msg.continuation))
          .then(result => { sendResponse({ result: JSON.parse(JSON.stringify(result ?? null)) }); })
          .catch(err => { sendResponse({ error: err.message ?? String(err), ...errorResponseFields(err) }); });
        return;
      }
      if (Date.now() >= deadline) {
        console.error(`${tracePrefix}[WebMCP] call_tool: ${toolName} — handler not found after 8s`);
        traceLog(traceID, `[ContentScript] call_tool: ${toolName} — 等待 8 秒后仍未找到 handler`);
        // 附带当前页面实际可用的工具名，便于上层（LLM）纠正幻觉/拼写错误
        const available = toolDefs.map(t => t.name);
        // 区分两种情况：本站有工具只是名字写错(幻觉/拼写) vs 本站完全无工具(页面未加载/域名无 adapter)。
        // 前者必须明示"这是工具名错误、重开页面无效、请改用清单内工具"——否则 LLM 会把
        // "not found in this page" 误判为页面加载问题而反复 open_browser 重试(实测发生过)。
        const suffix = available.length
          ? ` — 这是工具名错误(非页面加载问题，重开页面/open_browser 无效)，请改用本站已注册的工具之一: [${available.join(', ')}]`
          : ' (no tools registered on this page — 可能页面尚未加载完成或域名无 adapter)';
        sendResponse({ error: `Tool "${toolName}" not found in this page${suffix}` });
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
    return true;
  }

  console.log(`${tracePrefix}[WebMCP] call_tool: ${toolName} — executing`);
  traceLog(traceID, `[ContentScript] call_tool: ${toolName} — 开始执行`);
  Promise.resolve()
    .then(() => runHandlerWithTrace(handler, args, traceID, msg.continuation))
    .then(result => {
      console.log(`${tracePrefix}[WebMCP] call_tool completed: ${toolName}`);
      traceLog(traceID, `[ContentScript] call_tool 完成: ${toolName}`);
      sendResponse({ result: JSON.parse(JSON.stringify(result ?? null)) });
    })
    .catch(err => {
      console.error(`${tracePrefix}[WebMCP] call_tool error: ${toolName} — ${err.message}`);
      traceLog(traceID, `[ContentScript] call_tool 错误: ${toolName} — ${err.message}`);
      sendResponse({ error: err.message ?? String(err), ...errorResponseFields(err) });
    });

  return true;
});

// ─── bfcache 恢复处理 ──────────────────────────────────────────────────────
// 当页面从 bfcache（后退/前进缓存）恢复时，Chrome 会解冻页面并触发 pageshow
// 事件（event.persisted === true）。此时消息通道已恢复，需要重新向 Service Worker
// 注册工具，确保 toolRegistry 中该 tab 的工具注册信息是最新的。

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    console.log("[WebMCP] Page restored from bfcache, re-registering tools...");
    if (toolDefs.length > 0) {
      chrome.runtime.sendMessage({ type: "register_tools", tools: toolDefs });
    }
    // 重新恢复网络监控（PerformanceObserver 在 bfcache 解冻后可能停止）
    if (!networkObserverStarted && window.location.hostname) {
      setupNetworkObserver();
    }
  }
});

// 页面即将进入 bfcache 时，预留清理机会（可选，目前无需特殊处理）
window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    console.log("[WebMCP] Page entering bfcache, connection will be frozen");
  }
});

} // end of __webmcpInjectorLoaded guard
