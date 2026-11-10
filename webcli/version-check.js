/**
 * 版本自检 —— semver 比较 / 检查缓存 / 升级提示。
 * 同步读本地缓存比对(零网络);缓存过期(24h)时后台异步刷新 registry,
 * 本次仍用旧缓存,刷新结果下次生效。registry 不可达完全静默(离线零影响)。
 * WEBCLI_EMBEDDED=1(桌面端内嵌)时整段关闭:桌面端自带 webcli 随应用更新。
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { homedir } from "os";

export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** 包名 → 默认 registry(行内 wnpm / 公开 npmjs)。WEBCLI_UPGRADE_REGISTRY 或 --registry 可覆盖。 */
const PACKAGE_REGISTRIES = {
  "@webank/webcli": "http://wnpm.weoa.com:8001",
  "weworker-webcli": "https://registry.npmjs.org",
};

export function resolveRegistry(pkgName, override = null) {
  return override || PACKAGE_REGISTRIES[pkgName] || "https://registry.npmjs.org";
}

/** 轻量 semver 数字段比较:a<b → -1,a=b → 0,a>b → 1。非数字段按 0 处理。 */
export function compareSemver(a, b) {
  const pa = String(a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function readVersionCache(file = path.join(homedir(), ".webcli", "version-check.json")) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export async function writeVersionCache(value, file = path.join(homedir(), ".webcli", "version-check.json")) {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  } catch { /* 静默 */ }
}

/** 后台刷新 registry latest(2s 超时,失败静默),写缓存供下次比对。 */
export function refreshLatestAsync({ registry, pkgName, file, fetchImpl = fetch, now = Date.now() } = {}) {
  fetchImpl(`${String(registry).replace(/\/$/, "")}/${pkgName}/latest`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((manifest) => {
      if (manifest?.version) return writeVersionCache({ latest: manifest.version, checkedAt: now }, file);
    })
    .catch(() => {});
}

/**
 * 命令分派前的版本自检。返回提示文本(无需升级返回 null)。
 * embedded=true(桌面端内嵌)→ 直接 null,不读缓存不发起刷新。
 */
export async function checkForUpdate({ currentVersion, pkgName, registry, file, fetchImpl = fetch, now = Date.now(), embedded = false, ttl = CHECK_TTL_MS } = {}) {
  if (embedded) return null;
  const cacheFile = file ?? path.join(homedir(), ".webcli", "version-check.json");
  const cache = await readVersionCache(cacheFile);
  if (cache?.latest && compareSemver(currentVersion, cache.latest) < 0) {
    return `[webcli] 有新版本 ${cache.latest}(当前 ${currentVersion})——运行 webcli upgrade 升级(自动清理 Service Worker 缓存)`;
  }
  if (!cache?.checkedAt || now - cache.checkedAt > ttl) {
    refreshLatestAsync({ registry, pkgName, file: cacheFile, fetchImpl, now });
  }
  return null;
}
