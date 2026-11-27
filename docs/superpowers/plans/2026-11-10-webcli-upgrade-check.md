# webcli 版本自检与 upgrade 命令 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** webcli 每次命令运行时(24h TTL 缓存)比对 registry 最新版,落后则 stderr 提示;`webcli upgrade` 一条命令升级并自动清理 Service Worker 缓存;桌面端内嵌模式整段关闭。

**Architecture:** 新建独立模块 `webcli/version-check.js`(semver 比较/缓存/notice)与 `webcli/upgrade.js`(升级编排),`index.js` 只做接线;weworker 桌面端两处 spawn env 注入 `WEBCLI_EMBEDDED=1`。

**Tech Stack:** webcli vitest;weworker TypeScript(仅 env 一行)。

**Spec:** docs/superpowers/specs/2026-11-10-webcli-version-check-upgrade-design.md
**分支:** feat/webcli-upgrade-check(基线 upstream/dev-1.1.0)
**注意:** `weworker/changelog.json` 未提交改动绝不 add;`docs/superpowers/plans/` 不入库。

---

### Task 1: version-check 模块(semver + 缓存 + notice)

**Files:**
- Create: `webcli/version-check.js`
- Test: `webcli/__tests__/version-check.test.js`(新建)

- [ ] **Step 1: 写失败测试**(新建文件)

```js
// Feature: webcli-version-check, 版本自检 + upgrade
import { describe, it, expect } from 'vitest'
import { compareSemver, checkForUpdate, readVersionCache, writeVersionCache, resolveRegistry } from '../version-check.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpFile = () => join(tmpdir(), `vc-${randomUUID()}.json`)

describe('compareSemver', () => {
  it('数字段比较', () => {
    expect(compareSemver('1.1.8', '1.1.11')).toBe(-1)
    expect(compareSemver('1.1.10', '1.1.9')).toBe(1)
    expect(compareSemver('1.1.8', '1.1.8')).toBe(0)
    expect(compareSemver('1.2', '1.1.9')).toBe(1)
  })
})

describe('checkForUpdate', () => {
  const base = { currentVersion: '1.1.8', pkgName: '@webank/webcli', registry: 'http://x:8001' }

  it('缓存落后 → 返回提示(零网络)', async () => {
    const file = tmpFile()
    await writeVersionCache({ latest: '1.1.11', checkedAt: Date.now() }, file)
    const notice = await checkForUpdate({ ...base, file })
    expect(notice).toContain('1.1.11')
    expect(notice).toContain('webcli upgrade')
  })
  it('缓存最新 / 相同 → null', async () => {
    const file = tmpFile()
    await writeVersionCache({ latest: '1.1.8', checkedAt: Date.now() }, file)
    expect(await checkForUpdate({ ...base, file })).toBe(null)
  })
  it('无缓存/过期 → 触发后台刷新并写缓存,本次不打提示', async () => {
    const file = tmpFile()
    let fetched = 0
    const fetchImpl = async () => { fetched++; return { ok: true, json: async () => ({ version: '1.1.11' }) } }
    const notice = await checkForUpdate({ ...base, file, fetchImpl, now: 1_000_000_000_000 })
    expect(notice).toBe(null)
    expect(fetched).toBe(1)
    expect((await readVersionCache(file)).latest).toBe('1.1.11')
  })
  it('内嵌模式(WEBCLI_EMBEDDED)直接 null,不读不写', async () => {
    const file = tmpFile()
    const notice = await checkForUpdate({ ...base, file, embedded: true })
    expect(notice).toBe(null)
    expect(await readVersionCache(file)).toBe(null)
  })
})

describe('resolveRegistry', () => {
  it('按包名自推导,可覆盖', () => {
    expect(resolveRegistry('@webank/webcli')).toBe('http://wnpm.weoa.com:8001')
    expect(resolveRegistry('weworker-webcli')).toBe('https://registry.npmjs.org')
    expect(resolveRegistry('@webank/webcli', 'http://override:8001')).toBe('http://override:8001')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/version-check.test.js
```
预期:FAIL——模块不存在。

- [ ] **Step 3: 实现**(新建 `webcli/version-check.js`)

```js
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
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/version-check.test.js
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add webcli/version-check.js webcli/__tests__/version-check.test.js
git commit -m "feat(webcli): 版本自检模块(semver/缓存/notice)"
```

---

### Task 2: upgrade 命令模块

**Files:**
- Create: `webcli/upgrade.js`
- Test: `webcli/__tests__/upgrade.test.js`(新建)

- [ ] **Step 1: 写失败测试**(新建文件)

