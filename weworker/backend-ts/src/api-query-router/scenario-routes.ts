/**
 * 第 0 层：manifest 预配置话术的确定性路由——编译产物加载与匹配（详见设计文档 §2 第 1/2/6/7 行）。
 *
 * 三种形态共用同一套「锚定全等 + 空白剥离 + 负向守卫 + 槽位强转」语义，区别只在目标：
 *   - 形态一 `tool`   ：直接派发单个只读工具（第 0 层形态 A/B）
 *   - 形态二 `plan`   ：只产出「入口 terminal + 输入装配」，链路语义交给锚点 DAG（第 9 层）
 *   - 形态三 `optout` ：不派发任何工具，仅**抑制**下层宽泛层抢答，整条交还 LLM
 *
 * 数据来源优先级：
 *   1) `router-config/scenario-routes.json`（`gen:routes` 编译产物，进 git、可评审、受逐层开关控制）；
 *   2) 产物缺失/为空 → 按当前 adapter 目录**内存重建**（写入方只用改 manifest 即可生效）。
 *
 * 精度姿态：任一环节不确定即返回 `null`（fail-closed），由调用方落回既有级联。漏判免费，
 * 误判致命——用错误答案短路模型是本设计唯一要防的事故。
 */

import { parseAllAdapters, type ParsedAdapter } from '../adapter-parser.js'
import { findAdaptersDirectory, resolveToolsForAdapter } from '../adapter-tool-list.js'
import { getSiteEnabled } from '../config.js'
import { createLogger } from '../logger.js'
import { loadRouterConfig } from '../router-config/loader.js'
import { applyRouterConfigScope } from '../router-config/validate.js'
import type {
  CompiledScenarioArgSpec,
  CompiledScenarioRoute,
  PlanTerminalsFile,
  ScenarioRoutesFile,
} from '../router-config/types.js'
import { compileScenarioRoutes, type CompileAdapterInput } from './scenario-route-compiler.js'
import { catalogSignature, getCatalog, isReadOnlyTool, type ToolCatalog } from './tool-catalog.js'
import type { MatchResult, ScenarioPayload } from './types.js'

const log = createLogger('api-query-router')

export type ScenarioRouteDef = CompiledScenarioRoute

/** 多跳形态命中：入口 terminal + 已装配输入 + 抽到的槽位（日志 / 审计用）。 */
export type ScenarioPlanHit = {
  adapter: string
  scenarioId: string
  terminalKey: string
  input: Record<string, unknown>
  slotValues: { name: string; raw: string }[]
}

/** 显式不直连命中：卡片身份 + 理由（仅日志 / 埋点用，不派发任何工具）。 */
export type ScenarioOptOutHit = {
  adapter: string
  scenarioId: string
  reason: string
}

/** 编译产物运行时形态（与 JSON 文件一一对应，字段名不可随意更名）。 */
export type { CompiledScenarioRoute, ScenarioRoutesFile }

const SCENARIO_ROUTE_ENV = 'WEWORKER_SCENARIO_ROUTE'

// ── 编译输入（运行时路径：当前 adapter 目录 + 已启用集合）─────────────────────

/**
 * 按当前生效 adapter 构造编译输入。**作用域硬约束**：只包含 `getSiteEnabled` 通过的 adapter，
 * 保证「配置项只对当前配置里真实存在的 adapter 生效」。
 */
export function buildCompileInputsFromRuntime(
  adaptersDir: string | null = findAdaptersDirectory(),
): CompileAdapterInput[] {
  let adapters: Map<string, ParsedAdapter>
  try {
    adapters = parseAllAdapters()
  } catch (error) {
    log.warn('scenario-route compile inputs failed', error)
    return []
  }
  const inputs: CompileAdapterInput[] = []
  for (const adapter of adapters.values()) {
    if (!getSiteEnabled(adapter.id, adapter.defaultEnabled, adapter.managed?.enabled)) continue
    let tools = adapter.tools
    try {
      tools = resolveToolsForAdapter(adapter, adaptersDir)
    } catch {
      // 读取失败时退回 manifest 声明的工具
    }
    inputs.push({
      adapterId: adapter.id,
      scenarios: adapter.registryScenarios ?? [],
      tools: tools.map((tool) => ({
        name: tool.name,
        safety: tool.safety,
        requiresConfirmation: tool.requiresConfirmation === true,
        parameters: tool.parameters ?? {},
        execution: adapter.toolExecution?.[tool.name] ?? tool.execution,
        aliases: tool.aliases ?? [],
      })),
    })
  }
  return inputs
}

