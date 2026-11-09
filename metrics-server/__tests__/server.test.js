/**
 * metrics-server 测试（node:test，零依赖）
 * 覆盖：鉴权失败 / 幂等去重 / 非法记录跳过 / 白名单丢弃 args / 聚合查询。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertBatch, queryStats, queryVisits, insertVisit, pickWhitelist, validRecord, resolveWindow, noiseExcludeClause } from "../db.js";
import { checkAuth, dayParam, handle } from "../handler.js";

function freshDb() {
  return openDb(":memory:");
}

function rec(over = {}) {
  return {
    ts: Date.now(),
    tool: "tickets.example.com.search_tickets",
    domain: "tickets.example.com",
    kind: "adapter",
    ok: true,
    ms: 1200,
    traceID: "t1",
    err: null,
    ...over,
  };
}

test("pickWhitelist 丢弃 args/result 等多余字段", () => {
  const r = pickWhitelist({ ...rec(), args: { secret: "x" }, result: "leak" });
  assert.equal(r.args, undefined);
  assert.equal(r.result, undefined);
  assert.equal(r.tool, "tickets.example.com.search_tickets");
});

test("validRecord 拒绝缺 tool / 缺 ts", () => {
  assert.equal(validRecord(rec()), true);
  assert.equal(validRecord({ ...rec(), tool: undefined }), false);
  assert.equal(validRecord({ ...rec(), ts: "no" }), false);
});

test("insertBatch 幂等：相同 (client_id, ts, trace_id, tool) 只入一条", () => {
  const db = freshDb();
  const r = rec({ ts: 1000, traceID: "dup" });
  const body = { clientId: "c1", batch: [r, r] };
  const res1 = insertBatch(db, body);
  assert.equal(res1.accepted, 1);
  assert.equal(res1.skipped, 1);
  // 再发一次整批 → 全部去重
  const res2 = insertBatch(db, { clientId: "c1", batch: [r] });
  assert.equal(res2.accepted, 0);
  assert.equal(res2.skipped, 1);
});

test("insertBatch 跳过非法记录而非拒绝整批", () => {
  const db = freshDb();
  const res = insertBatch(db, {
    clientId: "c1",
    batch: [rec({ ts: 1, traceID: "a" }), { tool: undefined }, rec({ ts: 2, traceID: "b" })],
  });
  assert.equal(res.accepted, 2);
  assert.equal(res.skipped, 1);
});

test("insertBatch 截断 err 到 200 字符", () => {
  const db = freshDb();
  insertBatch(db, { clientId: "c1", batch: [rec({ traceID: "e", err: "x".repeat(500) })] });
  const row = db.prepare("SELECT err FROM metrics WHERE trace_id='e'").get();
  assert.equal(row.err.length, 200);
});

test("queryStats 聚合 domain：calls / okRate / topTool", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: now, traceID: "1", ok: true, ms: 100 }),
      rec({ ts: now, traceID: "2", ok: false, ms: 300 }),
      rec({ ts: now, traceID: "3", tool: "mail.163.com.get", domain: "mail.163.com", ok: true, ms: 50 }),
    ],
  });
  const { rows, totalCalls } = queryStats(db, { by: "domain", since: "1d" });
  assert.equal(totalCalls, 3);
  const itsm = rows.find((r) => r.key === "tickets.example.com");
  assert.equal(itsm.calls, 2);
  assert.equal(itsm.okRate, 50);
  assert.equal(itsm.topTool, "tickets.example.com.search_tickets");
});

test("queryStats kind 过滤 builtin", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: now, traceID: "1" }),
      rec({ ts: now, traceID: "2", tool: "open_browser", domain: "open_browser", kind: "builtin" }),
    ],
  });
  const adapters = queryStats(db, { kind: "adapter", since: "1d" });
  assert.equal(adapters.rows.length, 1);
  assert.equal(adapters.rows[0].key, "tickets.example.com");
});

test("queryStats by=user：返回 user×domain 二维分布", () => {
  const db = freshDb();
  const now = Date.now();
  // rickhuang 调 itsm 2 次、mail 1 次；alice 调 itsm 1 次；无 user 的不入统计
  insertBatch(db, {
    clientId: "c1",
    user: "rickhuang",
    batch: [
      rec({ ts: now, traceID: "u1" }),
      rec({ ts: now, traceID: "u2", tool: "mail.163.com.get", domain: "mail.163.com" }),
    ],
  });
  insertBatch(db, {
    clientId: "c2",
    user: "alice",
    batch: [rec({ ts: now, traceID: "u3" })],
  });
  // user 缺失（null）→ 归入 (unknown) 组，缺失可见而非静默消失
  insertBatch(db, {
    clientId: "c3",
    batch: [rec({ ts: now, traceID: "u4" })],
  });

  const { rows, totalCalls } = queryStats(db, { by: "user", since: "1d" });
  assert.equal(totalCalls, 4); // 全部 4 条（含 unknown 组）
  // rickhuang: itsm(1) + mail(1) = 2；alice: itsm(1) = 1
  const rick = rows.filter((r) => r.user === "rickhuang");
  const alice = rows.filter((r) => r.user === "alice");
  assert.equal(rick.length, 2);
  assert.equal(rick.find((r) => r.domain === "tickets.example.com").calls, 1);
  assert.equal(rick.find((r) => r.domain === "mail.163.com").calls, 1);
  assert.equal(alice.length, 1);
  assert.equal(alice[0].domain, "tickets.example.com");
  assert.equal(alice[0].calls, 1);
});

test("queryStats by=user：kind 过滤 + top 限制每用户 domain 数", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c1",
    user: "rickhuang",
    batch: [
      rec({ ts: now, traceID: "k1" }),
      rec({ ts: now, traceID: "k2", tool: "open_browser", domain: "open_browser", kind: "builtin" }),
    ],
  });
  const { rows } = queryStats(db, { by: "user", kind: "adapter", since: "1d" });
  // builtin 被过滤，只剩 itsm
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, "tickets.example.com");
});

test("queryStats by=route:命中率 + 分 kind 调用数/p50(隔离 adapter)", () => {
  const db = freshDb();
  const now = Date.now();
  const routeRec = (kind, tool, ms, traceID) =>
    rec({
      ts: now,
      kind,
      tool,
      domain: tool.includes(".") ? tool.slice(0, tool.lastIndexOf(".")) : tool,
      ms,
      traceID,
    });
  insertBatch(db, {
    clientId: "c1",
    batch: [
      routeRec("route_hit.alias", "demo.a.x", 100, "r1"),
      routeRec("route_hit.override", "demo.b.x", 200, "r2"),
      routeRec("route_hit.override", "demo.b.x", 400, "r3"),
      routeRec("route_hit.llm", "demo.c.x", 300, "r4"),
      routeRec("route_miss", "__route_miss__", 0, "r5"),
      routeRec("route_miss", "__route_miss__", 0, "r6"),
      routeRec("route_miss", "__route_miss__", 50, "r7"),
      routeRec("route_fallback.auth", "demo.d.x", 500, "r8"),
      // adapter 记录不应计入 route 聚合
      rec({ ts: now, traceID: "a1", kind: "adapter", ms: 999 }),
    ],
  });

  const { total, hitRate, byKind } = queryStats(db, { by: "route", since: "1d" });
  assert.equal(total, 8); // 8 条 route_*,adapter 不计
  assert.equal(hitRate, 50.0); // 4 hits / 8 total
  // 按 calls 倒序:route_miss(3) 居首
  assert.equal(byKind[0].kind, "route_miss");
  assert.equal(byKind[0].calls, 3);
  const ov = byKind.find((r) => r.kind === "route_hit.override");
  assert.equal(ov.calls, 2);
  // p50:override 两条 ms=[200,400] → 200
  assert.equal(ov.p50, 200);
  // adapter(999ms) 不应混入任何 route kind
  assert.ok(!byKind.map((r) => r.kind).includes("adapter"));
});

test("queryStats by=route:无 route 事件 → total 0 / hitRate 0", () => {
  const db = freshDb();
  insertBatch(db, { clientId: "c1", batch: [rec({ traceID: "x" })] }); // 仅 adapter
  const { total, hitRate, byKind } = queryStats(db, { by: "route", since: "1d" });
  assert.equal(total, 0);
  assert.equal(hitRate, 0);
  assert.deepEqual(byKind, []);
});

test("checkAuth：配置 token 时校验 Bearer", () => {
  assert.equal(checkAuth({ headers: {} }, ""), true); // 未配置 → 开放
  assert.equal(checkAuth({ headers: { authorization: "Bearer s3cr3t" } }, "s3cr3t"), true);
  assert.equal(checkAuth({ headers: { authorization: "Bearer wrong" } }, "s3cr3t"), false);
  assert.equal(checkAuth({ headers: {} }, "s3cr3t"), false);
});

test("queryStats by=user：空 user 归入 (unknown) 组，缺失可见", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c9",
    batch: [
      rec({ ts: now, traceID: "k1", tool: "dpms.example.com.list_items", domain: "dpms.example.com" }),
      rec({ ts: now, traceID: "k2", tool: "dpms.example.com.list_items", domain: "dpms.example.com" }),
    ],
  });
  const { rows, totalCalls } = queryStats(db, { by: "user", since: "1d" });
  const unknown = rows.find((r) => r.user === "(unknown)");
  assert.ok(unknown, "(unknown) 组应出现在结果中");
  assert.equal(unknown.domain, "dpms.example.com");
  assert.equal(unknown.calls, 2);
  assert.equal(totalCalls, 2);
});

test("queryStats by=err：失败原因聚合（仅 ok=0，按 err 分组）", () => {
  const db = freshDb();
  const now = Date.now();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: now, traceID: "e1", ok: false, ms: 100, err: "LOGIN_REQUIRED" }),
      rec({ ts: now, traceID: "e2", ok: false, ms: 120, err: "LOGIN_REQUIRED" }),
      rec({ ts: now, traceID: "e3", ok: false, ms: 80, err: "HTTP_ERROR" }),
      rec({ ts: now, traceID: "e4", ok: true, ms: 90 }),
    ],
  });
  const { rows, totalFailed } = queryStats(db, { by: "err", since: "1d" });
  assert.equal(totalFailed, 3);
  assert.equal(rows.length, 2);
  const login = rows.find((r) => r.err === "LOGIN_REQUIRED");
  assert.equal(login.calls, 2);
  assert.ok(login.tools >= 1);
  assert.equal(rows[0].calls >= rows[1].calls, true);
});

test("queryStats by=err：空 err 的失败不计入", () => {
  const db = freshDb();
  insertBatch(db, {
    clientId: "c1",
    batch: [
      rec({ ts: Date.now(), traceID: "e1", ok: false, ms: 100, err: null }),
    ],
  });
  const { rows } = queryStats(db, { by: "err", since: "1d" });
  assert.equal(rows.length, 0);
});

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

test("resolveWindow:只给 from → 上界不设", () => {
  const { start, end } = resolveWindow({ from: "2026-01-05" });
  assert.equal(start, Date.parse("2026-01-05T00:00:00Z"));
  assert.equal(end, null);
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

test("noiseExcludeClause:由 NOISE_FIRST_SEGMENTS 生成,含 wecli 与 flag 排除", () => {
  const clause = noiseExcludeClause();
  assert.ok(clause.includes("'wecli'"));
  assert.ok(clause.includes("NOT LIKE '-%'"));
});

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

  const { mau } = queryStats(db, { by: "active", since: "1d" });
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

test("queryStats kind+from/to 组合:占位符顺序端到端钉死", () => {
  // P2 审查指出:kind 与 windowSql 组合的占位符顺序靠人工约定,错位时 SQLite 静默出错数据。
  // 本用例把 [start, end, kind] 的绑定顺序在聚合层钉死。
  const db = freshDb();
  const d = (day, h = "10") => Date.parse(`${day}T${h}:00:00Z`);
  insertBatch(db, {
    clientId: "c1", user: "u1",
    batch: [
      rec({ ts: d("2026-01-05"), traceID: "k1" }),                              // 窗内 adapter → 计入
      rec({ ts: d("2026-01-05"), traceID: "k2", tool: "open_browser", domain: "open_browser", kind: "builtin" }), // 窗内 builtin → kind 过滤掉
      rec({ ts: d("2026-01-20"), traceID: "k3" }),                              // 窗外 adapter → 时间过滤掉
    ],
  });
  const { rows, totalCalls } = queryStats(db, { by: "domain", since: "30d", from: "2026-01-01", to: "2026-01-07", kind: "adapter" });
  assert.equal(totalCalls, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "tickets.example.com");
  assert.equal(rows[0].topTool, "tickets.example.com.search_tickets");
});

test("dayParam:合法日期返回原值,未提供返回 null,非法抛 code=400", () => {
  const ok = new URL("http://x/v1/stats?from=2026-01-05&to=2026-02-01");
  assert.equal(dayParam(ok, "from"), "2026-01-05");
  assert.equal(dayParam(ok, "to"), "2026-02-01");
  assert.equal(dayParam(new URL("http://x/v1/stats"), "from"), null);
  assert.throws(() => dayParam(new URL("http://x/v1/stats?from=20260105"), "from"), (e) => e.code === 400);
  assert.throws(() => dayParam(new URL("http://x/v1/stats?from=2026-13-99"), "from"), (e) => e.code === 400);
  // V8 对日在当月长度之外的 ISO 串是 rollover 而非 NaN(2026-02-30 → 3月2日),回读校验须拒绝
  assert.throws(() => dayParam(new URL("http://x/v1/stats?from=2026-02-30"), "from"), (e) => e.code === 400);
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

test("handle:GET /v1/stats 非法 to → 400", async () => {
  const db = freshDb();
  const res = await captureHandle("GET", "/v1/stats?to=bad", db);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid to/);
});

test("handle:GET /v1/visits from/to 透传", async () => {
  const db = freshDb();
  insertVisit(db, { ip: "10.0.0.1", ts: Date.parse("2026-01-05T10:00:00Z") });
  const res = await captureHandle("GET", "/v1/visits?from=2026-01-05&to=2026-01-06", db);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalPv, 1);
});

test("handle:GET /v1/visits 非法 from → 400", async () => {
  const db = freshDb();
  const res = await captureHandle("GET", "/v1/visits?from=bad", db);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid from/);
});

test("queryStats by=active:kind+from/to 组合占位符钉死", () => {
  // P3 审查遗留:queryActiveUsers 自建 [start, end, kind] 顺序,该组合此前只钉了 by=domain 路径。
  const db = freshDb();
  const d = (day, h = "10") => Date.parse(`${day}T${h}:00:00Z`);
  insertBatch(db, {
    clientId: "c1", user: "u1",
    batch: [
      rec({ ts: d("2026-01-05"), traceID: "ac1" }),                                                            // 窗内 adapter → 计 DAU
      rec({ ts: d("2026-01-05"), traceID: "ac2", tool: "open_browser", domain: "open_browser", kind: "builtin" }), // 窗内 builtin → kind 滤掉
      rec({ ts: d("2026-01-20"), traceID: "ac3" }),                                                            // 窗外 adapter → 时间滤掉
      rec({ traceID: "ac4" }),                                                                                  // 近30天(默认 ts=now)→ 计 MAU;在 from/to 窗外 → 不计 DAU
    ],
  });
  const { rows, mau } = queryStats(db, { by: "active", since: "30d", from: "2026-01-01", to: "2026-01-07", kind: "adapter" });
  assert.deepEqual(rows, [{ day: "2026-01-05", dau: 1 }]);
  // MAU 与窗口解耦:u1 在近30天 → 1(即使 from/to 窗口是 1 月)
  assert.equal(mau, 1);
});
