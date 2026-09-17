import { Router } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const PREFIX = '/api/website-exploration'
const UPSTREAM = 'http://127.0.0.1:8766'
const id = '[A-Za-z0-9_-]+'
const tool = `/api/toolkits/${id}/tools/${id}`
const rules: [string, RegExp][] = [
  ['GET', /^\/api\/(health|activity|browser\/(status|tabs|match)|toolkits)$/],
  ['POST', /^\/api\/(browser\/open|toolkits)$/],
  ['GET PUT DELETE', new RegExp(`^/api/toolkits/${id}$`)],
  ['GET POST', new RegExp(`^/api/toolkits/${id}/tools$`)],
  ['GET PUT DELETE', new RegExp(`^${tool}$`)],
  ['GET', new RegExp(`^${tool}/formal$`)],
  ['GET PUT DELETE', new RegExp(`^${tool}/development$`)],
  ['POST', new RegExp(`^${tool}/development/(start|messages|cancel|reset-from-formal|restart-from-exploration)$`)],
  ['GET', new RegExp(`^${tool}/development/events$`)],
  ['POST', new RegExp(`^${tool}/publish$`)],
  ['GET POST', new RegExp(`^${tool}/(explorations|debug-runs)$`)],
  ['GET', new RegExp(`^/api/toolkits/${id}/(export-status|export)$`)],
  ['POST', new RegExp(`^/api/toolkits/${id}/install-to-weworker$`)],
  ['GET', new RegExp(`^/api/(explorations|debug-runs|development-runs|replays)/${id}$`)],
  ['GET', new RegExp(`^/api/explorations/${id}/(timeline|steps|messages|events)$`)],
  ['POST', new RegExp(`^/api/explorations/${id}/(messages|pause|resume|cancel|replay)$`)],
  ['GET', new RegExp(`^/api/(debug-runs|replays)/${id}/events$`)],
  ['POST', new RegExp(`^/api/(debug-runs|replays)/${id}/cancel$`)],
  ['GET', new RegExp(`^/api/(explorations|debug-runs|development-runs)/${id}/files/[A-Za-z0-9_./-]+$`)],
]

export function allowedExplorationRequest(method: string, raw: string): boolean {
  const [pathname, query = ''] = raw.split('?')
  if (/%|\\|#/.test(pathname)) return false
  if (pathname.split('/').some(part => part === '.' || part === '..')) return false
  if (!rules.some(([methods, pattern]) => methods.split(' ').includes(method) && pattern.test(pathname))) return false
  const params = new URLSearchParams(query)
  const allowed = pathname === '/api/browser/match' ? ['url'] : pathname.endsWith('/cancel') ? ['force'] : []
  return [...params.keys()].every(key => allowed.includes(key))
}

export function mapExplorationResources(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('/api/') && allowedExplorationRequest('GET', value)) {
    return PREFIX + value.slice(4)
  }
  if (Array.isArray(value)) return value.map(mapExplorationResources)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapExplorationResources(item)]),
  )
  return value
}

export function createWebsiteExplorationRouter(options: {
  instanceId?: string
  fetch?: typeof fetch
} = {}) {
  const router = Router()
  const fetchUpstream = options.fetch || globalThis.fetch
  const instanceId = options.instanceId ?? process.env.WEWORKER_EXPLORATION_INSTANCE_ID
  router.use(async (req, res) => {
    const raw = '/api' + req.url
    if (!allowedExplorationRequest(req.method, raw)) {
      res.status(404).json({ detail: '不支持的网站探索操作' })
      return
    }
    const controller = new AbortController()
    const close = () => controller.abort()
    res.once('close', close)
    const timeout = setTimeout(close, 30_000)
    try {
      if (!instanceId) {
        res.status(503).json({ detail: '请从 WeWorker 客户端启动网站探索服务' })
        return
      }
      const health = await fetchUpstream(UPSTREAM + '/api/health', {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      })
      const identity = health.ok ? await health.json() : null
      if (!identity?.ok || identity.instance_id !== instanceId) {
        res.status(503).json({ detail: '网站探索服务尚未就绪或实例不匹配' })
        return
      }
      if (raw === '/api/health') {
        res.json(identity)
        return
      }
      const response = await fetchUpstream(UPSTREAM + raw, {
        method: req.method, redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: JSON.stringify(req.body || {}) } : {}),
      })
      res.status(response.status)
      res.setHeader('Cache-Control', 'no-store')
      const type = response.headers.get('content-type') || 'application/octet-stream'
      if (type.includes('application/json')) {
        res.json(mapExplorationResources(await response.json()))
      } else if (response.body) {
        clearTimeout(timeout)
        res.setHeader('Content-Type', type)
        const disposition = response.headers.get('content-disposition')
        if (disposition) res.setHeader('Content-Disposition', disposition)
        res.flushHeaders()
        await pipeline(Readable.fromWeb(response.body as never), res, { signal: controller.signal })
      } else res.end()
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(503).json({ detail: '网站探索连接中断，请确认服务状态后重试；操作结果可能需要刷新确认' })
      else if (!res.destroyed) res.end()
    } finally {
      clearTimeout(timeout)
      res.off('close', close)
    }
  })
  return router
}
