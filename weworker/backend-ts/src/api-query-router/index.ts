/**
 * 智能路由引擎对外出口（详见 docs/intelligent_routing_design.md）。
 *
 * 结构：`cascade.ts` 负责**规划**（纯函数，不派发），本文件负责**执行**（派发 + 渲染 + 落库 + 推流）
 * 与装配（把 router-config 的各层编成 matcher）。
 *
 * 三条不可动摇的性质：
 *   1. **幂等落回**：任一环节不确定 → 返回 false，由调用方走既有 `streamChat`；今天的行为是兜底，
 *      不是被替代品。零配置（所有层为空）时本模块对任何消息都返回 false。
 *   2. **写操作不入路由面**：只有「存在 + 可直调 + 显式 `safety: 'read'`」的工具会被派发。
 *   3. **热重载**：所有配置与 manifest 改动在下一次决策即生效（按签名重建 matcher），无需重启进程。
 */

import { createHash } from 'node:crypto'
import { loadRouterConfig } from '../router-config/loader.js'
import { appendWorkLog } from '../work-log-file.js'
import { applyRouterConfigScope } from '../router-config/validate.js'
import { emptyRouterConfigBundle, type CompiledScenarioRoute, type RouterConfigBundle } from '../router-config/types.js'
import { runWebcliCall } from '../webcli-runner.js'
import { rehydratePointer } from '../webcli-result-cache.js'
import * as store from '../works-store.js'
import { getSettings } from '../config.js'
import { createLogger } from '../logger.js'
import { looksLikeAuthFailure, looksLikeMissingArg } from '../query-router/configurable-query-route.js'
import {
  advanceAfterFailure,
  isLayerSkipped,
  planCascade,
  type CascadeLayer,
  type CascadePlan,
  type CascadeStep,
  type PlanCascadeDeps,
} from './cascade.js'
import { isDiscussionMessage, isFollowUpMessage } from './gates.js'
import { mentionsAdapter } from './recall.js'
import { getCatalog, isReadOnlyTool, listDirectTools, relativeForLog, currentAdaptersDir } from './tool-catalog.js'
import { buildRouteMatcher, configuredToolsOf } from './routes-layer.js'
import { runPagePrep } from './page-prep.js'
import { buildPatternMatcher } from './patterns.js'
import { buildShortcutMatcher } from './shortcuts.js'
import { buildAliasMatcher, isAliasPrefixed } from './aliases.js'
import { buildPlanMatcher, type CompiledPlan } from './plan-dag.js'
import { getManifestTemplateIndex, matchManifestTemplate } from './manifest-templates.js'
import {
  buildScenarioDirectMatcher,
  buildScenarioMatcher,
  buildScenarioOptOutMatcher,
  buildScenarioPlanDirectMatcher,
  buildScenarioPlanMatcher,
  loadScenarioRoutes,
  parseScenarioDirectPayload,
  type ScenarioPlanHit,
} from './scenario-routes.js'
import { renderGeneric } from './generic-renderer.js'
import { runPlan, PlanFallback, type AskUserFn, type PlanInput } from './anchor-plan.js'
import { describeScenarioRoutes } from './scenario-routes.js'
import {
  classifyDispatchPayload,
  createGuardedDispatch,
  isUnrenderableAnswer,
  resolveDispatchTimeoutMs,
  RouteDispatchError,
  type RouteDispatchFn,
} from './route-dispatch.js'
import { briefPayload, type MatchSource, type RenderCtx, type RoutedAnswer, type ScenarioPayload } from './types.js'

const log = createLogger('api-query-router')

/** 运行时急停总开关：置 0 即整层不生效（与其它层同机制）。 */
const ROUTE_ENV = 'WEWORKER_API_QUERY_ROUTE'

export type RouteEngine = {
  /** 规划期与执行期共用的一组 matcher（按配置签名重建） */
  matchers: PlanCascadeDeps['matchers']
  /** 当前生效的工具全名（可直调 + 只读），用于路由面准入 */
  routableTools: Set<string>
  /** 层 9 编译后的计划（执行期按 id 取 resolver / terminal） */
  plans: CompiledPlan[]
  bundle: RouterConfigBundle
  signature: string
  /** 当前产物统计，仅日志用 */
  describe: string
}

