# 上报用户名兜底(HRM 解析)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** whoami 失败的机器经扩展代取 HRM 接口解析真实用户名,本地缓存后上报;metrics-server 按上报自动修正该机器存量降级行。

**Architecture:** 三段——client(metrics.js 缓存 + bridge 解析编排)、extension(identity_fetch 处理器,带登录态 fetch)、server(insertBatch 事务内 backfill UPDATE)。查询层零改动。

**Tech Stack:** webcli vitest(`npm run test`,webcli/__tests__);metrics-server node --test(Node ≥22)。

**Spec:** docs/superpowers/specs/2026-11-10-metrics-user-fallback-design.md
**分支:** feat/metrics-user-fallback-dev110(基线 upstream/dev-1.1.0)
**注意:** 工作区 `weworker/changelog.json` 有未提交改动,绝不 add;`docs/superpowers/plans/` 不入库。

---

### Task 1: metrics-server — insertBatch 身份修正(backfill)

**Files:**
- Modify: `metrics-server/db.js`(insertBatch,约 122-163 行)
- Test: `metrics-server/__tests__/server.test.js`

- [ ] **Step 1: 写失败测试**(追加到 server.test.js 末尾)

```js
test("insertBatch 身份修正:userSource=hrm 改写该机器存量降级行", () => {
  const db = freshDb();
  const now = Date.now();
  // 先以降级名入库
  insertBatch(db, { clientId: "c1", user: "client-ab12cd34", batch: [rec({ ts: now, traceID: "f1" })] });
  // 解析成功后的上报(userSource=hrm)
  insertBatch(db, { clientId: "c1", user: "rickhuang", userSource: "hrm", batch: [rec({ ts: now, traceID: "f2" })] });
  const rows = db.prepare("SELECT user FROM metrics WHERE client_id='c1'").all();
  assert.ok(rows.length === 2 && rows.every((r) => r.user === "rickhuang"), "存量与新行都应是真实名");
});

test("insertBatch 身份修正:只改降级行,whoami 真实名不动;其他机器不受影响", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, { clientId: "c1", user: "alice", batch: [rec({ ts: now, traceID: "g1" })] });
  insertBatch(db, { clientId: "c1", user: "client-ab12cd34", batch: [rec({ ts: now, traceID: "g2" })] });
  insertBatch(db, { clientId: "c2", user: "client-xxxxxxxx", batch: [rec({ ts: now, traceID: "g3" })] });
  insertBatch(db, { clientId: "c1", user: "rickhuang", userSource: "hrm-cache", batch: [rec({ ts: now, traceID: "g4" })] });
  const byTrace = Object.fromEntries(db.prepare("SELECT trace_id, user FROM metrics").all().map((r) => [r.trace_id, r.user]));
  assert.equal(byTrace.g1, "alice");            // whoami 真实行不动
  assert.equal(byTrace.g2, "rickhuang");        // 降级行被修正
  assert.equal(byTrace.g3, "client-xxxxxxxx");  // 其他机器不受影响
  assert.equal(byTrace.g4, "rickhuang");
});

test("insertBatch 身份修正:空 user 行(unknown 源)也修正;无 userSource 不触发;幂等", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, { clientId: "c1", batch: [rec({ ts: now, traceID: "h1" })] }); // user 缺失 → NULL
  insertBatch(db, { clientId: "c1", user: "rickhuang", batch: [rec({ ts: now, traceID: "h2" })] }); // 无 userSource
  let rows = db.prepare("SELECT trace_id, user FROM metrics WHERE client_id='c1' ORDER BY trace_id").all();
  assert.equal(rows.find((r) => r.trace_id === "h1").user, null); // 未触发
  // 触发一次
  insertBatch(db, { clientId: "c1", user: "rickhuang", userSource: "hrm", batch: [rec({ ts: now, traceID: "h3" })] });
  rows = db.prepare("SELECT user FROM metrics WHERE client_id='c1'").all();
  assert.ok(rows.every((r) => r.user === "rickhuang"));
  // 重复触发无害
  insertBatch(db, { clientId: "c1", user: "rickhuang", userSource: "hrm", batch: [rec({ ts: now, traceID: "h3" })] });
  rows = db.prepare("SELECT user FROM metrics WHERE client_id='c1'").all();
  assert.ok(rows.every((r) => r.user === "rickhuang"));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:3 个新用例 FAIL(现实现不改写存量;h1 行为 null、f1/g2 行为 client-*)。

- [ ] **Step 3: 实现**(insertBatch 的 for 循环之后、`db.exec("COMMIT")` 之前插入)

```js
    // 身份修正(方案 X backfill):客户端经 HRM 解析出真实用户名后,改写该机器
    // 的存量降级行(client-* / 空 user)。whoami 来源的真实行永不触碰;幂等无害。
    if (
      (body.userSource === "hrm" || body.userSource === "hrm-cache") &&
      clientId && user
    ) {
      db.prepare(
        `UPDATE metrics SET user = ?
         WHERE client_id = ? AND (user IS NULL OR user = '' OR user LIKE 'client-%')`
      ).run(user, clientId);
    }
