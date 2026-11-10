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
 * 升级编排。依赖全部可注入以便测试。
 * @returns {Promise<{upgraded:boolean, latest?:string, error?:string, embedded?:boolean}>}
 */
export async function runUpgrade({
  pkgName, currentVersion, registryOverride = null,
  fetchImpl = fetch, spawnImpl = spawn, removeImpl = null, existsImpl = stat, home = homedir(),
  log = console.log, embedded = false,
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