export type RouteEngineDeps = {
  bundle?: RouterConfigBundle
  /** 只在这些 adapter 内生效（缺省取当前已启用集合） */
  adapterIds?: ReadonlySet<string>
}

let engineCache: { signature: string; engine: RouteEngine } | null = null

function configSignature(bundle: RouterConfigBundle, adapterIds: ReadonlySet<string>): string {
  // 用各层 JSON 的字符串指纹参与缓存键：改一行配置即重建 matcher（热重载）。
  return JSON.stringify([
    bundle.routes,
    bundle.aliases,
    bundle.shortcuts,
    bundle.patterns,
    bundle.plans,
    bundle.renderers,
    bundle.planTerminals,
    bundle.scenarioRoutes?.generatedAt ?? '',
    bundle.scenarioRoutes?.routes?.length ?? 0,
    [...adapterIds].sort(),
    getCatalog().tools.map((tool) => `${tool.name}:${tool.safety ?? ''}:${tool.direct ? 1 : 0}`),
  ])
}

/**
 * 装配路由引擎。所有层的匹配器在这里一次性建好；配置或 adapter 目录变化时自动重建。
 */
export function getRouteEngine(deps: RouteEngineDeps = {}): RouteEngine {
  const catalog = getCatalog()
  const adapterIds = deps.adapterIds ?? catalog.adapterIds
  const bundle = deps.bundle ?? loadScopedBundle(adapterIds)
  const signature = configSignature(bundle, adapterIds)
  if (engineCache && engineCache.signature === signature) return engineCache.engine

  const routableTools = new Set<string>()
  for (const tool of catalog.tools) {
    if (tool.direct && isReadOnlyTool(tool)) routableTools.add(tool.name)
  }
  // 只读但不可直调的工具（需页面上下文）不进路由面——不在 routableTools 里，天然拒绝。
  const scenarioRoutes = filterScenarioRoutesInScope(adapterIds)
  const routeMatcher = buildRouteMatcher(bundle.routes?.routes)
  const patternMatcher = buildPatternMatcher(bundle.patterns, { allowedTools: routableTools })
  const shortcutMatcher = buildShortcutMatcher(bundle.shortcuts?.shortcuts)
  const aliasMatcher = buildAliasMatcher(bundle.aliases?.aliases)
  const planMatcher = buildPlanMatcher(bundle.plans?.plans)

  const templates = getManifestTemplateIndex()
  const templateMatcher = (message: string) => {
    const hit = matchManifestTemplate(message, templates)
    if (!hit) return null
    return { tool: hit.template.tool, args: hit.args, id: hit.template.id }
  }

  const toolMatcher = buildScenarioMatcher(scenarioRoutes)
  const planScenarioMatcher = buildScenarioPlanMatcher(scenarioRoutes)
  const optOutMatcher = buildScenarioOptOutMatcher(scenarioRoutes)
  const directMatcher = buildScenarioDirectMatcher(scenarioRoutes)
  const planDirectMatcher = buildScenarioPlanDirectMatcher(scenarioRoutes)

  const engine: RouteEngine = {
    matchers: {
      route: routeMatcher,
      scenario: {
        match: (message) => {
          const hit = toolMatcher(message)
          return hit ? { tool: hit.tool, args: hit.args } : null
        },
        matchPlan: (message) => planScenarioMatcher(message),
        matchOptOut: (message) => optOutMatcher(message),
        matchDirect: (payload, message) => {
          const hit = directMatcher(payload, message)
          return hit ? { tool: hit.tool, args: hit.args } : null
        },
        matchPlanDirect: (payload, message) => planDirectMatcher(payload, message),
      },
      template: templateMatcher,
      pattern: (message) => {
        const hit = patternMatcher(message)
        // Keep the pattern-level render declaration when adapting the matcher result to the
        // cascade interface. Dropping it here silently falls back to generic rendering even
        // though both the config loader and the matcher preserved the schema reference.
        return hit ? { tool: hit.tool, args: hit.args, confidence: hit.confidence, render: hit.render } : null
      },
      plan: (message) => {
        const hit = planMatcher.match(message)
        if (!hit) return null
        const terminalTool = hit.plan.terminals[hit.terminalKey]?.tool ?? hit.terminalKey
        const adapter = hit.plan.adapterId
        return {
          hit: {
            adapter: adapter ?? adapterIdOfTool(terminalTool),
            scenarioId: hit.plan.id,
            terminalKey: hit.terminalKey,
            // 入口正则的具名捕获组即 PlanInput；directAnchors 由入口显式声明时才有值
            input: hit.input as Record<string, unknown>,
            slotValues: Object.entries(hit.input).map(([name, raw]) => ({ name, raw: String(raw) })),
          },
        }
      },
      shortcut: (message) => {
        const hit = shortcutMatcher(message)
        return hit
          ? {
              tool: hit.tool,
              args: hit.args,
              id: hit.id,
              schemaId: hit.render?.type === 'schema' ? hit.render.schemaId : undefined,
            }
          : null
      },
      alias: (message) => {
        const hit = aliasMatcher(message)
        // `render` 必须带下去：别名与层 P / 快捷话术共用声明式渲染，漏传就变成
        // 「同一个工具经 `!别名` 进来渲染成通用表格」且无任何日志。
        return hit ? { tool: hit.tool, args: hit.args, id: hit.id, render: hit.render } : null
      },
    },
    routableTools,
    plans: planMatcher.plans,
    bundle,
    signature,
    describe: `${describeScenarioRoutes(scenarioRoutes)} plans=${planMatcher.plans.length} routable=${routableTools.size}`,
  }
  engineCache = { signature, engine }
  return engine
}

