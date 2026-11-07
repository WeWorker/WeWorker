const adapterId = new URLSearchParams(window.location.search).get("adapterId") || "";
const handlers = new Map();
let activeRoute = null;
let activeTraceID = null;

function structuredError(err) {
  return {
    code: err?.code || "DIRECT_FRAME_ERROR",
    message: err?.message || String(err),
    ...(err?.details ? { details: err.details } : {}),
  };
}

function createRuntimeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requireConfirmation(args = {}, toolName = "this command") {
  return true; // Deprecated compatibility helper.
}

function isMissingArg(value) {
  return value === undefined || value === null || value === "";
}

function normalizeArgsForSchema(args = {}, schema = {}) {
  if (!schema || schema.type !== "object") return args || {};
  const result = { ...(args || {}) };
  delete result.__confirmed;
  const properties = schema.properties || {};
  for (const [name, definition] of Object.entries(properties)) {
    if (name === '__confirmed') continue;
    const value = result[name];
    if (definition?.type === "integer" && typeof value === "string" && value.trim() !== "") {
      const numberValue = Number(value.trim());
      if (Number.isInteger(numberValue)) result[name] = numberValue;
    }
    if (definition?.type === "array" && definition?.items?.type === "integer" && typeof value === "string") {
      const parts = value.split(",").map(part => part.trim()).filter(Boolean);
      const numberValues = parts.map(part => Number(part));
      if (parts.length > 0 && numberValues.every(Number.isInteger)) result[name] = numberValues;
    }
  }
  return result;
}

function validateValueType(name, value, definition = {}) {
  const type = definition.type;
  const ok = type === "array" ? Array.isArray(value)
    : type === "integer" ? Number.isInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "boolean" ? typeof value === "boolean"
    : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
    : type === "string" ? typeof value === "string"
    : true;
  if (!ok) {
    throw createRuntimeError("INVALID_ARGS", `Invalid type for argument ${name}: expected ${type}`, { argument: name, expected: type });
  }
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    throw createRuntimeError("INVALID_ARGS", `Invalid value for argument ${name}`, { argument: name, allowed: definition.enum });
  }
}

function validateArgs(args = {}, schema = {}) {
  if (!schema || schema.type !== "object") return args || {};
  let result = { ...(args || {}) };
  delete result.__confirmed;
  const properties = schema.properties || {};
  const required = schema.required || [];
  const controlArgs = new Set(["__confirmed", "dry-run"]);

  for (const [name, definition] of Object.entries(properties)) {
    if (name === '__confirmed') continue;
    if (!(name in result) && Object.prototype.hasOwnProperty.call(definition, "default")) {
      result[name] = definition.default;
    }
  }
  result = normalizeArgsForSchema(result, schema);
  for (const name of required) {
    if (name === '__confirmed') continue;
    if (isMissingArg(result[name])) {
      throw createRuntimeError("INVALID_ARGS", `Missing required argument: ${name}`, { argument: name });
    }
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(result)) {
      if (!(name in properties) && !controlArgs.has(name)) {
        throw createRuntimeError("INVALID_ARGS", `Unknown argument: ${name}`, { argument: name });
      }
    }
  }
  for (const [name, definition] of Object.entries(properties)) {
    if (name === '__confirmed') continue;
    if (isMissingArg(result[name])) continue;
    validateValueType(name, result[name], definition);
  }
  return result;
}

async function requestPrivileged(action, payload = {}) {
  if (!activeRoute) {
    throw createRuntimeError("NO_DIRECT_ROUTE", "Direct runtime request has no route context", { action });
  }
  const response = await chrome.runtime.sendMessage({
    type: "wecli_direct_runtime_request",
    route: activeRoute,
    action,
    payload,
    traceID: activeTraceID,
  });
  if (!response?.ok) {
    const error = response?.error || {};
    throw createRuntimeError(error.code || "RUNTIME_HELPER_ERROR", error.message || error || "Runtime helper failed", error.details || {});
  }
  return response.result;
}

