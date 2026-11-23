/** 报错源:metrics-server errdetail → 统一修复任务。 */
import { buildTask } from "./task.js";

export function adapterIdOfTool(tool) {
  const i = String(tool).lastIndexOf(".");
  return i > 0 ? String(tool).slice(0, i) : null;
}

export function tasksFromErrDetail(errdetail, { minCalls = 3, now = Date.now() } = {}) {
  const byAdapter = new Map();
  for (const row of errdetail.rows || []) {
    for (const t of row.tools || []) {
      const adapterId = adapterIdOfTool(t.tool);
      if (!adapterId) continue;
      if (!byAdapter.has(adapterId)) byAdapter.set(adapterId, []);
      byAdapter.get(adapterId).push({ tool: t.tool, count: t.calls, lastErr: String(row.err || "").slice(0, 200) });
    }
  }
  const tasks = [];
  for (const [adapterId, failures] of byAdapter) {
    const total = failures.reduce((s, f) => s + f.count, 0);
    if (total < minCalls) continue;
    failures.sort((a, b) => b.count - a.count);
    tasks.push(buildTask({ source: "errdetail", adapterId, failures, now }));
  }
  return tasks;
}

export async function fetchErrDetail({ registry = process.env.METRICS_STATS_ENDPOINT || "http://weworker.weoa.com", token = process.env.METRICS_STATS_TOKEN, since = "7d", fetchImpl = fetch } = {}) {
  if (!token) throw new Error("缺少 METRICS_STATS_TOKEN 环境变量(工作台机器配置 errdetail 查询令牌)");
  const url = `${String(registry).replace(/\/$/, "")}/v1/stats?by=errdetail&kind=adapter&since=${encodeURIComponent(since)}`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`errdetail 拉取失败: ${res.status}`);
  return res.json();
}