/** 取当前生效的层 9 入口白名单（受逐层开关与用户覆盖层控制）。 */
export function getPlanTerminals(): PlanTerminalsFile | null {
  try {
    const { bundle } = loadRouterConfig()
    return bundle.planTerminals ?? null
  } catch (error) {
    log.warn('plan-terminals load failed', error)
    return null
  }
}

/**
 * 运行时二次准入：编译产物可能过期（工具被删 / safety 被改 / adapter 被停用）。
 * 匹配前逐条对齐当前工具目录，**只保留「存在 + 只读 + 可直调」的目标**；optout 无目标、恒保留。
 */
export function filterRoutesByCatalog(
  routes: readonly CompiledScenarioRoute[],
  planTerminals: PlanTerminalsFile | null = getPlanTerminals(),
  catalog: ToolCatalog = getCatalog(),
): { routes: CompiledScenarioRoute[]; dropped: string[] } {
  const out: CompiledScenarioRoute[] = []
  const dropped: string[] = []
  for (const route of routes) {
    if (!route || typeof route !== 'object') continue
    const label = `${route.adapter}:${route.scenarioId}`
    if (route.enabled === false) {
      dropped.push(`${label} (enabled:false)`)
      continue
    }
    if (route.optout) {
      out.push(route)
      continue
    }
    const target = route.tool ?? planTerminals?.adapters?.[route.adapter]?.[route.plan?.terminal ?? '']?.tool
    if (!target) {
      dropped.push(`${label} (目标工具未解析)`)
      continue
    }
    const tool = catalog.byName.get(target) ?? catalog.byName.get(`${route.adapter}.${target}`)
    if (!tool) {
      dropped.push(`${label} (工具不存在：${target})`)
      continue
    }
    if (!tool.direct) {
      dropped.push(`${label} (工具不可直调：${target})`)
      continue
    }
    if (!isReadOnlyTool(tool)) {
      // 写操作 / 需二次确认的工具绝不进路由面（§7 红线），即使产物里写了也拦掉。
      dropped.push(`${label} (工具非只读：${target})`)
      continue
    }
    out.push(route)
  }
  return { routes: out, dropped }
}

// ── 加载与热重载 ─────────────────────────────────────────────────────────────

type CacheState = {
  signature: string
  routes: CompiledScenarioRoute[]
}

let cache: CacheState | null = null

function currentSignature(): string {
  let routerSignature = '-'
  try {
    routerSignature = loadRouterConfig().signature
  } catch {
    routerSignature = '-'
  }
  return `${routerSignature}|${catalogSignature()}`
}

/**
 * 取当前生效的第 0 层路由。
 *
 * - `WEWORKER_SCENARIO_ROUTE=0` 为急停总开关（与其它层同机制）；
 * - 配置层有产物 → 用它（已过校验、已按作用域过滤）；
 * - 配置层为空 → 按当前 adapter 内存重建（改 manifest 即生效，无需跑编译脚本）；
 * - 任何异常 → 返回 `[]`，绝不炸主链路。
 */
export function loadScenarioRoutes(): CompiledScenarioRoute[] {
  if (process.env[SCENARIO_ROUTE_ENV] === '0') return []
  const signature = currentSignature()
  if (cache && cache.signature === signature) return cache.routes

  let routes: CompiledScenarioRoute[] = []
  try {
    const { bundle } = loadRouterConfig()
    const fromConfig = Array.isArray(bundle.scenarioRoutes?.routes) ? bundle.scenarioRoutes.routes : []
    if (fromConfig.length) {
      routes = fromConfig.filter((route) => route?.enabled !== false)
    } else {
      routes = compileInMemory()
    }
  } catch (error) {
    log.warn('scenario-routes load failed', error)
    routes = []
  }

  const { routes: usable, dropped } = filterRoutesByCatalog(routes)
  if (dropped.length) log.warn(`scenario-routes dropped ${dropped.length}: ${dropped.slice(0, 5).join('; ')}`)
  cache = { signature, routes: usable }
  return usable
}

