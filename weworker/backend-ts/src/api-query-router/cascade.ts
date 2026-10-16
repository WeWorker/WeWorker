/**
 * 18 行级联的**决策规划器**（详见设计文档 §2）。纯函数：输入消息与已装配的匹配器，
 * 输出「按序尝试的步骤表」；派发与渲染由 `index.ts` 执行。
 *
 * 为什么拆成「规划 + 执行」两步：级联的关键性质是**顺序**与**失败后的走向**，而这两者
 * 都可以在不派发任何工具的前提下算出来。于是评测集（含对抗性负例）可以直接断言规划结果，
 * 不需要起 HTTP、不需要真工具——这是「漏判免费、误判致命」能被自动化守住的前提。
 *
 * 两条**顺序硬约束**（写死在这里，不接受配置覆盖）：
 *   ① 第 0 层（卡片话术）必须早于 Tier -1（宽泛提示词）：后者是宽泛正则，会遮蔽更特化的卡片句；
 *   ② Tier -2（模板直达）排在硬门之前，但对 `!` 别名让位——`!` 是用户显式指令。
 */

import type { MatchSource, RenderCtx, ScenarioPayload } from './types.js'
import type { RouterRenderSpec } from '../router-config/types.js'
import type { ScenarioOptOutHit, ScenarioPlanHit } from './scenario-routes.js'

/** 级联层名（与设计文档的行号一一对应，便于日志与评测断言）。 */
export type CascadeLayer =
  /** 层 P：routes.json 配置路由 */
  | 'route'
  /** 第 0 层形态 A 单工具（客户端结构化直连） */
  | 'scenario-a'
  /** 第 0 层形态 A 多跳 */
  | 'scenario-a-plan'
  /** Tier -2：manifest 模板直达 */
  | 'template'
  /** 第 0 层形态 B：卡片话术锚定匹配 */
  | 'scenario'
  /** 第 0 层形态三：显式不直连（抑制宽泛层） */
  | 'optout'
  /** Tier -1：提示词配置 */
  | 'pattern'
  /** 层 9：多跳锚点 DAG */
  | 'plan'
  /** 第 11 层：`!` 别名显式点名 */
  | 'alias'
  /** 第 11 层：守卫式短路 */
  | 'shortcut'
  /** 第 12 层：词法召回 → LLM 分类 */
  | 'llm-classify'

export type CascadeDecision =
  | {
      kind: 'tool'
      tool: string
      args: Record<string, unknown>
      source: MatchSource
      render: RenderCtx
      /** 日志与埋点用的可读标签（不含用户数据） */
      label: string
    }
  | {
      kind: 'plan'
      hit: ScenarioPlanHit
      source: MatchSource
      render: RenderCtx
      label: string
    }

/** 步骤失败后的走向。这是每层**必须显式声明**的语义，不允许默认值。 */
export type CascadeFailurePolicy =
  /** 整条落回 LLM，不再尝试下游层（避免在已派发过一次之后继续猜） */
  | { action: 'stop'; reason: string }
  /** 继续下游层（可附带要跳过的层） */
  | { action: 'continue'; prune?: CascadeLayer[] }

export type CascadeStep = {
  layer: CascadeLayer
  decision: CascadeDecision
  onFailure: CascadeFailurePolicy
}

export type CascadePlan = {
  steps: CascadeStep[]
  /** 被本消息抑制的层（opt-out 卡片句）：规划期就剔除，执行期不再问 */
  suppressed: CascadeLayer[]
  /** 硬门拦截：整条落回 LLM，`steps` 为空 */
  blocked?: { gate: 'discussion' | 'follow_up' | 'alias_gate'; detail?: string }
}

export type CascadeInput = {
  message: string
  /** 客户端结构化场景载荷（形态 A）；无则跳过两个形态 A 步骤 */
  scenarioPayload?: ScenarioPayload | null
  workId: string
  now: number
  log?: (msg: string) => void
}

