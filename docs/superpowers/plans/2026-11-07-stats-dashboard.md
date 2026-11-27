# Stats 看板:错误聚合/用户活跃/日期筛选 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 官网 Stats 看板支持按错误类型视图、用户日活/月活、近90天与自定义日期范围筛选;metrics-server 补齐 `by=active` 聚合与 `from`/`to` 参数,并收敛噪音 SQL。

**Architecture:** 后端在 `metrics-server/db.js` 统一时间窗解析(`resolveWindow`)并穿透到全部聚合函数,新增 `by=active`(逐日 DAU + 固定近30天 MAU);`handler.js` 校验 `from`/`to`(非法 400)。前端 `officialWeb` 数据层加噪音名单兜底与 `from`/`to` 透传,页面加第三个「按错误」视图、时间筛选改造和「用户活跃」区块。全程走既有 `/api/stats` 代理路径,vite/Nginx 零改动。

**Tech Stack:** Node ≥22 内置 `node:sqlite` + `node:test`(零依赖);React 19 + Vite(officialWeb,无测试设施)。

**Spec:** `docs/superpowers/specs/2026-11-07-stats-dashboard-design.md`(已提交)

**分支:** `feat/metrics-dashboard-dev110`(已建,基于 upstream/dev-1.1.0,spec 已提交 a579ef2)

**注意:** 工作区有无关未跟踪文件(webcli/login-recovery 等)与 `officialWeb/src/lib/stats.js` 的 WIP 改动(countActiveUsers/fetchActiveUsers,会被 Task 5 重写覆盖)。提交时只 `git add` 各任务明确列出的文件,绝不 `git add -A`。`docs/superpowers/plans/` 下计划文件**不入库**(仓库惯例:specs 入库、plans 不入库)。

---

### Task 1: db.js — resolveWindow + 噪音清单收敛

**Files:**
- Modify: `metrics-server/db.js:172-192`(噪音段)、`metrics-server/db.js:210-222`(queryStats 内联噪音串)
- Test: `metrics-server/__tests__/server.test.js`

- [ ] **Step 1: 写失败测试**

在 `metrics-server/__tests__/server.test.js` 末尾追加(import 行加 `resolveWindow, noiseExcludeClause`):

```js
import { openDb, insertBatch, queryStats, pickWhitelist, validRecord, resolveWindow, noiseExcludeClause } from "../db.js";

test("resolveWindow:默认 since 相对窗,无上界", () => {
  const { start, end } = resolveWindow({ since: "7d" });
  const expected = Date.now() - 7 * 86400000;
  assert.ok(Math.abs(start - expected) < 1000); // 允许毫秒级时钟差
  assert.equal(end, null);
});

test("resolveWindow:from/to 自定义窗,UTC 日界,to 含当天", () => {
  const { start, end } = resolveWindow({ from: "2026-01-05", to: "2026-01-07" });
  assert.equal(start, Date.parse("2026-01-05T00:00:00Z"));
  assert.equal(end, Date.parse("2026-01-08T00:00:00Z")); // to 次日 00:00
});

test("resolveWindow:只给 to → 下界为 since 相对窗", () => {
  const { start, end } = resolveWindow({ since: "7d", to: "2026-01-07" });
  assert.equal(end, Date.parse("2026-01-08T00:00:00Z"));
  assert.ok(Math.abs(start - (Date.now() - 7 * 86400000)) < 1000);
});

test("queryStats:噪音工具(flag 误用 / 名单首段含 wecli)不计入", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: now, traceID: "n1", tool: "-flag.misuse", domain: "-flag" }),
      rec({ ts: now, traceID: "n2", tool: "skill.list", domain: "skill" }),
      rec({ ts: now, traceID: "n3", tool: "wecli.mgmt.call", domain: "wecli.mgmt" }),
      rec({ ts: now, traceID: "ok1", tool: "mail.163.com.get", domain: "mail.163.com" }),
    ],
  });
  const { rows } = queryStats(db, { by: "domain", since: "1d" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "mail.163.com");
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:FAIL,`resolveWindow` 未导出(`The module ... does not provide an export named 'resolveWindow'`);wecli 用例 FAIL(现 SQL 排除名单不含 wecli 时 `wecli.mgmt.call` 会计入)。

- [ ] **Step 3: 实现**

`metrics-server/db.js`:

1. `NOISE_FIRST_SEGMENTS` 集合加 `"wecli"`(与 PR #326 内联清单对齐,误拼名),置于 `"webcli"` 之后:

```js
export const NOISE_FIRST_SEGMENTS = new Set([
  "skill", "skills", "tool", "tools", "adapter", "adapters", "adapterhub",
  "service", "call", "route", "routes", "trace", "traces", "install", "list",
  "completion", "mcp", "mcp-logs", "browser", "login", "auth", "extension-path",
  "stats", "webcli", "wecli", "help", "mode", "profiles", "capabilities", "tabs",
  "list_sites", "inspect_page_state", "evaluate_in_page", "version", "doctor",
]);
```

2. 删除 `noiseClauseFor()`(与 `noiseExcludeClause` 完全重复),保留导出的 `noiseExcludeClause()`。

3. `queryStats` 主查询里那串内联 `AND tool NOT LIKE '-%' AND substr(...)` 长串替换为 `${noiseExcludeClause()}`;同样替换 `queryByErr`、`queryByUser` 里的内联长串(它们原本已在用 `noiseExcludeClause()` 之外又重复内联了一份,去掉重复那份)。

4. 在 `parseDuration` 之前新增:

```js
/**
 * 解析查询时间窗。
 * @param {{since?:string, from?:string|null, to?:string|null}} opts
 *   - from/to:YYYY-MM-DD(UTC 日界);任一出现即自定义窗,缺 from 时下界沿用 since 相对窗,缺 to 时上界不设(end=null)
 *   - 都不出现:since 相对窗(start = now - parseDuration(since),无上界)
 *   - 非法格式的 from/to 会产生 NaN 边界(SQL 匹配零行),由 handler 层 dayParam 保证格式
 * @returns {{start:number, end:number|null}} end 为 null 表示不设上界
 */
export function resolveWindow({ since = "30d", from = null, to = null } = {}) {
  const start = from ? Date.parse(`${from}T00:00:00Z`) : Date.now() - parseDuration(since);
  const end = to ? Date.parse(`${to}T00:00:00Z`) + 86400000 : null;
  return { start, end };
}
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:全部 PASS(含既有用例——替换 `noiseExcludeClause()` 后语义不变)。

- [ ] **Step 5: 提交**

```bash
git add metrics-server/db.js metrics-server/__tests__/server.test.js
git commit -m "feat(metrics-server): 时间窗 resolveWindow + 噪音清单收敛(补 wecli)"
```

---