/** 作用域过滤：只保留当前 adapter 集合内的卡片路由（配置项只对存在的 adapter 生效）。 */
function filterScenarioRoutesInScope(adapterIds: ReadonlySet<string>): CompiledScenarioRoute[] {
  if (!adapterIds.size) return []
  return loadScenarioRoutes().filter((route) => !!route.adapter && adapterIds.has(route.adapter))
}

function loadScopedBundle(adapterIds: ReadonlySet<string>): RouterConfigBundle {
  try {
    const { bundle } = loadRouterConfig()
    return { ...bundle, ...applyRouterConfigScope(bundle, adapterIds).bundle }
  } catch (error) {
    log.warn('router-config load failed, using empty bundle', error)
    return emptyRouterConfigBundle()
  }
}

function adapterIdOfTool(tool: string): string {
  const known = getCatalog().byName.get(tool)
  if (known) return known.adapterId
  return tool.includes('.') ? tool.slice(0, tool.indexOf('.')) : ''
}

/** 测试钩子：清空引擎缓存。 */
export function resetRouteEngineForTests(): void {
  engineCache = null
}

// ── 规划 ────────────────────────────────────────────────────────────────────

export type RouteInput = {
  message: string
  /** 客户端结构化场景载荷（原样传入即可，内部会做形状校验） */
  scenario?: unknown
  workId: string
  now?: number
  log?: (msg: string) => void
  /** 近窗历史（追问态判定用） */
  history?: unknown[]
  /** 第 12 层开关；缺省读设置 `api_query_llm_route`，但**没有注入分类器时该层天然不生效** */
  llmClassifyEnabled?: boolean
  engine?: RouteEngine
}

/** 纯规划：不派发任何工具，可直接用于评测集断言。 */
export function planRouteDecision(input: RouteInput): { plan: CascadePlan; payload: ScenarioPayload | null } {
  const payload = parseScenarioDirectPayload(input.scenario)
  const engine = input.engine ?? getRouteEngine()
  const settings = safeSettings()
  const plan = planCascade(
    { message: input.message, scenarioPayload: payload, workId: input.workId, now: input.now ?? Date.now(), log: input.log },
    {
      matchers: engine.matchers,
      guards: {
        isDiscussion: (message) => isDiscussionMessage(message),
        isFollowUp: (message, history) => isFollowUpMessage(message, (history ?? input.history) as never),
        mentionsAdapter,
        isAliasPrefixed,
        isRoutableTool: (tool) => engine.routableTools.has(tool),
      },
      history: input.history,
      llmClassifyEnabled: input.llmClassifyEnabled ?? settings?.api_query_llm_route === true,
      log: input.log,
    },
  )
  return { plan, payload }
}

