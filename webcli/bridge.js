/**
 * WebSocket Bridge
 *
 * 本地 WebSocket server，作为 webcli 和浏览器扩展之间的通信通道。
 *
 * 架构：
 *   webcli call / service ---> ws://localhost:3711 <--- Chrome Extension (service worker)
 */

import { WebSocketServer } from "ws";
import { EventEmitter } from "events";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import XLSX from "xlsx";
import { resolveAdaptersDir, resolveAdapterPaths, resolveUserAdaptersDir } from "./paths.js";
import { watchAdapterState } from './adapter-state-watch.js';
import { describeAdapterCatalog, readAdapterBundle, resolveAdapterCall } from './adapter-host.js';
import { reportMetric, buildUploadConfig } from "./metrics.js";
import {
  assertAllowedOpenBrowserUrl,
  buildAllowedOpenBrowserOrigins,
  loadAdapterManifests,
} from "./open-browser-policy.js";
import { isAllowedBridgeOrigin, isBrowserExtensionOrigin } from "./websocket-origin-policy.js";
import {
  analyzeActionCaptureResult,
  resolveActionCaptureModelConfig,
  analyzeExplorationResult,
  getAiConfigPath,
  readAiConfig,
  saveAiConfig,
  testAiConfig,
} from "./ai-analyzer.js";
import { resolveToolCallTimeout } from "./tool-timeouts.js";
import { GenerationWorkerController } from './generation-worker-controller.js';
import { buildApiSourceEvidence, normalizeRequestBodyEvidence, normalizeResponseBodyEvidence } from './generation-harness/source-evidence.js';
import { buildPreviousFailureContext } from './generation-harness/failure-attribution.js';
import { modelOutputErrorDetails } from './generation-harness/model-output-policy.js';

const execFileAsync = promisify(execFile);
const WS_PORT = 3711;
const SAFE_ADAPTER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_ADAPTER_WRITE_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const ADAPTER_ROOT_WRITABLE_FILES = new Set([
  'index.js',
  'manifest.json',
  'SKILL.md',
  'SKILL.generated.md',
  'WEBCLI_KNOWLEDGE.md',
  'WEBCLI_KNOWLEDGE.json',
]);
const GENERATED_WRITABLE_FILE_RE = /^webcli-generated\/[a-zA-Z0-9._/-]+\.(?:js|json|md|txt)$/;
const API_REPLAY_BODY_LIMIT = 2 * 1024 * 1024;
const API_REPLAY_TIMEOUT_MS = 30000;
const API_REPLAY_CURL_BODY_LIMIT = 8 * 1024 * 1024;
const API_REPLAY_ALLOWED_HEADER_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;
const API_REPLAY_BLOCKED_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

const TRACE_PREVIEW_LIMIT = 3000;
const TRACE_RESPONSE_PREVIEW_LIMIT = 5000;
const SENSITIVE_HEADER_OR_FIELD = /cookie|authorization|token|ticket|session|password|passwd|secret|csrf|credential/i;

function truncateTraceText(value, limit = TRACE_PREVIEW_LIMIT) {
  const text = value == null ? '' : String(value);
  return text.length > limit ? `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]` : text;
}

function sanitizeTraceValue(value, key = '') {
  if (value == null) return value;
  if (SENSITIVE_HEADER_OR_FIELD.test(String(key))) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text ? `[redacted length=${text.length}]` : '';
  }
  if (typeof value === 'string') return truncateTraceText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item, key));
  if (isPlainObject(value)) {
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

function writeTrace(traceID, message) {
  if (!traceID) return;
  process.stderr.write(`[${ts()}] [${traceID}] ${message}\n`);
}

export async function handleBackendRuntimeFetch(payload = {}, traceID = null) {
  const url = String(payload.url || '');
  if (!url) throw new Error('url is required');
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are allowed');
  }

  const requestOptions = isPlainObject(payload.options) ? payload.options : payload;
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const headers = isPlainObject(requestOptions.headers) ? requestOptions.headers : undefined;
  const requestBody = requestOptions.bodyEncoding === 'base64'
    ? Buffer.from(String(requestOptions.body || ''), 'base64')
    : requestOptions.body != null ? String(requestOptions.body) : undefined;
  writeTrace(traceID, `[BridgeRuntime] backend_fetch request ${JSON.stringify({
    method,
    url,
    headers: sanitizeTraceValue(headers || {}),
    body: payload.redactBodyInTrace === true ? '[redacted]' : summarizeTraceBody(requestOptions.body, requestOptions.bodyEncoding),
  })}`);
  const replay = await performApiReplayRequest({
    url,
    method,
    headers,
    body: requestBody,
    redirect: requestOptions.redirect,
    timeoutMs: requestOptions.timeoutMs,
    responseEncoding: requestOptions.responseEncoding,
    maxResponseBytes: requestOptions.maxResponseBytes,
  });
  if (!replay.ok || !replay.response) {
    const error = replay.error || 'backend fetch failed';
    writeTrace(traceID, `[BridgeRuntime] backend_fetch error ${error}`);
    throw new Error(`Backend fetch failed: ${url} (${error})`);
  }
  const response = replay.response;
  const responseBody = response.body ?? '';
  const responseHeaders = response.headers || {};
  writeTrace(traceID, `[BridgeRuntime] backend_fetch response ${JSON.stringify({
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: sanitizeTraceValue(responseHeaders),
    body: payload.redactBodyInTrace === true ? '[redacted]' : summarizeTraceBody(responseBody, response.bodyEncoding, TRACE_RESPONSE_PREVIEW_LIMIT),
    transport: response.replay?.transport || '',
  })}`);
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: responseHeaders,
    body: responseBody,
    ...(response.bodyEncoding ? { bodyEncoding: response.bodyEncoding, size: response.size } : {}),
    url: response.url || url,
    redirected: Boolean(response.redirected),
    replay: response.replay,
  };
}

function formatBackendFetchError(url, error) {
  const cause = error?.cause || error;
  const code = cause?.code || error?.code || '';
  const message = cause?.message || error?.message || String(error);
  const detail = code ? `${code}: ${message}` : message;
  return `Backend fetch failed: ${url} (${detail})`;
}

export async function handleBackendRuntimeFileRead(payload = {}) {
  const filePath = resolveRequiredFilePath(payload.path);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`path is not a file: ${filePath}`);
  const maxBytes = Number(payload.maxBytes || 50 * 1024 * 1024);
  if (stat.size > maxBytes) throw new Error(`file is too large: ${stat.size} bytes`);
  const encoding = payload.encoding === 'base64' ? 'base64' : 'utf8';
  const buffer = fs.readFileSync(filePath);
  return {
    path: filePath,
    encoding,
    content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
    size: buffer.length,
    ...(payload.hash === 'md5' ? { md5: createHash('md5').update(buffer).digest('hex') } : {}),
  };
}

export async function handleBackendRuntimeXlsxRead(payload = {}) {
  const filePath = resolveRequiredFilePath(payload.path);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`path is not a file: ${filePath}`);
  const maxBytes = Number(payload.maxBytes || 20 * 1024 * 1024);
  if (stat.size > maxBytes) throw new Error(`file is too large: ${stat.size} bytes`);

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = payload.sheet || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) {
    throw new Error(`worksheet not found: ${sheetName || '<first>'}`);
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: '',
    raw: false,
  });
  return { path: filePath, sheetName, rows, size: stat.size };
}

export async function handleBackendRuntimeFileWrite(payload = {}) {
  const filePath = resolveRequiredFilePath(payload.path);
  const encoding = payload.encoding === 'base64' ? 'base64' : 'utf8';
  const content = String(payload.content ?? '');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, encoding);
  const buffer = fs.readFileSync(filePath);
  return {
    path: filePath,
    size: buffer.length,
  };
}

function resolveRequiredFilePath(value) {
  if (!value || typeof value !== 'string') throw new Error('path is required');
  return path.resolve(value);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAdapterWriteFilename(filename) {
  const normalized = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || !SAFE_ADAPTER_WRITE_FILE_RE.test(normalized)) {
    throw new Error(`Invalid adapter filename: ${filename}`);
  }
  if (ADAPTER_ROOT_WRITABLE_FILES.has(normalized)) return normalized;
  if (GENERATED_WRITABLE_FILE_RE.test(normalized)) return normalized;
  throw new Error(`Adapter file is not writable from extension: ${normalized}`);
}

function normalizeReplayHeaders(headers = {}) {
  const result = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return result;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || '').trim();
    const lowerName = name.toLowerCase();
    if (!name || !API_REPLAY_ALLOWED_HEADER_RE.test(name) || API_REPLAY_BLOCKED_HEADERS.has(lowerName)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return result;
}

