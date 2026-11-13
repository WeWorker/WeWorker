import { Router } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readExplorationAttachments } from './exploration-attachments.js'
import type { Settings } from './config.js'
import { defaultExplorationModel, explorationConversationSettings } from './exploration-model-settings.js'

const PREFIX = '/api/website-exploration'
const UPSTREAM = 'http://127.0.0.1:8766'
const id = '[A-Za-z0-9_-]+'
const tool = `/api/toolkits/${id}/tools/${id}`
const rules: [string, RegExp][] = [
  ['GET POST', /^\/api\/explorations$/],
  ['GET POST', new RegExp(`^/api/explorations/${id}/model$`)],
  ['PATCH DELETE', new RegExp(`^/api/explorations/${id}$`)],
  ['GET', /^\/api\/(health|activity|browser\/(status|tabs|match)|toolkits)$/],
  ['POST', /^\/api\/(browser\/open|toolkits)$/],
  ['GET PUT DELETE', new RegExp(`^/api/toolkits/${id}$`)],
  ['GET POST', new RegExp(`^/api/toolkits/${id}/tools$`)],
  ['GET PUT DELETE', new RegExp(`^${tool}$`)],
  ['GET', new RegExp(`^${tool}/formal$`)],
  ['GET PUT DELETE', new RegExp(`^${tool}/development$`)],
  ['POST', new RegExp(`^${tool}/development/(start|messages|cancel|reset-from-formal|restart-from-exploration)$`)],
  ['GET', new RegExp(`^${tool}/development/events$`)],
  ['GET POST', new RegExp(`^${tool}/(explorations|debug-runs)$`)],
  ['GET', new RegExp(`^/api/toolkits/${id}/(export-status|export)$`)],
  ['GET', new RegExp(`^/api/(explorations|debug-runs|development-runs|replays)/${id}$`)],
  ['GET', new RegExp(`^/api/explorations/${id}/(timeline|steps|messages|events)$`)],
  ['GET', new RegExp(`^/api/explorations/${id}/file-changes(?:/[a-f0-9]{32}(?:/artifact)?)?$`)],
  ['POST', new RegExp(`^/api/explorations/${id}/(messages|resume|cancel|replay)$`)],
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
  if (pathname.includes('/file-changes')) {
    const key = pathname.endsWith('/file-changes') ? 'offset' : 'file'
    return [...params.keys()].every(k => k === key) && (!params.has(key)
      || (params.getAll(key).length === 1 && /^\d+$/.test(params.get(key)!) && Number(params.get(key)) <= (key === 'offset' ? 1_000_000 : 10_000)))
  }
  const summaryList = method === 'GET' && (pathname === '/api/explorations' || new RegExp(`^${tool}/explorations$`).test(pathname))
  if (summaryList) return [...params.keys()].every(key => key === 'view')
    && (!params.has('view') || (params.getAll('view').length === 1 && params.get('view') === 'summary'))
  const allowed = pathname === '/api/browser/match' ? ['url', 'toolkit_id', 'tool_id'] : pathname.endsWith('/cancel') ? ['force'] : []
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
  beforeDelete?: (explorationId: string) => void
  afterDelete?: (explorationId: string) => void
  getSettings?: () => Settings
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
        const detail = process.env.WEWORKER_BACKEND_INSTANCE_ID
          ? '客户端未传入网站探索服务实例信息，请完整退出并重启 WeWorker'
          : '当前连接的是独立启动的后端，请停止该后端后重启 WeWorker 客户端'
        res.status(503).json({ detail })
        return
      }
      const health = await fetchUpstream(UPSTREAM + '/api/health', {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      })
      const identity = health.ok ? await health.json() : null
      if (!identity?.ok) {
        res.status(503).json({ detail: '网站探索服务尚未就绪，正在等待服务启动' })
        return
      }
      if (identity.instance_id !== instanceId) {
        res.status(503).json({ detail: '网站探索服务实例不匹配，请检查 8766 端口是否被其他实例占用' })
        return
      }
      if (raw === '/api/health') {
        res.json(identity)
        return
      }
      const deletingId = req.method === 'DELETE' && raw.split('?')[0].match(/^\/api\/explorations\/([A-Za-z0-9_-]+)$/)?.[1]
      if (deletingId) {
        try { options.beforeDelete?.(deletingId) }
        catch (error) { res.status(409).json({ detail: error instanceof Error ? error.message : '探索记录暂时无法删除' }); return }
      }
      let body = req.body || {}
      const creating = req.method === 'POST' && (raw === '/api/explorations' || new RegExp(`^${tool}/explorations$`).test(raw))
      const selectingModel = req.method === 'POST' && new RegExp(`^/api/explorations/${id}/model$`).test(raw)
      if ((creating || selectingModel) && options.getSettings) {
        try {
          const candidate = explorationConversationSettings(options.getSettings(), body.model_selection)
          body = { ...body, model_selection: defaultExplorationModel(candidate) }
        } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '探索模型无效' }); return }
      }
      if (body.attachments !== undefined) {
        const acceptsFiles = req.method === 'POST' && (raw === '/api/explorations'
          || new RegExp(`^${tool}/explorations$`).test(raw)
          || new RegExp(`^/api/explorations/${id}/(messages|resume)$`).test(raw))
        if (!acceptsFiles) { res.status(400).json({ detail: '此操作不支持附件' }); return }
        try { body = { ...body, attachments: await readExplorationAttachments(body.attachments) } }
        catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '附件读取失败' }); return }
      }
      const response = await fetchUpstream(UPSTREAM + raw, {
        method: req.method, redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: JSON.stringify(body) } : {}),
      })
      if (response.ok && deletingId) options.afterDelete?.(deletingId)
      res.status(response.status)
      res.setHeader('Cache-Control', 'no-store')
      const type = response.headers.get('content-type') || 'application/octet-stream'
      if (type.includes('application/json') && !/\/file-changes\/[a-f0-9]{32}\/artifact(?:\?|$)/.test(raw)) {
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
      if (!res.headersSent && !res.destroyed) res.status(503).json({ detail: req.method === 'GET'
        ? '网站探索服务暂时无法连接，正在等待服务启动或恢复'
        : '网站探索连接中断，请确认服务状态后重试；操作结果可能需要刷新确认' })
      else if (!res.destroyed) res.end()
    } finally {
      clearTimeout(timeout)
      res.off('close', close)
    }
  })
  return router
}