function safeSettings(): { api_query_llm_route?: boolean } | null {
  try {
    return getSettings() as unknown as { api_query_llm_route?: boolean }
  } catch {
    return null
  }
}

// ── 执行 ────────────────────────────────────────────────────────────────────

/** Route diagnostics are metadata-only: never persist user text, argument values or response bodies. */
function routeDiagnostic(ctx: RouteExecutionContext, phase: string, fields: Record<string, unknown> = {}): void {
  appendWorkLog(ctx.workId, 'route_diagnostic', { phase, ...fields }, ctx.turnId)
  ctx.log?.(`route diagnostic ${phase}${fields.reason ? ` reason=${fields.reason}` : ''}${fields.layer ? ` layer=${fields.layer}` : ''}${fields.tool ? ` tool=${fields.tool}` : ''}${fields.category ? ` category=${fields.category}` : ''}${fields.fallback ? ` fallback=${fields.fallback}` : ''}`)
}

function argumentShape(args: Record<string, unknown>): Record<string, number> {
  const types: Record<string, number> = {}
  for (const value of Object.values(args)) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    types[kind] = (types[kind] ?? 0) + 1
  }
  return types
}

function resultShape(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) return { type: 'array', count: value.length }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const arrays = Object.values(record).filter(Array.isArray)
      const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
        ? Object.values(record.data as Record<string, unknown>).filter(Array.isArray) : []
      return { type: 'object', fieldCount: Object.keys(record).length, arrayCounts: [...arrays, ...nested].map(item => item.length) }
    }
    return { type: typeof value, bytes: Buffer.byteLength(raw) }
  } catch {
    return { type: 'text', bytes: Buffer.byteLength(raw) }
  }
}

export type RouteExecutionContext = {
  /** Sanitized diagnostics for this turn's Agent input, independent of human-readable logs. */
  onFallback?: (outcome: import('../webcli-route.js').DirectRouteOutcome) => void
  message: string
  workId: string
  turnId: string
  chatStartTime: number
  send: (event: object) => void
  log?: (msg: string) => void
  scenario?: unknown
  history?: unknown[]
}

export type RouteExecutionDeps = {
  dispatch?: (tool: string, argsJson: string, workId: string) => Promise<string>
  persistAssistantMessage?: (workId: string, text: string, timing: Record<string, unknown>) => void
  askUser?: AskUserFn
  now?: () => number
  engine?: RouteEngine
  /** 单次派发预算（毫秒）；缺省读 `WEWORKER_API_QUERY_ROUTE_TIMEOUT_MS`，0 = 不设 */
  dispatchTimeoutMs?: number
  /** 测试注入：直接给出计划，跳过规划 */
  plan?: CascadePlan
  /** 测试注入：回读落盘大结果；缺省用 webcli-result-cache（含缓存根校验与 TTL） */
  rehydrate?: (pointerText: string) => string | null
}

/**
 * 跑一次级联：按规划顺序尝试，命中即渲染、推流、落库并返回 true。
 * 任一环节落回 → 返回 false（调用方走既有 streamChat）。
 */