function normalizeReplayRequest(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('api replay request must be an object');
  }

  const url = new URL(String(request.url || ''));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported api replay protocol: ${url.protocol}`);
  }

  const method = String(request.method || 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error(`Invalid api replay method: ${request.method}`);
  }

  const body = request.body === undefined || request.body === null
    ? undefined
    : Buffer.isBuffer(request.body) ? request.body : String(request.body);
  const bodySize = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body || '', 'utf8');
  if (body !== undefined && bodySize > API_REPLAY_BODY_LIMIT) {
    throw new Error(`api replay body exceeds ${API_REPLAY_BODY_LIMIT} bytes`);
  }

  const responseEncoding = request.responseEncoding ?? 'utf8';
  if (!['utf8', 'base64'].includes(responseEncoding)) throw new Error('Unsupported responseEncoding');
  const maxResponseBytes = request.maxResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 50 * 1024 * 1024) throw new Error('maxResponseBytes must be an integer from 1 to 52428800');
  return {
    responseEncoding, maxResponseBytes,
    url: url.toString(),
    method,
    headers: normalizeReplayHeaders(request.headers),
    body,
    redirect: request.redirect === 'manual' ? 'manual' : 'follow',
    timeoutMs: Math.max(1000, Math.min(Number(request.timeoutMs || API_REPLAY_TIMEOUT_MS), 120000)),
  };
}

export async function performApiReplayRequest(request = {}, options = {}) {
  const normalized = normalizeReplayRequest(request);
  const fetchResult = await performApiReplayRequestViaFetch(normalized, options.fetchImpl || fetch);
  if (fetchResult.ok || fetchResult.retryable === false) return fetchResult;

  const curlResult = await performApiReplayRequestViaCurl(normalized, fetchResult.error);
  if (curlResult.ok) return curlResult;

  return {
    ok: false,
    error: curlResult.error || fetchResult.error || 'api replay request failed',
    detail: {
      fetchError: fetchResult.error || '',
      curlError: curlResult.error || '',
    },
  };
}

async function performApiReplayRequestViaFetch(normalized, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalized.timeoutMs);

  try {
    const response = await fetchImpl(normalized.url, {
      method: normalized.method,
      headers: normalized.headers,
      body: ['GET', 'HEAD'].includes(normalized.method) ? undefined : normalized.body,
      redirect: normalized.redirect,
      signal: controller.signal,
    });
    let binary;
    if (normalized.responseEncoding === 'base64') {
      const declared = Number(response.headers.get('content-length'));
      const tooLarge = () => Object.assign(new Error('Binary response exceeds maxResponseBytes'), { code: 'RESPONSE_TOO_LARGE' });
      if (declared > normalized.maxResponseBytes) { await response.body?.cancel(); throw tooLarge(); }
      const chunks = []; let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) { const {done,value} = await reader.read(); if(done)break; size += value.byteLength; if(size > normalized.maxResponseBytes){await reader.cancel();throw tooLarge();} chunks.push(Buffer.from(value)); } }
        finally { reader.releaseLock(); }
      }
      binary = Buffer.concat(chunks);
    }
    const text = binary ? binary.toString('base64') : await response.text();
    return {
      ok: true,
      response: {
        url: response.url || normalized.url,
        status: response.status,
        statusText: response.statusText || '',
        redirected: Boolean(response.redirected),
        headers: Object.fromEntries(response.headers.entries()),
        body: text,
        ...(binary ? { bodyEncoding: 'base64', size: binary.length } : {}),
        replay: { transport: 'node-fetch' },
      },
    };
  } catch (err) {
    return {
      ok: false,
      ...(err?.code === 'RESPONSE_TOO_LARGE' ? { retryable: false } : {}),
      error: err?.name === 'AbortError'
        ? `api replay timeout after ${normalized.timeoutMs}ms`
        : formatReplayError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatReplayError(err) {
  const message = err?.message || String(err);
  const cause = err?.cause;
  const causeCode = cause?.code || cause?.name || '';
  const causeMessage = cause?.message || '';
  if (causeCode || causeMessage) {
    return [message, causeCode, causeMessage].filter(Boolean).join(' — ');
  }
  return message;
}

async function performApiReplayRequestViaCurl(normalized, fetchError = '') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-api-replay-'));
  const configPath = path.join(tempDir, 'curl.conf');
  const bodyInPath = path.join(tempDir, 'request-body.bin');
  const bodyOutPath = path.join(tempDir, 'response-body.bin');
  const headerOutPath = path.join(tempDir, 'response-headers.txt');
  try {
    const configLines = [
      'silent',
      'show-error',
      ...(normalized.redirect === 'follow' ? ['location'] : []),
      'ssl-no-revoke',
      ...(normalized.responseEncoding === 'base64' ? [`max-filesize = ${normalized.maxResponseBytes}`] : []),
      `max-time = ${Math.ceil(normalized.timeoutMs / 1000)}`,
      `request = "${escapeCurlConfigValue(normalized.method)}"`,
      `url = "${escapeCurlConfigValue(normalized.url)}"`,
      `output = "${escapeCurlConfigValue(bodyOutPath)}"`,
      `dump-header = "${escapeCurlConfigValue(headerOutPath)}"`,
      'write-out = "\\n%{http_code}\\n%{url_effective}\\n"',
    ];

    for (const [name, value] of Object.entries(normalized.headers || {})) {
      configLines.push(`header = "${escapeCurlConfigValue(`${name}: ${value}`)}"`);
    }

    if (normalized.body !== undefined && !['GET', 'HEAD'].includes(normalized.method)) {
      fs.writeFileSync(bodyInPath, normalized.body);
      configLines.push(`data-binary = @${escapeCurlConfigValue(bodyInPath)}`);
    }

    fs.writeFileSync(configPath, `${configLines.join('\n')}\n`, { mode: 0o600 });
    const { stdout } = await execFileAsync('curl', ['--config', configPath], {
      windowsHide: true,
      maxBuffer: API_REPLAY_CURL_BODY_LIMIT,
    });
    const outputLines = String(stdout || '').trim().split(/\r?\n/);
    const status = Number(outputLines[outputLines.length - 2] || 0);
    const finalUrl = outputLines[outputLines.length - 1] || normalized.url;
    const binaryMode = normalized.responseEncoding === 'base64';
    if (binaryMode && fs.existsSync(bodyOutPath) && fs.statSync(bodyOutPath).size > normalized.maxResponseBytes) throw new Error('Binary response exceeds maxResponseBytes');
    const responseBytes = fs.existsSync(bodyOutPath) ? fs.readFileSync(bodyOutPath) : Buffer.alloc(0);
    const body = responseBytes.toString(binaryMode ? 'base64' : 'utf8');
    const rawHeaders = fs.existsSync(headerOutPath) ? fs.readFileSync(headerOutPath, 'utf8') : '';
    return {
      ok: true,
      response: {
        url: finalUrl,
        status,
        statusText: '',
        redirected: finalUrl !== normalized.url,
        headers: parseCurlResponseHeaders(rawHeaders),
        body,
        ...(binaryMode ? { bodyEncoding: 'base64', size: responseBytes.length } : {}),
        replay: {
          transport: 'curl',
          fetchError,
        },
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: formatReplayError(err),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function escapeCurlConfigValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseCurlResponseHeaders(rawHeaders) {
  const blocks = String(rawHeaders || '').trim().split(/\r?\n\r?\n/).filter(Boolean);
  const latest = blocks[blocks.length - 1] || '';
  const headers = {};
  for (const line of latest.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!name) continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

export class WebSocketBridge extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this._pendingRequests = new Map();
    this._requestCounter = 0;

    /** @type {Set<import('ws').WebSocket>} 所有连接的客户端 */
    this._clients = new Set();

    /** @type {import('ws').WebSocket | null} Chrome扩展的连接 */
    this._extensionWs = null;
    /** @type {string | null} Chrome扩展的版本号 */
    this._extensionVersion = null;
    /** @type {string[]} Chrome扩展声明的增量能力 */
    this._extensionCapabilities = [];
    /** @type {string | null} Chrome扩展连接的 Origin */
    this._extensionOrigin = null;
    // Credentials stay in this process, never in extension messages or capture data.
    this._captureModelContexts = new Map();
    this._generationWorkers = new GenerationWorkerController({
      requestExtension: (message, timeout) => this._request(message, timeout),
    });
    this._generationWorkers.on('event', (event, snapshot) => {
      this._broadcast({
        type: 'generation_run_event',
        runId: event.runId,
        event,
        run: snapshot,
      });
    });
    this._adapterStateWatcher = null;
    try {
      this._adapterStateWatcher = watchAdapterState(resolveAdapterPaths(), (event) => {
        this._handleAdapterStateEvent(event);
      }, {
        onError: (error) => process.stderr.write(`[${ts()}] [Bridge] Adapter state watch failed: ${error.message}\n`),
      });
    } catch (error) {
      process.stderr.write(`[${ts()}] [Bridge] Adapter state watcher unavailable: ${error.message}\n`);
    }
    this._startServer();

    // 埋点上报配置：由 init() 异步构造（含 whoami / clientId），未完成前 reportMetric 静默跳过
    this._metricsCfg = null;
  }

  /**
   * 异步初始化埋点上报配置（whoami / clientId / 版本号）。
   * 必须在 new WebSocketBridge() 之后 await 一次；未调用则不上报（不影响主流程）。
   * @param {{ webcliVersion?: string }} [opts]
   */
  _adapterStateSnapshot() {
    const snapshot = this._adapterStateWatcher?.snapshot?.();
    return snapshot ? { ...snapshot, type: 'adapter_state_changed' } : null;
  }

  _sendAdapterStateSnapshot(ws) {
    const snapshot = this._adapterStateSnapshot();
    if (!snapshot) return false;
    try { ws.send(JSON.stringify(snapshot)); return true; }
    catch (error) {
      process.stderr.write(`[${ts()}] [Bridge] Failed to send Adapter state snapshot: ${error.message}\n`);
      return false;
    }
  }

  _handleAdapterStateEvent(event) {
    this._broadcast({ ...event, type: 'adapter_state_changed' });
  }
  stopAdapterStateWatcher() {
    this._adapterStateWatcher?.stop();
    this._adapterStateWatcher = null;
  }
  async init(opts = {}) {
    try {
      this._metricsCfg = await buildUploadConfig({
        webcliVersion: opts.webcliVersion ?? "unknown",
      });
      if (this._metricsCfg.endpoint) {
        process.stderr.write(`[Bridge] Metrics upload enabled → ${this._metricsCfg.endpoint}\n`);
      }
    } catch {
      /* 上报初始化失败不影响服务 */
    }
    return this;
  }

  // ─── WebSocket Server ───────────────────────────────────────────────────────

  _startServer() {
    try {
      this._wss = new WebSocketServer({ port: WS_PORT });

      this._wss.on("connection", (ws, req) => {
        const origin = req?.headers?.origin;
        if (!isAllowedBridgeOrigin(origin)) {
          process.stderr.write(`[${ts()}] [Bridge] Rejected WebSocket origin: ${origin}\n`);
          ws.close(1008, "Forbidden origin");
          return;
        }
        const connectionId = Date.now();
        process.stderr.write(`[${ts()}] [Bridge] New connection #${connectionId}\n`);

        // 添加到客户端集合
        this._clients.add(ws);

        // New long-lived consumers may have missed revisions while disconnected.
        // Send one idempotent sync snapshot after the client completes its hello.
        let stateSyncSent = false;
        const sendInitialState = () => {
          if (stateSyncSent) return;
          stateSyncSent = this._sendAdapterStateSnapshot(ws);
        };
        const stateSyncTimer = setTimeout(sendInitialState, 500);
        stateSyncTimer.unref?.();
        ws.on('close', () => clearTimeout(stateSyncTimer));

        ws.on("message", (data) => {
          try {
            let msg;
            try { msg = JSON.parse(data.toString()); } catch (e) {
              process.stderr.write(`[${ts()}] [Bridge] Failed to parse message: ${e.message}\n`);
              return;
            }

            // 如果是extension_hello消息，说明这是Chrome扩展
            if (msg.type === 'extension_hello') {
              const wasConnected = this._extensionWs !== null;
              this._extensionWs = ws;
              if (msg.version) this._extensionVersion = msg.version;
              this._extensionCapabilities = Array.isArray(msg.capabilities)
                ? [...new Set(msg.capabilities.filter((item) => typeof item === 'string' && item.trim()))]
                : [];
              process.stderr.write(`[${ts()}] [Bridge] Identified Chrome extension connection #${connectionId}${msg.version ? ` (v${msg.version})` : ''}\n`);
              try {
                ws.send(JSON.stringify({ type: 'extension_hello_ack', ts: Date.now(), capabilities: ['adapter_catalog_v1'] }));
              } catch (e) {
                process.stderr.write(`[${ts()}] [Bridge] Failed to ack extension hello: ${e.message}\n`);
              }
              sendInitialState();
              // 如果这是扩展首次被识别（之前未连接），通知所有其他客户端
              if (!wasConnected) {
                this._broadcast({
                  type: 'extension_connected',
                  version: this._extensionVersion,
                  capabilities: this._extensionCapabilities,
                });
              }
            }

            // 根据消息类型判断来源并处理
            if (msg.type === 'extension_hello' || msg.type === 'call_tool_result' || msg.type === 'call_tool_error' || msg.type === 'get_active_tab_result' || msg.type === 'get_trace_logs_result' || msg.type === 'validate_generation_preview_result') {
              // 来自Chrome扩展的消息
              this._handleExtensionMessage(msg);
            } else if (msg.type === 'write_adapter_file') {
              // 来自扩展的文件写入请求
              this._handleWriteAdapterFile(msg, ws);
            } else if (msg.type === 'wecli_backend_fetch' || msg.type === 'wecli_backend_file_read' || msg.type === 'wecli_backend_xlsx_read' || msg.type === 'wecli_backend_file_write') {
              this._handleWecliBackendRuntimeRequest(msg, ws);
            } else if (msg.type === 'adapter_catalog' || msg.type === 'adapter_bundle') {
              this._handleAdapterSnapshot(msg, ws);
            } else if (msg.type === 'list_user_adapters') {
              this._handleListUserAdapters(msg, ws);
            } else if (msg.type === 'list_user_adapter_files') {
              this._handleListUserAdapterFiles(msg, ws);
            } else if (msg.type === 'read_user_adapter') {
              this._handleReadUserAdapter(msg, ws);
            } else if (msg.type === 'generate_adapter_scaffold') {
              // 来自扩展的 scaffold 生成请求
              this._handleGenerateAdapterScaffold(msg, ws);
            } else if (msg.type === 'get_ai_config') {
              this._handleGetAiConfig(msg, ws);
            } else if (msg.type === 'save_ai_config') {
              this._handleSaveAiConfig(msg, ws);
            } else if (msg.type === 'test_ai_config') {
              this._handleTestAiConfig(msg, ws);
            } else if (msg.type === 'analyze_action_capture_result') {
              this._handleAnalyzeActionCaptureResult(msg, ws);
            } else if (msg.type === 'analyze_exploration_result') {
              this._handleAnalyzeExplorationResult(msg, ws);
            } else if (msg.type === 'generate_adapter_with_ai') {
              // 来自扩展的 AI adapter 生成请求
              this._handleGenerateAdapterWithAI(msg, ws);
            } else if (msg.type === 'start_generation_run') {
              this._handleStartGenerationRun(msg, ws);
            } else if (msg.type === 'resume_generation_run') {
              this._handleResumeGenerationRun(msg, ws);
            } else if (msg.type === 'get_generation_run') {
              this._handleGetGenerationRun(msg, ws);
            } else if (msg.type === 'cancel_generation_run') {
              this._handleCancelGenerationRun(msg, ws);
            } else if (msg.type === 'publish_generation_run') {
              this._handlePublishGenerationRun(msg, ws);
            } else if (msg.type === 'client_action_capture_start' || msg.type === 'client_action_capture_analyze') {
              // Local-only credential-bearing request; never forward this envelope.
              this._handleClientRequest(msg);
            } else if (msg.type === 'call_tool' || msg.type === 'get_active_tab' || msg.type === 'exploration_list_tabs' || msg.type === 'exploration_capture_passive' || msg.type === 'exploration_safe_actions_inspect' || msg.type === 'exploration_safe_probe_run' || msg.type === 'exploration_replay_candidate' || msg.type === 'exploration_action_capture_start' || msg.type === 'exploration_action_capture_stop' || msg.type === 'exploration_action_capture_get' || msg.type === 'exploration_action_capture_select' || msg.type === 'exploration_action_capture_clear' || msg.type === 'refresh_adapter_tabs' || msg.type === 'open_browser' || msg.type === 'capture_screenshot' || msg.type === 'reload_extension' || msg.type === 'refresh_registry' || msg.type === 'browser_state' || msg.type === 'browser_network' || msg.type === 'browser_eval' || msg.type === 'browser_analyze' || msg.type === 'browser_explore_workflow' || msg.type === 'browser_action_capture_workflow' || msg.type === 'get_trace_logs') {
              // 来自CLI客户端的请求，需要转发给Chrome扩展或处理系统命令
              this._handleClientRequest(msg);
            } else {
              process.stderr.write(`[${ts()}] [Bridge] Unknown message type: ${msg.type}\n`);
            }
          } catch (err) {
            process.stderr.write(`[${ts()}] [Bridge] Error handling message: ${err.message}\n${err.stack}\n`);
          }
        });

        ws.on("close", () => {
          this._clients.delete(ws);
          if (this._extensionWs === ws) {
            this._clearCaptureModelContexts();
            this._extensionWs = null;
            this._extensionCapabilities = [];
            process.stderr.write(`[${ts()}] [Bridge] Chrome extension disconnected #${connectionId}\n`);
            this._broadcast({ type: 'extension_disconnected' });
          } else {
            process.stderr.write(`[${ts()}] [Bridge] Connection #${connectionId} closed\n`);
          }
        });

        ws.on("error", (err) => {
          process.stderr.write(`[${ts()}] [Bridge] Connection #${connectionId} error: ${err.message}\n`);
        });

        // 如果是新连接，通知扩展连接状态
        if (this.isExtensionConnected()) {
          ws.send(JSON.stringify({
            type: 'extension_connected',
            version: this._extensionVersion,
            capabilities: this._extensionCapabilities,
          }));
        }
      });

      this._wss.on("error", (err) => {
        if (err.code === 'EADDRINUSE') {
          process.stderr.write(`[${ts()}] [Bridge] FATAL: Port ${WS_PORT} is already in use\n`);
          process.stderr.write(`[${ts()}] [Bridge] Another instance may be running. Please stop it first.\n`);
          process.exit(1);
        }
        process.stderr.write(`[${ts()}] [Bridge] WS server error: ${err.message}\n${err.stack}\n`);
      });

      process.stderr.write(`[${ts()}] [Bridge] WebSocket server listening on ws://localhost:${WS_PORT}\n`);
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`[${ts()}] [Bridge] FATAL: Port ${WS_PORT} is already in use\n`);
        process.stderr.write(`[${ts()}] [Bridge] Another instance may be running. Please stop it first.\n`);
        process.exit(1);
      }
      process.stderr.write(`[${ts()}] [Bridge] Failed to start WebSocket server: ${err.message}\n${err.stack}\n`);
      throw err;
    }
  }

  // 广播消息给所有连接的客户端
  _broadcast(msg) {
    if (!this._wss) return;

    let msgStr;
    try {
      msgStr = JSON.stringify(msg);
    } catch (error) {
      process.stderr.write(`[${ts()}] [Bridge] Failed to serialize broadcast: ${error.message}\n`);
      return;
    }
    this._wss.clients.forEach(client => {
      if (client.readyState === 1 /* OPEN */) {
        try {
          client.send(msgStr, (error) => {
            if (error) process.stderr.write(`[${ts()}] [Bridge] Broadcast failed: ${error.message}\n`);
          });
        } catch (error) {
          process.stderr.write(`[${ts()}] [Bridge] Broadcast failed: ${error.message}\n`);
        }
      }
    });
  }

  // ─── 处理来自扩展的消息 ────────────────────────────────────────────────────

  _handleExtensionMessage(msg) {
    if (msg.type === 'call_tool_error') {
      for (const [contextId, context] of this._captureModelContexts) {
        if (context.requestId === msg.id) this._deleteCaptureModelContext(contextId);
      }
    }
    // 从 pending 请求中取出 traceID
    const pending = this._pendingRequests.get(msg.id);
    const traceID = pending?.traceID || msg.traceID || null;
    const tracePrefix = traceID ? `[${traceID}] ` : '';

    // 响应待处理请求（来自bridge自己的_request调用）
    if (pending) {
      this._pendingRequests.delete(msg.id);

      if (msg.type === "call_tool_result") {
        pending.resolve(msg.result);
      } else if (msg.type === "call_tool_error") {
        pending.reject(new Error(msg.error));
      } else if (msg.type === "list_tools_result") {
        pending.resolve(msg.tools);
      } else if (msg.type === "get_active_tab_result") {
        pending.resolve(msg.tabId);
      } else if (msg.type === 'validate_generation_preview_result') {
        if (msg.ok === false) pending.reject(new Error(msg.error || 'preview validation failed'));
        else pending.resolve(msg.result || msg);
      }
      return;
    }

    // 如果不是bridge自己的请求，广播给所有客户端（来自CLI客户端的转发请求）
    if (msg.type === "call_tool_result" || msg.type === "call_tool_error" || msg.type === "get_active_tab_result" || msg.type === "get_trace_logs_result") {
      this._broadcast(msg);
    }
  }

  // ─── 处理来自CLI客户端的请求 ─────────────────────────────────────────────────

  async _handleClientRequest(msg) {
    const traceID = msg.traceID || null;
    const tracePrefix = traceID ? `[${traceID}] ` : '';

    if (msg.type === 'call_tool') {
      const { toolName, args, id } = msg;
      process.stderr.write(`[${ts()}] ${tracePrefix}[Bridge] 收到调用: ${toolName}\n`);

      try {
        const result = await this.callTool(toolName, args, traceID, msg.adapterSnapshot);
        this._broadcast({ type: 'call_tool_result', id, result, traceID });
        process.stderr.write(`[${ts()}] ${tracePrefix}[Bridge] 调用成功: ${toolName}\n`);
      } catch (err) {
        process.stderr.write(`[${ts()}] ${tracePrefix}[Bridge] 调用失败: ${toolName} — ${err.message}\n`);
        this._broadcast({ type: 'call_tool_error', id, error: err.message, traceID });
      }
    } else if (msg.type === 'client_action_capture_start' || msg.type === 'client_action_capture_analyze' || msg.type === 'exploration_action_capture_start') {
      const { modelConfig, analysisContextId: ignoredContextId, ...captureRequest } = msg;
      let contextId;
      try {
        const retryAnalysis = msg.type === 'client_action_capture_analyze';
        captureRequest.type = retryAnalysis ? 'exploration_action_capture_analyze' : 'exploration_action_capture_start';
        if (msg.type.startsWith('client_') || Object.hasOwn(msg, 'modelConfig')) {
          if (!this._extensionCapabilities.includes(retryAnalysis ? 'action_capture_analysis_retry_v1' : 'action_capture_model_context_v1')) {
            throw new Error('请重载浏览器扩展后重试，以使用客户端模型进行动作分析');
          }
          const config = resolveActionCaptureModelConfig(modelConfig ?? null);
          if (this._captureModelContexts.size >= 64) throw new Error('动作捕获分析任务过多，请稍后重试');
          contextId = randomUUID();
          const timer = setTimeout(() => this._deleteCaptureModelContext(contextId), 10 * 60_000);
          timer.unref?.();
          this._captureModelContexts.set(contextId, {
            config, timer, requestId: msg.id,
            tabId: Number(msg.tabId), site: String(msg.siteKey || '').trim(), actionName: String(msg.actionName || '').trim(),
          });
          captureRequest.analysisContextId = contextId;
        }
        if (!this._send(captureRequest)) throw new Error('浏览器扩展未连接');
      } catch (err) {
        this._deleteCaptureModelContext(contextId);
        this._broadcast({ type: 'call_tool_error', id: msg.id, error: err.message });
      }
    } else if (msg.type === 'get_active_tab') {
      try {
        const tabId = await this.getActiveTabId();
        this._broadcast({ type: 'get_active_tab_result', id: msg.id, tabId, traceID });
      } catch (err) {
        this._broadcast({ type: 'get_active_tab_error', id: msg.id, error: err.message, traceID });
      }
    } else if (msg.type === 'open_browser') {
      try {
        const result = await this.openBrowser(msg.url);
        this._broadcast({ type: 'call_tool_result', id: msg.id, result, traceID });
      } catch (err) {
        this._broadcast({ type: 'call_tool_error', id: msg.id, error: err.message, traceID });
      }
    } else if (msg.type === 'capture_screenshot') {
      // 直接转发给Chrome扩展
      process.stderr.write('[Bridge] Forwarding capture_screenshot to Chrome extension\n');
      this._send(msg);
    } else if (msg.type === 'reload_extension') {
      process.stderr.write('[Bridge] Forwarding reload_extension to Chrome extension\n');
      this._send({ type: 'reload_extension' });
    } else if (msg.type === 'refresh_registry') {
      process.stderr.write('[Bridge] Forwarding refresh_registry to Chrome extension\n');
      this._send({ type: 'refresh_registry' });
    } else if (msg.type === 'get_trace_logs') {
      // CLI 查询扩展的 trace 日志，直接转发给扩展
      process.stderr.write(`[${ts()}] [Bridge] Forwarding get_trace_logs to extension: ${msg.traceID}\n`);
      this._send(msg);
    } else if (msg.type === 'exploration_list_tabs' || msg.type === 'exploration_capture_passive' || msg.type === 'exploration_safe_actions_inspect' || msg.type === 'exploration_safe_probe_run' || msg.type === 'exploration_replay_candidate' || msg.type === 'exploration_action_capture_stop' || msg.type === 'exploration_action_capture_get' || msg.type === 'exploration_action_capture_select' || msg.type === 'exploration_action_capture_clear' || msg.type === 'refresh_adapter_tabs' || msg.type === 'browser_state' || msg.type === 'browser_network' || msg.type === 'browser_eval' || msg.type === 'browser_analyze' || msg.type === 'browser_explore_workflow' || msg.type === 'browser_action_capture_workflow') {
      process.stderr.write(`[${ts()}] [Bridge] Forwarding ${msg.type} to Chrome extension\n`);
      this._send(msg);
    }
  }

  // ─── 处理 adapter 文件写入 ──────────────────────────────────────────────────

  _handleWriteAdapterFile(msg, ws) {
    const { id, siteKey, filename, content, manifest } = msg;
    try {
      if (!siteKey || !filename || typeof content !== 'string') {
        throw new Error('siteKey, filename, content are required');
      }
      // 安全校验：只允许插件写 adapter 代码、manifest、skill、知识包和 webcli-generated 产物。
      if (/\.\./.test(siteKey)) {
        throw new Error('Invalid siteKey: contains ".."');
      }
      if (!SAFE_ADAPTER_ID_RE.test(siteKey)) {
        throw new Error(`Invalid siteKey: ${siteKey}`);
      }
      const safeFilename = normalizeAdapterWriteFilename(filename);

      const adaptersDir = resolveAdaptersDir();
      const adapterDir = path.join(adaptersDir, siteKey);
      fs.mkdirSync(adapterDir, { recursive: true });

      const filePath = path.join(adapterDir, safeFilename);
      // 确保最终路径仍在 adapterDir 内
      if (!filePath.startsWith(`${adapterDir}${path.sep}`) && filePath !== adapterDir) {
        throw new Error('Path traversal detected');
      }

      fs.writeFileSync(filePath, content, 'utf-8');
      process.stderr.write(`[${ts()}] [Bridge] Wrote adapter file: ${filePath}\n`);

      // Write manifest.json if provided
      if (manifest) {
        const manifestPath = path.join(adapterDir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        process.stderr.write(`[${ts()}] [Bridge] Wrote manifest: ${manifestPath}\n`);
      }

      // Update index.json to register the adapter
      const indexPath = path.join(adaptersDir, 'index.json');
      let indexList = [];
      try {
        indexList = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      } catch {}
      if (!indexList.includes(siteKey)) {
        indexList.push(siteKey);
        indexList.sort();
        fs.writeFileSync(indexPath, JSON.stringify(indexList, null, 2) + '\n', 'utf-8');
        process.stderr.write(`[${ts()}] [Bridge] Added ${siteKey} to index.json\n`);
      }

      ws.send(JSON.stringify({ type: 'write_adapter_file_result', id, ok: true, filePath }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] write_adapter_file error: ${err.message}\n`);
      ws.send(JSON.stringify({ type: 'write_adapter_file_result', id, ok: false, error: err.message }));
    }
  }

  async _handleWecliBackendRuntimeRequest(msg, ws) {
    const { id, type, payload = {}, traceID = null } = msg;
    const resultType = `${type}_result`;
    try {
      const result = type === 'wecli_backend_fetch'
        ? await handleBackendRuntimeFetch(payload, traceID)
        : type === 'wecli_backend_file_read'
          ? await handleBackendRuntimeFileRead(payload)
          : type === 'wecli_backend_xlsx_read'
            ? await handleBackendRuntimeXlsxRead(payload)
            : await handleBackendRuntimeFileWrite(payload);
      ws.send(JSON.stringify({ type: resultType, id, ok: true, result, traceID }));
    } catch (err) {
      ws.send(JSON.stringify({ type: resultType, id, ok: false, error: err.message, traceID }));
    }
  }

  // ─── 用户 adapter 目录访问 ────────────────────────────────────────────────

  /**
   * 列出用户安装的 adapter（~/.weworker/adapters 或 ~/.webcli/adapters）。
   * 扩展侧据此合并内置 adapter 与用户 adapter，实现双层共存。
   */
  _handleAdapterSnapshot(msg, ws) {
    try {
      const result = msg.type === 'adapter_catalog' ? describeAdapterCatalog() : readAdapterBundle(msg.payload);
      ws.send(JSON.stringify({ type: `${msg.type}_result`, id: msg.id, ok: true, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: `${msg.type}_result`, id: msg.id, ok: false,
        code: error.code || 'ADAPTER_SNAPSHOT_ERROR', error: 'Adapter snapshot unavailable; refresh the catalog.' }));
    }
  }

  _handleListUserAdapters(msg, ws) {
    const { id, traceID = null } = msg;
    try {
      const dir = resolveUserAdaptersDir();
      let items = [];
      if (fs.existsSync(dir)) {
        items = fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && SAFE_ADAPTER_ID_RE.test(entry.name))
          .map((entry) => ({
            id: entry.name,
            dir: path.join(dir, entry.name),
            hasManifest: fs.existsSync(path.join(dir, entry.name, "manifest.json")),
            hasIndex: fs.existsSync(path.join(dir, entry.name, "index.js")),
          }));
      }
      ws.send(JSON.stringify({ type: 'list_user_adapters_result', id, ok: true, adapters: items, dir, traceID }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'list_user_adapters_result', id, ok: false, error: err.message, traceID }));
    }
  }

  /**
   * 列出用户 adapter 目录内的全部文件相对路径（v2 loader 注入序用，递归）。
   * payload: { adapterId }
   */
  _handleListUserAdapterFiles(msg, ws) {
    const { id, payload = {}, traceID = null } = msg;
    try {
      const adapterId = String(payload.adapterId || '').trim();
      if (!SAFE_ADAPTER_ID_RE.test(adapterId)) {
        throw new Error(`非法 adapter id: ${adapterId}`);
      }
      const root = resolveUserAdaptersDir();
      const adapterDir = path.join(root, adapterId);
      if (!fs.existsSync(adapterDir) || !fs.statSync(adapterDir).isDirectory()) {
        throw new Error(`用户 adapter "${adapterId}" 不存在`);
      }
      const files = [];
      const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
          else if (entry.isFile()) files.push(childRel);
        }
      };
      walk(adapterDir, '');
      if (files.length > 512) throw new Error(`文件数超限: ${files.length}`);
      ws.send(JSON.stringify({ type: 'list_user_adapter_files_result', id, ok: true, files, traceID }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'list_user_adapter_files_result', id, ok: false, error: err.message, traceID }));
    }
  }

  /**
   * 读取用户 adapter 目录内的文件内容（带白名单校验，防路径穿越）。
   * payload: { adapterId, relPath, maxBytes? }
   */
  _handleReadUserAdapter(msg, ws) {
    const { id, payload = {}, traceID = null } = msg;
    try {
      const adapterId = String(payload.adapterId || '').trim();
      const relPath = String(payload.relPath || '').trim();
      if (!SAFE_ADAPTER_ID_RE.test(adapterId)) {
        throw new Error(`非法 adapter id: ${adapterId}`);
      }
      if (!relPath || relPath.includes('..')) {
        throw new Error(`非法文件路径: ${relPath}`);
      }
      const root = resolveUserAdaptersDir();
      const adapterDir = path.join(root, adapterId);
      if (!fs.existsSync(adapterDir)) {
        throw new Error(`用户 adapter "${adapterId}" 不存在`);
      }
      const filePath = path.resolve(adapterDir, relPath);
      // 白名单校验：解析后的路径必须仍位于 adapterDir 内
      if (filePath !== path.join(adapterDir, relPath)) {
        throw new Error(`路径越界: ${relPath}`);
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`文件不存在: ${relPath}`);
      }
      const maxBytes = Number(payload.maxBytes || 10 * 1024 * 1024);
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) throw new Error(`文件过大: ${stat.size} bytes`);
      const content = fs.readFileSync(filePath, 'utf8');
      ws.send(JSON.stringify({
        type: 'read_user_adapter_result',
        id,
        ok: true,
        result: { adapterId, relPath, content, size: stat.size },
        traceID,
      }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'read_user_adapter_result', id, ok: false, error: err.message, traceID }));
    }
  }

  // ─── Scaffold 生成 ────────────────────────────────────────────────────────

  async _handleGenerateAdapterScaffold(msg, ws) {
    return this._handleStartGenerationRun({ ...msg, mode: 'quick' }, ws);
  }

  _handleGetAiConfig(msg, ws) {
    const { id } = msg;
    try {
      const configPath = getAiConfigPath();
      const exists = fs.existsSync(configPath);
      const config = readAiConfig();
      ws.send(JSON.stringify({
        type: 'get_ai_config_result',
        id,
        ok: true,
        exists,
        configPath,
        config,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] get_ai_config error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: 'get_ai_config_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  _handleSaveAiConfig(msg, ws) {
    const { id, config } = msg;
    try {
      const saved = saveAiConfig(config || {});
      ws.send(JSON.stringify({
        type: 'save_ai_config_result',
        id,
        ok: true,
        configPath: getAiConfigPath(),
        config: saved,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] save_ai_config error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: 'save_ai_config_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  async _handleTestAiConfig(msg, ws) {
    const { id, config } = msg;
    try {
      const result = await testAiConfig(config || {});
      ws.send(JSON.stringify({
        type: 'test_ai_config_result',
        id,
        ok: true,
        ...result,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] test_ai_config error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: 'test_ai_config_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  async _handleAnalyzeActionCaptureResult(msg, ws) {
    const { id, captureResult } = msg;
    try {
      let modelConfig;
      if (Object.hasOwn(msg, 'analysisContextId')) {
        const context = this._captureModelContexts.get(msg.analysisContextId);
        if (!context) throw new Error('客户端动作分析上下文已失效，请重试已有捕获的 AI 分析，无需重新操作网站');
        if (context.tabId !== captureResult?.tabId || context.site !== captureResult?.site || context.actionName !== captureResult?.actionName) {
          throw new Error('客户端动作分析上下文与捕获任务不匹配');
        }
        modelConfig = context.config;
        this._deleteCaptureModelContext(msg.analysisContextId);
      }
      const analysis = await analyzeActionCaptureResult({ captureResult, modelConfig });
      ws.send(JSON.stringify({
        type: 'analyze_action_capture_result',
        id,
        ok: true,
        analysis,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] analyze_action_capture_result error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: 'analyze_action_capture_result',
        id,
        ok: false,
        error: err.message,
        code: err.code || 'ACTION_ANALYSIS_FAILED',
        details: modelOutputErrorDetails(err.details),
      }));
    }
  }

  _deleteCaptureModelContext(contextId) {
    const context = this._captureModelContexts.get(contextId);
    if (context) clearTimeout(context.timer);
    this._captureModelContexts.delete(contextId);
  }

  _clearCaptureModelContexts() {
    for (const contextId of this._captureModelContexts.keys()) this._deleteCaptureModelContext(contextId);
  }

  async _handleAnalyzeExplorationResult(msg, ws) {
    const { id, siteKey, explorationResult, heuristicVerdict } = msg;
    try {
      const analysis = await analyzeExplorationResult({
        siteKey,
        explorationResult,
        heuristicVerdict,
      });
      ws.send(JSON.stringify({
        type: 'analyze_exploration_result',
        id,
        ok: true,
        analysis,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] analyze_exploration_result error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: 'analyze_exploration_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  // ─── AI adapter 生成 ───────────────────────────────────────────────────────

  async _handleStartGenerationRun(msg, ws) {
    const { id, siteKey, memory, goal, budget, tabId, modelConfig, previousRunId, mode } = msg;
    const responseType = msg.type === 'generate_adapter_scaffold' ? 'generate_adapter_scaffold_result'
      : msg.type === 'generate_adapter_with_ai' ? 'generate_adapter_with_ai_result' : 'start_generation_run_result';
    try {
      const normalizedMemory = normalizeSiteMemoryForScaffold(memory, siteKey);
      let previousFailure = null;
      if (previousRunId) {
        try {
          const previous = this._generationWorkers.get(String(previousRunId));
          if (previous
            && previous.siteKey === normalizedMemory.siteKey
            && ['failed', 'budget_exceeded'].includes(previous.status)) {
            previousFailure = buildPreviousFailureContext(previous);
          }
        } catch (error) {
          process.stderr.write(`[${ts()}] [Bridge] previous generation run unavailable: ${error.message}\n`);
        }
      }
      const run = await this._generationWorkers.start(
        {
          siteKey: normalizedMemory.siteKey,
          goal: String(goal || `为 ${normalizedMemory.siteKey} 生成可验证的 API Adapter`),
          input: {
            memory: normalizedMemory,
            tabId: Number.isInteger(tabId) ? tabId : null,
            ...(previousFailure ? { previousFailure } : {}),
            ...(['auto', 'agent', 'classic', 'quick'].includes(mode) ? { mode } : {}),
          },
          budget: budget || {},
        },
        modelConfig ? { modelConfig } : undefined,
      );
      ws.send(JSON.stringify({
        type: responseType,
        id,
        ok: true,
        run,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] start_generation_run error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: responseType,
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  async _handleResumeGenerationRun(msg, ws) {
    const { id, runId, answer, modelConfig } = msg;
    try {
      const run = await this._generationWorkers.resume(
        String(runId || ''),
        String(answer || ''),
        modelConfig ? { modelConfig } : {},
      );
      ws.send(JSON.stringify({
        type: 'resume_generation_run_result',
        id,
        ok: true,
        run,
      }));
    } catch (err) {
      process.stderr.write(`[${ts()}] [Bridge] resume_generation_run error: ${err.message}\n`);
      ws.send(JSON.stringify({
        type: 'resume_generation_run_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  _handleGetGenerationRun(msg, ws) {
    const { id, runId, includeTrace = false } = msg;
    try {
      const run = this._generationWorkers.get(String(runId || ''));
      if (!run) throw new Error(`generation run not found: ${runId}`);
      ws.send(JSON.stringify({
        type: 'get_generation_run_result',
        id,
        ok: true,
        run,
        ...(includeTrace ? { trace: this._generationWorkers.getTrace(runId) } : {}),
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'get_generation_run_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  async _handleCancelGenerationRun(msg, ws) {
    const { id, runId, reason } = msg;
    try {
      const run = await this._generationWorkers.cancel(
        String(runId || ''),
        String(reason || 'cancelled by user'),
      );
      if (!run) throw new Error(`generation run not found: ${runId}`);
      ws.send(JSON.stringify({
        type: 'cancel_generation_run_result',
        id,
        ok: true,
        run,
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'cancel_generation_run_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  async _handlePublishGenerationRun(msg, ws) {
    const { id, runId } = msg;
    try {
      const run = await this._generationWorkers.publish(String(runId || ''), msg.approval);
      if (run.status === 'completed') this._broadcast({ type: 'adapter_installed', siteKey: run.siteKey, digest: run.result?.digest });
      ws.send(JSON.stringify({
        type: 'publish_generation_run_result',
        id,
        ok: true,
        run,
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'publish_generation_run_result',
        id,
        ok: false,
        error: err.message,
      }));
    }
  }

  async _handleGenerateAdapterWithAI(msg, ws) {
    // The old RPC now creates the same reviewed package task as desktop generation.
    return this._handleStartGenerationRun({
      ...msg, mode: 'agent',
      memory: msg.memory || { siteKey: msg.siteKey, apiCandidates: msg.apiEntries || [] },
    }, ws);
  }

  // ─── 发送消息给扩展 ─────────────────────────────────────────────────────────  // ─── 发送消息给扩展 ─────────────────────────────────────────────────────────

  _send(msg) {
    if (!this._extensionWs || this._extensionWs.readyState !== 1 /* OPEN */) {
      process.stderr.write("[Bridge] Cannot send: Chrome extension not connected\n");
      return false;
    }
    this._extensionWs.send(JSON.stringify(msg));
    process.stderr.write(`[${ts()}] [Bridge] -> extension: ${JSON.stringify(msg).substring(0, 200)}\n`);
    return true;
  }

  _nextId() {
    return String(++this._requestCounter);
  }

  _request(msg, timeout = 120000, traceID = null) {
    const id = this._nextId();
    return new Promise((resolve, reject) => {
      this._pendingRequests.set(id, { resolve, reject, traceID });
      const msgWithId = { ...msg, id };
      if (traceID) msgWithId.traceID = traceID;
      if (!this._send(msgWithId)) {
        this._pendingRequests.delete(id);
        reject(new Error("Extension not connected"));
        return;
      }
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`Request "${msg.type}" timed out after ${timeout}ms`));
        }
      }, timeout);
    });
  }

  // ─── 公开 API ─────────────────────────────────────────────────────────────

  async getActiveTabId() {
    return this._request({ type: "get_active_tab" });
  }

  async callTool(toolName, args, traceID = null, adapterSnapshot = null) {
    if (isLegacyWecliHandlerName(toolName)) {
      throw new Error(`"${toolName}" is an internal handler name. Use the public WebCLI command name without "wecli_".`);
    }
    // 在唯一收口处包一层计时与埋点：内置工具与 adapter 工具都被覆盖。
    // 埋点只记元数据，绝不阻塞调用（reportMetric 内部 fire-and-forget 且静默失败）。
    const t0 = Date.now();
    try {
      const result = await this._callToolInner(toolName, args, traceID, adapterSnapshot);
      const transformed = this._extractQrcodeToFile(result);
      reportMetric(this._metricsCfg, toolName, true, Date.now() - t0, traceID, null);
      return transformed;
    } catch (err) {
      reportMetric(this._metricsCfg, toolName, false, Date.now() - t0, traceID, err);
      throw err;
    }
  }

  /**
   * 登录二维码落盘：adapter 返回 qrcode_base64 时，把 PNG/JPEG 写到
   * ~/.webcli/login-qrcode.<ext>，并把结果里的 base64 替换成 qrcode_file 绝对路径。
   * 避免大段 base64 进入 agent 上下文；文件路径可直接在 WeWorker 聊天中以图片渲染，
   * 也可让用户手动打开扫码。落盘失败时保留 base64 原样返回（尽力而为）。
   */
  _extractQrcodeToFile(result, targetDir = null) {
    try {
      if (!result || typeof result !== "object" || result.ok !== true) return result;

      // 优先：页面二维码元素 base64（adapter 兜底路径）
      let base64 = result.qrcode_base64;
      let mime = result.qrcode_mime || "image/png";
      let fileField = "qrcode_file";
      // 编排路径：登录页截图（jpeg）
      if (typeof base64 !== "string" || base64.length < 100) {
        if (typeof result.screenshot_base64 === "string" && result.screenshot_base64.length >= 100) {
          base64 = result.screenshot_base64;
          mime = result.screenshot_mime || "image/jpeg";
          fileField = "screenshot_file";
        } else {
          return result;
        }
      }

      const ext = mime === "image/jpeg" ? "jpg" : "png";
      const dir = targetDir || path.join(os.homedir(), ".webcli");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `login-qrcode.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));

      const { qrcode_base64, screenshot_base64, ...rest } = result;
      return { ...rest, [fileField]: filePath };
    } catch {
      return result; // 落盘失败，保留 base64 原样
    }
  }

  async _callToolInner(toolName, args, traceID = null, adapterSnapshot = null) {
    if (isLegacyWecliHandlerName(toolName)) {
      throw new Error(`"${toolName}" is an internal handler name. Use the public WebCLI command name without "wecli_".`);
    }
    // 内置工具：不经过 Chrome 扩展的 call_tool 路径，由 Bridge 直接处理
    // 这些工具没有 domain.action 格式，Chrome 扩展无法提取域名，必须在此拦截
    if (toolName === "open_browser") {
      return this.openBrowser(args?.url);
    }
    if (toolName === "capture_screenshot") {
      return this.captureScreenshot(args?.fullPage ?? false);
    }
    // 开发调试工具 — 暂不对用户开放，取消拦截后这些工具会走正常的 adapter 路径（报错"找不到域名"）
    // if (toolName === "inspect_page_state") {
    //   return this.getPageState(args?.tabId ?? null);
    // }
    // if (toolName === "inspect_network_requests") {
    //   return this.getPageNetwork(args?.tabId ?? null);
    // }
    // if (toolName === "evaluate_in_page") {
    //   return this.evaluateInPage(args?.expression, args?.tabId ?? null);
    // }
    // if (toolName === "explore_site") {
    //   return this.analyzePage(args?.tabId ?? null);
    // }
    // if (toolName === "explore_site_workflow") {
    //   return this.exploreWorkflow(args?.url ?? null, args?.tabId ?? null);
    // }

    // 下载类任务耗时较长，按工具动态放宽超时，避免误判为失败
    const selected = resolveAdapterCall(toolName);
    if (adapterSnapshot && (!selected || adapterSnapshot.name !== selected.snapshot.name
      || adapterSnapshot.digest !== selected.snapshot.digest || adapterSnapshot.profile !== selected.snapshot.profile)) {
      throw new Error('Adapter changed since this call started; refresh the catalog.');
    }
    if ((selected?.command.requires_confirmation ?? selected?.command.safety === 'write') && args?.__confirmed !== true) throw new Error('Explicit confirmation is required for this command.');
    if (selected?.command.runtime === 'wewright') {
      const { runToolkitTool } = await import('./toolkit-runner.js');
      const completed = await runToolkitTool({
        adapter: { root: selected.adapter.root, entryPath: path.join(selected.adapter.root, selected.command.module) },
        tool: { id: selected.command.id, name: toolName },
      }, args || {});
      if (completed.exitCode !== 0) throw new Error('Toolkit Adapter execution failed.');
      return completed.result;
    }
    if (selected && !this._extensionCapabilities?.includes('adapter_catalog_v1')) {
      throw new Error('Reload the browser extension before calling managed Adapter packages.');
    }
    if (selected?.command.execution?.runtime === 'background' && !this._extensionCapabilities?.includes('adapter_background_v1')) {
      throw new Error('Reload the browser extension before calling background Adapter commands.');
    }
    const timeout = resolveToolCallTimeout(toolName);
    return this._request({ type: "call_tool", toolName, args, ...(selected ? { adapterSnapshot: selected.snapshot } : {}) }, timeout, traceID);
  }

  async getPageState(tabId = null) {
    return this._request({ type: 'browser_state', tabId }, 15000);
  }

  async getPageNetwork(tabId = null) {
    return this._request({ type: 'browser_network', tabId }, 15000);
  }

  async evaluateInPage(expression, tabId = null) {
    return this._request({ type: 'browser_eval', expression, tabId }, 15000);
  }

  async analyzePage(tabId = null) {
    return this._request({ type: 'browser_analyze', tabId }, 20000);
  }

  async exploreWorkflow(url = null, tabId = null) {
    return this._request({ type: 'browser_explore_workflow', url, tabId }, 90000);
  }

  // ─── 浏览器控制 ─────────────────────────────────────────────────────────────

  /**
   * 检查Chrome扩展是否已连接
   */
  isExtensionConnected() {
    return this._extensionWs && this._extensionWs.readyState === 1;
  }

  /**
   * 截取当前浏览器标签页的屏幕截图
   * @param {boolean} fullPage - 是否截取整个页面（包括滚动区域）
   * @returns {Promise<{data: string, width: number, height: number}>} base64编码的PNG图片数据
   */
  async captureScreenshot(fullPage = false) {
    if (!this.isExtensionConnected()) {
      throw new Error("Chrome扩展未连接，无法截图");
    }

    try {
      process.stderr.write(`[${ts()}] [Bridge] Capturing screenshot (fullPage: ${fullPage})\n`);
      const result = await this._request({ type: "capture_screenshot", fullPage }, 30000);
      process.stderr.write(`[${ts()}] [Bridge] Screenshot captured successfully\n`);
      return result;
    } catch (err) {
      throw new Error(`截图失败: ${err.message}`);
  }
}

