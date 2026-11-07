/**
 * HTTP 路由处理 —— 与 server.js 解耦，便于单测
 *
 * 路由：
 *   POST /v1/metrics/batch   接收上报（鉴权 + 限尺 + 校验 + 脱敏 + 幂等落库）
 *   GET  /v1/stats           聚合查询
 *   GET  /v1/healthz         健康检查
 */

import { insertBatch, queryStats, insertVisit, queryVisits } from "./db.js";

const MAX_BODY_BYTES = 1 << 20; // 1MB
const MAX_BATCH = 500;

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
      byRaw === "tool" ? "tool" : byRaw === "err" ? "err" : byRaw === "user" ? "user" : byRaw === "route" ? "route" : "domain";
    const since = url.searchParams.get("since") || "30d";
    const kind = url.searchParams.get("kind") || null;
    const topRaw = url.searchParams.get("top");
    const top = topRaw ? parseInt(topRaw, 10) : null;
    try {
      const data = queryStats(ctx.db, { by, since, kind, top });
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
    try {
      const data = queryVisits(ctx.db, { since });
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: "visits query failed" });
    }
  }

  return send(res, 404, { error: "not found" });
}