export async function executeRoutePlan(
  plan: CascadePlan,
  ctx: RouteExecutionContext,
  deps: RouteExecutionDeps = {},
): Promise<boolean> {
  const engine = deps.engine ?? getRouteEngine()
  const pruned = new Set<CascadeLayer>()

  for (const step of plan.steps) {
    if (isLayerSkipped(step.layer, plan, pruned)) {
      routeDiagnostic(ctx, 'candidate_skipped', { layer: step.layer, reason: 'layer_pruned' })
      continue
    }
    routeDiagnostic(ctx, 'candidate_selected', { layer: step.layer, kind: step.decision.kind,
      tool: step.decision.kind === 'tool' ? step.decision.tool : undefined,
      rule: step.decision.kind === 'tool' ? step.decision.label : step.decision.hit.scenarioId,
      argsTypes: step.decision.kind === 'tool' ? argumentShape(step.decision.args) : undefined })
    const outcome = await runStep(step, ctx, deps, engine)
    routeDiagnostic(ctx, 'candidate_outcome', { layer: step.layer, outcome })
    if (outcome === 'handled') return true
    // Once a tool was actually dispatched, a failed request or unusable rendering must go
    // straight to the model, not retry a different (possibly broader) routing layer.
    if (outcome === 'fallback') return false
    const { stop } = advanceAfterFailure(step, pruned)
    if (stop) {
      ctx.log?.(`cascade stopped after ${step.layer}: ${step.onFailure.action === 'stop' ? step.onFailure.reason : ''}`)
      return false
    }
  }
  return false
}

type RouteStepOutcome = 'handled' | 'skip' | 'fallback'

async function runStep(
  step: CascadeStep,
  ctx: RouteExecutionContext,
  deps: RouteExecutionDeps,
  engine: RouteEngine,
): Promise<RouteStepOutcome> {
  const now = deps.now?.() ?? Date.now()
  if (step.decision.kind === 'tool') {
    const { tool, args, source, render } = step.decision
    return dispatchAndRender({ ctx, deps, engine, tool, args, source, render, label: step.decision.label })
  }
  return runPlanDecision(step.decision.hit, step.decision.render, ctx, deps, engine, now)
}

