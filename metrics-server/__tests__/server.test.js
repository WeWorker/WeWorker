/**
 * metrics-server 测试（node:test，零依赖）
 * 覆盖：鉴权失败 / 幂等去重 / 非法记录跳过 / 白名单丢弃 args / 聚合查询。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, insertBatch, queryStats, pickWhitelist, validRecord } from "../db.js";
import { checkAuth } from "../handler.js";

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
  // user 缺失（null）→ by=user 应过滤掉
  insertBatch(db, {
    clientId: "c3",
    batch: [rec({ ts: now, traceID: "u4" })],
  });

  const { rows, totalCalls } = queryStats(db, { by: "user", since: "1d" });
  assert.equal(totalCalls, 3); // 只算有 user 的 3 条
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
