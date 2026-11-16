/**
 * Adapter 调用埋点 —— 实时上报层
 *
 * Extension Adapter / builtin 工具经 bridge.js 的 callTool() 收口，Toolkit
 * Adapter 经 toolkit-runner.js 收口；两条路径都调用 reportMetric()，把一条
 * 元数据**实时** POST 到服务端。
 *
 * 设计原则：
 *   - 只记元数据（tool / domain / kind / ok / ms / traceID / err），绝不记 args / result
 *   - fire-and-forget：绝不 await、绝不阻塞调用主流程；上报失败一律静默丢弃
 *   - 不落本地文件：断网 / 服务端不可用时该条记录丢失（如需不丢，回退本地缓冲方案）
 *   - user 由 whoami 自动取得，无需手动配置
 *
 * 共享给：bridge.js、toolkit-runner.js（实时上报）、stats.js（远程查询）
 */

import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { promises as fsp } from "fs";
import path from "path";
import { homedir, userInfo as osUserInfo } from "os";

// ~/.webcli 是 webcli 既有的配置目录（见 index.js getConfigDir）
export const METRICS_DIR    = path.join(homedir(), ".webcli");
const CLIENT_ID_FILE        = path.join(METRICS_DIR, "client-id");
const USER_CACHE_FILE       = path.join(METRICS_DIR, "user-cache.json");

const POST_TIMEOUT_MS = 10_000;

/**
 * 从完整工具名提取 domain 与 kind。
 * adapter 工具形如 `mail.example.com.search_messages` → domain 取最后一个 `.` 之前；
 * builtin 工具形如 `open_browser` 无 `.` → domain 填工具名本身。
 * @param {string} tool
 * @returns {{ domain: string, kind: "adapter" | "builtin" }}
 */
export function classifyTool(tool) {
  const hasDomain = typeof tool === "string" && tool.includes(".");
  return {
    domain: hasDomain ? tool.slice(0, tool.lastIndexOf(".")) : tool,
    kind: hasDomain ? "adapter" : "builtin",
  };
}

/**
 * 错误信息脱敏：只保留首行 + 截断，并抹掉可能混入的敏感片段
 * （URL query、token、邮箱、长数字串如手机号/卡号）。
 * @param {unknown} err 错误对象或字符串
 * @returns {string|null}
 */
export function sanitizeErr(err) {
  if (err == null) return null;
  let msg = typeof err === "string" ? err : (err.message || String(err));
  msg = msg.split("\n")[0];                                  // 只要首行
  msg = msg.replace(/\?[^\s]*/g, "?…");                      // 抹掉 URL query
  msg = msg.replace(/(token|key|secret|password|pwd|authorization)=[^\s&]+/gi, "$1=…");
  msg = msg.replace(/[\w.+-]+@[\w.-]+\.\w+/g, "<email>");    // 邮箱
  msg = msg.replace(/\b\d{7,}\b/g, "<num>");                 // 长数字串（手机号/卡号等）
  return msg.slice(0, 200);
}

/**
 * 构造一条埋点记录（纯函数，便于测试）。
 * @returns {{ts:number,tool:string,domain:string,kind:string,ok:boolean,ms:number,traceID:string|null,err:string|null}}
 */
export function buildRecord(tool, ok, ms, traceID, err) {
  const { domain, kind } = classifyTool(tool);
  return {
    ts: Date.now(),
    tool,
    domain,
    kind,
    ok: !!ok,
    ms,
    traceID: traceID || null,
    err: err ? sanitizeErr(err) : null,
  };
}

/**
 * whoami 取当前系统用户；跨平台取最后一段（DOMAIN\user → user）。
 * 失败（无 whoami / 超时）返回 null。
 * @returns {string|null}
 */
export function whoami() {
  try {
    const raw = execSync("whoami", { encoding: "utf8", timeout: 2000 }).trim();
    return (raw.split(/[\\/]/).pop() || raw) || null;
  } catch {
    return null;
  }
}

/**
 * 读取或生成匿名机器标识，存 ~/.webcli/client-id。
 * 与真实身份解耦，仅用于服务端区分上报来源。
 * @returns {Promise<string>}
 */