### Task 2: db.js — from/to 时间窗穿透全部聚合

**Files:**
- Modify: `metrics-server/db.js`(queryStats / queryByErr / queryByUser / queryRouteStats / queryVisits / percentilesFor / topToolFor)
- Test: `metrics-server/__tests__/server.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `server.test.js`(import 行加 `queryVisits, insertVisit`):

```js
import { openDb, insertBatch, queryStats, queryVisits, insertVisit, pickWhitelist, validRecord, resolveWindow, noiseExcludeClause } from "../db.js";

test("queryStats by=domain:from/to 按 UTC 日界过滤", () => {
  const db = freshDb();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: Date.parse("2026-01-05T10:00:00Z"), traceID: "w1" }),
      rec({ ts: Date.parse("2026-01-06T10:00:00Z"), traceID: "w2" }),
      rec({ ts: Date.parse("2026-01-08T10:00:00Z"), traceID: "w3" }), // to 外
    ],
  });
  const { totalCalls } = queryStats(db, { by: "domain", since: "30d", from: "2026-01-05", to: "2026-01-07" });
  assert.equal(totalCalls, 2);
});

test("queryStats by=err:from/to 生效", () => {
  const db = freshDb();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: Date.parse("2026-01-05T10:00:00Z"), traceID: "f1", ok: false, ms: 100, err: "HTTP_ERROR" }),
      rec({ ts: Date.parse("2026-01-08T10:00:00Z"), traceID: "f2", ok: false, ms: 100, err: "HTTP_ERROR" }),
    ],
  });
  const { totalFailed } = queryStats(db, { by: "err", since: "30d", from: "2026-01-05", to: "2026-01-07" });
  assert.equal(totalFailed, 1);
});