/** 各层的产出（缺省表示该层未命中或未启用）。 */
export type CascadeMatchers = {
  /** 层 P */
  route: (message: string) => {
    tool: string
    args: Record<string, unknown>
    title?: string
    id: string
    /** 配置里声明的渲染方式；`type: 'schema'` 时走声明式表格 */
    render?: RouterRenderSpec
  } | null
  /** 第 0 层形态 A / B / 形态三 */
  scenario: {
    matchDirect: (payload: ScenarioPayload | null | undefined, message: string) => { tool: string; args: Record<string, unknown> } | null
    matchPlanDirect: (payload: ScenarioPayload | null | undefined, message: string) => ScenarioPlanHit | null
    match: (message: string) => { tool: string; args: Record<string, unknown> } | null
    matchPlan: (message: string) => ScenarioPlanHit | null
    matchOptOut: (message: string) => ScenarioOptOutHit | null
  }
  /** Tier -2 */
  template: (message: string) => { tool: string; args: Record<string, unknown>; id: string } | null
  /** Tier -1 */
  pattern: (message: string) => { tool: string; args: Record<string, unknown>; confidence: number } | null
  /** 层 9 自动推断 */
  plan: (message: string) => { hit: ScenarioPlanHit } | null
  /** 第 11 层 */
  shortcut: (message: string) => { tool: string; args: Record<string, unknown>; schemaId?: string; id: string } | null
  alias: (message: string) => {
    tool: string
    args: Record<string, unknown>
    id: string
    /** 配置里声明的渲染方式；`type: 'schema'` 时走声明式表格 */
    render?: RouterRenderSpec
  } | null
  /** 第 12 层（默认关：未提供即不启用） */
  llmClassify?: (message: string) => { tool: string; args: Record<string, unknown>; confidence: number } | null
}

/** 守卫与硬门的外置依赖：可注入以便测试，缺省为「全放行」。 */
export type CascadeGuards = {
  isDiscussion: (message: string, history?: unknown[]) => boolean
  isFollowUp: (message: string, history?: unknown[]) => boolean
  mentionsAdapter: (message: string, tool: string) => boolean
  isAliasPrefixed: (message: string) => boolean
  /** 工具是否可进路由面（存在 + 可直调 + 显式只读） */
  isRoutableTool: (tool: string) => boolean
}

export type PlanCascadeDeps = {
  matchers: CascadeMatchers
  guards: CascadeGuards
  /** 追问态判定所需的近窗历史 */
  history?: unknown[]
  /** 第 12 层开关（默认关） */
  llmClassifyEnabled?: boolean
  log?: (msg: string) => void
}

/** 落回 LLM 的统一理由（日志用，不含用户数据）。 */
const STOP_REASON = {
  pattern: 'pattern_failed',
  plan: 'plan_failed',
  shortcut: 'shortcut_failed',
  alias: 'alias_failed',
  llm: 'llm_classify_failed',
  route: 'route_failed',
} as const

/**
 * 规划一次级联。**不派发任何工具**，只决定「按什么顺序、在什么条件下试哪些层」。
 */
