/**
 * 版本自检 —— semver 比较 / 检查缓存 / 升级提示。
 * 同步读本地缓存比对(零网络);缓存过期(24h)时后台异步刷新 registry,
 * 本次仍用旧缓存,刷新结果下次生效。registry 不可达完全静默(离线零影响)。
 * WEBCLI_EMBEDDED=1(桌面端内嵌)时整段关闭:桌面端自带 webcli 随应用更新。
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * 解析升级/检查用的 registry。优先级:显式覆盖(env/--registry)> 包内
 * internal-registry.json(行内 repack 注入,不入公开仓)> npmjs 默认。
 */
export function resolveRegistry(pkgName, override = null, { internalRegistryFile = null, readFileImpl = null } = {}) {
  if (override) return override;
  const file = internalRegistryFile ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "internal-registry.json");
  try {
    const data = JSON.parse((readFileImpl ?? readFileSync)(file, "utf8"));
    if (data && typeof data.registry === "string" && data.registry) return data.registry;
  } catch { /* 文件不存在(公开包/源码树)→ 默认 */ }
  return pkgName === "weworker-webcli" ? DEFAULT_REGISTRY : DEFAULT_REGISTRY;
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
      if (manifest?.version) return writeVersionCache({ latest: manifest.version, checkedAt: now, pkgName }, file);
    })
    .catch(() => {});
}

/**
 * 命令分派前的版本自检。返回提示文本(无需升级返回 null)。
 * embedded=true(桌面端内嵌)→ 直接 null,不读缓存不发起刷新。
 * cliName 用于提示前缀与命令名(webgo 包显示 [webgo],默认 webcli)。
 */
export async function checkForUpdate({ currentVersion, pkgName, registry, file, cliName = "webcli", fetchImpl = fetch, now = Date.now(), embedded = false, ttl = CHECK_TTL_MS } = {}) {
  if (embedded) return null;
  const cacheFile = file ?? path.join(homedir(), ".webcli", "version-check.json");
  const cache = await readVersionCache(cacheFile);
  // 缓存按包名隔离:共享 ~/.webcli 目录下,读到别的包写入的缓存必须视为无缓存,
  // 否则 webgo 会误读 webcli 的 latest 而误报。
  const ownCache = cache && cache.pkgName === pkgName ? cache : null;
  if (ownCache?.latest && compareSemver(currentVersion, ownCache.latest) < 0) {
    return `[${cliName}] 有新版本 ${ownCache.latest}(当前 ${currentVersion})——运行 ${cliName} upgrade 升级(自动清理 Service Worker 缓存)`;
  }
  if (!ownCache?.checkedAt || now - ownCache.checkedAt > ttl) {
    refreshLatestAsync({ registry, pkgName, file: cacheFile, fetchImpl, now });
  }
  return null;
}