/** 内存重建：把配置层的空产物当作「未编译」，直接用运行时输入编译一份。 */
function compileInMemory(): CompiledScenarioRoute[] {
  const inputs = buildCompileInputsFromRuntime()
  if (!inputs.length) return []
  const result = compileScenarioRoutes(inputs, { planTerminals: getPlanTerminals() })
  if (result.errors.length) {
    // 这里不抛错：坏声明只让对应卡片失效，其余仍可用（与配置层「坏条目只丢自己」同策略）。
    log.warn(`scenario-routes compile errors ${result.errors.length}: ${result.errors.slice(0, 5).join('; ')}`)
  }
  return result.routes
}

/** 当前 adapter 集合内、被编译产物覆盖的卡片 id（`adapter:scenarioId`）。供 /sites 徽标使用。 */
export function listCompiledScenarioKeys(): Set<string> {
  const keys = new Set<string>()
  for (const route of loadScenarioRoutes()) {
    if (route?.adapter && route?.scenarioId) keys.add(`${route.adapter}:${route.scenarioId}`)
  }
  return keys
}

/** 测试钩子：清空缓存（不触碰真实配置目录，仅重置进程内记忆）。 */
export function resetScenarioRoutesCacheForTests(): void {
  cache = null
}

// ── 共用匹配原语 ─────────────────────────────────────────────────────────────

/** 消息归一化：去全部空白（模板编译同规则，中文场景空格无语义）。 */
function normalize(message: string): string {
  return String(message ?? '').replace(/\s+/g, '')
}

/** 捕获值 → 参数值：按编译期类型转换；失败返回 undefined（视为未命中）。 */
function coerce(value: string | undefined, type: string | undefined): unknown {
  if (value === undefined) return undefined
  switch (type) {
    case 'integer':
    case 'number': {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    case 'boolean':
      return value === 'true' || value === 'false' ? value === 'true' : undefined
    default:
      return value
  }
}

type Compiled<T extends CompiledScenarioRoute> = {
  def: T
  guards: (RegExp | null)[]
  patterns: RegExp[]
}

/**
 * 共用编译：过滤 + 守卫 / 正则预编译。**正则非法即丢弃该条**（宁可漏判，不可误判）。
 */
function compileRoutes<T extends CompiledScenarioRoute>(
  routes: readonly CompiledScenarioRoute[],
  keep: (route: CompiledScenarioRoute) => route is T,
): Compiled<T>[] {
  const out: Compiled<T>[] = []
  for (const route of routes ?? []) {
    if (!route || route.enabled === false) continue
    if (!Array.isArray(route.patterns) || route.patterns.length === 0) continue
    if (!keep(route)) continue
    const patterns = route.patterns
      .map((pattern) => {
        try {
          return new RegExp(pattern.regex, pattern.flags || '')
        } catch {
          return null
        }
      })
      .filter((re): re is RegExp => re !== null)
    if (!patterns.length) continue
    out.push({
      def: route,
      guards: (route.guardNegative ?? []).map((source) => {
        try {
          return new RegExp(source)
        } catch {
          return null
        }
      }),
      patterns,
    })
  }
  return out
}

/** 捕获组 → 参数装配（slot 引用强转 + enum 校验）；任一失败返回 null（视为未命中）。 */
function assembleArgs(
  specs: Record<string, CompiledScenarioArgSpec> | undefined,
  groups: Record<string, string> | undefined,
): Record<string, unknown> | null {
  const args: Record<string, unknown> = {}
  for (const [param, spec] of Object.entries(specs ?? {})) {
    if (!spec || typeof spec !== 'object') continue
    if (spec.slot !== undefined) {
      const value = coerce(groups?.[spec.slot], spec.type)
      if (value === undefined) return null
      if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.map(String).includes(String(value))) return null
      args[param] = value
    } else if ('const' in spec) {
      args[param] = spec.const
    }
  }
  return args
}

function isToolRoute(route: CompiledScenarioRoute): route is CompiledScenarioRoute & { tool: string } {
  return typeof route.tool === 'string' && route.tool.length > 0
}

function isPlanRoute(
  route: CompiledScenarioRoute,
): route is CompiledScenarioRoute & { plan: { terminal: string; input?: Record<string, CompiledScenarioArgSpec> } } {
  return typeof route.plan?.terminal === 'string' && route.plan.terminal.length > 0
}