export function planCascade(input: CascadeInput, deps: PlanCascadeDeps): CascadePlan {
  const message = String(input.message ?? '')
  const log = deps.log ?? input.log ?? (() => {})
  const { matchers, guards } = deps
  const suppressed: CascadeLayer[] = []

  // `!` 前缀是用户显式指令：豁免硬门①/①b，并在 Tier -2 处让位（硬约束②）。
  const aliasPrefixed = guards.isAliasPrefixed(message)

  // 硬门①：讨论态 / 元问题。谈系统而非查数据的消息不得被任何层抢答。
  if (!aliasPrefixed && guards.isDiscussion(message, deps.history)) {
    return { steps: [], suppressed, blocked: { gate: 'discussion' } }
  }
  // 硬门①b：追问态。回指词 + 近窗有路由结果 → 重跑同一查询会吞掉追问意图。
  if (!aliasPrefixed && guards.isFollowUp(message, deps.history)) {
    return { steps: [], suppressed, blocked: { gate: 'follow_up' } }
  }

  // 第 0 层形态三（opt-out）：只抑制**宽泛启发层**（Tier -1 / Tier 2），不抑制确定性层。
  // 依据：卡片句与宽泛正则撞型时，后者常派发到错工具（跨 adapter、或写操作→只读），
  // 比落回 LLM 更糟；而确定性层（plan / 别名 / 短路）的命中各有更强依据，不应被卡片连坐。
  if (!aliasPrefixed && matchers.scenario.matchOptOut) {
    const optOut = safe(() => matchers.scenario.matchOptOut(message), log, 'optout')
    if (optOut) {
      suppressed.push('pattern', 'llm-classify')
      log(`scenario opt-out: ${optOut.adapter}:${optOut.scenarioId}${optOut.reason ? ` (${optOut.reason})` : ''}`)
    }
  }

  const steps: CascadeStep[] = []
  const push = (step: CascadeStep) => {
    if (step.decision.kind === 'tool' && !guards.isRoutableTool(step.decision.tool)) {
      // 层级命中但工具不在路由面（不存在 / 不可直调 / 非只读）→ 该层视为未命中，继续下游。
      log(`layer ${step.layer} skipped: ${step.decision.tool} not routable`)
      return
    }
    steps.push(step)
  }

  // ── 层 P ────────────────────────────────────────────────────────────────
  const routeHit = safe(() => matchers.route(message), log, 'route')
  if (routeHit) {
    push({
      layer: 'route',
      decision: {
        kind: 'tool',
        tool: routeHit.tool,
        args: routeHit.args,
        source: 'route',
        // 层 P 的 `render.type === 'schema'` 必须一路带到渲染：少了这行，配置里写的
        // 声明式表格永远不会生效（表现为「命中了但渲染出通用表格」，且没有任何日志）。
        render: {
          title: routeHit.title,
          schemaId: routeHit.render?.type === 'schema' ? routeHit.render.schemaId : undefined,
        },
        label: `route ${routeHit.id}`,
      },
      onFailure: { action: 'stop', reason: STOP_REASON.route },
    })
  }

  // ── 第 0 层形态 A（客户端结构化直连，身份最明确）────────────────────────
  const payload = input.scenarioPayload ?? null
  if (payload) {
    const directHit = safe(() => matchers.scenario.matchDirect(payload, message), log, 'scenario-a')
    if (directHit) {
      push({
        layer: 'scenario-a',
        decision: {
          kind: 'tool',
          tool: directHit.tool,
          args: directHit.args,
          source: 'scenario-a',
          render: {},
          label: `scenario-a ${payload.adapterId}:${payload.scenarioId}`,
        },
        // 卡片已认领该消息：失败后不让 Tier -1 降级接管（会换一个工具作答，比落回更糟）。
        onFailure: { action: 'continue', prune: ['pattern'] },
      })
    }
    const directPlan = safe(() => matchers.scenario.matchPlanDirect(payload, message), log, 'scenario-a-plan')
    if (directPlan) {
      push({
        layer: 'scenario-a-plan',
        decision: {
          kind: 'plan',
          hit: directPlan,
          source: 'scenario-a',
          render: {},
          label: `scenario-a plan ${payload.adapterId}:${payload.scenarioId}`,
        },
        onFailure: { action: 'continue', prune: ['pattern'] },
      })
    }
  }

  // ── Tier -2：manifest 模板直达（锚定全等，零推断）───────────────────────
  // 逐字全等无推断成分，故豁免讨论态守卫与硬门②；但 `!` 别名必须先让位（硬约束②）。
  if (!aliasPrefixed) {
    const templateHit = safe(() => matchers.template(message), log, 'template')
    if (templateHit) {
      push({
        layer: 'template',
        decision: {
          kind: 'tool',
          tool: templateHit.tool,
          args: templateHit.args,
          source: 'template',
          render: {},
          label: `template ${templateHit.id}`,
        },
        onFailure: { action: 'continue' },
      })
    }
  }

  // ── 第 0 层形态 B：卡片话术锚定匹配（硬约束①：必须早于 Tier -1）─────────
  const scenarioHit = safe(() => matchers.scenario.match(message), log, 'scenario')
  if (scenarioHit) {
    push({
      layer: 'scenario',
      decision: {
        kind: 'tool',
        tool: scenarioHit.tool,
        args: scenarioHit.args,
        source: 'scenario',
        render: {},
        label: 'scenario',
      },
      onFailure: { action: 'continue', prune: ['pattern'] },
    })
  }
  const scenarioPlanHit = safe(() => matchers.scenario.matchPlan(message), log, 'scenario-plan')
  if (scenarioPlanHit) {
    push({
      layer: 'scenario',
      decision: {
        kind: 'plan',
        hit: scenarioPlanHit,
        source: 'scenario',
        render: {},
        label: `scenario plan ${scenarioPlanHit.adapter}:${scenarioPlanHit.scenarioId}`,
      },
      onFailure: { action: 'continue', prune: ['pattern'] },
    })
  }

  // ── Tier -1：提示词配置（宽泛正则层）───────────────────────────────────
  if (!suppressed.includes('pattern')) {
    const patternHit = safe(() => matchers.pattern(message), log, 'pattern')
    if (patternHit) {
      push({
        layer: 'pattern',
        decision: {
          kind: 'tool',
          tool: patternHit.tool,
          args: patternHit.args,
          source: 'pattern',
          render: {},
          label: 'pattern',
        },
        onFailure: { action: 'stop', reason: STOP_REASON.pattern },
      })
    }
  }

  // ── 层 9：多跳锚点 DAG（自动推断；自由话术必须点名系统）─────────────────
  const planHit = safe(() => matchers.plan(message), log, 'plan')
  if (planHit) {
    const terminalTool = planHit.hit.terminalKey
    if (guards.mentionsAdapter(message, terminalTool)) {
      push({
        layer: 'plan',
        decision: {
          kind: 'plan',
          hit: planHit.hit,
          source: 'plan',
          render: {},
          label: `plan ${planHit.hit.adapter}:${planHit.hit.scenarioId}`,
        },
        onFailure: { action: 'stop', reason: STOP_REASON.plan },
      })
    } else {
      log(`plan gate: no adapter keyword for ${terminalTool} → skip`)
    }
  }

  // ── 第 11 层：`!` 别名 → 守卫式短路 ────────────────────────────────────
  // 别名在前：用户显式点名优先于作者的通用正则；别名天然豁免硬门②（`!a.b.tool` 含 adapter 名）。
  const aliasHit = safe(() => matchers.alias(message), log, 'alias')
  if (aliasHit) {
    push({
      layer: 'alias',
      decision: {
        kind: 'tool',
        tool: aliasHit.tool,
        args: aliasHit.args,
        source: 'alias',
        render: { schemaId: aliasHit.render?.type === 'schema' ? aliasHit.render.schemaId : undefined },
        label: `alias ${aliasHit.id}`,
      },
      onFailure: { action: 'stop', reason: STOP_REASON.alias },
    })
  } else if (aliasPrefixed) {
    // `!` 开头但没有任何别名匹配：这是用户显式指令却无人承接，绝不降级到宽泛层猜。
    // 清空已规划的步骤，保证 `blocked ⇒ steps 为空`（否则调用方漏判 blocked 就会照跑）。
    return { steps: [], suppressed, blocked: { gate: 'alias_gate' } }
  }

  const shortcutHit = safe(() => matchers.shortcut(message), log, 'shortcut')
  if (shortcutHit && guards.mentionsAdapter(message, shortcutHit.tool)) {
    push({
      layer: 'shortcut',
      decision: {
        kind: 'tool',
        tool: shortcutHit.tool,
        args: shortcutHit.args,
        source: 'override',
        render: { schemaId: shortcutHit.schemaId },
        label: `shortcut ${shortcutHit.id}`,
      },
      onFailure: { action: 'stop', reason: STOP_REASON.shortcut },
    })
  } else if (shortcutHit) {
    log(`shortcut gate: no adapter keyword for ${shortcutHit.tool} → skip`)
  }

  // ── 第 12 层：词法召回 → LLM 分类（默认关）──────────────────────────────
  if (deps.llmClassifyEnabled && matchers.llmClassify && !suppressed.includes('llm-classify')) {
    const llmHit = safe(() => matchers.llmClassify!(message), log, 'llm-classify')
    if (llmHit) {
      push({
        layer: 'llm-classify',
        decision: {
          kind: 'tool',
          tool: llmHit.tool,
          args: llmHit.args,
          source: 'llm',
          render: {},
          label: 'llm-classify',
        },
        onFailure: { action: 'stop', reason: STOP_REASON.llm },
      })
    }
  }

  return { steps, suppressed }
}

/**
 * 执行期跳过判定：某步失败后，按 `onFailure` 决定停或继续。
 * 抽成独立函数便于单测覆盖「失败后走向」这一最容易写错的语义。
 */
export function advanceAfterFailure(step: CascadeStep, pruned: Set<CascadeLayer>): { stop: boolean } {
  if (step.onFailure.action === 'stop') return { stop: true }
  for (const layer of step.onFailure.prune ?? []) pruned.add(layer)
  return { stop: false }
}

/** 规划期与执行期共用的跳过判定。 */
export function isLayerSkipped(layer: CascadeLayer, plan: CascadePlan, pruned: ReadonlySet<CascadeLayer>): boolean {
  return plan.suppressed.includes(layer) || pruned.has(layer)
}

/** 匹配器抛错绝不让整条级联失效：当作该层未命中，记一条日志。 */
function safe<T>(fn: () => T, log: (msg: string) => void, layer: string): T | null {
  try {
    return fn()
  } catch (error) {
    log(`layer ${layer} failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