test("queryStats by=user:from/to 生效", () => {
  const db = freshDb();
  insertBatch(db, {
    clientId: "c1", user: "u1",
    batch: [rec({ ts: Date.parse("2026-01-05T10:00:00Z"), traceID: "v1" })],
  });
  insertBatch(db, {
    clientId: "c2", user: "u2",
    batch: [rec({ ts: Date.parse("2026-01-08T10:00:00Z"), traceID: "v2" })],
  });
  const { rows } = queryStats(db, { by: "user", since: "30d", from: "2026-01-05", to: "2026-01-07" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, "u1");
});

test("queryVisits:from/to 生效", () => {
  const db = freshDb();
  insertVisit(db, { ip: "10.0.0.1", ts: Date.parse("2026-01-05T10:00:00Z") });
  insertVisit(db, { ip: "10.0.0.2", ts: Date.parse("2026-01-09T10:00:00Z") });
  const { totalPv, totalUv } = queryVisits(db, { since: "30d", from: "2026-01-05", to: "2026-01-07" });
  assert.equal(totalPv, 1);
  assert.equal(totalUv, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:4 个新用例 FAIL。注意:fixture 用 2026-01 绝对日期,`since: "30d"` 相对窗(相对当下)在实现前会把它们全部排除,所以失败表现为 `0 !== 2` 之类,而非「3/2/2/2」——断言失败即红,语义成立。

- [ ] **Step 3: 实现**

`metrics-server/db.js`。在 `resolveWindow` 后新增时间窗 SQL 片段助手:

```js
/** 时间窗 WHERE 片段:`ts >= ? [AND ts < ?]`,参数按序 push 进 params。 */
function windowSql(start, end, params) {
  params.push(start);
  if (end != null) {
    params.push(end);
    return "ts >= ? AND ts < ?";
  }
  return "ts >= ?";
}
```

整函数替换 `queryStats`(注意 dispatch 增加 from/to 透传,`by=active` 分支 Task 3 才加):

```js
export function queryStats(db, { by = "domain", since = "30d", from = null, to = null, kind = null, top = null } = {}) {
  // 按用户聚合:user × domain 二维分布,结构不同于单维聚合,单独处理
  // 失败原因聚合(by=err):仅统计失败调用(ok=0),按脱敏后的 err 分组
  if (by === "err") return queryByErr(db, { since, from, to, top });
  if (by === "user") return queryByUser(db, { since, from, to, kind, top });

  // 路由决策埋点:route_* 事件聚合,结构不同于单维聚合
  if (by === "route") return queryRouteStats(db, { since, from, to });

  const col = by === "tool" ? "tool" : "domain";
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }

  const rows = db
    .prepare(
      `SELECT ${col} AS key,
              COUNT(*) AS calls,
              SUM(ok) AS oks,
              CAST(AVG(ms) AS INTEGER) AS avg_ms
       FROM metrics
       WHERE ${where} ${kindClause}
         ${noiseExcludeClause()}
       GROUP BY ${col}
       ORDER BY calls DESC`
    )
    .all(...params);

  // 百分位:对每个 key 单独取 ms 序列算(数据量不大时简单可靠)
  const result = rows.map((r) => {
    const p = percentilesFor(db, col, r.key, start, end, kind);
    const topTool = topToolFor(db, col, r.key, start, end, kind);
    return {
      key: r.key,
      calls: r.calls,
      okRate: r.calls ? +((r.oks / r.calls) * 100).toFixed(1) : 0,
      p50: p.p50,
      p95: p.p95,
      topTool: topTool.tool,
      topToolCalls: topTool.calls,
    };
  });

  const totalCalls = result.reduce((s, r) => s + r.calls, 0);
  const sliced = top ? result.slice(0, top) : result;
  return { rows: sliced, totalCalls };
}
```

整函数替换 `queryByErr`:

```js
function queryByErr(db, { since = "30d", from = null, to = null, top = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  const rows = db
    .prepare(
      `SELECT err,
              COUNT(*)                                        AS calls,
              COUNT(DISTINCT tool)                            AS tools,
              COUNT(DISTINCT user)                            AS users,
              MIN(tool)                                       AS sampleTool
       FROM metrics
       WHERE ${where} AND ok = 0${noiseExcludeClause()}
         AND err IS NOT NULL AND err != ''
       GROUP BY err
       ORDER BY calls DESC`
    )
    .all(...params);
  const sliced = top ? rows.slice(0, top) : rows;
  const totalFailed = rows.reduce((s, r) => s + r.calls, 0);
  return { rows: sliced, totalFailed };
}
```

整函数替换 `queryByUser`(top 截断逻辑不变):

```js
function queryByUser(db, { since = "30d", from = null, to = null, kind = null, top = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }

  // 空 user(whoami 失败等)归入 (unknown) 组而不是静默消失:
  // 调用次数与用户维度的总量必须一致,缺失可见才能被发现。
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(user, ''), '(unknown)') AS user, domain, COUNT(*) AS calls
       FROM metrics
       WHERE ${where} ${kindClause} ${noiseExcludeClause()}
       GROUP BY COALESCE(NULLIF(user, ''), '(unknown)'), domain
       ORDER BY user, calls DESC`
    )
    .all(...params);

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  // top 限制每个 user 的 domain 数(不限制 user 数,user 通常不多)
  let sliced = rows;
  if (top) {
    const perUser = new Map();
    sliced = rows.filter((r) => {
      const n = perUser.get(r.user) || 0;
      if (n >= top) return false;
      perUser.set(r.user, n + 1);
      return true;
    });
  }
  return { rows: sliced, totalCalls };
}
```

整函数替换 `queryRouteStats`:

```js
function queryRouteStats(db, { since = "30d", from = null, to = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS calls, CAST(AVG(ms) AS INTEGER) AS avg_ms
       FROM metrics WHERE ${where} AND kind LIKE 'route_%'
       GROUP BY kind ORDER BY calls DESC`
    )
    .all(...params);

  const byKind = rows.map((r) => {
    const p = [r.kind];
    const kindWhere = windowSql(start, end, p);
    const times = db
      .prepare(`SELECT ms FROM metrics WHERE kind = ? AND ${kindWhere} AND ms IS NOT NULL ORDER BY ms`)
      .all(...p)
      .map((x) => x.ms);
    return { kind: r.kind, calls: r.calls, p50: percentile(times, 50), p95: percentile(times, 95) };
  });

  const total = byKind.reduce((s, r) => s + r.calls, 0);
  const hits = byKind
    .filter((r) => r.kind.startsWith("route_hit"))
    .reduce((s, r) => s + r.calls, 0);
  const hitRate = total ? +((hits / total) * 100).toFixed(1) : 0;
  return { total, hitRate, byKind };
}
```

整函数替换 `percentilesFor` / `topToolFor`(签名加 end):

```js
function percentilesFor(db, col, key, start, end, kind) {
  const params = [key];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }
  const times = db
    .prepare(`SELECT ms FROM metrics WHERE ${col} = ? AND ${where} ${kindClause} AND ms IS NOT NULL ORDER BY ms`)
    .all(...params)
    .map((r) => r.ms);
  return { p50: percentile(times, 50), p95: percentile(times, 95) };
}

function topToolFor(db, col, key, start, end, kind) {
  const params = [key];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }
  const row = db
    .prepare(
      `SELECT tool, COUNT(*) AS calls FROM metrics
       WHERE ${col} = ? AND ${where} ${kindClause}
       GROUP BY tool ORDER BY calls DESC LIMIT 1`
    )
    .get(...params);
  return row ? { tool: row.tool, calls: row.calls } : { tool: key, calls: 0 };
}
```

整函数替换 `queryVisits`:

```js
export function queryVisits(db, { since = "30d", from = null, to = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  const rows = db
    .prepare(
      `SELECT day,
              COUNT(*) AS pv,
              COUNT(DISTINCT ip) AS uv
       FROM visits
       WHERE ${where}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...params);
  const totalPv = rows.reduce((s, r) => s + r.pv, 0);
  const totalUv = db
    .prepare(`SELECT COUNT(DISTINCT ip) AS uv FROM visits WHERE ${where} AND ip IS NOT NULL`)
    .get(...params).uv;
  return { rows, totalPv, totalUv: totalUv || 0 };
}
```

同步更新 `queryVisits` 的 JSDoc `@param {{since?:string, from?:string|null, to?:string|null}} opts`。

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add metrics-server/db.js metrics-server/__tests__/server.test.js
git commit -m "feat(metrics-server): from/to 自定义时间窗穿透全部聚合查询"
```

---

### Task 3: db.js — by=active 用户活跃聚合(DAU/MAU)

**Files:**
- Modify: `metrics-server/db.js`(新增 queryActiveUsers + queryStats dispatch)
- Test: `metrics-server/__tests__/server.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `server.test.js`:

```js
test("queryStats by=active:逐日 DAU(按 UTC 天,空 user 归 unknown)", () => {
  const db = freshDb();
  const d = (day, h = "10") => Date.parse(`${day}T${h}:00:00Z`);
  insertBatch(db, {
    clientId: "c1", user: "u1",
    batch: [rec({ ts: d("2026-01-05"), traceID: "a1" }), rec({ ts: d("2026-01-05", "15"), traceID: "a2" })],
  }); // 同一天 u1 两次 → dau 1
  insertBatch(db, { clientId: "c2", user: "u2", batch: [rec({ ts: d("2026-01-05"), traceID: "a3" })] });
  insertBatch(db, { clientId: "c3", user: "u3", batch: [rec({ ts: d("2026-01-06"), traceID: "a4" })] });
  insertBatch(db, { clientId: "c4", batch: [rec({ ts: d("2026-01-06"), traceID: "a5" })] }); // 无 user → (unknown)

  const { rows } = queryStats(db, { by: "active", since: "30d", from: "2026-01-01", to: "2026-01-07" });
  assert.deepEqual(rows, [
    { day: "2026-01-05", dau: 2 }, // u1 + u2
    { day: "2026-01-06", dau: 2 }, // u3 + (unknown)
  ]);
});

test("queryStats by=active:MAU 固定近30天,不随窗口漂移", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, { clientId: "c1", user: "recent1", batch: [rec({ ts: now - 86400000, traceID: "m1" })] });
  insertBatch(db, { clientId: "c2", user: "recent2", batch: [rec({ ts: now - 2 * 86400000, traceID: "m2" })] });
  // 31 天前的用户不算 MAU
  insertBatch(db, { clientId: "c3", user: "stale", batch: [rec({ ts: now - 31 * 86400000, traceID: "m3" })] });

  const { mau } = queryStats(db, { by: "active", since: "1d", from: null, to: null });
  assert.equal(mau, 2);
});