/**
   * 打开浏览器并访问指定URL
   * 优先使用Chrome扩展API（如果已连接），否则使用系统命令
   */
  async openBrowser(url) {
    let managed = [];
    try { managed = describeAdapterCatalog().adapters; }
    catch { /* The legacy allowlist remains available if the managed catalog cannot be read. */ }
    const allowedOrigins = buildAllowedOpenBrowserOrigins([...loadAdapterManifests(), ...managed]);
    const allowedUrl = assertAllowedOpenBrowserUrl(url, allowedOrigins);
    url = allowedUrl;

    // 方案1：如果Chrome扩展已连接，使用扩展API打开新tab
    if (this.isExtensionConnected()) {
      try {
        process.stderr.write(`[${ts()}] [Bridge] Opening URL via Chrome extension: ${url}\n`);
        const result = await this._request({ type: "open_tab", url }, 5000);
        return {
          success: true,
          method: "extension",
          message: `已在Chrome中打开新标签页: ${url}`,
          tabId: result.tabId
        };
      } catch (err) {
        process.stderr.write(`[${ts()}] [Bridge] Failed to open via extension: ${err.message}\n`);
        // 失败则继续尝试系统命令
      }
    }

    // 方案2：使用 execFile（非 shell）打开 Chrome，避免命令注入
    process.stderr.write(`[${ts()}] [Bridge] Opening URL via system command: ${url}\n`);

    try {
      if (process.platform === "darwin") {
        await execFileAsync("open", ["-a", "Google Chrome", url]);
      } else if (process.platform === "win32") {
        // `start` is a cmd.exe built-in — must go through cmd /c
        await execFileAsync("cmd", ["/c", "start", "", "chrome", url]);
      } else {
        // Linux: try browsers in order until one succeeds
        const browsers = ["google-chrome", "chromium", "chromium-browser"];
        let opened = false;
        for (const bin of browsers) {
          try { await execFileAsync(bin, [url]); opened = true; break; } catch { /* try next */ }
        }
        if (!opened) throw new Error("找不到可用的 Chrome/Chromium 可执行文件");
      }

      // 等待 Chrome 扩展连接（最多等待 10 秒）
      process.stderr.write(`[${ts()}] [Bridge] Waiting for Chrome extension to connect...\n`);
      const startTime = Date.now();
      const timeout = 10000; // 10 秒超时

      while (!this.isExtensionConnected() && (Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 每 500ms 检查一次
      }

      if (this.isExtensionConnected()) {
        process.stderr.write(`[${ts()}] [Bridge] Chrome extension connected after ${Date.now() - startTime}ms\n`);
        return {
          success: true,
          method: "system_command",
          message: `已使用系统命令打开Chrome: ${url}`,
          extensionConnected: true
        };
      } else {
        process.stderr.write(`[${ts()}] [Bridge] Chrome extension did not connect within ${timeout}ms\n`);
        return {
          success: true,
          method: "system_command",
          message: `已使用系统命令打开Chrome: ${url}`,
          extensionConnected: false,
          note: "Chrome扩展未在10秒内连接，请稍后再试截图功能"
        };
      }
    } catch (err) {
      throw new Error(`无法打开Chrome: ${err.message}`);
    }
  }
}

