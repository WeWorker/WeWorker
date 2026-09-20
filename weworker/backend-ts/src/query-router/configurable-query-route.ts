import fs from 'node:fs'
import { parseAllAdapters, type ParsedAdapter, type StaticToolDef } from '../adapter-parser.js'
import { findAdaptersDirectory, resolveToolsForAdapter } from '../adapter-tool-list.js'
import { getSiteEnabled } from '../config.js'
import { runWebcliCall } from '../webcli-runner.js'
import * as store from '../works-store.js'

export type QueryRouteMatchConfig = {
  aliases?: string[]
  keywords?: string[]
}

export type QueryRouteConfigEntry = {
  id: string
  tool: string
  enabled?: boolean
  match?: QueryRouteMatchConfig
  args?: Record<string, unknown>
  title?: string
  render?: {
    type?: 'generic'
  }
}

export type QueryRouteConfig = {
  routes?: QueryRouteConfigEntry[]
}

export type QueryRouteContext = {
  message: string
  workId: string
  turnId: string
  chatStartTime: number
  send: (event: object) => void
  log?: (msg: string) => void
  llmRouteSettings?: unknown
}

export type QueryRouteCatalogTool = {
  adapterId: string
  toolName: string
  directCapable: boolean
}

export type QueryRouteDeps = {
  listCatalogTools?: () => QueryRouteCatalogTool[]
  dispatch?: (tool: string, argsJson: string, workId: string) => Promise<string>
  persistAssistantMessage?: (workId: string, text: string, timing: Record<string, unknown>) => void
  now?: () => number
}

const AUTH_FAILURE_RE = /登录超时|重新登录|登录态无效|未登录|统一认证|\/cas\/login|passport|logged_in["'\s:]+false/i
const RETCODE_3001_RE = /["']?retCode["']?\s*:\s*3001\b/
const AUTH_CODE_RE = /["'](AUTH_ERROR|UNAUTHORIZED|NOT_LOGGED_IN)["']/i
const MISSING_ARG_RE =
  /(is\s+required|为必填参数|missing\s+(?:required\s+)?(?:param|arg|parameter|argument)|MISSING_ARG)/i

export function loadQueryRouteConfig(filePath: string): QueryRouteConfig {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as QueryRouteConfig
  validateQueryRouteConfig(raw)
  return raw
}

export function validateQueryRouteConfig(config: QueryRouteConfig): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('query route config must be an object')
  }
  if (config.routes === undefined) return
  if (!Array.isArray(config.routes)) throw new Error('"routes" must be an array')
  for (const [index, route] of config.routes.entries()) {
    const label = `routes[${index}]`
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error(`${label} must be an object`)
    }
    if (!route.id || typeof route.id !== 'string') throw new Error(`${label}.id must be a string`)
    if (!route.tool || typeof route.tool !== 'string') throw new Error(`${label}.tool must be a string`)
    if (route.enabled !== undefined && typeof route.enabled !== 'boolean') {
      throw new Error(`${label}.enabled must be a boolean`)
    }
    if (route.match !== undefined) validateMatchConfig(route.match, `${label}.match`)
    if (route.args !== undefined && (!route.args || typeof route.args !== 'object' || Array.isArray(route.args))) {
      throw new Error(`${label}.args must be an object`)
    }
    if (route.title !== undefined && typeof route.title !== 'string') {
      throw new Error(`${label}.title must be a string`)
    }
    if (route.render !== undefined) {
      if (!route.render || typeof route.render !== 'object' || Array.isArray(route.render)) {
        throw new Error(`${label}.render must be an object`)
      }
      if (route.render.type !== undefined && route.render.type !== 'generic') {
        throw new Error(`${label}.render.type must be "generic"`)
      }
    }
  }
}

