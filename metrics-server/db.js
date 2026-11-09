/**
 * 存储层 —— SQLite（node:sqlite，Node ≥22 内置，零依赖）
 *
 * 起步用 SQLite：上报频率低（每客户端 60s 一批），单写者足够；
 * schema 与 SQL 与 PostgreSQL 基本兼容，规模扩大后迁移成本低。
 */

import { DatabaseSync } from "node:sqlite";

/** 入库白名单字段（每条记录只保留这些，多余字段一律丢弃，防止 args/result 混入） */
export const RECORD_FIELDS = ["ts", "tool", "domain", "kind", "ok", "ms", "traceID", "err"];

export function openDb(file = "metrics.db") {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT, user TEXT, webcli_version TEXT, os TEXT,
      ts INTEGER NOT NULL, recv_ts INTEGER NOT NULL,
      tool TEXT NOT NULL, domain TEXT, kind TEXT,
      ok INTEGER, ms INTEGER, trace_id TEXT, err TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_event
      ON metrics(client_id, ts, trace_id, tool);
    CREATE INDEX IF NOT EXISTS idx_ts     ON metrics(ts);
    CREATE INDEX IF NOT EXISTS idx_domain ON metrics(domain);

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,            -- YYYY-MM-DD（UTC）
      ip TEXT,                      -- 访客标识（IP），用于 UV 去重
      path TEXT,                    -- 访问路径（首页/下载/文档等）
      ua TEXT,                      -- UA（可选，粗略区分）
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
    CREATE INDEX IF NOT EXISTS idx_visits_ts  ON visits(ts);
  `);
  return db;
}

/** 生成当前 UTC 日期的 YYYY-MM-DD */
export function dayString(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 记录一次站点访问。幂等性不强求（PV 就是逐次累加）；UV 靠查询时 COUNT(DISTINCT ip)。
 * @param {DatabaseSync} db
 * @param {{day?:string, ip?:string, path?:string, ua?:string, ts?:number}} visit
 * @returns {{ok:boolean}}
 */
export function insertVisit(db, { day, ip, path, ua, ts } = {}) {
  const now = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
  const stmt = db.prepare(
    `INSERT INTO visits (day, ip, path, ua, ts) VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run(
    day || dayString(now),
    typeof ip === "string" && ip ? ip.slice(0, 64) : null,
    typeof path === "string" && path ? path.slice(0, 256) : null,
    typeof ua === "string" && ua ? ua.slice(0, 256) : null,
    now
  );
  return { ok: true };
}

/**
 * 按天聚合 PV/UV。
 * - PV = 每天访问次数（COUNT(*)）
 * - UV = 每天独立访客数（COUNT(DISTINCT ip)）
 * @param {DatabaseSync} db
 * @param {{since?:string, from?:string|null, to?:string|null}} opts  since: 1d/7d/30d;from/to:YYYY-MM-DD(UTC 日界)
 * @returns {{rows:Array<{day:string, pv:number, uv:number}>, totalPv:number, totalUv:number}}
 */
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

/** 只取白名单字段 */
export function pickWhitelist(rec, fields = RECORD_FIELDS) {
  const out = {};
  for (const f of fields) if (rec[f] !== undefined) out[f] = rec[f];
  return out;
}

/** 校验一条记录的字段类型；非法返回 false（调用方跳过该条而非整批拒绝） */
export function validRecord(r) {
  return (
    r &&
    typeof r.tool === "string" && r.tool.length > 0 && r.tool.length <= 256 &&
    typeof r.ts === "number" && Number.isFinite(r.ts) &&
    (r.ms === undefined || typeof r.ms === "number")
  );
}

/**
 * 幂等批量落库。以唯一索引 (client_id, ts, trace_id, tool) 去重，
 * 重复记录被 INSERT OR IGNORE 忽略（容忍客户端 at-least-once 重发）。
 * @returns {{accepted:number, skipped:number}}
 */
