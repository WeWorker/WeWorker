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
// 导出供 metrics-server 的漂移守卫测试做双向比对,改动名单必须两侧同步。
export const NOISE_FIRST_SEGMENTS = new Set([
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
 * @returns {Promise<{rows:Array, totalCalls?:number, totalFailed?:number, mau?:number, unavailable?:boolean}>}
 *   by=tool/domain → {rows, totalCalls};by=err → {rows, totalFailed};by=active → {rows, mau};
 *   代理未接入(非 JSON 响应)→ {rows:[], totalCalls:0, unavailable:true}
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
  const rows = Array.isArray(data.rows) ? data.rows : []
  // 旧 server 无 by=active:回落 domain 聚合,响应不含 mau 字段(rows 形状也可能是
  // {key,...})。以「响应带数值型 mau」为支持判据——空数据的新 server 也返回 mau:0,
  // 而空 rows 的旧 server 会被误判为支持、显示假 0 月活。
  const supported = typeof data.mau === 'number' && (rows.length === 0 || rows[0].day != null)
  return {
    rows: supported ? rows : [],
    mau: supported ? data.mau : 0,
    unavailable: Boolean(data.unavailable) || !supported,
  }
}