async function dispatchAndRender(args: {
  ctx: RouteExecutionContext
  deps: RouteExecutionDeps
  engine: RouteEngine
  tool: string
  args: Record<string, unknown>
  source: MatchSource
  render: RenderCtx
  label: string
}): Promise<RouteStepOutcome> {
  const { ctx, deps, engine, tool, source } = args
  // 准入复核：规划期已过一遍，执行期再确认一次（规划到执行之间配置可能已变）。
  if (!engine.routableTools.has(tool)) {
    routeDiagnostic(ctx, 'dispatch_skipped', { tool, reason: 'tool_not_routable' })
    ctx.log?.(`route execution skipped non-routable tool: ${tool}`)
    return 'skip'
  }

  const dispatch = deps.dispatch ?? runWebcliCall
  routeDiagnostic(ctx, 'dispatch_start', { tool, argsTypes: argumentShape(args.args ?? {}) })
  const started = deps.now?.() ?? Date.now()
  // 页面准备（第17行）：仅对「目录里声明了 navigate_before 的直调工具」动手，其余工具零行为变化。
  // 失败/无声明都不阻断主调用——页面准备只是把「必有的一次鉴权失败重试」提前成一次确定性开页。
  const prep = await runPagePrep(tool, dispatch, ctx.workId)
  if (prep.prepared) {
    ctx.log?.(`route page-prep: ${tool} -> ${prep.url} (${prep.ms}ms, toolsReady=${prep.toolsReady})`)
  }
  // 主调用走「预算 + 结果判定」这一层：接口报错 / 超时 / 空结果 / CLI 崩溃都算**没答出来**，
  // 一律落回 LLM，绝不把 `⚠️ 查询失败` 渲染成这一轮的答案（见 route-dispatch.ts 模块头）。
  let raw = ''
  try {
    raw = await guardDispatch(deps)(tool, JSON.stringify(args.args ?? {}), ctx.workId)
  } catch (error) {
    if (error instanceof RouteDispatchError) {
      routeDiagnostic(ctx, 'dispatch_failed', { tool, category: error.kind, fallback: 'llm' })
      ctx.onFallback?.({ status: 'failed', reason: error.kind })
      return 'fallback'
    }
    throw error
  }
  const execMs = (deps.now?.() ?? Date.now()) - started
  routeDiagnostic(ctx, 'dispatch_result', { tool, durationMs: execMs, ...resultShape(raw) })

  if (looksLikeAuthFailure(raw)) {
    routeDiagnostic(ctx, 'dispatch_failed', { tool, category: 'authentication', fallback: 'llm' })
    ctx.log?.(`route auth fallback: ${tool}`)
    ctx.onFallback?.({ status: 'failed', reason: 'authentication_required' })
    return 'fallback'
  }
  if (looksLikeMissingArg(raw)) {
    routeDiagnostic(ctx, 'dispatch_failed', { tool, category: 'missing_argument', fallback: 'llm' })
    ctx.log?.(`route missing-arg fallback: ${tool}`)
    ctx.onFallback?.({ status: 'failed', reason: 'missing_arguments' })
    return 'fallback'
  }

  // A spill pointer alone cannot answer the user. Rehydrate before rendering so missing,
  // expired or unusable cached results return to the model instead of showing a file hint.
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    // Plain-text tool results are supported by the generic renderer.
  }
  let renderRaw = raw
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && (payload as Record<string, unknown>).type === 'large_output') {
    try {
      const hydrated = (deps.rehydrate ?? rehydratePointer)(raw)
      if (!hydrated || classifyDispatchPayload(hydrated)) {
        routeDiagnostic(ctx, 'render_failed', { tool, category: 'unavailable_cached_result', fallback: 'llm' })
        ctx.onFallback?.({ status: 'failed', reason: 'unusable_result' })
        return 'fallback'
      }
      renderRaw = hydrated
    } catch {
      routeDiagnostic(ctx, 'render_failed', { tool, category: 'cache_read_failed', fallback: 'llm' })
      ctx.onFallback?.({ status: 'failed', reason: 'unusable_result' })
      return 'fallback'
    }
  }
  const schemaId = args.render.schemaId
  let text: string
  try {
    text = renderGeneric(renderRaw, args.render.title, schemaId ? { schemaId } : undefined, {
      lookupSchema: (id) => engine.bundle.renderers?.schemas?.[id],
      now: new Date(),
    })
  } catch {
    routeDiagnostic(ctx, 'render_failed', { tool, category: 'renderer_exception', fallback: 'llm' })
    ctx.onFallback?.({ status: 'failed', reason: 'render_failed' })
    return 'fallback'
  }
  // 渲染不出可展示内容（渲染器吞掉异常或投影为空）→ 同为「没答出来」，落回 LLM。
  if (isUnrenderableAnswer(text)) {
    routeDiagnostic(ctx, 'render_failed', { tool, category: 'no_renderable_data', fallback: 'llm' })
    ctx.log?.(`route render produced no answer: ${tool} → fall back to LLM`)
    ctx.onFallback?.({ status: 'failed', reason: 'empty_answer' })
    return 'fallback'
  }
  routeDiagnostic(ctx, 'render_succeeded', { tool, source, responseChars: text.length })
  emitRoutedAnswer(ctx, deps, { tool, args: args.args, text, source, execMs, renderMs: 0 })
  ctx.log?.(`route hit [${source}]: ${tool} ${args.label} (exec ${execMs}ms, payload ${briefPayload(raw, 120).length}B)`)
  return 'handled'
}

/**
 * 每次执行用同一份「预算 + 结果判定」派发器；缺省派发把预算一并交给 `runWebcliCall`，
 * 让超时能杀掉子进程，而不是留下一个还在跑的 CLI 去写缓存/占桥。
 */
function guardDispatch(deps: RouteExecutionDeps): RouteDispatchFn {
  const timeoutMs = deps.dispatchTimeoutMs ?? resolveDispatchTimeoutMs()
  const dispatch: RouteDispatchFn = deps.dispatch ?? ((tool, argsJson, workId) => runWebcliCall(tool, argsJson, workId, { timeoutMs }))
  return createGuardedDispatch({ dispatch, workId: '', timeoutMs, now: deps.now })
}