export function insertBatch(db, body) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO metrics
      (client_id, user, webcli_version, os, ts, recv_ts,
       tool, domain, kind, ok, ms, trace_id, err)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const recvTs = Date.now();
  const clientId = typeof body.clientId === "string" ? body.clientId.slice(0, 64) : null;
  const user = typeof body.user === "string" ? body.user.slice(0, 128) : null;
  const ver = typeof body.webcliVersion === "string" ? body.webcliVersion.slice(0, 32) : null;
  const os = typeof body.os === "string" ? body.os.slice(0, 32) : null;

  let accepted = 0;
  let skipped = 0;
  db.exec("BEGIN");
  try {
    for (const raw of body.batch) {
      const rec = pickWhitelist(raw);
      if (!validRecord(rec)) { skipped++; continue; }
      const res = stmt.run(
        clientId, user, ver, os,
        rec.ts, recvTs,
        rec.tool,
        rec.domain ?? null,
        rec.kind ?? null,
        rec.ok ? 1 : 0,
        typeof rec.ms === "number" ? rec.ms : null,
        rec.traceID ?? null,
        rec.err != null ? String(rec.err).slice(0, 200) : null
      );
      if (res.changes > 0) accepted++;
      else skipped++; // 去重命中
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { accepted, skipped };
}

/**
 * 聚合查询。返回与客户端 stats.aggregate 同构的 rows。
 * SQLite 无原生 percentile，用 NTILE 窗口近似 p50/p95。
 * @param {DatabaseSync} db
 * @param {{by?:string, since?:string, from?:string|null, to?:string|null, kind?:string, top?:number}} opts
 *   - by="user"：按用户聚合，返回 user×domain 二维分布（扁平 rows [{user,domain,calls}]）
 */
// 非 adapter 的噪音工具首段（CLI 管理命令 / 误解析名）。与 webcli/metrics.js
// 的语义保持一致：这类调用不进 adapter 统计口径。
export const NOISE_FIRST_SEGMENTS = new Set([
  "skill", "skills", "tool", "tools", "adapter", "adapters", "adapterhub",
  "service", "call", "route", "routes", "trace", "traces", "install", "list",
  "completion", "mcp", "mcp-logs", "browser", "login", "auth", "extension-path",
  // "wecli"：与 PR #326 曾内联在聚合 SQL 里的噪音清单对齐（历史内联版比集合多此一项）
  "stats", "webcli", "wecli", "help", "mode", "profiles", "capabilities", "tabs",
  "list_sites", "inspect_page_state", "evaluate_in_page", "version", "doctor",
]);
/** 噪音排除（SQL 侧）：flag 误用（'-' 开头）与 CLI 管理命令首段的调用不计入统计。 */
export function noiseExcludeClause() {
  const domains = [...NOISE_FIRST_SEGMENTS].map((s) => `'${s}'`).join(",");
  return ` AND tool NOT LIKE '-%' AND substr(tool, 1, instr(tool || '.', '.') - 1) NOT IN (${domains})`;
}

export function queryStats(db, { by = "domain", since = "30d", from = null, to = null, kind = null, top = null } = {}) {
  // 按用户聚合：user × domain 二维分布，结构不同于单维聚合，单独处理
  // 失败原因聚合（by=err）：仅统计失败调用（ok=0），按脱敏后的 err 分组
  if (by === "err") return queryByErr(db, { since, from, to, top });
  if (by === "user") return queryByUser(db, { since, from, to, kind, top });
  if (by === "active") return queryActiveUsers(db, { since, from, to, kind });

  // 路由决策埋点：route_* 事件聚合（命中率 + 分 kind 延迟），结构不同于单维聚合
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

  // 百分位：对每个 key 单独取 ms 序列算（数据量不大时简单可靠）
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

/**
 * 失败原因聚合（by=err）：仅统计失败调用（ok=0），按脱敏后的 err 分组。
 * 返回 [{ err, calls, tools, users, sampleTool }]，按 calls 倒序。
 * @param {DatabaseSync} db
 * @param {{since?:string, from?:string|null, to?:string|null, top?:number}} opts
 */
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

/**
 * 按用户聚合：返回 user × domain 二维分布的扁平 rows。
 *   [{ user, domain, calls }]，按 user、calls 倒序排列。
 * 调用方可前端再按 user 分组：user → [{domain, calls}]
 * @param {DatabaseSync} db
 * @param {{since?:string, from?:string|null, to?:string|null, kind?:string, top?:number}} opts
 */
function queryByUser(db, { since = "30d", from = null, to = null, kind = null, top = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }

  // 空 user（whoami 失败等）归入 (unknown) 组而不是静默消失：
  // 调用次数与用户维度的总量必须一致，缺失可见才能被发现。
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
  // top 限制每个 user 的 domain 数（不限制 user 数，user 通常不多）
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

/**
 * 用户活跃聚合（by=active）：逐日 DAU + 近 30 天 MAU。
 * DAU 跟随查询窗；MAU 固定近 30 天，不随窗口漂移（语义保持「月活」）。
 * 空 user 归 (unknown)，与 by=user 口径一致；噪音排除与 kind 过滤两者都生效。
 * @param {DatabaseSync} db
 * @param {{since?:string, from?:string|null, to?:string|null, kind?:string}} opts
 */
function queryActiveUsers(db, { since = "30d", from = null, to = null, kind = null } = {}) {
  const { start, end } = resolveWindow({ since, from, to });
  const params = [];
  const where = windowSql(start, end, params);
  let kindClause = "";
  if (kind) { kindClause = "AND kind = ?"; params.push(kind); }

  // 归一为普通对象:测试用 assert/strict deepEqual 断言整个数组,对 null 原型行敏感
  const rows = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch') AS day,
              COUNT(DISTINCT COALESCE(NULLIF(user, ''), '(unknown)')) AS dau
       FROM metrics
       WHERE ${where} ${kindClause} ${noiseExcludeClause()}
       GROUP BY day
       ORDER BY day ASC`
    )
    .all(...params)
    .map((r) => ({ day: r.day, dau: r.dau }));

  // MAU 固定近 30 天窗口,与 DAU 查询窗解耦(独立 params,不共享绑定参数)
  const mauParams = [];
  const mauWhere = windowSql(Date.now() - parseDuration("30d"), null, mauParams);
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

/**
 * 路由决策埋点聚合（by=route）。route_* 事件按 kind 聚合：调用数 + p50/p95 延迟，
 * 外加总命中率（route_hit.* / 全部 route_*）。kind 形如 route_hit.alias/override/llm、
 * route_miss、route_fallback.auth/missing_arg。结构独立于单维聚合。
 */
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

export function percentile(arr, p) {
  if (arr.length === 0) return 0;
  return arr[Math.max(0, Math.ceil((arr.length * p) / 100) - 1)];
}

/**
 * 解析查询时间窗。
 * @param {{since?:string, from?:string|null, to?:string|null}} opts
 *   - from/to:YYYY-MM-DD(UTC 日界);任一出现即自定义窗;缺 from 时下界沿用 since 相对窗,缺 to 时上界不设(end=null)
 *   - 都不出现:since 相对窗(start = now - parseDuration(since),无上界)
 * @returns {{start:number, end:number|null}} end 为 null 表示不设上界
 * 非法格式的 from/to 会产生 NaN 边界(SQL 匹配零行),由 handler 层 dayParam 保证格式
 */
export function resolveWindow({ since = "30d", from = null, to = null } = {}) {
  const start = from ? Date.parse(`${from}T00:00:00Z`) : Date.now() - parseDuration(since);
  const end = to ? Date.parse(`${to}T00:00:00Z`) + 86400000 : null;
  return { start, end };
}

/** 时间窗 WHERE 片段：`ts >= ? [AND ts < ?]`，参数按序 push 进 params。 */
function windowSql(start, end, params) {
  params.push(start);
  if (end != null) {
    params.push(end);
    return "ts >= ? AND ts < ?";
  }
  return "ts >= ?";
}

export function parseDuration(str) {
  const m = String(str || "").match(/^(\d+)(d|h|m)$/);
  if (!m) return 30 * 86400000;
  return parseInt(m[1], 10) * { d: 86400000, h: 3600000, m: 60000 }[m[2]];
}