function validateMatchConfig(match: QueryRouteMatchConfig, label: string): void {
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    throw new Error(`${label} must be an object`)
  }
  validateStringArray(match.aliases, `${label}.aliases`)
  validateStringArray(match.keywords, `${label}.keywords`)
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`)
  }
}

export function createConfiguredQueryRoute(
  config: QueryRouteConfig,
  deps: QueryRouteDeps = {},
): (context: QueryRouteContext) => Promise<boolean> {
  validateQueryRouteConfig(config)
  const routes = (config.routes ?? []).filter((route) => route.enabled !== false)
  if (routes.length === 0) return async () => false

  return async (context: QueryRouteContext): Promise<boolean> => {
    const message = String(context.message ?? '')
    const route = routes.find((entry) => routeMatches(entry, message))
    if (!route) return false

    const catalog = deps.listCatalogTools ? deps.listCatalogTools() : listDefaultCatalogTools()
    const tool = catalog.find((item) => item.toolName === route.tool)
    if (!tool) {
      context.log?.(`query-route skipped unavailable tool: ${route.tool}`)
      return false
    }
    if (!tool.directCapable) {
      context.log?.(`query-route skipped non-direct tool: ${route.tool}`)
      return false
    }

    const start = deps.now?.() ?? Date.now()
    const argsJson = JSON.stringify(route.args ?? {})
    const dispatch = deps.dispatch ?? runWebcliCall
    let raw = ''
    try {
      raw = await dispatch(route.tool, argsJson, context.workId)
    } catch (error) {
      raw = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }

    if (looksLikeAuthFailure(raw)) {
      context.log?.(`query-route auth fallback: ${route.tool}`)
      return false
    }
    if (looksLikeMissingArg(raw)) {
      context.log?.(`query-route missing-arg fallback: ${route.tool}`)
      return false
    }

    const execMs = (deps.now?.() ?? Date.now()) - start
    const totalMs = (deps.now?.() ?? Date.now()) - context.chatStartTime
    const text = renderGeneric(raw, route.title)

    context.send({ type: 'turn_start', turnId: context.turnId, workId: context.workId })
    context.send({ type: 'text_delta', content: text })
    context.send({ type: 'turn_end', turnId: context.turnId, workId: context.workId, totalMs, llmMs: 0, execMs, steps: 1 })

    const timing = { totalMs, llmMs: 0, execMs, steps: 1 }
    if (deps.persistAssistantMessage) {
      deps.persistAssistantMessage(context.workId, text, timing)
    } else {
      store.appendMessage(context.workId, 'assistant', [
        { type: 'text', text },
        { type: 'timing', ...timing },
      ])
    }
    context.log?.(`query-route hit: ${route.tool}`)
    return true
  }
}

export function listDefaultCatalogTools(): QueryRouteCatalogTool[] {
  const adapters = parseAllAdapters()
  const adaptersDir = findAdaptersDirectory()
  const result: QueryRouteCatalogTool[] = []
  for (const adapter of adapters.values()) {
    if (!getSiteEnabled(adapter.id, adapter.defaultEnabled)) continue
    for (const tool of resolveToolsForAdapter(adapter, adaptersDir)) {
      const toolName = tool.name.startsWith(`${adapter.id}.`) ? tool.name : `${adapter.id}.${tool.name}`
      result.push({
        adapterId: adapter.id,
        toolName,
        directCapable: isDirectCapable(adapter, tool),
      })
    }
  }
  return result
}

function isDirectCapable(adapter: ParsedAdapter, tool: StaticToolDef): boolean {
  const execution = adapter.toolExecution?.[tool.name] ?? tool.execution
  return execution?.type === 'api' && execution?.runtime === 'background'
    || tool.directCapable === true
    || tool.executionMode === 'direct'
}

function routeMatches(route: QueryRouteConfigEntry, message: string): boolean {
  const normalized = normalizeText(message)
  for (const alias of route.match?.aliases ?? []) {
    if (normalized === normalizeText(alias)) return true
  }
  for (const keyword of route.match?.keywords ?? []) {
    const k = normalizeText(keyword)
    if (k && normalized.includes(k)) return true
  }
  return false
}

function normalizeText(value: string): string {
  return String(value ?? '').trim().toLowerCase()
}

export function looksLikeAuthFailure(raw: string): boolean {
  if (!raw) return false
  return AUTH_FAILURE_RE.test(raw) || RETCODE_3001_RE.test(raw) || AUTH_CODE_RE.test(raw)
}

export function looksLikeMissingArg(raw: string): boolean {
  if (!raw) return false
  return MISSING_ARG_RE.test(raw)
}

export function renderGeneric(raw: string, title?: string): string {
  const parsed = tryParseJson(raw)
  const body = renderValue(parsed)
  return title ? `### ${title}\n\n${body}` : body
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map((item, index) => `${index + 1}. ${renderInline(item)}`).join('\n')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const rows = Object.entries(record).filter(([, v]) => v !== undefined)
    if (rows.length === 0) return '{}'
    return rows.map(([key, val]) => `- ${key}: ${renderInline(val)}`).join('\n')
  }
  return String(value)
}

function renderInline(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
