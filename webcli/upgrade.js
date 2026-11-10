/**
 * webcli upgrade —— 一条命令升级全局安装的 webcli 并自动清理 Service Worker 缓存。
 * 包名/registry 取自运行中包自身身份(行内包经 repack 注入 internal-registry.json;公开包默认 npmjs),
 * WEBCLI_UPGRADE_REGISTRY env 或 --registry 参数可覆盖。
 * 桌面端内嵌模式(WEBCLI_EMBEDDED=1)不做任何动作:桌面端自带 webcli 随应用更新。
 */

import { spawn } from "child_process";
import { stat } from "fs/promises";
import { rmSync } from "fs";
import path from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { resolveRegistry, compareSemver } from "./version-check.js";

export function buildInstallCommand(pkgName, version, registry) {
  return `npm install -g ${pkgName}@${version} --registry=${registry}`;
}

export async function fetchLatestVersion(registry, pkgName, fetchImpl = fetch) {
  const res = await fetchImpl(`${String(registry).replace(/\/$/, "")}/${pkgName}/latest`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`registry 响应 ${res.status}`);
  const manifest = await res.json();
  if (!manifest?.version) throw new Error("registry 响应缺少 version");
  return manifest.version;
}

/** Service Worker 缓存目录(升级后必须清理,否则扩展变更不生效)。 */
export function serviceWorkerCacheDirs(home = homedir()) {
  return [path.join(home, ".webcli", "browser", "profile", "Default", "Service Worker")];
}

/**
 * 解析全局安装目标 prefix。npm 默认 prefix 在部分环境指向系统 Node 目录
 * (如 C:\Program Files\nodejs),无管理员权限时 `npm install -g` 直接 EPERM;
 * 而用户的全局包实际装在用户级目录。探测顺序:
 *   1. WEBCLI_UPGRADE_PREFIX 显式指定(env,部署/排障用);
 *   2. 现有全局包的安装位置(从本模块真实位置推断——正在运行的包就在全局目录里);
 *   3. 平台惯例目录存在才采用(win: %APPDATA%\npm;POSIX: ~/.npm-global 或 /usr/local 不强求);
 *   4. 都没有 → 不加 --prefix,走 npm 默认(保持旧行为,失败时给手动命令)。
 * @returns {Promise<{prefixArgs:string[], prefix:string|null}>}
 */
export async function resolveGlobalInstallTarget({ env = process.env, platform = process.platform, existsImpl = stat, home = homedir() } = {}) {
  const explicit = env.WEBCLI_UPGRADE_PREFIX?.trim();
  if (explicit) return { prefixArgs: ["--prefix", explicit], prefix: explicit };
  // existsImpl 语义兼容:真实 stat 以抛异常表示不存在,测试替身以 false 表示——
  // 两者都要覆盖(抛 → 不存在;返回 falsy → 不存在;返回 truthy → 存在)。
  const pathExists = async (p) => {
    try { return Boolean(await existsImpl(p)); } catch { return false; }
  };
  // 2. 当前运行的包自身就在某个全局目录里 —— 升级应原地覆盖同一位置
  //    (<prefix>/node_modules/<scope?>/<pkg>/ → prefix 为 pkgDir 上三级;
  //     无 scope 包少一级但此处以行内 @webank scope 布局为准)
  const pkgDir = path.dirname(fileURLToPath(import.meta.url));
  if (await pathExists(path.join(pkgDir, "package.json"))) {
    const prefix = path.resolve(pkgDir, "..", "..", "..");
    return { prefixArgs: ["--prefix", prefix], prefix };
  }
  // 3. 平台惯例目录(存在才用,避免臆造)
  const candidates = platform === "win32"
    ? [env.APPDATA ? path.join(env.APPDATA, "npm") : null].filter(Boolean)
    : [path.join(home, ".npm-global")].filter(Boolean);
  for (const dir of candidates) {
    if (await pathExists(dir)) return { prefixArgs: ["--prefix", dir], prefix: dir };
  }
  return { prefixArgs: [], prefix: null };
}

/**
 * 升级编排。依赖全部可注入以便测试。
 * @returns {Promise<{upgraded:boolean, latest?:string, error?:string, embedded?:boolean}>}
 */
export async function runUpgrade({
  pkgName, currentVersion, registryOverride = null,
  fetchImpl = fetch, spawnImpl = spawn, removeImpl = null, existsImpl = stat, home = homedir(),
  log = console.log, embedded = false, env = process.env, platform = process.platform,
} = {}) {
  if (embedded) {
    log("[webcli] 桌面端自带 webcli 随应用更新,请通过应用内升级,不做 npm 升级。");
    return { upgraded: false, embedded: true };
  }
  const registry = resolveRegistry(pkgName, registryOverride ?? process.env.WEBCLI_UPGRADE_REGISTRY ?? null);
  let latest;
  try {
    latest = await fetchLatestVersion(registry, pkgName, fetchImpl);
  } catch (e) {
    log(`[webcli] 查询最新版本失败:${e.message}`);
    return { upgraded: false, error: e.message };
  }
  if (compareSemver(currentVersion, latest) >= 0) {
    log(`[webcli] 已是最新(${currentVersion})。`);
    return { upgraded: false, latest };
  }
  const installCmd = buildInstallCommand(pkgName, latest, registry).split(" ");
  // 全局安装目标探测:优先覆盖到用户实际的全局目录,规避系统 Node 目录 EPERM
  const target = await resolveGlobalInstallTarget({ env, platform, existsImpl, home });
  installCmd.push(...target.prefixArgs);
  log(`[webcli] 升级 ${currentVersion} → ${latest}:${installCmd.join(" ")}`);
  try {
    const child = await spawnImpl(installCmd[0], installCmd.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
    await new Promise((resolve, reject) => {
      // 真 spawn 返回 EventEmitter;注入的测试替身可返回 { code } 结果对象
      if (child && typeof child.on === "function") {
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm 退出码 ${code}`))));
        child.on("error", reject);
      } else if (child?.code === 0) {
        resolve();
      } else {
        reject(new Error(`npm 退出码 ${child?.code}`));
      }
    });
  } catch (e) {
    log(`[webcli] 升级失败(保留原版本 ${currentVersion}):${e.message}`);
    log(`[webcli] 可手动执行:${buildInstallCommand(pkgName, latest, registry)}`);
    return { upgraded: false, latest, error: e.message };
  }
  for (const dir of serviceWorkerCacheDirs(home)) {
    try {
      await existsImpl(dir);
      (removeImpl ?? ((d) => rmSync(d, { recursive: true, force: true })))(dir);
      log(`[webcli] 已清理 Service Worker 缓存:${dir}`);
    } catch { /* 目录不存在或清理失败:仅提示性忽略 */ }
  }
  log(`[webcli] 已升级到 ${latest}。请重启 bridge / 重启浏览器扩展后生效。`);
  return { upgraded: true, latest };
}