```

并在 insertBatch 的 JSDoc 里补一行:`@param {string} [body.userSource] 用户名来源;hrm/hrm-cache 时触发存量降级行身份修正`。

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add metrics-server/db.js metrics-server/__tests__/server.test.js
git commit -m "feat(metrics-server): userSource=hrm 上报自动修正存量降级用户名"
```

---

### Task 2: webcli/metrics.js — 身份缓存与 buildUploadConfig 优先级

**Files:**
- Modify: `webcli/metrics.js`(CLIENT_ID_FILE 常量区、buildUploadConfig)
- Test: `webcli/__tests__/metrics.test.js`(追加)

- [ ] **Step 1: 写失败测试**(metrics.test.js 末尾追加;注意 import 行加 `loadIdentityCache, saveIdentityCache`)

```js
import { randomUUID } from 'node:crypto'
import { loadIdentityCache, saveIdentityCache, buildUploadConfig } from '../metrics.js'

describe('身份缓存与 buildUploadConfig 优先级', () => {
  it('save/load 往返与合并', async () => {
    const file = join(os.tmpdir(), `identity-${randomUUID()}.json`)
    await saveIdentityCache({ user: 'rickhuang', resolvedAt: 1 }, file)
    await saveIdentityCache({ lastFailedAt: 2 }, file)
    const cache = await loadIdentityCache(file)
    expect(cache).toEqual({ user: 'rickhuang', resolvedAt: 1, lastFailedAt: 2 })
  })
  it('缓存真实名优先于 whoami,来源 hrm-cache', async () => {
    const file = join(os.tmpdir(), `identity-${randomUUID()}.json`)
    await saveIdentityCache({ user: 'rickhuang' }, file)
    const cfg = await buildUploadConfig({ webcliVersion: 't', identityCacheFile: file })
    expect(cfg.meta.user).toBe('rickhuang')
    expect(cfg.meta.userSource).toBe('hrm-cache')
  })
  it('无缓存走 whoami;whoami 失败降级 client-<id8>', async () => {
    const file = join(os.tmpdir(), `identity-${randomUUID()}.json`)
    const cfg = await buildUploadConfig({ webcliVersion: 't', identityCacheFile: file, whoamiImpl: () => 'alice' })
    expect(cfg.meta.userSource).toBe('whoami')
    const cfg2 = await buildUploadConfig({ webcliVersion: 't', identityCacheFile: file, whoamiImpl: () => null })
    expect(cfg2.meta.userSource).toBe('client-id-fallback')
    expect(cfg2.meta.user).toMatch(/^client-.{8}$/)
  })
})
```

