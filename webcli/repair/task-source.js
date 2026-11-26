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

// ── 巡检源:巡检报告(契约见 docs/superpowers/plans/2026-11-26-adapter-self-evolution-phase2.md)→ 修复任务。
// verdict 枚举 ok | degraded | needs-regeneration | login-blocked;仅 degraded/needs-regeneration 生成任务。
const PATROL_VERDICTS = new Set(["degraded", "needs-regeneration"]);

export function tasksFromPatrol(report, { minEntries = 1, now = Date.now() } = {}) {
  const adapters = report?.adapters || [];
  const tasks = [];
  for (const a of adapters) {
    if (!a.adapterId || !SAFE_ADAPTER_ID.test(a.adapterId)) continue;
    const entries = (a.entries || []).filter((e) => PATROL_VERDICTS.has(e.verdict));
    const degraded = entries.filter((e) => e.verdict === "degraded");
    const needsRegen = entries.filter((e) => e.verdict === "needs-regeneration").map((e) => e.tool);
    if (degraded.length + needsRegen.length < minEntries) continue;
    // needs-regeneration 也进 failures:诊断上下文可见;executor 对此类工具按既有 needs-regeneration 提前终止路径处理
    const failures = [
      ...degraded.map((e) => ({ tool: e.tool, count: 1, lastErr: `[patrol:${e.verdict}] ${String(e.diff || "").slice(0, 180)}` })),
      ...needsRegen.map((tool) => ({ tool, count: 1, lastErr: "[patrol:needs-regeneration] 站点结构改版,需重新取证" })),
    ];
    const task = buildTask({ source: "patrol", adapterId: a.adapterId, failures, now });
    task.runtime = a.runtime || null;
    task.patrol = { runId: String(report.runId || "").slice(0, 64), needsRegenerationTools: needsRegen };
    tasks.push(task);
  }
  return tasks;
}
