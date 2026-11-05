import profile from './adapterhub-profile.json' with { type: 'json' };
/**
 * AdapterHub client — Profile 配置的 目录与分发站 API 封装
 *
 * 端点配置：
 * - 默认官方地址 Profile 配置的地址
 * - 仅开发/自建时覆盖：WEBCLI_ADAPTERHUB_ENDPOINT 环境变量
 * - 端点与重定向均支持 HTTP 和 HTTPS，无需 Profile 单独放行 HTTP
 * - 上传/发布需访问令牌：ADAPTERHUB_TOKEN 环境变量（AdapterHub 网页「令牌」处创建）
 */

import { existsSync, readFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { loadAdapterHubToken } from "./adapterhub-credentials.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ENDPOINT = profile.endpoint;

export class UsageError extends Error {}

export function resolveEndpoint() {
  const raw = String(process.env.WEBCLI_ADAPTERHUB_ENDPOINT || DEFAULT_ENDPOINT).trim();
  if (!raw) throw new UsageError("AdapterHub 端点为空。请检查 WEBCLI_ADAPTERHUB_ENDPOINT。");
  let url;
  try { url = new URL(raw); } catch { throw new UsageError(`AdapterHub 端点不是合法 URL: ${raw}`); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new UsageError("AdapterHub 端点必须使用 HTTP 或 HTTPS。");
  }
  return String(raw).replace(/\/+$/, "");
}

export function resolveToken() {
  return String(process.env.ADAPTERHUB_TOKEN || "").trim();
}

export async function resolveTokenWithSource() {
  return loadAdapterHubToken();
}

function joinUrl(base, path) {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

function timeoutError(url, ms) {
  const seconds = Math.round(ms / 1000);
  return new Error(`网络请求超时（>${seconds}s）: ${url}\n请检查内网连通性或设置 HTTPS_PROXY。`);
}

/** fetch，失败时回退 curl（尊重系统代理/HTTPS_PROXY），与 adapter-cli 行为一致。超时：读 30s / 上传 120s。 */
async function request(url, options = {}, redirectCount = 0) {
  const timeout = options.method && options.method !== "GET" ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  try {
    const resp = await fetch(url, { ...options, redirect: "manual", signal: options.signal || AbortSignal.timeout(timeout) });
    if (resp.status >= 300 && resp.status < 400) {
      if (redirectCount >= 5) throw new Error(`AdapterHub 重定向次数过多: ${url}`);
      const location = resp.headers.get("location");
      if (!location) throw new Error(`AdapterHub 返回无目标地址的重定向: ${url}`);
      const next = new URL(location, url);
      if (!["http:", "https:"].includes(next.protocol)) {
        throw new Error(`AdapterHub 重定向必须使用 HTTP 或 HTTPS: ${next.href}`);
      }
      return request(next.href, { ...options, signal: undefined }, redirectCount + 1);
    }
    return resp;
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") throw timeoutError(url, timeout);
    // 安全策略/重定向错误不可通过 curl 绕过；写请求（携带凭证）也不走回退。
    if (err?.message?.includes("拒绝不安全") || err?.message?.includes("重定向")) throw err;
    if (options.method && options.method !== "GET") throw err;
    return requestViaCurl(url, options, timeout);
  }
}

/**
 * curl 回退：二进制安全（--output - 捕获 stdout 为 Buffer）、保留 HTTP 状态码。
 * 返回与 fetch 兼容的最小响应接口 { ok, status, arrayBuffer, text, json, headers }。
 */
async function requestViaCurl(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const args = [
    "-sS", "--max-time", String(Math.round(timeoutMs / 1000)),
    "-w", "\n%{http_code}", // 追加状态码行
    "-X", options.method || "GET",
  ];
  for (const [name, value] of Object.entries(options.headers || {})) {
    args.push("-H", `${name}: ${value}`);
  }
  args.push(url);
  try {
    const { stdout } = await execFileAsync("curl", args, {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
    });
    // 拆出末尾状态码行
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const lastNewline = buffer.lastIndexOf(10);
    const statusLine = lastNewline === -1 ? "" : buffer.subarray(lastNewline + 1).toString("utf8").trim();
    const status = Number.parseInt(statusLine, 10) || 0;
    const body = lastNewline === -1 ? buffer : buffer.subarray(0, lastNewline);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => body.toString("utf8"),
      json: async () => JSON.parse(body.toString("utf8")),
    };
  } catch (err) {
    throw new Error(
      `网络请求失败: ${url}\n` +
      `  Node fetch 与 curl 均失败。请检查内网连通性或设置 HTTPS_PROXY。\n` +
      `  curl 错误: ${err.stderr?.toString()?.trim() || err.message}`
    );
  }
}

const PUBLISH_STATUS_HINTS = {
  401: "令牌无效或未设置：请在 AdapterHub 网页「令牌」处创建 PAT 并 export ADAPTERHUB_TOKEN=ahp_xxx",
  403: "无权发布该 Adapter（归属人/管理员限制）",
  409: "版本冲突：",
  413: "包超过 32MB 上限，请精简后重试",
};

async function parseError(resp, url) {
  const body = await resp.json().catch(() => null);
  let message = body?.error?.message || body?.message || `HTTP ${resp.status}`;
  const hint = PUBLISH_STATUS_HINTS[resp.status];
  if (hint) message = resp.status === 409 ? hint + message : `${message}\n  ${hint}`;
  const error = new Error(`${message}\n  (${resp.status} ${url})`);
  error.status = resp.status;
  error.code = body?.error?.code;
  return error;
}

// ── 目录 API（匿名可用）──

export async function listAdapters({ q = "", sort = "", origin = "", runtime = "", page = 1 } = {}) {
  const params = new URLSearchParams({ page_size: "100", page: String(Math.max(1, page)) });
  if (q) params.set("q", q);
  if (sort) params.set("sort", sort);
  if (origin) params.set("origin", origin);
  if (runtime) params.set("runtime", runtime);
  const url = joinUrl(resolveEndpoint(), `/api/v1/adapters?${params}`);
  const resp = await request(url);
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

export async function getAdapter(name) {
  const url = joinUrl(resolveEndpoint(), `/api/v1/adapters/${encodeURIComponent(name)}`);
  const resp = await request(url);
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

export async function getAdapterVersions(name) {
  const url = joinUrl(resolveEndpoint(), `/api/v1/adapters/${encodeURIComponent(name)}/versions`);
  const resp = await request(url);
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

/** 下载 .adapt 包，返回 Buffer。可指定历史版本（服务端支持 ?version=）。 */
export async function downloadAdapter(name, { version } = {}) {
  const query = version ? `?version=${encodeURIComponent(version)}` : "";
  const url = joinUrl(resolveEndpoint(), `/api/v1/adapters/${encodeURIComponent(name)}/download${query}`);
  const resp = await request(url, { headers: { accept: "application/octet-stream" } });
  if (!resp.ok) throw await parseError(resp, url);
  const raw = await resp.arrayBuffer();
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const etag = resp.headers?.get?.("etag") || (resp.headers instanceof Map ? resp.headers.get("etag") : "") || "";
  return { buffer, sha256Header: etag };
}

// ── Adapter 命令清单（匿名可用）──

export async function getAdapterCommands(name) {
  const url = joinUrl(resolveEndpoint(), `/api/v1/adapters/${encodeURIComponent(name)}/commands`);
  const resp = await request(url);
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

// ── v1 冻结存量：站点目录（只读）──

export async function listSites(params = {}) {
  const search = new URLSearchParams({ page_size: "100", page: String(Math.max(1, params.page || 1)) });
  if (params.q) search.set("q", params.q);
  const url = joinUrl(resolveEndpoint(), `/api/v1/sites?${search}`);
  const resp = await request(url);
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

// ── v1 冻结存量：站点维度（只读）──

export async function getSite(name) {
  const url = joinUrl(resolveEndpoint(), `/api/v1/sites/${encodeURIComponent(name)}`);
  const resp = await request(url);
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

export async function downloadSite(name) {
  const url = joinUrl(resolveEndpoint(), `/api/v1/sites/${encodeURIComponent(name)}/download`);
  const resp = await request(url, { headers: { accept: "application/octet-stream" } });
  if (!resp.ok) throw await parseError(resp, url);
  const raw = await resp.arrayBuffer();
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const etag = resp.headers?.get?.("etag") || (resp.headers instanceof Map ? resp.headers.get("etag") : "") || "";
  return { buffer, sha256Header: etag };
}

// ── 发布 API（需 ADAPTERHUB_TOKEN）──

export async function publishAdapter(packageBuffer) {
  const { token } = await resolveTokenWithSource();
  if (!token) {
    throw new Error("缺少访问令牌：请先运行 webcli adapterhub init 完成一次性初始化。");
  }
  const url = joinUrl(resolveEndpoint(), "/api/v1/adapters");
  const resp = await request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(packageBuffer.length),
    },
    body: packageBuffer,
  });
  if (!resp.ok) throw await parseError(resp, url);
  return resp.json();
}

// ── 版本比较（供 update 检查；与服务端 checkAdapterPublish 同规则）──

export function compareVersions(a, b) {
  const rank = (v) => String(v).split(".").map((n) => Number(n) || 0);
  const x = rank(a), y = rank(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