```js
import { describe, it, expect } from 'vitest'
import { runUpgrade, buildInstallCommand, fetchLatestVersion } from '../upgrade.js'

describe('fetchLatestVersion', () => {
  it('取 manifest.version;非 ok/缺 version 抛错', async () => {
    expect(await fetchLatestVersion('http://r', 'pkg', async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) }))).toBe('2.0.0')
    await expect(fetchLatestVersion('http://r', 'pkg', async () => ({ ok: false, json: async () => ({}) }))).rejects.toThrow()
  })
})

describe('buildInstallCommand', () => {
  it('npm -g 安装带 registry', () => {
    expect(buildInstallCommand('@webank/webcli', '1.1.11', 'http://wnpm.weoa.com:8001'))
      .toBe('npm install -g @webank/webcli@1.1.11 --registry=http://wnpm.weoa.com:8001')
  })
})

describe('runUpgrade', () => {
  const mk = (over = {}) => ({
    pkgName: '@webank/webcli', currentVersion: '1.1.8',
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.1.11' }) }),
    spawnImpl: async () => ({ code: 0 }),
    removeImpl: async () => {}, existsImpl: async () => true,
    log: () => {}, registryOverride: null, home: '/h', embedded: false, ...over,
  })

  it('已是最新 → 跳过安装', async () => {
    let spawned = 0
    const res = await runUpgrade(mk({ currentVersion: '1.1.11', spawnImpl: async () => { spawned++; return { code: 0 } } }))
    expect(res.upgraded).toBe(false)
    expect(spawned).toBe(0)
  })
  it('落后 → npm 安装 + 清理 SW 缓存 + upgraded', async () => {
    const calls = []
    const res = await runUpgrade(mk({
      spawnImpl: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0 } },
      removeImpl: async (dir) => { calls.push(['rm', dir]) },
    }))
    expect(res.upgraded).toBe(true)
    expect(res.latest).toBe('1.1.11')
    expect(calls[0][0]).toBe('npm')
    expect(calls.some((c) => c[0] === 'rm' && c[1].includes('Service Worker'))).toBe(true)
  })
  it('npm 失败 → 保留原版本,upgraded=false', async () => {
    const res = await runUpgrade(mk({ spawnImpl: async () => ({ code: 1 }) }))
    expect(res.upgraded).toBe(false)
    expect(res.error).toBeTruthy()
  })
  it('内嵌模式 → 不装不查,提示走应用更新', async () => {
    let fetched = 0
    const res = await runUpgrade(mk({ embedded: true, fetchImpl: async () => { fetched++; throw new Error('should not fetch') } }))
    expect(res.upgraded).toBe(false)
    expect(res.embedded).toBe(true)
    expect(fetched).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/upgrade.test.js
```
预期:FAIL——模块不存在。

- [ ] **Step 3: 实现**(新建 `webcli/upgrade.js`)