async function runPlanDecision(
  hit: ScenarioPlanHit,
  render: RenderCtx,
  ctx: RouteExecutionContext,
  deps: RouteExecutionDeps,
  engine: RouteEngine,
  now: number,
): Promise<RouteStepOutcome> {
  const terminalTool = resolvePlanTerminal(engine, hit)
  if (!terminalTool) {
    routeDiagnostic(ctx, 'plan_skipped', { reason: 'terminal_unavailable' })
    ctx.log?.(`plan terminal not resolvable: ${hit.adapter}:${hit.terminalKey}`)
    return 'skip'
  }

  const compiled = planOf(engine, hit)
  if (!compiled) {
    routeDiagnostic(ctx, 'plan_skipped', { reason: 'plan_not_compiled' })
    ctx.log?.(`plan not compiled: ${hit.scenarioId} → fall back to LLM`)
    return 'skip'
  }

  try {
    const out = await runPlan(
      hit.terminalKey,
      hit.input as PlanInput,
      {
        // 多跳的每一跳都走同一层判定：中途接口报错 / 超时 → PlanFallback('error') → 整条落回。
        dispatch: guardDispatch(deps),
        workId: ctx.workId,
        resolvers: compiled.resolvers,
        terminals: compiled.terminals,
        isAuthFailure: looksLikeAuthFailure,
        isMissingArg: looksLikeMissingArg,
        askUser: deps.askUser,
        log: ctx.log,
      },
      { schemaId: render.schemaId },
    )
    if (isUnrenderableAnswer(out.md)) {
      routeDiagnostic(ctx, 'render_failed', { tool: out.terminalTool, category: 'no_renderable_data', fallback: 'llm' })
      ctx.log?.(`plan render produced no answer: ${out.terminalTool} → fall back to LLM`)
      ctx.onFallback?.({ status: 'failed', reason: 'empty_answer' })
      return 'fallback'
    }
    routeDiagnostic(ctx, 'render_succeeded', { tool: out.terminalTool, source: 'plan', responseChars: out.md.length, steps: out.steps })
    emitRoutedAnswer(ctx, deps, {
      tool: out.terminalTool,
      args: hit.input,
      text: out.md,
      source: 'plan',
      execMs: out.dispatchMs,
      renderMs: 0,
      steps: out.steps,
    })
    ctx.log?.(`plan hit: ${out.terminalTool} (${out.steps} steps, ${out.dispatchMs}ms, ${now})`)
    return 'handled'
  } catch (error) {
    if (error instanceof PlanFallback) {
      routeDiagnostic(ctx, 'plan_failed', { category: error.reason, fallback: 'llm' })
      ctx.onFallback?.({ status: 'failed', reason: `plan_${error.reason}` })
      // 'error' 也承载派发失败（接口报错 / 超时 / 空结果），把原因带进日志，排查时不用猜。
      const detail = error.reason === 'error' && error.message ? `: ${error.message}` : ''
      ctx.log?.(`plan fallback (${error.reason}) at ${hit.adapter}:${hit.scenarioId}${detail} → fall back to LLM`)
      return 'fallback'
    }
    throw error
  }
}

function planOf(engine: RouteEngine, hit: ScenarioPlanHit): CompiledPlan | undefined {
  return (
    engine.plans.find((plan) => plan.id === hit.scenarioId && plan.adapterId === hit.adapter) ??
    engine.plans.find((plan) => plan.id === hit.scenarioId)
  )
}

function resolvePlanTerminal(engine: RouteEngine, hit: ScenarioPlanHit): string | null {
  const plan = planOf(engine, hit)
  const terminal = plan?.terminals[hit.terminalKey]
  return terminal?.tool ?? null
}

