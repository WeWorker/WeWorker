/**
 * HTTP 路由处理 —— 与 server.js 解耦，便于单测
 *
 * 路由：
 *   POST /v1/metrics/batch   接收上报（鉴权 + 限尺 + 校验 + 脱敏 + 幂等落库）
 *   GET  /v1/stats           聚合查询（by=domain|tool|err|user|route|active）
 *   POST /v1/visits          站点访问上报（PV 逐次累加，UV 查询时按 ip 去重）
 *   GET  /v1/visits          站点访问 PV/UV 聚合查询
 *   GET  /v1/healthz         健康检查
 *   GET stats/visits 支持 from/to=YYYY-MM-DD（UTC 日界）自定义窗，非法值 → 400
 */

import { insertBatch, queryStats, insertVisit, queryVisits } from "./db.js";

const MAX_BODY_BYTES = 1 << 20; // 1MB
const MAX_BATCH = 500;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析 YYYY-MM-DD 日期查询参数(UTC 日界)。
 * 未提供返回 null;格式非法抛 {code:400},由路由层转 400 响应。
 */
export function dayParam(url, name) {
  const v = url.searchParams.get(name);
  if (v == null || v === "") return null;
  // V8 对「日在当月长度之外」的 ISO 串(如 2026-02-30)是 rollover 成 3 月 2 日而非 NaN,
  // 除正则与 Date.parse 有限性外,还回读 toISOString 校验该日历日真实存在。
  const ts = Date.parse(`${v}T00:00:00Z`);
  if (!DAY_RE.test(v) || !Number.isFinite(ts) || new Date(ts).toISOString().slice(0, 10) !== v) {
    throw Object.assign(new Error(`invalid ${name}, expect YYYY-MM-DD`), { code: 400 });
  }
  return v;
}

/** 校验 Bearer token。未配置 token（空）时视为开放（仅建议内网/测试用） */
export function checkAuth(req, token) {
  if (!token) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${token}`;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/** 读取并解析 JSON body，超过上限则抛错 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("invalid json"), { code: 400 })); }
    });
    req.on("error", reject);
  });
}

/**
 * 主路由。
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{db:object, token:string}} ctx
 */
export async function handle(req, res, ctx) {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /v1/healthz") {
    return send(res, 200, { ok: true });
  }

  if (route === "POST /v1/metrics/batch") {
    if (!checkAuth(req, ctx.token)) return send(res, 401, { error: "unauthorized" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, e.code || 400, { error: e.message });
    }
    if (!Array.isArray(body.batch)) return send(res, 400, { error: "batch required" });
    if (body.batch.length > MAX_BATCH) return send(res, 413, { error: "batch too large" });
    try {
      const { accepted, skipped } = insertBatch(ctx.db, body);
      return send(res, 200, { accepted, skipped });
    } catch (e) {
      return send(res, 500, { error: "ingest failed" });
    }
  }

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

  // ── 站点访问统计（PV/UV）──

  if (route === "POST /v1/visits") {
    if (!checkAuth(req, ctx.token)) return send(res, 401, { error: "unauthorized" });
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, e.code || 400, { error: e.message });
    }
    const clientIp =
      (req.headers["x-forwarded-for"] || "").split(",")[0]?.trim()
      || req.socket?.remoteAddress
      || "";
    try {
      insertVisit(ctx.db, {
        day: typeof body.day === "string" ? body.day : undefined,
        ip: typeof body.ip === "string" && body.ip ? body.ip : clientIp,
        path: typeof body.path === "string" ? body.path : undefined,
        ua: typeof body.ua === "string" ? body.ua : undefined,
      });
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { error: "visit ingest failed" });
    }
  }

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

  return send(res, 404, { error: "not found" });
}