test("queryStats by=active:kind 过滤与噪音排除生效", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c1", user: "u1",
    batch: [
      rec({ ts: now, traceID: "b1" }),
      rec({ ts: now, traceID: "b2", tool: "open_browser", domain: "open_browser", kind: "builtin" }),
      rec({ ts: now, traceID: "b3", tool: "skill.list", domain: "skill" }),
    ],
  });
  const { rows, mau } = queryStats(db, { by: "active", since: "1d", kind: "adapter" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dau, 1);
  assert.equal(mau, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:FAIL——`by=active` 落到默认 domain 聚合,返回结构是 `{key,...}` 而非 `{day,dau}`。

- [ ] **Step 3: 实现**

`metrics-server/db.js`:

1. `queryStats` dispatch 区(与 err/user/route 并列)加一行:

```js
  if (by === "active") return queryActiveUsers(db, { since, from, to, kind });
```

2. `queryByUser` 之后新增:

```js
/**
 * 用户活跃聚合(by=active):逐日 DAU + 近 30 天 MAU。
 * DAU 跟随查询窗;MAU 固定近 30 天,不随窗口漂移(语义保持「月活」)。
 * 空 user 归 (unknown),与 by=user 口径一致;噪音排除与 kind 过滤两者都生效。
 */
function queryActiveUsers(db, { since = "30d", from = null, to = null, kind = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }

  const rows = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch') AS day,
              COUNT(DISTINCT COALESCE(NULLIF(user, ''), '(unknown)')) AS dau
       FROM metrics
       WHERE ${where} ${kindClause} ${noiseExcludeClause()}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...params);

  const mauParams = [];
  const mauWhere = windowSql(Date.now() - 30 * 86400000, null, mauParams);
  let mauKind = "";
  if (kind) { mauKind = "AND kind = ?"; mauParams.push(kind); }
  const mau = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(user, ''), '(unknown)')) AS mau
       FROM metrics
       WHERE ${mauWhere} ${mauKind} ${noiseExcludeClause()}`
    )
    .get(...mauParams).mau;

  return { rows, mau };
}
```

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add metrics-server/db.js metrics-server/__tests__/server.test.js
git commit -m "feat(metrics-server): 新增 by=active 用户活跃聚合(逐日 DAU + 近30天 MAU)"
```

---

### Task 4: handler.js — from/to 校验与 by=active 路由

**Files:**
- Modify: `metrics-server/handler.js`(stats / visits 两个 GET 路由 + dayParam)
- Test: `metrics-server/__tests__/server.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `server.test.js`(import 行加 `dayParam, handle`):

```js
import { openDb, insertBatch, queryStats, queryVisits, insertVisit, pickWhitelist, validRecord, resolveWindow, noiseExcludeClause } from "../db.js";
import { checkAuth, dayParam, handle } from "../handler.js";

test("dayParam:合法日期返回原值,未提供返回 null,非法抛 code=400", () => {
  const ok = new URL("http://x/v1/stats?from=2026-01-05&to=2026-02-01");
  assert.equal(dayParam(ok, "from"), "2026-01-05");
  assert.equal(dayParam(ok, "to"), "2026-02-01");
  assert.equal(dayParam(new URL("http://x/v1/stats"), "from"), null);
  assert.throws(() => dayParam(new URL("http://x/v1/stats?from=20260105"), "from"), (e) => e.code === 400);
  assert.throws(() => dayParam(new URL("http://x/v1/stats?from=2026-13-99"), "from"), (e) => e.code === 400);
});

/** handle() 的内存 stub:返回 {status, body}。 */
function captureHandle(method, url, db) {
  return new Promise((resolve) => {
    const req = { method, url, headers: {} };
    const res = {
      status: 0,
      writeHead(s) { this.status = s; },
      end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
    };
    handle(req, res, { db, token: "" });
  });
}

test("handle:GET /v1/stats 非法 from → 400", async () => {
  const db = freshDb();
  const res = await captureHandle("GET", "/v1/stats?from=bad", db);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid from/);
});

test("handle:GET /v1/stats?by=active 返回 rows+mau", async () => {
  const db = freshDb();
  insertBatch(db, { clientId: "c1", user: "u1", batch: [rec({ traceID: "h1" })] });
  const res = await captureHandle("GET", "/v1/stats?by=active&since=1d", db);
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.rows), true);
  assert.equal(typeof res.body.mau, "number");
  assert.equal(res.body.mau, 1);
});

