// 主站访问统计 —— 数据层
// 走同域 /api/visits：本地 dev 由 Vite proxy 转发到 metrics-server，生产由 Nginx 反代。
// token 在代理层注入，不进前端 bundle。

/**
 * 上报一次页面访问（PV）。
 * 静默失败：上报不影响页面加载；keepalive 保证页面卸载时也能送达。
 * @param {string} path 当前访问路径，如 '/'、'/download'、'/docs'
 */
export async function reportVisit(path) {
  try {
    await fetch('/api/visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      keepalive: true,
    })
  } catch {
    // 静默失败，不阻塞页面
  }
}

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