function isLegacyWecliHandlerName(toolName) {
  return typeof toolName === "string" && /\.wecli_/.test(toolName);
}

function normalizeSiteMemoryForScaffold(memory, fallbackSiteKey = '') {
  const input = memory && typeof memory === 'object' ? memory : {};
  const now = new Date().toISOString();
  const siteKey = toNonEmptyString(input.siteKey) || normalizeSiteKey(fallbackSiteKey);

  if (!siteKey) {
    throw new Error('siteKey is required');
  }

  const siteHost = toNonEmptyString(input.siteHost) || siteKey;
  const canonicalEntryUrl = firstNonEmptyString(
    input.canonicalEntryUrl,
    input.lastSourceUrl,
    input?.rawSummary?.resultPageUrl,
    input?.rawSummary?.finalPageUrl,
  );
  const canonicalResultUrl = firstNonEmptyString(
    input.canonicalResultUrl,
    input?.rawSummary?.resultPageUrl,
    input?.rawSummary?.finalPageUrl,
    canonicalEntryUrl,
  );
  const siteOrigin = firstNonEmptyString(
    input.siteOrigin,
    originFromUrl(canonicalEntryUrl),
    originFromUrl(canonicalResultUrl),
    siteHost ? `https://${siteHost}` : '',
  );
  const workflowVersion = toNonEmptyString(input.workflowVersion);
  const legacyListCandidates = Array.isArray(input.apiCandidates) ? input.apiCandidates : [];
  const listApiCandidates = normalizeListApiCandidates(
    Array.isArray(input.listApiCandidates) ? input.listApiCandidates : legacyListCandidates,
    legacyListCandidates,
  );
  const actionApiCandidates = normalizeActionApiCandidates(input.actionApiCandidates, siteKey, now);

  return {
    siteKey,
    siteHost,
    siteOrigin,
    updatedAt: toNonEmptyString(input.updatedAt) || now,
    firstCapturedAt: toNonEmptyString(input.firstCapturedAt) || now,
    captureCount: toPositiveNumber(input.captureCount),
    workflowVersion,
    workflowVersionsSeen: normalizeStringArray(input.workflowVersionsSeen, workflowVersion ? [workflowVersion] : []),
    lastSourceUrl: firstNonEmptyString(input.lastSourceUrl, canonicalEntryUrl, canonicalResultUrl),
    canonicalEntryUrl,
    canonicalResultUrl,
    verdictPattern: firstNonEmptyString(input.verdictPattern, input.pattern),
    recommendedStrategy: toNonEmptyString(input.recommendedStrategy),
    verdictReason: firstNonEmptyString(input.verdictReason, input.reason),
    search: normalizeSearchState(input.search),
    resultSignals: normalizeResultSignals(input.resultSignals),
    listApiCandidates,
    apiAnalysisV2: input.apiAnalysisV2 && typeof input.apiAnalysisV2 === 'object'
      ? input.apiAnalysisV2
      : undefined,
    actionApiCandidates,
    actionCaptureHistory: normalizeActionApiCandidates(input.actionCaptureHistory, siteKey, now),
    actionEvidenceSummary: input.actionEvidenceSummary,
    detailHints: normalizeDetailHints(input.detailHints),
    pagination: normalizePaginationState(input.pagination),
    rawSummary: normalizeRawSummary(input.rawSummary),
  };
}