test("handle:GET /v1/visits from/to 透传", async () => {
  const db = freshDb();
  insertVisit(db, { ip: "10.0.0.1", ts: Date.parse("2026-01-05T10:00:00Z") });
  const res = await captureHandle("GET", "/v1/visits?from=2026-01-05&to=2026-01-06", db);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalPv, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:FAIL——`dayParam` 未导出;`by=active` 请求 200 但 body 无 mau;visits 路由忽略 from/to。

- [ ] **Step 3: 实现**

`metrics-server/handler.js`:

1. `MAX_BATCH` 常量后新增:

```js
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析 YYYY-MM-DD 日期查询参数(UTC 日界)。
 * 未提供返回 null;格式非法抛 {code:400},由路由层转 400 响应。
 */
export function dayParam(url, name) {
  const v = url.searchParams.get(name);
  if (v == null || v === "") return null;
  if (!DAY_RE.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) {
    throw Object.assign(new Error(`invalid ${name}, expect YYYY-MM-DD`), { code: 400 });
  }
  return v;
}
```

2. `GET /v1/stats` 路由整体替换:

```js
  if (route === "GET /v1/stats") {
    if (!checkAuth(req, ctx.token)) return send(res, 401, { error: "unauthorized" });
    const byRaw = url.searchParams.get("by");
    const by =
      byRaw === "tool" ? "tool" : byRaw === "err" ? "err" : byRaw === "user" ? "user" : byRaw === "route" ? "route" : byRaw === "active" ? "active" : "domain";
    const since = url.searchParams.get("since") || "30d";
    const kind = url.searchParams.get("kind") || null;
    const topRaw = url.searchParams.get("top");
    const top = topRaw ? parseInt(topRaw, 10) : null;
    let from;
    let to;
    try {
      from = dayParam(url, "from");
      to = dayParam(url, "to");
    } catch (e) {
      return send(res, e.code || 400, { error: e.message });
    }
    try {
      const data = queryStats(ctx.db, { by, since, from, to, kind, top });
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: "query failed" });
    }
  }
```

3. `GET /v1/visits` 路由整体替换:

```js
  if (route === "GET /v1/visits") {
    if (!checkAuth(req, ctx.token)) return send(res, 401, { error: "unauthorized" });
    const since = url.searchParams.get("since") || "30d";
    let from;
    let to;
    try {
      from = dayParam(url, "from");
      to = dayParam(url, "to");
    } catch (e) {
      return send(res, e.code || 400, { error: e.message });
    }
    try {
      const data = queryVisits(ctx.db, { since, from, to });
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: "visits query failed" });
    }
  }
```

4. 文件头路由注释补两行说明(by=active、from/to)。

- [ ] **Step 4: 跑测试确认全绿**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add metrics-server/handler.js metrics-server/__tests__/server.test.js
git commit -m "feat(metrics-server): handler 支持 from/to 校验与 by=active 路由"
```

---

### Task 5: officialWeb 数据层 — 噪音兜底 + by=active + from/to 透传

**Files:**
- Modify: `officialWeb/src/lib/stats.js`(整文件重写,下方为最终内容)
- Modify: `officialWeb/src/lib/visits.js`(fetchVisits)

officialWeb 无测试设施(仓库惯例仅 vite dev/build),本任务验证方式 = Task 9 端到端。

- [ ] **Step 1: 重写 `officialWeb/src/lib/stats.js` 为以下最终内容**

(覆盖工作区 WIP 的 countActiveUsers/fetchActiveUsers;groupByDomain/groupByUser 增加噪音过滤;fetchStats 增加 from/to;fetchActiveUsers 改打 by=active)

```js
// Adapter 调用统计 —— 数据层
// 走同域 /api/stats:本地 dev 由 Vite proxy 转发到 metrics-server,生产由 Nginx 反代。
// token 在代理层注入,不进前端 bundle。
// 一次请求 by=tool 拿全量 tool 明细,前端按 domain 分组:
//   - adapter 汇总 calls = 各 tool calls 之和(精确)
//   - adapter 汇总 okRate = 按 calls 加权(精确)
//   - adapter 汇总 p50/p95 = 各 tool p50/p95 按 calls 加权平均(近似,看板够用)

/**
 * 从完整工具名提取 domain(最后一个 '.' 之前)。
 * mail.example.com.search_messages → mail.example.com
 * open_browser(无点)→ open_browser
 */
export function domainOf(tool) {
  const i = String(tool).lastIndexOf('.')
  return i > 0 ? tool.slice(0, i) : tool
}

// 噪音工具首段名单 —— 与 metrics-server/db.js 的 NOISE_FIRST_SEGMENTS 对齐(含 'wecli')。
// classifyTool 把带 '.' 的工具一律标成 kind="adapter",kind 筛选挡不住噪音
//(skill.list 等带着 adapter 标签入库);名单兜底保证旧版 server 未升级时也不展示。
const NOISE_FIRST_SEGMENTS = new Set([
  'skill', 'skills', 'tool', 'tools', 'adapter', 'adapters', 'adapterhub',
  'service', 'call', 'route', 'routes', 'trace', 'traces', 'install', 'list',
  'completion', 'mcp', 'mcp-logs', 'browser', 'login', 'auth', 'extension-path',
  'stats', 'webcli', 'wecli', 'help', 'mode', 'profiles', 'capabilities', 'tabs',
  'list_sites', 'inspect_page_state', 'evaluate_in_page', 'version', 'doctor',
])

/**
 * 工具名首段属于 CLI 管理命令 / 误解析名('-' 开头 flag 误用)→ 视为噪音,不进看板口径。
 * 与 metrics-server/db.js 的 noiseExcludeClause 语义一致。
 */
export function isNoiseTool(name) {
  const s = String(name || '')
  const first = s.includes('.') ? s.slice(0, s.indexOf('.')) : s
  return s.startsWith('-') || NOISE_FIRST_SEGMENTS.has(first)
}

/**
 * 请求 stats。走同域 /api/stats(Vite proxy / Nginx 注入 token)。
 * @param {{by?:string, since?:string, kind?:string, top?:number, from?:string|null, to?:string|null}} opts
 *   from/to:YYYY-MM-DD(UTC 日界),仅自定义时间窗时传
 * @returns {Promise<{rows:Array, totalCalls:number}>}
 */
export async function fetchStats({ by = 'tool', since = '7d', kind = 'adapter', top = null, from = null, to = null } = {}) {
  const params = new URLSearchParams({ by, since })
  if (kind) params.set('kind', kind)
  if (top) params.set('top', String(top))
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const res = await fetch(`/api/stats?${params}`)
  if (!res.ok) throw new Error(`stats 请求失败: ${res.status}`)
  if (!res.headers.get('content-type')?.includes('application/json')) {
    return { rows: [], totalCalls: 0, unavailable: true }
  }
  return res.json()
}

/**
 * 把 by=tool 的明细分组为 adapter(domain)汇总。
 */
export function groupByDomain(toolRows) {
  const map = new Map()
  for (const r of toolRows) {
    if (isNoiseTool(r.key)) continue // 噪音兜底(旧版 server 未升级时)
    const d = domainOf(r.key)
    if (!map.has(d)) {
      map.set(d, { domain: d, calls: 0, okSum: 0, p50Sum: 0, p95Sum: 0, tools: [] })
    }
    const g = map.get(d)
    const calls = Number(r.calls) || 0
    g.calls += calls
    g.okSum += calls * (Number(r.okRate) || 0)
    g.p50Sum += calls * (Number(r.p50) || 0)
    g.p95Sum += calls * (Number(r.p95) || 0)
    g.tools.push({
      tool: r.key,
      calls,
      okRate: Number(r.okRate) || 0,
      p50: Number(r.p50) || 0,
      p95: Number(r.p95) || 0,
    })
  }

  const result = [...map.values()].map((g) => {
    const calls = g.calls
    const tools = g.tools.sort((a, b) => b.calls - a.calls)
    return {
      domain: g.domain,
      calls,
      okRate: calls ? +(g.okSum / calls).toFixed(1) : 0,
      p50: calls ? Math.round(g.p50Sum / calls) : 0,
      p95: calls ? Math.round(g.p95Sum / calls) : 0,
      tools,
    }
  })
  result.sort((a, b) => b.calls - a.calls)
  return result
}

/**
 * 把 by=user 的扁平 rows 按 user 分组。
 */
export function groupByUser(rows) {
  const map = new Map()
  for (const r of rows) {
    if (!r.user || isNoiseTool(r.domain)) continue // 噪音兜底(旧版 server 未升级时)
    if (!map.has(r.user)) {
      map.set(r.user, { user: r.user, calls: 0, domains: [] })
    }
    const g = map.get(r.user)
    g.calls += Number(r.calls) || 0
    g.domains.push({ domain: r.domain, calls: Number(r.calls) || 0 })
  }
  const result = [...map.values()].map((g) => ({
    user: g.user,
    calls: g.calls,
    domains: g.domains.sort((a, b) => b.calls - a.calls),
  }))
  result.sort((a, b) => b.calls - a.calls)
  return result
}

/**
 * 用户活跃(by=active):逐日 DAU + 近30天 MAU。
 * @param {{since?:string, from?:string|null, to?:string|null, kind?:string}} opts
 * @returns {Promise<{rows:Array<{day:string, dau:number}>, mau:number, unavailable?:boolean}>}
 */
export async function fetchActiveUsers({ since = '30d', from = null, to = null, kind = 'adapter' } = {}) {
  const data = await fetchStats({ by: 'active', since, kind, from, to })
  return { rows: data.rows || [], mau: data.mau || 0, unavailable: Boolean(data.unavailable) }
}
```

- [ ] **Step 2: `officialWeb/src/lib/visits.js` 的 fetchVisits 改为**

```js
/**
 * 查询按天 PV/UV 趋势。
 * @param {{since?:string, from?:string|null, to?:string|null}} opts
 * @returns {Promise<{rows:Array<{day:string, pv:number, uv:number}>, totalPv:number, totalUv:number}>}
 */
export async function fetchVisits({ since = '7d', from = null, to = null } = {}) {
  const p = new URLSearchParams({ since })
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  const res = await fetch(`/api/visits?${p}`)
  if (!res.ok) throw new Error(`visits 请求失败: ${res.status}`)
  if (!res.headers.get('content-type')?.includes('application/json')) {
    return { rows: [], totalPv: 0, totalUv: 0, unavailable: true }
  }
  return res.json()
}
```

- [ ] **Step 3: 构建 sanity check**

```bash
cd D:/github/WeWorker-fork/officialWeb && npm run build
```
预期:构建成功(vite build 会做语法/引用检查)。

- [ ] **Step 4: 提交**

```bash
git add officialWeb/src/lib/stats.js officialWeb/src/lib/visits.js
git commit -m "feat(officialWeb): 数据层噪音兜底 + by=active + from/to 透传"
```

---

### Task 6: Stats.jsx — 时间筛选(近90天 + 自定义日期)

**Files:**
- Modify: `officialWeb/src/pages/Stats.jsx`

- [ ] **Step 1: 常量区(第 5-7 行)替换为**

```jsx
const SINCE_OPTIONS = [
  { value: '1d', label: '近1天' },
  { value: '7d', label: '近7天' },
  { value: '30d', label: '近30天' },
  { value: '90d', label: '近90天' },
  { value: 'custom', label: '自定义' },
]
const KIND_OPTIONS = ['adapter', 'builtin']
const VIEW_OPTIONS = ['adapter', 'user', 'err']
```

- [ ] **Step 2: state 区(view 声明之后)替换为**

(加 errRows/totalFailed/customFrom/customTo 与时间窗派生量;errRows 供 Task 7 使用,本任务先声明)

```jsx
  const [view, setView] = useState('adapter')

  // 时间窗:预设走 since 相对窗;自定义走 from/to(YYYY-MM-DD,UTC 日界)。
  // 自定义模式下一律回落 since=30d(后端 from/to 存在时忽略 since;旧 server 未升级时
  // 也回落到合理的 30 天窗,绝不让字面 'custom' 出现在请求里)。
  // 起止都没填时即 30d 预设;from>to 产生空窗(后端契约如此),由日期输入 min/max 约束。
  const [since, setSince] = useState('7d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const isCustom = since === 'custom'
  const effSince = isCustom ? '30d' : since
  const apiFrom = isCustom ? customFrom || null : null
  const apiTo = isCustom ? customTo || null : null

  // 按错误视图(err):错误类型聚合 rows + 失败总数
  const [errRows, setErrRows] = useState([])
  const [totalFailed, setTotalFailed] = useState(0)
```

删除原有独立的 `const [since, setSince] = useState('7d')` 行(已并入上方)。

- [ ] **Step 3: loadVisits 改为跟随时间窗**

```jsx
  const loadVisits = useCallback(async () => {
    setVisitsLoading(true)
    setVisitsError(null)
    setVisitsUnavailable(false)
    try {
      const data = await fetchVisits({ since: effSince, from: apiFrom, to: apiTo })
      setVisitsUnavailable(Boolean(data.unavailable))
      setVisits(data)
    } catch (e) {
      setVisitsError(e.message)
    } finally {
      setVisitsLoading(false)
    }
  }, [effSince, apiFrom, apiTo])
```

- [ ] **Step 4: load 替换为(err 分支供 Task 7 使用)**

```jsx
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setStatsUnavailable(false)
    try {
      const by = view === 'user' ? 'user' : view === 'err' ? 'err' : 'tool'
      const data = await fetchStats({ by, since: effSince, kind, from: apiFrom, to: apiTo })
      setStatsUnavailable(Boolean(data.unavailable))
      const rows = data.rows || []
      if (view === 'err') {
        setErrRows(rows)
        setTotalFailed(data.totalFailed || 0)
        setGroups([])
      } else {
        setGroups(view === 'user' ? groupByUser(rows) : groupByDomain(rows))
        setErrRows([])
        setTotalFailed(0)
      }
      setTotalCalls(data.totalCalls || 0)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [view, effSince, kind, apiFrom, apiTo])
```

- [ ] **Step 5: 时间窗筛选 UI 替换**

(`Filters` 区中「时间窗」那个 div 整体替换;类型选择器外包 `{view !== 'err' && (...)}`,本任务先加条件)

```jsx
        <div className="flex items-center gap-2">
          <span className="text-muted">时间窗</span>
          <div className="flex bg-surface border border-border rounded-lg overflow-hidden">
            {SINCE_OPTIONS.map((s) => (
              <button
                key={s.value}
                onClick={() => setSince(s.value)}
                className={`px-3 py-1.5 transition-colors ${
                  since === s.value
                    ? 'bg-accent/20 text-[rgb(var(--color-text))]'
                    : 'text-muted hover:text-[rgb(var(--color-text))]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {isCustom && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-border bg-surface text-[rgb(var(--color-text))] text-sm"
              />
              <span className="text-muted">至</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-border bg-surface text-[rgb(var(--color-text))] text-sm"
              />
            </div>
          )}
        </div>
```

- [ ] **Step 6: 构建 sanity check**

```bash
cd D:/github/WeWorker-fork/officialWeb && npm run build
```
预期:构建成功。

- [ ] **Step 7: 提交**

```bash
git add officialWeb/src/pages/Stats.jsx
git commit -m "feat(officialWeb): 时间筛选新增近90天与自定义日期范围"
```

---

### Task 7: Stats.jsx — 按错误类型视图

**Files:**
- Modify: `officialWeb/src/pages/Stats.jsx`

- [ ] **Step 1: 视图/列派生区替换**

(`const isUser = view === 'user'` 与 `cols` 那两段替换为):

```jsx
  const isErr = view === 'err'
  const isUser = view === 'user'
  const cols = isErr
    ? 'grid-cols-[1fr_90px_80px_80px_1fr]'
    : isUser
      ? 'grid-cols-[1fr_100px_40px]'
      : 'grid-cols-[1fr_80px_80px_80px_80px_40px]'
```

- [ ] **Step 2: switchView 清 err 态**

```jsx
  const switchView = (v) => {
    setView(v)
    setExpanded(new Set())
    setGroups([])
    setErrRows([])
    setTotalFailed(0)
    setLoading(true)
  }
```

- [ ] **Step 3: 筛选行右侧汇总文案替换**

(原 `{!loading && !error && groups.length > 0 && (...)}` 那块替换为):

```jsx
        {!loading && !error && !statsUnavailable && (
          view === 'err'
            ? errRows.length > 0 && (
                <div className="text-muted ml-auto">
                  {errRows.length} 类错误 · {fmt(totalFailed)} 次失败
                </div>
              )
            : groups.length > 0 && (
                <div className="text-muted ml-auto">
                  {isUser ? `${groups.length} 个用户` : `${groups.length} 个 adapter`} · {fmt(totalCalls)} 次调用
                </div>
              )
        )}
```

- [ ] **Step 4: 表格区渲染分支**

(`{!loading && !error && !statsUnavailable && groups.length > 0 && (...)}` 那块替换为——err 分支 + 原表格原样保留在非 err 分支;原表格内部代码不动,此处仅示意包裹):

```jsx
      {!loading && !error && !statsUnavailable && (
        isErr ? (
          errRows.length > 0 ? (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className={`grid ${cols} gap-3 px-4 py-3 text-xs text-muted border-b border-border bg-bg/40`}>
                <div>错误类型</div>
                <div className="text-right">调用次数</div>
                <div className="text-right">涉及工具</div>
                <div className="text-right">涉及用户</div>
                <div>样例工具</div>
              </div>
              {errRows.map((r) => (
                <div
                  key={r.err}
                  className={`grid ${cols} gap-3 px-4 py-3 text-sm border-b border-border last:border-b-0 items-center`}
                >
                  <div className="text-[rgb(var(--color-text))] font-medium truncate" title={r.err}>
                    {r.err}
                  </div>
                  <div className="text-right tabular-nums text-red-500">{fmt(r.calls)}</div>
                  <div className="text-right tabular-nums text-[rgb(var(--color-text-soft))]">{fmt(r.tools)}</div>
                  <div className="text-right tabular-nums text-[rgb(var(--color-text-soft))]">{fmt(r.users)}</div>
                  <div className="text-muted truncate" title={r.sampleTool}>
                    {r.sampleTool}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-16">
              <div className="text-[rgb(var(--color-text))] mb-2">该时间窗内无失败调用。</div>
            </div>
          )
        ) : (
          groups.length > 0 && (
            /* ── 原 adapter/user 表格整块原样保留 ── */
          )
        )
      )}
```

同时把「暂无埋点数据」空态的显示条件改为加上 `!isErr`:即 `{!loading && !error && !statsUnavailable && !isErr && groups.length === 0 && (...)}`——err 视图的空态已由上方「该时间窗内无失败调用」承担。

- [ ] **Step 5: 构建 sanity check**

```bash
cd D:/github/WeWorker-fork/officialWeb && npm run build
```
预期:构建成功。

- [ ] **Step 6: 提交**

```bash
git add officialWeb/src/pages/Stats.jsx
git commit -m "feat(officialWeb): 新增按错误类型视图(by=err)"
```

---

### Task 8: Stats.jsx — 用户活跃(DAU/MAU)区块

**Files:**
- Modify: `officialWeb/src/pages/Stats.jsx`

- [ ] **Step 1: import 行加 fetchActiveUsers**

```jsx
import { fetchStats, groupByDomain, groupByUser, fetchActiveUsers } from '../lib/stats'
```

- [ ] **Step 2: visits 区块 state 后新增 active state + loader**

```jsx
  // 用户活跃(DAU/MAU)
  const [active, setActive] = useState(null)
  const [activeLoading, setActiveLoading] = useState(true)
  const [activeError, setActiveError] = useState(null)
  const [activeUnavailable, setActiveUnavailable] = useState(false)

  const loadActive = useCallback(async () => {
    setActiveLoading(true)
    setActiveError(null)
    setActiveUnavailable(false)
    try {
      const data = await fetchActiveUsers({ since: effSince, from: apiFrom, to: apiTo, kind })
      setActiveUnavailable(Boolean(data.unavailable))
      setActive(data)
    } catch (e) {
      setActiveError(e.message)
    } finally {
      setActiveLoading(false)
    }
  }, [effSince, apiFrom, apiTo, kind])

  useEffect(() => {
    loadActive()
  }, [loadActive])
```

- [ ] **Step 3: 刷新按钮带上 loadActive**

```jsx
        <button
          onClick={() => { load(); loadVisits(); loadActive(); }}
          ...其余属性不变...
```

- [ ] **Step 4: 「网站访问量」区块之后、loading skeleton 之前插入「用户活跃」区块**

(结构与 visits 区块同款:标题行右侧 MAU,表体逐日 DAU 条)

```jsx
      {/* 用户活跃(DAU/MAU) */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-[rgb(var(--color-text))]">用户活跃</h2>
          {!activeLoading && !activeError && active && (
            <div className="text-muted text-sm">MAU(近30天){fmt(active.mau)}</div>
          )}
        </div>

        {activeLoading && (
          <div className="bg-surface border border-border rounded-xl p-4 animate-pulse">
            <div className="h-4 bg-subtle/40 rounded w-1/2" />
          </div>
        )}

        {activeError && (
          <div className="bg-surface border border-border rounded-xl p-4 text-sm text-red-500">
            用户活跃加载失败:{activeError}
          </div>
        )}

        {!activeLoading && !activeError && activeUnavailable && (
          <div className="bg-surface border border-border rounded-xl p-4 text-sm text-muted">
            用户活跃统计暂未接入;页面可正常使用。
          </div>
        )}

        {!activeLoading && !activeError && !activeUnavailable && active && active.rows.length === 0 && (
          <div className="bg-surface border border-border rounded-xl p-4 text-muted text-sm">暂无活跃数据。</div>
        )}

        {!activeLoading && !activeError && !activeUnavailable && active && active.rows.length > 0 && (
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_120px] gap-3 px-4 py-3 text-xs text-muted border-b border-border bg-bg/40">
              <div>日期</div>
              <div className="text-right">DAU</div>
            </div>
            {active.rows.map((r) => {
              const maxDau = Math.max(...active.rows.map((x) => x.dau), 1)
              return (
                <div key={r.day} className="grid grid-cols-[1fr_120px] gap-3 px-4 py-2.5 text-sm border-b border-border/60 last:border-b-0 items-center">
                  <div className="flex items-center gap-3">
                    <span className="text-[rgb(var(--color-text))] font-medium shrink-0">{r.day}</span>
                    <div className="h-1.5 bg-subtle/40 rounded-full flex-1 overflow-hidden">
                      <div
                        className="h-full bg-accent/70 rounded-full"
                        style={{ width: `${(r.dau / maxDau) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right text-[rgb(var(--color-text))] tabular-nums">{fmt(r.dau)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
```

- [ ] **Step 5: 构建 sanity check**

```bash
cd D:/github/WeWorker-fork/officialWeb && npm run build
```
预期:构建成功。

- [ ] **Step 6: 提交**

```bash
git add officialWeb/src/pages/Stats.jsx
git commit -m "feat(officialWeb): 新增用户活跃区块(逐日 DAU + 近30天 MAU)"
```

---

### Task 9: 端到端验证

**Files:** 无代码改动;验证产物=命令输出与页面确认。

- [ ] **Step 1: 后端全量测试**

```bash
cd D:/github/WeWorker-fork/metrics-server && node --test
```
预期:全部 PASS。

- [ ] **Step 2: 种子数据 + 起 metrics-server**

```bash
cd D:/github/WeWorker-fork/metrics-server
node -e "
import('./db.js').then(({ openDb, insertBatch, insertVisit }) => {
  const db = openDb('e2e-seed.db');
  const now = Date.now();
  const recs = [];
  for (let i = 0; i < 40; i++) recs.push({ ts: now - i * 3600000, tool: 'tickets.example.com.search_tickets', domain: 'tickets.example.com', kind: 'adapter', ok: i % 5 !== 0, ms: 100 + i, traceID: 's' + i });
  recs.push({ ts: now, tool: 'skill.list', domain: 'skill', kind: 'adapter', ok: false, ms: 5, traceID: 'noise1', err: 'UNKNOWN_COMMAND' });
  recs.push({ ts: now - 2 * 86400000, tool: 'mail.163.com.get', domain: 'mail.163.com', kind: 'adapter', ok: false, ms: 30, traceID: 'err1', err: 'HTTP_ERROR' });
  // 固定时间戳(在 from=2026-11-01~to=2026-11-07 验证窗内),保证 from/to 的 curl 检查非空转
  recs.push({ ts: Date.parse('2026-11-05T10:00:00Z'), tool: 'dpms.example.com.list_items', domain: 'dpms.example.com', kind: 'adapter', ok: true, ms: 80, traceID: 'ft1' });
  recs.push({ ts: Date.parse('2026-11-12T10:00:00Z'), tool: 'dpms.example.com.list_items', domain: 'dpms.example.com', kind: 'adapter', ok: true, ms: 80, traceID: 'ft2' });
  insertBatch(db, { clientId: 'seed1', user: 'rickhuang', batch: recs });
  insertVisit(db, { ip: '10.0.0.1', ts: now });
  console.log('seeded', recs.length + 1);
});
"
METRICS_TOKEN=devtoken METRICS_DB=e2e-seed.db node server.js
```
(后台跑,或另开终端。预期 stderr:`listening on :8787 (db=e2e-seed.db, auth=on)`)

- [ ] **Step 3: curl 验证各端点**

```bash
# 噪音不出现(skill.list 不在 rows,UNKNOWN_COMMAND 不在 err rows)
curl -s -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/v1/stats?by=domain&since=30d&kind=adapter"
curl -s -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/v1/stats?by=err&since=30d"
# by=active 形态
curl -s -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/v1/stats?by=active&since=30d&kind=adapter"
# from/to
curl -s -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/v1/stats?by=domain&from=2026-11-01&to=2026-11-07&kind=adapter"
curl -s -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/v1/visits?from=2026-11-01&to=2026-11-07"
# 非法日期 → 400
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer devtoken" "http://127.0.0.1:8787/v1/stats?from=bad"
```
预期:domain rows 只含 `tickets.example.com`;err rows 只含 `HTTP_ERROR`(UNKNOWN_COMMAND 属噪音被排除);active 返回 `{rows:[{day,dau}],mau}`;非法 from 返回 400;from/to 用例应返回 `dpms.example.com` 且 totalCalls=1(11-05 在窗内,11-12 在窗外——若 rows 为空说明种子或窗口有误,须排查而非视为通过)。

- [ ] **Step 4: 页面实测**

另开终端:

```bash
cd D:/github/WeWorker-fork/officialWeb && METRICS_TOKEN=devtoken METRICS_TARGET=http://127.0.0.1:8787 npm run dev
```

浏览器开 `http://localhost:5173/stats`,逐项确认:

1. 视图三 tab:按 Adapter / 按用户 / 按错误,切换无崩溃、数据正确;
2. err 视图:只有 `HTTP_ERROR` 一行,列齐全,「类型」选择器隐藏,汇总「1 类错误 · 1 次失败」;
3. 时间窗:近1/7/30/90天切换生效;「自定义」出现日期框,选起止后主表/err/DAU/PV-UV 全部联动;
4. 用户活跃区块:MAU(近30天)≥1,逐日 DAU 条正常;
5. 明暗主题切换下各区块样式正常。

- [ ] **Step 5: 清理验证产物**

```bash
rm -f D:/github/WeWorker-fork/metrics-server/e2e-seed.db
```

---

### Task 10: PR

**Files:** 无新改动;推送与建 PR。

- [ ] **Step 1: 提交范围检查**

```bash
cd D:/github/WeWorker-fork && git status --short && git diff upstream/dev-1.1.0 --stat
```
预期:仅含 metrics-server 三个文件、officialWeb 三个文件与 spec;`webcli/login-recovery*`、`docs/superpowers/plans/` 等无关文件必须保持未跟踪、绝不 add。

- [ ] **Step 2: 敏感信息自查**

```bash
git diff upstream/dev-1.1.0 | grep -inE "token|secret|password|Bearer [A-Za-z0-9]" | grep -v "METRICS_TOKEN\|checkAuth\|unauthorized\|authorization\|token 注入\|不进前端 bundle\|Bearer \${" || echo "clean"
```
预期:clean(测试里 `devtoken` 属本地值,若出现确认无真实凭据)。

- [ ] **Step 3: 推 fork 并建 PR**

```bash
git push -u fork feat/metrics-dashboard-dev110
gh pr create --repo WeWorker/WeWorker --base dev-1.1.0 --head hws552303251:feat/metrics-dashboard-dev110 \
  --title "feat(metrics): 看板错误聚合/用户活跃/日期筛选(server + officialWeb)" \
  --body "对应 #326 的看板侧配套:

- metrics-server: 时间窗统一 resolveWindow,from/to(YYYY-MM-DD, UTC)穿透 stats/err/user/route/visits;新增 by=active(逐日 DAU + 固定近30天 MAU);噪音 SQL 收敛为 noiseExcludeClause 单一来源(补 wecli)
- handler: from/to 非法格式 400;by 白名单加 active
- officialWeb: 视图新增「按错误」(by=err 列表);时间筛选新增近90天与自定义日期范围;新增用户活跃区块(MAU + 逐日 DAU);数据层噪音名单兜底(旧版 server 也不展示)

测试:metrics-server node --test 全绿(新增 resolveWindow / from/to / by=active / dayParam / handle 400 用例);官网本地 seed + dev 实测三视图与时间筛选联动。"
```

- [ ] **Step 4: CI 观察**

```bash
gh pr checks --repo WeWorker/WeWorker --watch
```
预期:绿。若 builtin-settings-storage / claude-process 相关用例红,先重跑(已知 flaky,见 memory),再排查。