function isOptOutRoute(
  route: CompiledScenarioRoute,
): route is CompiledScenarioRoute & { optout: true; reason: string } {
  return route.optout === true && !route.tool && !route.plan
}

// ── 形态一：单工具直连 ───────────────────────────────────────────────────────

/**
 * 形态 B（话术匹配）：编译产物 → match 函数。输入用户原始消息，输出 `MatchResult`
 * （`source='scenario'`）或 null。纯函数、无 IO。
 */
export function buildScenarioMatcher(
  routes: readonly CompiledScenarioRoute[],
): (message: string) => MatchResult | null {
  const compiled = compileRoutes(routes, isToolRoute)

  return function matchScenario(message: string): MatchResult | null {
    const trimmed = message?.trim()
    if (!trimmed) return null
    const normalized = normalize(trimmed)

    for (const route of compiled) {
      if (route.guards.some((guard) => guard?.test(normalized))) continue
      for (const re of route.patterns) {
        const match = re.exec(normalized)
        if (!match?.groups) continue
        const args = assembleArgs(route.def.args, match.groups)
        if (!args) continue
        return { tool: route.def.tool, args, confidence: 1, source: 'scenario' }
      }
    }
    return null
  }
}

// ── 形态二：多跳入口 ─────────────────────────────────────────────────────────

/** 槽位名 ← 捕获组名（sN → slotNames[N]），供日志与审计记录。 */
function slotValuesOf(
  def: CompiledScenarioRoute,
  groups: Record<string, string> | undefined,
): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = []
  for (const spec of Object.values(def.plan?.input ?? {})) {
    if (!spec?.slot) continue
    const raw = groups?.[spec.slot]
    if (typeof raw !== 'string') continue
    const index = Number(/^s(\d+)$/.exec(spec.slot)?.[1] ?? Number.NaN)
    const name = Number.isInteger(index) && def.slotNames?.[index] ? def.slotNames[index] : spec.slot
    out.push({ name, raw })
  }
  return out
}

/**
 * 形态 B（多跳）：编译产物 → plan 命中函数。刻意不接进 `MatchResult`（其 `tool` 必填），
 * 由级联单独接线交给锚点 DAG。
 */
export function buildScenarioPlanMatcher(
  routes: readonly CompiledScenarioRoute[],
): (message: string) => ScenarioPlanHit | null {
  const compiled = compileRoutes(routes, isPlanRoute)

  return function matchScenarioPlan(message: string): ScenarioPlanHit | null {
    const trimmed = message?.trim()
    if (!trimmed) return null
    const normalized = normalize(trimmed)

    for (const route of compiled) {
      if (route.guards.some((guard) => guard?.test(normalized))) continue
      for (const re of route.patterns) {
        const match = re.exec(normalized)
        if (!match?.groups) continue
        const input = assembleArgs(route.def.plan.input, match.groups)
        if (!input) continue
        return {
          adapter: route.def.adapter,
          scenarioId: route.def.scenarioId,
          terminalKey: route.def.plan.terminal,
          input,
          slotValues: slotValuesOf(route.def, match.groups),
        }
      }
    }
    return null
  }
}

// ── 形态三：显式不直连（抑制下层）────────────────────────────────────────────

/**
 * 形态三：锚定全等命中 → 第 0 层抑制下层宽泛层抢答，整条交还 LLM。
 * 只对卡片句本身（含任意槽位填充）生效，故零误判面——不会因宽泛关键词误伤自由话术。
 */
export function buildScenarioOptOutMatcher(
  routes: readonly CompiledScenarioRoute[],
): (message: string) => ScenarioOptOutHit | null {
  const compiled = compileRoutes(routes, isOptOutRoute)

  return function matchScenarioOptOut(message: string): ScenarioOptOutHit | null {
    const trimmed = message?.trim()
    if (!trimmed) return null
    const normalized = normalize(trimmed)

    for (const route of compiled) {
      if (route.guards.some((guard) => guard?.test(normalized))) continue
      for (const re of route.patterns) {
        if (re.test(normalized)) {
          return { adapter: route.def.adapter, scenarioId: route.def.scenarioId, reason: route.def.reason ?? '' }
        }
      }
    }
    return null
  }
}

// ── 形态 A：客户端结构化 scenarioId + slots 直连 ─────────────────────────────