function normalizeSiteKey(value) {
  const text = toNonEmptyString(value);
  if (!text) return '';
  try {
    return new URL(text).hostname;
  } catch {
    return text;
  }
}

function listCandidateKey(candidate) {
  const url = toNonEmptyString(candidate?.url);
  const method = toNonEmptyString(candidate?.method) || 'GET';
  return url ? `${method.toUpperCase()} ${url}` : '';
}

function structuralApiUrl(input) {
  const text = toNonEmptyString(input);
  if (!text) return '';
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, ':value');
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return text.split('#', 1)[0];
  }
}

function pickRicherText(primary, secondary) {
  const left = toNonEmptyString(primary);
  const right = toNonEmptyString(secondary);
  if (!left) return right;
  if (!right) return left;
  return left.length >= right.length ? left : right;
}

function normalizeListApiCandidates(candidates, fallbackCandidates = []) {
  const usable = Array.isArray(candidates) ? candidates : [];
  const fallbackByKey = new Map(
    (Array.isArray(fallbackCandidates) ? fallbackCandidates : [])
      .map((candidate) => [listCandidateKey(candidate), candidate])
      .filter(([key]) => key),
  );
  const deduped = new Map();

  for (const candidate of usable) {
    const rawUrl = toNonEmptyString(candidate?.url);
    if (!rawUrl) continue;
    const method = toNonEmptyString(candidate?.method) || 'GET';
    const key = `${method.toUpperCase()} ${rawUrl}`;
    const fallback = fallbackByKey.get(key) || {};
    const requestBodyPreview = firstNonEmptyString(
      candidate?.requestBodyPreview,
      candidate?.requestBody,
      fallback?.requestBodyPreview,
      fallback?.requestBody,
    );
    const requestEvidence = normalizeRequestBodyEvidence({
      ...fallback,
      ...candidate,
      requestBodyPreview,
    });
    const normalized = {
      url: structuralApiUrl(rawUrl),
      method,
      status: Number.isFinite(Number(candidate?.status ?? fallback?.status))
        ? Number(candidate?.status ?? fallback?.status)
        : undefined,
      requestEvidence,
      responseEvidence: normalizeResponseBodyEvidence({ ...fallback, ...candidate, responsePreview: firstNonEmptyString(candidate?.responsePreview, candidate?.responseBodyPreview, fallback?.responsePreview, fallback?.responseBodyPreview) }),
      responseContentType: firstNonEmptyString(
        candidate?.responseContentType,
        candidate?.contentType,
        fallback?.responseContentType,
        fallback?.contentType,
      ),
      responseHints: normalizeResponseHints(candidate?.responseHints || fallback?.responseHints),
      sourceSteps: normalizeStringArray(candidate?.sourceSteps, ['extension_memory']),
      apiEvidence: candidate?.apiEvidence && typeof candidate.apiEvidence === 'object'
        ? candidate.apiEvidence
        : (fallback?.apiEvidence && typeof fallback.apiEvidence === 'object' ? fallback.apiEvidence : undefined),
    };
    if (deduped.has(key)) {
      const existing = deduped.get(key);
      if (existing.requestEvidence?.bodyOmitted && !normalized.requestEvidence?.bodyOmitted) {
        existing.requestEvidence = normalized.requestEvidence;
      }
      if (existing.responseEvidence?.bodyKind !== 'json' && normalized.responseEvidence?.bodyKind === 'json') existing.responseEvidence = normalized.responseEvidence;
      existing.responseContentType ||= normalized.responseContentType;
      existing.responseHints ||= normalized.responseHints;
      existing.apiEvidence ||= normalized.apiEvidence;
      existing.sourceSteps = normalizeStringArray([...existing.sourceSteps, ...normalized.sourceSteps]);
      continue;
    }
    deduped.set(key, normalized);
  }

  return [...deduped.values()].map((candidate) => ({
    ...candidate,
    sourceEvidence: buildApiSourceEvidence(candidate, { sourceKind: 'passive_list' }),
  }));
}

