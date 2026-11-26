/** 报错源:metrics-server errdetail → 统一修复任务。 */
import { buildTask } from "./task.js";

// adapterId 允许字符:open_browser 等会把整段 URL 记进工具名(如
// `open.https:\todo.weoa.com/...`),派生的 adapterId 含 :/\ 非法字符,
// 会让 saveTask 写文件 ENOENT 并污染任务列表——此类脏数据直接跳过。
const SAFE_ADAPTER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function adapterIdOfTool(tool) {
  const i = String(tool).lastIndexOf(".");
  return i > 0 ? String(tool).slice(0, i) : null;
}

export function tasksFromErrDetail(errdetail, { minCalls = 3, now = Date.now() } = {}) {
  const rows = errdetail?.rows || [];
  const byAdapter = new Map();
  for (const row of rows) {
    for (const t of row.tools || []) {
      const adapterId = adapterIdOfTool(t.tool);
      if (!adapterId || !SAFE_ADAPTER_ID.test(adapterId)) continue;
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
  const totalOf = (t) => t.failures.reduce((s, f) => s + f.count, 0);
  tasks.sort((a, b) => totalOf(b) - totalOf(a));
  return tasks;
}

export async function fetchErrDetail({ registry = process.env.METRICS_STATS_ENDPOINT, token = process.env.METRICS_STATS_TOKEN, since = "7d", fetchImpl = fetch } = {}) {
  if (!registry) throw new Error("缺少 METRICS_STATS_ENDPOINT 环境变量(metrics-server 查询地址)");
  if (!token) throw new Error("缺少 METRICS_STATS_TOKEN 环境变量(工作台机器配置 errdetail 查询令牌)");
  const url = `${String(registry).replace(/\/$/, "")}/v1/stats?by=errdetail&kind=adapter&since=${encodeURIComponent(since)}`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`errdetail 拉取失败: ${res.status}`);
  return res.json();
}