/** 统一的推流 + 落库（含 routeTool / routeSource / routeArgs 自描述字段）。 */
function emitRoutedAnswer(
  ctx: RouteExecutionContext,
  deps: RouteExecutionDeps,
  answer: RoutedAnswer & { steps?: number },
): void {
  const totalMs = (deps.now?.() ?? Date.now()) - ctx.chatStartTime
  const execMs = Math.min(totalMs, Math.max(0, answer.execMs))
  const llmMs = totalMs - execMs
  const steps = answer.steps ?? 1
  const routeArgs = JSON.stringify(answer.args ?? {})
  ctx.send({ type: 'turn_start', turnId: ctx.turnId, workId: ctx.workId })
  ctx.send({ type: 'text_delta', content: answer.text })
  ctx.send({
    type: 'turn_end',
    turnId: ctx.turnId,
    workId: ctx.workId,
    totalMs,
    llmMs,
    execMs,
    steps,
    routeTool: answer.tool,
    routeSource: answer.source,
    routeArgs,
  })

  const timing = {
    totalMs,
    llmMs,
    execMs,
    steps,
    routeTool: answer.tool,
    routeSource: answer.source,
    routeArgs,
  }
  if (deps.persistAssistantMessage) deps.persistAssistantMessage(ctx.workId, answer.text, timing)
  else store.appendMessage(ctx.workId, 'assistant', [{ type: 'text', text: answer.text }, { type: 'timing', ...timing }])
}

/**
 * server.ts 入口：规划 + 执行。`true` 表示已处理（调用方跳过 streamChat）。
 *
 * 这是**纯增量**接线：所有层为空时 `planCascade` 产出空步骤表，本函数立即返回 false，
 * 行为与今天逐字一致。
 */
export async function tryIntelligentQueryRoute(
  ctx: RouteExecutionContext,
  deps: RouteExecutionDeps = {},
): Promise<boolean> {
  if (process.env[ROUTE_ENV] === '0') {
    routeDiagnostic(ctx, 'route_disabled', { reason: 'environment_switch' })
    ctx.onFallback?.({ status: 'skipped', reason: 'direct_route_disabled' })
    return false
  }
  try {
    const engine = deps.engine ?? getRouteEngine()
    routeDiagnostic(ctx, 'route_config', { fingerprint: createHash('sha256').update(engine.signature).digest('hex').slice(0, 16),
      configuredLayers: {
        routes: engine.bundle.routes?.routes?.length ?? 0,
        patterns: Object.keys(engine.bundle.patterns?.configs ?? {}).length,
        plans: engine.plans.length,
      }, routableTools: engine.routableTools.size,
      sources: engine.bundle.sources?.map(source => ({ layer: source.layer, origin: source.origin,
        rejected: !!source.rejected, overridden: source.overriddenIds?.length ?? 0 })) ?? [] })
    const { plan } = planRouteDecision({
      message: ctx.message,
      scenario: ctx.scenario,
      workId: ctx.workId,
      history: ctx.history,
      log: ctx.log,
      engine,
    })
    routeDiagnostic(ctx, 'route_plan', { candidateCount: plan.steps.length,
      layers: plan.steps.map(step => step.layer), suppressed: plan.suppressed })
    if (plan.blocked) {
      routeDiagnostic(ctx, 'route_unmatched', { reason: 'gate_blocked', gate: plan.blocked.gate, fallback: 'llm' })
      ctx.log?.(`cascade blocked at ${plan.blocked.gate} → fall back to LLM`)
      ctx.onFallback?.({ status: 'skipped', reason: `gate_${plan.blocked.gate}` })
      return false
    }
    if (!plan.steps.length) {
      routeDiagnostic(ctx, 'route_unmatched', { reason: 'no_eligible_candidate', fallback: 'llm' })
      return false
    }
    const handled = await executeRoutePlan(plan, ctx, { ...deps, engine })
    routeDiagnostic(ctx, 'route_finished', { handled, fallback: handled ? 'none' : 'llm' })
    return handled
  } catch (error) {
    routeDiagnostic(ctx, 'route_failed', { category: 'unexpected_exception', fallback: 'llm' })
    ctx.log?.(`intelligent route failed: ${error instanceof Error ? error.message : String(error)} → fall back to LLM`)
    ctx.onFallback?.({ status: 'failed', reason: 'direct_route_error' })
    return false
  }
}

/** 供日志 / 诊断：当前路由面与配置概览（不含用户数据）。 */
export function describeRouteEngine(engine: RouteEngine = getRouteEngine()): string {
  return [
    `routable=${engine.routableTools.size}/${listDirectTools().length} direct`,
    engine.describe,
    `adaptersDir=${relativeForLog(currentAdaptersDir())}`,
  ].join(' ')
}