export { normalizeSiteMemoryForScaffold };

function normalizeActionApiCandidates(candidates, siteKey, fallbackCapturedAt) {
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((candidate, index) => {
      const rawUrl = toNonEmptyString(candidate?.url);
      if (!rawUrl) return null;
      const actionName = toNonEmptyString(candidate?.actionName) || `captured_action_${index + 1}`;
      const toolName = toNonEmptyString(candidate?.toolName) || `${siteKey}.${actionName}_draft`;
      const requestEvidence = normalizeRequestBodyEvidence(candidate);
      const normalized = {
        actionName,
        mode: toNonEmptyString(candidate?.mode) || 'intercept',
        toolName,
        url: structuralApiUrl(rawUrl),
        method: toNonEmptyString(candidate?.method) || 'GET',
        requestEvidence,
        responseEvidence: normalizeResponseBodyEvidence(candidate),
        responseContentType: firstNonEmptyString(candidate?.responseContentType, candidate?.contentType),
        responseHints: normalizeResponseHints(candidate?.responseHints),
        intercepted: Boolean(candidate?.intercepted),
        blockedReason: toNonEmptyString(candidate?.blockedReason),
        aiIsPrimary: Boolean(candidate?.aiIsPrimary),
        aiPurpose: toNonEmptyString(candidate?.aiPurpose),
        aiWhy: toNonEmptyString(candidate?.aiWhy),
        primarySelection: ['user', 'ai', 'heuristic'].includes(candidate?.primarySelection)
          ? candidate.primarySelection
          : '',
        capturedAt: toNonEmptyString(candidate?.capturedAt) || fallbackCapturedAt,
        sourceWorkflowVersion: toNonEmptyString(candidate?.sourceWorkflowVersion),
        apiEvidence: candidate?.apiEvidence && typeof candidate.apiEvidence === 'object'
          ? candidate.apiEvidence
          : undefined,
      };
      normalized.sourceEvidence = buildApiSourceEvidence(normalized, { sourceKind: 'action_capture' });
      return normalized;
    })
    .filter(Boolean);
}