```js
/**
 * webcli upgrade —— 一条命令升级全局安装的 webcli 并自动清理 Service Worker 缓存。
 * 包名/registry 取自运行中包自身身份(@webank/webcli → 行内 wnpm;weworker-webcli → npmjs),
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
 * @returns {{upgraded:boolean, latest?:string, error?:string, embedded?:boolean}}
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
    await new Promise((resolve, reject) => {
      const child = spawnImpl(installCmd[0], installCmd.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm 退出码 ${code}`))));
      child.on("error", reject);
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
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/upgrade.test.js
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add webcli/upgrade.js webcli/__tests__/upgrade.test.js
git commit -m "feat(webcli): upgrade 命令模块(npm 升级 + SW 缓存清理)"
```

---

### Task 3: index.js 接线(notice 钩子 + upgrade 命令)

**Files:**
- Modify: `webcli/index.js`(BUILTIN_COMMANDS 集合约 1256 行、main() 入口约 1518 行、分派区约 1584 行前)

- [ ] **Step 1: BUILTIN_COMMANDS 加 `upgrade`**

```js
const BUILTIN_COMMANDS = new Set([
  "--version", "-v", "--help", "-h", "-help", "--service",
  "extension-path", "adapter", "service", "call", "route", "trace", "install",
  "list", "skills", "completion", "mcp", "mcp-logs", "browser", "login", "auth",
  "upgrade",
]);
```

- [ ] **Step 2: main() 里加 notice 钩子与 upgrade 分派**

在 `async function main() {` 内、`// --version / -v` 分派块(`if (cmd === "--version" || cmd === "-v")`)之前插入:

```js
  // ── 版本自检(内嵌/协议命令豁免;stderr 提示,stdout 永不污染) ────────────
  const VERSION_CHECK_EXEMPT = new Set(["--version", "-v", "upgrade", "--service", "internal-ai-call", "mcp"]);
  if (!VERSION_CHECK_EXEMPT.has(cmd)) {
    try {
      const { checkForUpdate } = await import("./version-check.js");
      let pkgInfo = null;
      try { pkgInfo = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")); } catch {}
      if (pkgInfo?.name && pkgInfo?.version) {
        const notice = await checkForUpdate({
          currentVersion: pkgInfo.version,
          pkgName: pkgInfo.name,
          registry: resolveRegistryShim(pkgInfo.name),
          embedded: process.env.WEBCLI_EMBEDDED === "1",
        });
        if (notice) process.stderr.write(notice + "\n");
      }
    } catch { /* 版本检查绝不影响命令 */ }
  }

  // ── upgrade 命令 ──────────────────────────────────────────────────────────
  if (cmd === "upgrade") {
    const { runUpgrade } = await import("./upgrade.js");
    const args2 = process.argv.slice(3);
    const registryOverride = args2.includes("--registry") ? args2[args2.indexOf("--registry") + 1] : null;
    let pkgInfo = null;
    try { pkgInfo = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")); } catch {}
    if (!pkgInfo?.name || !pkgInfo?.version) {
      console.log("webcli (unknown version)——无法升级,请手动重装。");
      return;
    }
    if (args2.includes("--json")) {
      const { resolveRegistry, compareSemver } = await import("./version-check.js");
      const registry = resolveRegistry(pkgInfo.name, registryOverride ?? process.env.WEBCLI_UPGRADE_REGISTRY ?? null);
      const { fetchLatestVersion } = await import("./upgrade.js");
      const latest = await fetchLatestVersion(registry, pkgInfo.name).catch(() => null);
      console.log(JSON.stringify({ current: pkgInfo.version, latest, registry, updateAvailable: latest ? compareSemver(pkgInfo.version, latest) < 0 : null }));
      return;
    }
    const res = await runUpgrade({
      pkgName: pkgInfo.name,
      currentVersion: pkgInfo.version,
      registryOverride,
      embedded: process.env.WEBCLI_EMBEDDED === "1",
    });
    process.exitCode = res.upgraded ? 0 : res.error ? 1 : 0;
    return;
  }
```

同文件顶部(现有 import 区末尾)加一个轻量 shim(避免 notice 路径 import upgrade.js):

```js
import { resolveRegistry as resolveRegistryShim } from "./version-check.js";
```

- [ ] **Step 3: 语法与冒烟校验**

```bash
cd D:/github/WeWorker-fork/webcli && node --check index.js && node index.js --version && node index.js upgrade --check --json
```
预期:版本号正常打印;upgrade --check --json 输出 `{"current":...,"latest":...,"registry":"http://wnpm.weoa.com:8001","updateAvailable":...}`(行内网络可达时)。

- [ ] **Step 4: 全量测试**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/version-check.test.js __tests__/upgrade.test.js __tests__/metrics.test.js
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add webcli/index.js
git commit -m "feat(webcli): 命令入口版本自检提示与 upgrade 命令接线"
```

---

### Task 4: 桌面端护栏(weworker 注入 WEBCLI_EMBEDDED)

**Files:**
- Modify: `weworker/backend-ts/src/webcli-runner.ts`(约 92-95 行 env 构造)
- Modify: `weworker/backend-ts/src/server.ts`(约 255 行 execFile env 构造)

- [ ] **Step 1: 两处 env 注入**

webcli-runner.ts env 对象加一行:

```ts
  const env = {
    ...process.env,
    ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: getOpenBrowserAllowedOrigins().join(','),
    WEBCLI_EMBEDDED: '1', // 桌面端内嵌 webcli:关闭版本自检与 npm 升级(随应用更新)
  }
```

server.ts 的 execFile env 构造处同样加 `WEBCLI_EMBEDDED: '1'`(找到该 execFile 的 env 来源对象,同一写法;若 env 直接透传 `process.env`,则改为 `{ ...process.env, WEBCLI_EMBEDDED: '1' }`)。

- [ ] **Step 2: 类型构建校验**

```bash
cd D:/github/WeWorker-fork/weworker/backend-ts && npx tsc --noEmit -p tsconfig.json 2>&1 | head -5
```
预期:无新增错误(与改动无关的既有告警可忽略,记录即可)。

- [ ] **Step 3: 提交**

```bash
git add weworker/backend-ts/src/webcli-runner.ts weworker/backend-ts/src/server.ts
git commit -m "feat(desktop): 内嵌 webcli 标记 WEBCLI_EMBEDDED,关闭版本自检与 npm 升级"
```

---

### Task 5: 端到端验证

- [ ] **Step 1: 全量测试**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/version-check.test.js __tests__/upgrade.test.js __tests__/metrics.test.js
```
预期:全部 PASS。

- [ ] **Step 2: 手动冒烟(行内网络环境)**

```bash
cd D:/github/WeWorker-fork/webcli
# 首次:写缓存后台刷新
node index.js --help; sleep 3; cat ~/.webcli/version-check.json
# 第二次:应看到 stderr 提示(当前本地版本 < registry latest 时)
node index.js list 2>&1 | grep "\[webcli\] 有新版本" | head -1
# 只查不装
node index.js upgrade --check --json
# 内嵌豁免
WEBCLI_EMBEDDED=1 node index.js list 2>&1 | grep -c "有新版本"   # 期望 0
```
预期:缓存文件出现 latest;提示出现;内嵌为 0。(不真正执行 `upgrade` 安装,避免动到全局环境——upgrade 逻辑已由 fake spawn 测试覆盖。)

- [ ] **Step 3: 汇总**

汇报:改动文件、测试结果、冒烟输出;提醒发布链路(随 1.1.12 行内包发布,首版需 release 说明提醒手动升一次)。