/**
 * `/chat` body.scenario 形状校验：畸形 / 缺失一律返回 null（静默忽略，不报错——它只是路由提示，
 * 不是对话内容）。槽位只收 string，数量上限 16（防畸形大载荷）。
 */
export function parseScenarioDirectPayload(raw: unknown): ScenarioPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { adapterId, scenarioId, slots } = raw as {
    adapterId?: unknown
    scenarioId?: unknown
    slots?: unknown
  }
  if (typeof adapterId !== 'string' || !adapterId.trim()) return null
  if (typeof scenarioId !== 'string' || !scenarioId.trim()) return null
  const out: Record<string, string> = {}
  if (slots != null && typeof slots === 'object' && !Array.isArray(slots)) {
    for (const [key, value] of Object.entries(slots)) {
      if (key && typeof value === 'string') out[key] = value
    }
  }
  if (Object.keys(out).length > 16) return null
  return { adapterId: adapterId.trim(), scenarioId: scenarioId.trim(), slots: out }
}

const PLACEHOLDER_SUB_RE = /\$\{([^}]+)\}/g
/** 缺槽哨兵：payload 缺该占位符时注入，重建文本必然与 message 不等（fail-closed）。 */
const MISSING_SLOT_SENTINEL = '\u0000'

/** 用 payload 槽位重填模板（同名占位符同值，与编译器去重语义一致）。 */
function rebuildTemplate(template: string, slots: Record<string, string>): string {
  return template.replace(PLACEHOLDER_SUB_RE, (_, name: string) => {
    const value = slots[name]
    return typeof value === 'string' ? value : MISSING_SLOT_SENTINEL
  })
}

/**
 * 形态 A 的**重建比对一致性门**：卡片点击与发送解耦、文本可被用户编辑，故不能盲信 payload。
 * 服务端用产物携带的原始话术模板重填 slots，与 message 归一化后**逐字符相等**才放行。
 * `tool` / `args` 映射永远来自编译产物（服务端白名单），payload 只带 scenarioId + 槽位值，
 * 因此伪造面 ≡ 形态 B。
 */
function identityGate(
  def: CompiledScenarioRoute,
  payload: ScenarioPayload,
  normalizedMessage: string,
): string[] | null {
  const slotNames = Array.isArray(def.slotNames) ? def.slotNames : null
  const templates = Array.isArray(def.promptTemplates)
    ? def.promptTemplates.filter((template) => typeof template === 'string' && template)
    : []
  if (!slotNames || !templates.length) return null
  if (!templates.some((template) => normalize(rebuildTemplate(template, payload.slots ?? {})) === normalizedMessage)) {
    return null
  }
  return slotNames
}

/** 形态 A（单工具）：`(payload, message)` → `MatchResult`（`source='scenario-a'`）或 null。纯函数。 */
export function buildScenarioDirectMatcher(
  routes: readonly CompiledScenarioRoute[],
): (payload: ScenarioPayload | null | undefined, message: string) => MatchResult | null {
  const byKey = new Map<string, CompiledScenarioRoute>()
  for (const route of routes ?? []) {
    if (!route?.adapter || !route?.scenarioId) continue
    byKey.set(`${route.adapter}:${route.scenarioId}`, route)
  }

  return function matchScenarioDirect(payload, message): MatchResult | null {
    if (!payload || typeof payload !== 'object') return null
    const trimmed = message?.trim()
    if (!trimmed) return null
    const def = byKey.get(`${payload.adapterId}:${payload.scenarioId}`)
    if (!def || def.enabled === false || !isToolRoute(def)) return null

    const normalizedMessage = normalize(trimmed)
    const slotNames = identityGate(def, payload, normalizedMessage)
    if (!slotNames) return null

    const args: Record<string, unknown> = {}
    for (const [param, spec] of Object.entries(def.args ?? {})) {
      if (!spec || typeof spec !== 'object') continue
      if (spec.slot !== undefined) {
        const index = Number(/^s(\d+)$/.exec(spec.slot)?.[1] ?? Number.NaN)
        const name = Number.isInteger(index) ? slotNames[index] : undefined
        const value = coerce(name !== undefined ? (payload.slots ?? {})[name] : undefined, spec.type)
        if (value === undefined) return null
        if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.map(String).includes(String(value))) return null
        args[param] = value
      } else if ('const' in spec) {
        args[param] = spec.const
      }
    }
    return { tool: def.tool, args, confidence: 1, source: 'scenario-a' }
  }
}