function normalizeResponseHints(hints) {
  if (!hints || typeof hints !== 'object') return undefined;
  return {
    topLevelKeys: normalizeStringArray(hints.topLevelKeys),
    listPath: toNonEmptyString(hints.listPath),
    itemKeys: normalizeStringArray(hints.itemKeys),
    idLikeKeys: normalizeStringArray(hints.idLikeKeys),
    displayLikeKeys: normalizeStringArray(hints.displayLikeKeys),
    availabilityLikeKeys: normalizeStringArray(hints.availabilityLikeKeys),
    preferredIdKey: toNonEmptyString(hints.preferredIdKey),
    preferredDisplayKey: toNonEmptyString(hints.preferredDisplayKey),
    preferredAvailabilityKey: toNonEmptyString(hints.preferredAvailabilityKey),
  };
}

function normalizeSearchState(search) {
  const input = search && typeof search === 'object' ? search : {};
  return {
    executed: Boolean(input.executed),
    action: toNonEmptyString(input.action),
    keywordSeed: toNonEmptyString(input.keywordSeed),
  };
}

function normalizeResultSignals(resultSignals) {
  const input = resultSignals && typeof resultSignals === 'object' ? resultSignals : {};
  return {
    listCandidates: toPositiveNumber(input.listCandidates),
    paginationCandidates: toPositiveNumber(input.paginationCandidates),
  };
}