export async function getOrCreateClientId() {
  try {
    const existing = (await fsp.readFile(CLIENT_ID_FILE, "utf8")).trim();
    if (existing) return existing;
  } catch {
    /* 不存在则生成 */
  }
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  await fsp.mkdir(METRICS_DIR, { recursive: true }).catch(() => {});
  await fsp.writeFile(CLIENT_ID_FILE, id).catch(() => {});
  return id;
}

/**
 * 身份缓存读写(~/.webcli/user-cache.json)。文件可传参以便测试隔离;
 * 任何 IO 失败静默降级为空缓存,主流程不受影响。
 */
export async function loadIdentityCache(file = USER_CACHE_FILE) {
  try {
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function saveIdentityCache(patch, file = USER_CACHE_FILE) {
  const next = { ...(await loadIdentityCache(file)), ...patch };
  try {
    await fsp.mkdir(METRICS_DIR, { recursive: true }).catch(() => {});
    await fsp.writeFile(file, JSON.stringify(next));
  } catch { /* 静默 */ }
  return next;
}

/**
 * 指标上报默认关闭。仅在部署者显式提供 endpoint 并开启上传时生效，
 * 凭证只能通过环境变量注入，不得写入源码或安装包。
 */
const DEFAULT_ENDPOINT = "";
const DEFAULT_TOKEN = "";

/**
 * 构造上报配置。
 *   - endpoint：只从环境变量读取
 *   - UPLOAD：必须显式设为 on
 *   - 总开关 WEBCLI_METRICS=off 可完全关闭
 * user 优先级:HRM 解析缓存 > 系统用户(whoami) > clientId 降级。
 * userSource 标记来源,服务端对 hrm/hrm-cache 上报做存量降级行身份修正。
 * identityCacheFile / whoamiImpl 为测试注入口。META 在此算一次并缓存。
 * @param {{ webcliVersion: string, identityCacheFile?: string, whoamiImpl?: Function }} opts
 * @returns {Promise<{endpoint:string|null, token:string, meta:object}>}
 */
export async function buildUploadConfig({ webcliVersion, identityCacheFile = null, whoamiImpl = whoami, osUserImpl = () => osUserInfo() } = {}) {
  const endpoint = process.env.WEBCLI_METRICS_ENDPOINT || DEFAULT_ENDPOINT;
  const token = process.env.WEBCLI_METRICS_TOKEN || DEFAULT_TOKEN;
  const uploadOn = process.env.WEBCLI_METRICS_UPLOAD === "on";
  const enabled =
    process.env.WEBCLI_METRICS !== "off" && uploadOn && !!endpoint;

  const clientId = await getOrCreateClientId();
  const identity = await loadIdentityCache(identityCacheFile ?? undefined);
  const cachedUser = typeof identity.user === "string" && identity.user ? identity.user : null;
  const systemUser = whoamiImpl();
  // os.userInfo 二级兜底:whoami 是 spawn 系统命令,可能被 EDR 拦截/PATH 缺失/超时;
  // os.userInfo 读当前进程令牌的用户名,零 spawn 零失败面,结果与 whoami 尾段一致。
  let osUser = null;
  try { osUser = osUserImpl()?.username || null; } catch { /* 极端环境取令牌失败 */ }
  const meta = {
    clientId,
    user: cachedUser || systemUser || osUser || `client-${clientId.slice(0, 8)}`,
    userSource: cachedUser ? "hrm-cache" : systemUser ? "whoami" : osUser ? "os-user" : "client-id-fallback",
    webcliVersion,
    os: process.platform,
  };

  return {
    endpoint: enabled ? endpoint : null,
    token,
    meta,
  };
}

/**
 * 实时上报：构造单条记录 → 立即异步 POST 到服务端。
 * 绝不 await、绝不落盘、失败静默丢弃。未配置 endpoint 时直接返回。
 * @param {{endpoint:string|null, token:string, meta:object}} cfg
 * @param {string} tool
 * @param {boolean} ok
 * @param {number} ms
 * @param {string|null} traceID
 * @param {unknown} err
 */
export function reportMetric(cfg, tool, ok, ms, traceID, err) {
  if (!cfg || !cfg.endpoint) return;                  // 未配置：静默不上报
  try {
    const record = buildRecord(tool, ok, ms, traceID, err);
    // fire-and-forget：不 await，不阻塞调用主流程
    fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify({ ...cfg.meta, batch: [record] }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    }).catch(() => {});                               // 断网/超时/非2xx：静默丢弃
  } catch {
    /* 静默：埋点永不影响调用 */
  }
}