(import 区补 `import os from 'node:os'`、`import { join } from 'node:path'`——若测试文件已有则不重复;确认 metrics.test.js 现有 import 行把 `buildUploadConfig` 的旧 import 与新 import 合并。)

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/metrics.test.js
```
预期:FAIL——`loadIdentityCache` 未导出;buildUploadConfig 不吃 identityCacheFile/whoamiImpl。

- [ ] **Step 3: 实现**(metrics.js)

CLIENT_ID_FILE 常量后新增:

```js
const USER_CACHE_FILE        = path.join(METRICS_DIR, "user-cache.json");
```

whoami 函数后新增:

```js
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
```

buildUploadConfig 整体替换(签名加 identityCacheFile/whoamiImpl 两个测试注入口):

```js
export async function buildUploadConfig({ webcliVersion, identityCacheFile = null, whoamiImpl = whoami } = {}) {
  const endpoint = process.env.WEBCLI_METRICS_ENDPOINT || DEFAULT_ENDPOINT;
  const token = process.env.WEBCLI_METRICS_TOKEN || DEFAULT_TOKEN;
  const uploadOn = process.env.WEBCLI_METRICS_UPLOAD === "on";
  const enabled =
    process.env.WEBCLI_METRICS !== "off" && uploadOn && !!endpoint;

  const clientId = await getOrCreateClientId();
  const identity = await loadIdentityCache(identityCacheFile ?? undefined);
  const cachedUser = typeof identity.user === "string" && identity.user ? identity.user : null;
  const systemUser = whoamiImpl();
  // 优先级:HRM 解析缓存 > 系统用户 > clientId 降级。userSource 标记来源,
  // 服务端对 hrm/hrm-cache 上报做存量降级行身份修正(见 metrics-server db.js)。
  const meta = {
    clientId,
    user: cachedUser || systemUser || `client-${clientId.slice(0, 8)}`,
    userSource: cachedUser ? "hrm-cache" : systemUser ? "whoami" : "client-id-fallback",
    webcliVersion,
    os: process.platform,
  };

  return { endpoint: enabled ? endpoint : null, token, meta };
}
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/webcli && npx vitest --run __tests__/metrics.test.js
```
预期:新 3 例 PASS,既有用例不破。

- [ ] **Step 5: 提交**

```bash
git add webcli/metrics.js webcli/__tests__/metrics.test.js
git commit -m "feat(webcli): 上报用户名缓存优先级(hrm-cache > whoami > client-xx)"
```

---

### Task 3: bridge 解析编排 + extension identity_fetch

**Files:**
- Modify: `webcli/bridge.js`(约 617 行 _metricsCfg 赋值处、_handleExtensionMessage accepted 集合约 889 行、新方法 maybeResolveIdentity)
- Modify: `extension/background/service-worker.js`(msg.type 分派链,约 2798 行区域)
- Test: `node --check` 语法校验 + Task 4 端到端

- [ ] **Step 1: bridge 新增编排方法**(Bridge 类内、_request 定义附近)

```js
  // ─── 上报身份兜底:whoami 失败时经扩展代取 HRM 用户名 ─────────────────────
  static IDENTITY_BACKOFF_MS = 60 * 60 * 1000;
  static IDENTITY_TIMEOUT_MS = 5000;

  async maybeResolveIdentity() {
    try {
      const cache = await loadIdentityCache();
      const now = Date.now();
      if (cache.user) return;                                              // 已有真实名
      if (cache.lastFailedAt && now - cache.lastFailedAt < Bridge.IDENTITY_BACKOFF_MS) return; // 退避中
      const ws = this._currentConnection()?.ws ?? this._extensionWs;
      if (!ws || ws.readyState !== 1) {                                    // 扩展未连接:不启动浏览器
        await saveIdentityCache({ lastFailedAt: now });
        return;
      }
      await saveIdentityCache({ lastAttemptAt: now });
      const response = await this._requestNow({ type: "identity_fetch" }, Bridge.IDENTITY_TIMEOUT_MS);
      const user = response && response.ok ? response.user : null;
      if (typeof user === "string" && user) {
        await saveIdentityCache({ user, resolvedAt: Date.now(), lastFailedAt: null });
        if (this._metricsCfg?.meta) {
          this._metricsCfg.meta.user = user;
          this._metricsCfg.meta.userSource = "hrm";
        }
      } else {
        await saveIdentityCache({ lastFailedAt: Date.now() });
      }
    } catch { /* 身份解析永不影响主流程 */ }
  }