function normalizeDetailHints(detailHints) {
  const input = detailHints && typeof detailHints === 'object' ? detailHints : {};
  return {
    mode: toNonEmptyString(input.mode),
    bestCandidateHref: toNonEmptyString(input.bestCandidateHref),
    bestCandidateText: toNonEmptyString(input.bestCandidateText),
    networkDetailCandidates: normalizeStringArray(input.networkDetailCandidates),
  };
}

function normalizePaginationState(pagination) {
  const input = pagination && typeof pagination === 'object' ? pagination : {};
  return {
    attempted: Boolean(input.attempted),
    verified: Boolean(input.verified),
    mode: toNonEmptyString(input.mode),
    targetPage: toNullableNumber(input.targetPage),
    activePageBefore: toNullableNumber(input.activePageBefore),
    activePageAfter: toNullableNumber(input.activePageAfter),
    reason: toNonEmptyString(input.reason),
  };
}

function normalizeRawSummary(rawSummary) {
  const input = rawSummary && typeof rawSummary === 'object' ? rawSummary : {};
  return {
    tabId: toNullableNumber(input.tabId),
    resultPageUrl: toNonEmptyString(input.resultPageUrl),
    finalPageUrl: toNonEmptyString(input.finalPageUrl),
  };
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((item) => toNonEmptyString(item)).filter(Boolean);
}

function toPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
}

function toNullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function toNonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = toNonEmptyString(value);
    if (text) return text;
  }
  return '';
}

function originFromUrl(value) {
  const text = toNonEmptyString(value);
  if (!text) return '';
  try {
    return new URL(text).origin;
  } catch {
    return '';
  }
}

function promiseWithTimeout(promise, timeoutMs, errorMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage || `operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