/** 形态 A（多跳）：同一重建门，命中则装配 `plan` 输入。 */
export function buildScenarioPlanDirectMatcher(
  routes: readonly CompiledScenarioRoute[],
): (payload: ScenarioPayload | null | undefined, message: string) => ScenarioPlanHit | null {
  const byKey = new Map<string, CompiledScenarioRoute & { plan: { terminal: string } }>()
  for (const route of routes ?? []) {
    if (isPlanRoute(route)) byKey.set(`${route.adapter}:${route.scenarioId}`, route)
  }

  return function matchScenarioPlanDirect(payload, message): ScenarioPlanHit | null {
    if (!payload || typeof payload !== 'object') return null
    const trimmed = message?.trim()
    if (!trimmed) return null
    const def = byKey.get(`${payload.adapterId}:${payload.scenarioId}`)
    if (!def || def.enabled === false) return null

    const normalizedMessage = normalize(trimmed)
    const slotNames = identityGate(def, payload, normalizedMessage)
    if (!slotNames) return null

    const input: Record<string, unknown> = {}
    const slotValues: { name: string; raw: string }[] = []
    for (const [key, spec] of Object.entries(def.plan.input ?? {})) {
      if (!spec || typeof spec !== 'object') continue
      if (spec.slot !== undefined) {
        const index = Number(/^s(\d+)$/.exec(spec.slot)?.[1] ?? Number.NaN)
        const name = Number.isInteger(index) ? slotNames[index] : undefined
        const raw = name !== undefined ? payload.slots?.[name] : undefined
        const value = coerce(raw, spec.type)
        if (value === undefined) return null
        if (Array.isArray(spec.enum) && spec.enum.length && !spec.enum.map(String).includes(String(value))) return null
        input[key] = value
        if (typeof raw === 'string') slotValues.push({ name: name ?? key, raw })
      } else if ('const' in spec) {
        input[key] = spec.const
      }
    }
    return { adapter: def.adapter, scenarioId: def.scenarioId, terminalKey: def.plan.terminal, input, slotValues }
  }
}

/** 便于测试与调用方一次性拿到全部 matcher（读一次配置，建四类匹配器）。 */
export function createScenarioMatchers(routes: readonly CompiledScenarioRoute[] = loadScenarioRoutes()): {
  routes: readonly CompiledScenarioRoute[]
  matchTool: (message: string) => MatchResult | null
  matchPlan: (message: string) => ScenarioPlanHit | null
  matchOptOut: (message: string) => ScenarioOptOutHit | null
  matchDirect: (payload: ScenarioPayload | null | undefined, message: string) => MatchResult | null
  matchPlanDirect: (payload: ScenarioPayload | null | undefined, message: string) => ScenarioPlanHit | null
} {
  return {
    routes,
    matchTool: buildScenarioMatcher(routes),
    matchPlan: buildScenarioPlanMatcher(routes),
    matchOptOut: buildScenarioOptOutMatcher(routes),
    matchDirect: buildScenarioDirectMatcher(routes),
    matchPlanDirect: buildScenarioPlanDirectMatcher(routes),
  }
}

/** 仅用于日志：当前产物条数与各形态分布。 */
export function describeScenarioRoutes(routes: readonly CompiledScenarioRoute[]): string {
  const tool = routes.filter(isToolRoute).length
  const plan = routes.filter(isPlanRoute).length
  const optout = routes.filter(isOptOutRoute).length
  return `total=${routes.length} tool=${tool} plan=${plan} optout=${optout}`
}

/** 作用域过滤的工具入口，供级联装配时复用（避免各处重复实现）。 */
export function scopedScenarioRoutes(
  bundle: { scenarioRoutes: ScenarioRoutesFile },
  adapterIds: ReadonlySet<string>,
): CompiledScenarioRoute[] {
  const scoped = applyRouterConfigScope(
    {
      routes: { routes: [] },
      aliases: { aliases: [] },
      shortcuts: { shortcuts: [] },
      patterns: { configs: {} },
      plans: { plans: [] },
      planTerminals: { adapters: {} },
      scenarioRoutes: bundle.scenarioRoutes,
    },
    adapterIds,
  )
  return scoped.bundle.scenarioRoutes.routes ?? []
}