```

import 区(metrics.js 的导入行)把 `reportMetric, buildUploadConfig` 扩为
`reportMetric, buildUploadConfig, loadIdentityCache, saveIdentityCache`。

- [ ] **Step 2: 接线两处**

1. `_metricsCfg = await buildUploadConfig({...})` 赋值语句(约 617 行)之后紧跟一行:

```js
      this.maybeResolveIdentity().catch(() => {});   // fire-and-forget,绝不阻塞 init
```

2. `_handleExtensionMessage` 的 accepted 集合(约 889 行)加 `identity_fetch_result`:

```js
    const accepted = new Set(['call_tool_result', 'call_tool_error', 'list_tools_result', 'get_active_tab_result', 'get_trace_logs_result', 'validate_generation_preview_result', 'identity_fetch_result']);
```

(注:分派入口的 else-if 链约 719 行把 result 型消息路由到 _handleExtensionMessage 的条件是列表字面量,同样追加 `|| msg.type === 'identity_fetch_result'`。)

- [ ] **Step 3: extension 处理器**(service-worker.js,`msg.type === "call_tool"` 所在 if/else 链同级新增分支)

```js
  } else if (msg.type === "identity_fetch") {
    (async () => {
      try {
        const resp = await fetch("https://weoa.com/weoa/api/hrm/getUserInfo", { credentials: "include" });
        const data = await resp.json().catch(() => null);
        const user = extractIdentityUsername(data);
        sendToNative({ type: "identity_fetch_result", id: msg.id, ok: !!user, ...(user ? { user } : { error: "no username in HRM response" }) });
      } catch (err) {
        sendToNative({ type: "identity_fetch_result", id: msg.id, ok: false, error: err?.message || "identity fetch failed" });
      }
    })();
  }
```

同文件工具函数区(任意顶层位置)新增:

```js
/** HRM getUserInfo 响应里探测登录名:字段链覆盖已知形态,全空返回 null。 */
function extractIdentityUsername(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.username, data.userName, data.loginName, data.account, data.workCode,
    data.user && data.user.loginName, data.user && data.user.name,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
```

- [ ] **Step 4: 语法校验**

```bash
cd D:/github/WeWorker-fork && node --check webcli/bridge.js && node --check extension/background/service-worker.js && npx vitest --run __tests__/metrics.test.js
```
预期:无语法错误,metrics 测试全绿。(扩展无独立测试设施,以 node --check + Task 4 端到端验证;这是对 spec 测试清单的已注明的简化。)

- [ ] **Step 5: 提交**

```bash
git add webcli/bridge.js extension/background/service-worker.js
git commit -m "feat(webcli/extension): whoami 失败时经扩展代取 HRM 用户名并缓存"
```

---

### Task 4: 端到端验证

- [ ] **Step 1: HRM 真实响应字段确认**(登录态;二选一)

用 sessionbridge 技能(读浏览器 cookie)请求 `https://weoa.com/weoa/api/hrm/getUserInfo`,
或让用户在已登录桌面端/浏览器环境执行:

```bash
curl -s --noproxy '*' -b "<登录cookie>" "https://weoa.com/weoa/api/hrm/getUserInfo"
```

确认 username 实际字段名;若不在探测链里,补进 `extractIdentityUsername`(并同步调整测试计划备注)。

- [ ] **Step 2: 本地链路冒烟**

```bash
cd D:/github/WeWorker-fork/webcli
WEBCLI_METRICS_UPLOAD=on WEBCLI_METRICS_ENDPOINT=http://127.0.0.1:8787/v1/metrics/batch node index.js --version
```
预期:正常打印版本(解析在 bridge 模式触发,--version 不经 bridge;此步只验证 import 无损)。
完整链路(bridge + 扩展)依赖真机浏览器环境,交由用户日常使用观察:
`~/.webcli/user-cache.json` 出现 `user` 字段、看板 by=user 不再出现该机器 client-xx。

- [ ] **Step 3: 清理与汇总**

确认无临时文件残留;汇报:改动文件、测试结果、真机观察点(user-cache.json、看板用户名)。