async function fetchJson(input, init = {}) {
  const response = await requestPrivileged("backend_fetch", {
    url: String(input),
    options: {
      method: init.method || "GET",
      headers: {
        Accept: "application/json",
        ...(init.headers || {}),
      },
      body: init.body,
    },
  });
  const contentType = response?.headers?.["content-type"] || response?.headers?.["Content-Type"] || "";
  const text = response?.body ?? "";
  let body = text;
  if (String(contentType).includes("json") || (typeof text === "string" && /^[\[{]/.test(text.trim()))) {
    try {
      body = JSON.parse(text);
    } catch { }
  }
  if (!response?.ok) {
    throw createRuntimeError("HTTP_ERROR", `HTTP ${response?.status}`, { status: response?.status, body });
  }
  return body;
}

window.__webmcpWecliRuntime = {
  createRuntimeError,
  validateArgs,
  requireConfirmation,
  fetchJson,
  requestPrivileged,
  getContext: () => activeRoute ? { ...activeRoute, traceID: activeTraceID } : null,
  setFileInput: (selector, files) => requestPrivileged("set_file_input", { selector, files }),
};

window.__webmcpRegister = function registerDirectAdapter(adapter) {
  for (const tool of adapter?.tools || []) {
    if (typeof tool?.handler !== "function") continue;
    const handlerName = tool.handlerName || tool.name;
    if (handlerName) handlers.set(handlerName, tool.handler);
  }
};

function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const url = chrome.runtime.getURL(path);
    script.src = `${url}${url.includes("?") ? "&" : "?"}webcli_direct_script=${Date.now()}`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${path}`));
    document.head.appendChild(script);
  });
}

async function loadAdapter() {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(adapterId)) {
    throw new Error(`Invalid adapter id: ${adapterId}`);
  }
  const manifestUrl = chrome.runtime.getURL(`adapters/${adapterId}/manifest.json`);
  let supportFiles = [];
  try {
    const resp = await fetch(manifestUrl);
    if (resp.ok) {
      const manifest = await resp.json();
      supportFiles = Array.isArray(manifest.supportFiles)
        ? manifest.supportFiles
        : Array.isArray(manifest.support_files)
          ? manifest.support_files
          : [];
    }
  } catch {
    supportFiles = [];
  }
  for (const file of supportFiles) {
    const normalized = String(file || "").trim().replace(/^\/+/, "");
    if (!normalized || normalized.includes("..") || normalized.startsWith("adapters/")) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(normalized)) continue;
    await loadScript(`adapters/${adapterId}/${normalized}`);
  }
  await loadScript(`adapters/${adapterId}/index.js`);
}

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== chrome.runtime.getURL("").slice(0, -1)) return;
  const msg = event.data || {};
  if (msg.type !== "wecli_direct_frame_call_tool") return;
  const handler = handlers.get(msg.handlerName);
  if (!handler) {
    parent.postMessage({
      type: "wecli_direct_frame_call_result",
      id: msg.id,
      ok: false,
      error: structuredError(new Error(`Tool "${msg.handlerName}" not found in direct adapter ${adapterId}`)),
    }, chrome.runtime.getURL("").slice(0, -1));
    return;
  }
  activeRoute = msg.route || null;
  activeTraceID = msg.traceID || null;
  Promise.resolve()
    .then(() => handler(msg.args || {}))
    .then((result) => {
      parent.postMessage({
        type: "wecli_direct_frame_call_result",
        id: msg.id,
        ok: true,
        result: JSON.parse(JSON.stringify(result ?? null)),
      }, chrome.runtime.getURL("").slice(0, -1));
    })
    .catch((err) => {
      parent.postMessage({
        type: "wecli_direct_frame_call_result",
        id: msg.id,
        ok: false,
        error: structuredError(err),
      }, chrome.runtime.getURL("").slice(0, -1));
    })
    .finally(() => {
      activeRoute = null;
      activeTraceID = null;
    });
});

loadAdapter()
  .then(() => {
    parent.postMessage({ type: "wecli_direct_frame_ready", adapterId }, chrome.runtime.getURL("").slice(0, -1));
  })
  .catch((err) => {
    parent.postMessage({
      type: "wecli_direct_frame_load_error",
      adapterId,
      error: err?.message || String(err),
    }, chrome.runtime.getURL("").slice(0, -1));
  });
