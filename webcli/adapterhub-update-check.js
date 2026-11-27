/**
 * adapterhub 更新静默感知(仿 version-check):24h TTL 后台刷新,缓存命中即提示。
 * 只提示不自动装;离线/超时完全静默,绝不阻塞命令。
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** 后台刷新短时限:adapterhub-client 链路自身超时 30s,不设限会拖住当前命令进程(仿 version-check 的 AbortSignal.timeout)。 */
export const REFRESH_TIMEOUT_MS = 5000;

function cacheFile(home = homedir()) {
  return path.join(home, ".webcli", "adapterhub-check.json");
}

export function readUpdateCache(file = cacheFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && Array.isArray(data.updates) ? data : null;
  } catch { return null; }
}

function writeUpdateCache(value, file = cacheFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子写:先落 tmp 再 rename(同 repair/knowledge.js),防并发/中断撕裂
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch { /* 静默 */ }
}

/** cli 默认 webgo(与 version-check 的 cliName 参数同模式);生产接线传 cliName() 自报包身份。 */
export function formatUpdateNotice(updates, cli = "webgo") {
  if (!updates || !updates.length) return null;
  return updates.map((u) => {
    const action = u.action === "install" ? `${cli} adapterhub install ${u.adapter}` : `${cli} adapterhub upgrade ${u.adapter}`;
    return `[${cli}] adapter ${u.adapter} ${u.local ?? "(未装)"} → ${u.hub}——运行 ${action}`;
  }).join("\n");
}

/**
 * 回源比对并把 compareLocalWithHub 的真实行形状
 * ({name, version, source, hubVersion, action:"update-available"|...})
 * 归一化为 {adapter, local, hub, action:"upgrade"|"install"}(与 cmdCheck 提示一致:
 * builtin 源 → install,自装 → upgrade);仅保留可更新行。
 */
async function defaultCompare({ signal } = {}) {
  const { collectLocalAdapters, compareLocalWithHub } = await import("./adapterhub-cli.js");
  const rows = await compareLocalWithHub(collectLocalAdapters(), { signal });
  return (rows || [])
    .filter((r) => r.action === "update-available")
    .map((r) => ({
      adapter: r.name,
      local: r.version ?? null,
      hub: r.hubVersion,
      action: r.source === "builtin" ? "install" : "upgrade",
    }));
}

async function refreshUpdates({ compareImpl, file, now }) {
  // AbortController 贯穿链路真取消 socket:race 只能赢下 Promise,赢不了 ref'd 的
  // pending I/O(fetch socket 会钉住事件循环直到 client 自身 30s 超时,命令仍被拖住)。
  // 5s timer unref 后 abort → fetch 立即拒绝(client 对 AbortError 不走 curl 回退);
  // 超时走 catch 静默不落缓存,下条命令再试。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const results = await compareImpl({ signal: controller.signal });
    const updates = (results || [])
      .filter((r) => r.action === "upgrade" || r.action === "install")
      .map((r) => ({ adapter: r.adapter, local: r.local ?? null, hub: r.hub, action: r.action }));
    writeUpdateCache({ checkedAt: now, updates }, file);
  } catch { /* 静默 */ }
}

export async function checkAdapterUpdates({ compareImpl = defaultCompare, file = cacheFile(), now = Date.now(), ttl = CHECK_TTL_MS } = {}) {
  const cache = readUpdateCache(file);
  if (cache && now - cache.checkedAt < ttl) return cache.updates;
  refreshUpdates({ compareImpl, file, now }).catch(() => {}); // 后台静默,不 await
  return cache ? cache.updates : [];                          // 本次用旧缓存,下次生效
}
