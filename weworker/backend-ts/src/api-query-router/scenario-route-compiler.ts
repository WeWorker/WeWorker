/**
 * 卡片话术路由编译器（详见 docs/intelligent_routing_design.md §3.3 规则 ①~⑥、§4）。
 *
 * **单一真源**：CLI（`npm run gen:routes`）与运行时加载器共用本文件——前者写盘产出
 * `router-config/scenario-routes.json`（进 git、可评审、`--check` 作 CI 硬门），后者在
 * 编译产物缺失时按内存重建。两条路径共用同一份编译代码，**不存在双实现漂移**。
 *
 * 输入：adapter manifest 的 `scenarios[].route` 声明（三形态互斥）
 *   - 形态一 `tool`  ：`{ tool, args:{参数:"${槽位}"|常量}, guard? }`        → 单工具直连
 *   - 形态二 `plan`  ：`{ plan:{terminal, input:{键:"${槽位}"|常量}}, guard? }` → 多跳入口
 *   - 形态三 `optout`：`{ direct:false, reason }`                            → 显式不直连
 *
 * 编译规则（任一失败即 error，`--check` 退出码 1）：
 *   ① 工具可直调且只读：`execution.type==='api' && runtime==='background'` 且 `safety:'read'`；
 *      写操作 / 需二次确认的工具一律不得进路由面。plan 形态对**白名单声明的终点工具**施同一门。
 *   ② 参数合法：`args` 键 ⊆ 工具 schema properties；常量值类型 / 枚举合法；必填参数全覆盖。
 *   ③ 占位符闭合：话术模板占位符 ↔ `args` 引用双向一致（plan 形态对 `input` 同规则）。
 *   ④ 与手写层冲突：同一工具在 `routes.json` / `aliases.json` / `shortcuts.json` 已配置 → warning
 *      （卡片更特化、级联在前，仅提醒不阻断）。
 *   ⑤ 含 `${}` 的话术卡片必须显式声明 `tool` / `plan` / `direct:false` 三者之一——把「装饰性
 *      卡片」（编译不出路由、静默不生效）变成构建错误。
 *   ⑥ 遮蔽门：同一 adapter 内一条路由的样本句不得被另一条路由的正则吃掉（error）；跨 adapter
 *      同形模板 → warning。这是多条声明同层共存的主要风险点。
 */

import type { ManifestRouteTemplateDef } from '../adapter-parser.js'
import type { ScenarioRouteDecl, RegistryScenarioDef } from '../site-scenarios.js'
import type { CompiledScenarioArgSpec, CompiledScenarioRoute, PlanTerminalsFile } from '../router-config/types.js'
import { checkTemplateValidate } from './manifest-templates.js'

/** 单条 adapter 的编译输入：工具表 + 卡片声明。 */
export type CompileAdapterInput = {
  adapterId: string
  /** manifest `scenarios[]`（可含 `route` 声明） */
  scenarios: readonly RegistryScenarioDef[]
  /** manifest `commands[]` 的工具信息；`name` 为命令 id（不含 adapter 前缀） */
  tools: readonly CompileToolInfo[]
}

export type CompileToolInfo = {
  name: string
  safety?: string
  requiresConfirmation?: boolean
  parameters?: Record<string, unknown>
  execution?: { type?: string; runtime?: string }
  aliases?: string[]
}

export type CompileOptions = {
  /** 层 9 入口白名单；缺失时 plan 形态一律报错（不静默放行） */
  planTerminals?: PlanTerminalsFile | null
  /** 手写层已配置的工具全名，用于规则 ④ 的冲突告警 */
  configuredTools?: readonly string[]
}

export type CompileResult = {
  routes: CompiledScenarioRoute[]
  errors: string[]
  warnings: string[]
  stats: {
    adapters: number
    scenariosWithRoute: number
    byShape: { tool: number; plan: number; optout: number }
  }
}

/** ③ 双向闭合 / ⑥ 遮蔽 lint 用的样本值：占位符名自身 + 拉丁 / 中文 / 数字（覆盖真实编辑形态）。 */
export const SAMPLE_VALUES: readonly (string | null)[] = [null, 'Example_Project', '示例项目', '98765']

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g

export function escapeRegExp(text: string): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 模板 / 消息归一化：去全部空白（与运行时 buildScenarioMatcher 同规则）。 */
export function normalizeText(text: string): string {
  return String(text ?? '').replace(/\s+/g, '')
}

/** 收集模板里全部占位符名（按首次出现顺序）。 */
export function collectPlaceholders(template: string): string[] {
  const names: string[] = []
  for (const match of String(template).matchAll(PLACEHOLDER_RE)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** 模板 → 样本句（null = 保留占位符名，即未配置变量时的默认展示值）。 */
export function renderSample(template: string, value: string | null): string {
  return normalizeText(String(template).replace(PLACEHOLDER_RE, (_, name: string) => (value === null ? name : String(value))))
}

/** slot → 类型化捕获组正则（由目标参数 schema 决定）；返回 null 走 string 缺省。 */
export function slotRegexFor(param: unknown): string | null {
  if (!param || typeof param !== 'object') return null
  const spec = param as { enum?: unknown; type?: unknown; description?: unknown }
  if (Array.isArray(spec.enum) && spec.enum.length) {
    return `(?:${spec.enum.map((value) => escapeRegExp(String(value))).join('|')})`
  }
  if (spec.type === 'integer' || spec.type === 'number') return '\\d+'
  if (/日期|date/i.test(String(spec.description ?? ''))) return '\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?'
  return null
}

type SlotIndex = Record<string, number> & { __params?: Record<string, unknown> }

/**
 * 单条话术模板 → 锚定正则。占位符命名为 `s0/s1/…`（索引按 scenario 级占位符首次出现序，
 * 跨 prompt 稳定，与 args 装配表对齐）。末尾 string slot 用贪婪（`.+`），其余非贪婪（`.+?`）。
 */
export function compilePatternRegex(template: string, slotIndex: SlotIndex): { regex: string; flags: string } {
  const normalized = normalizeText(template)
  const parts: string[] = ['^']
  const captured = new Set<string>()
  let cursor = 0
  for (const match of normalized.matchAll(PLACEHOLDER_RE)) {
    parts.push(escapeRegExp(normalized.slice(cursor, match.index)))
    const group = `s${slotIndex[match[1]]}`
    const param = slotIndex.__params?.[match[1]]
    const typed = slotRegexFor(param)
    const isTail = (match.index ?? 0) + match[0].length >= normalized.length
    const body = typed ?? (isTail ? '.+' : '.+?')
    // 同名占位符重复出现只保留首次捕获，后续用非捕获组：重复命名组会让正则非法，
    // 而重复出现本就各有各的文本，不应强求取值相同。
    if (captured.has(group)) {
      parts.push(`(?:${body})`)
    } else {
      captured.add(group)
      parts.push(`(?<${group}>${body})`)
    }
    cursor = (match.index ?? 0) + match[0].length
  }
  parts.push(escapeRegExp(normalized.slice(cursor)), '$')
  return { regex: parts.join(''), flags: 'i' }
}

/** 产物正则必须能编译：否则运行时静默丢弃、路由悄悄失效（`--check` 必须拦住）。 */
function validatePatterns(label: string, patterns: { regex: string; flags?: string }[], errors: string[]): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern.regex, pattern.flags ?? '')
    } catch (error) {
      errors.push(`${label}: 生成正则无法编译（${(error as Error).message}）：${pattern.regex}`)
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isApiBackground(execution: { type?: string; runtime?: string } | undefined): boolean {
  return execution?.type === 'api' && execution?.runtime === 'background'
}

function constValueMatches(param: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!param) return true // schema 无该参数定义时规则 ② 已另行报错，这里不重复
  if (Array.isArray(param.enum) && param.enum.length) {
    return param.enum.map(String).includes(String(value))
  }
  switch (param.type) {
    case 'integer':
      return Number.isInteger(Number(value))
    case 'number':
      return Number.isFinite(Number(value))
    case 'boolean':
      return typeof value === 'boolean'
    case undefined:
      return true
    default:
      return typeof value === 'string'
  }
}

/** 三形态判定：tool / plan / optout；都不是则 null（含 route 缺失与形态混用）。 */
export function routeShape(route: ScenarioRouteDecl | undefined | null): 'tool' | 'plan' | 'optout' | null {
  if (!route || typeof route !== 'object') return null
  const shapes: string[] = []
  if (typeof route.tool === 'string' && route.tool) shapes.push('tool')
  if (route.plan && typeof route.plan === 'object') shapes.push('plan')
  if (route.direct === false) shapes.push('optout')
  return shapes.length === 1 ? (shapes[0] as 'tool' | 'plan' | 'optout') : null
}

/** 卡片话术收集（非空字符串，保序）。 */
function promptsOf(scenario: RegistryScenarioDef | undefined): string[] {
  return (scenario?.prompts ?? [])
    .map((prompt) => prompt?.text)
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
}

/** ③ 双向闭合共用校验。 */
function checkClosure(options: {
  label: string
  placeholderNames: readonly string[]
  referencedSlots: ReadonlySet<string>
  targetName: string
  errors: string[]
}): void {
  for (const name of options.placeholderNames) {
    if (!options.referencedSlots.has(name)) {
      options.errors.push(`${options.label}: 占位符 \${${name}} 未被任何 ${options.targetName} 引用（双向闭合失败）`)
    }
  }
}

/** 负向守卫可编译性（三形态通用）。 */
function compileGuard(options: { label: string; route: ScenarioRouteDecl; errors: string[] }): string[] {
  const negatives: string[] = []
  for (const source of options.route?.guard?.negative ?? []) {
    try {
      new RegExp(source)
      negatives.push(source)
    } catch (error) {
      options.errors.push(`${options.label}: guard.negative 正则无效：${source}（${(error as Error).message}）`)
    }
  }
  return negatives
}

/** 编译形态一（单工具）。纯函数，便于单测。 */
export function compileToolRoute(ctx: {
  adapterId: string
  scenario: RegistryScenarioDef
  toolDef: CompileToolInfo | undefined
  configuredTools?: readonly string[]
}): { route: CompiledScenarioRoute | null; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const scenarioId = ctx.scenario?.id ?? '(未命名)'
  const label = `${ctx.adapterId}:${scenarioId}`
  const route = ctx.scenario?.route
  if (!route || typeof route !== 'object') return { route: null, errors, warnings }

  const tool = route.tool
  if (!tool || typeof tool !== 'string') {
    errors.push(`${label}: route.tool 缺失`)
    return { route: null, errors, warnings }
  }
  if (route.plan || route.direct === false) {
    errors.push(`${label}: route 三形态互斥（tool / plan / direct:false），不可混用`)
  }

  // ① 可直调 + 只读（§7 红线：写操作不得进路由面）。
  if (!isApiBackground(ctx.toolDef?.execution)) {
    errors.push(`${label}: ${tool} 未声明 execution.type:api + runtime:background（不可直调）`)
  }
  if (!ctx.toolDef) {
    errors.push(`${label}: ${tool} 不在本 adapter 的 commands 里（schema 校验无从进行）`)
  } else if (ctx.toolDef.safety !== 'read') {
    // 必须**显式**声明 safety:'read'：缺 safety 的工具读写不可区分，不得默认放行。
    errors.push(`${label}: ${tool} safety=${ctx.toolDef.safety ?? '(缺失)'}（路由面仅收显式 safety:"read" 的工具）`)
  } else if (ctx.toolDef.requiresConfirmation === true) {
    errors.push(`${label}: ${tool} 需要二次确认（写操作特征），不得进路由面`)
  }
  if (ctx.configuredTools?.includes(tool)) {
    warnings.push(`${label}: ${tool} 同时存在于手写层配置（卡片更特化、级联在前，请确认语义一致）`)
  }

  const prompts = promptsOf(ctx.scenario)
  if (!prompts.length) {
    errors.push(`${label}: scenario 无可用 prompts`)
    return { route: null, errors, warnings }
  }

  const parameters = (ctx.toolDef?.parameters ?? {}) as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  const properties = parameters.properties ?? {}
  const required = Array.isArray(parameters.required) ? parameters.required : []

  const placeholderNames = [...new Set(prompts.flatMap((text) => collectPlaceholders(text)))]
  const slotIndex: SlotIndex = {}
  placeholderNames.forEach((name, index) => {
    slotIndex[name] = index
  })

  const argsSpec: Record<string, CompiledScenarioArgSpec> = {}
  const referencedSlots = new Set<string>()
  for (const [param, value] of Object.entries(route.args ?? {})) {
    const paramDef = properties[param]
    if (!paramDef) {
      errors.push(`${label}: args.${param} 不在 ${tool} 的参数表里`)
      continue
    }
    const slotRef = typeof value === 'string' ? /^\$\{(.+)\}$/.exec(value)?.[1] : undefined
    if (slotRef !== undefined) {
      if (!placeholderNames.includes(slotRef)) {
        errors.push(`${label}: args.${param} 引用占位符 \${${slotRef}}，但 prompts 中未出现`)
        continue
      }
      referencedSlots.add(slotRef)
      slotIndex.__params = slotIndex.__params ?? {}
      slotIndex.__params[slotRef] = paramDef
      const enumList =
        Array.isArray(paramDef.enum) && paramDef.enum.length ? paramDef.enum.map((item) => String(item)) : null
      argsSpec[param] = enumList
        ? { slot: `s${slotIndex[slotRef]}`, type: String(paramDef.type ?? 'string'), enum: enumList }
        : { slot: `s${slotIndex[slotRef]}`, type: String(paramDef.type ?? 'string') }
    } else {
      if (!constValueMatches(paramDef, value)) {
        errors.push(`${label}: args.${param} 常量 ${JSON.stringify(value)} 不符合参数类型/枚举`)
        continue
      }
      argsSpec[param] = { const: value }
    }
  }
  // ③ 双向闭合：占位符必须被 args 引用；args 引用的占位符必须存在（上面已查）。
  checkClosure({ label, placeholderNames, referencedSlots, targetName: 'args', errors })
  // ② 必填参数全覆盖。
  for (const req of required) {
    if (!(req in argsSpec)) {
      errors.push(`${label}: 必填参数 ${req} 未在 route.args 中提供（常量或占位符）`)
    }
  }

  const guardNegative = compileGuard({ label, route, errors })
  if (errors.length) return { route: null, errors, warnings }

  const patterns = prompts.map((text) => compilePatternRegex(text, slotIndex))
  validatePatterns(label, patterns, errors)
  if (errors.length) return { route: null, errors, warnings }
  return {
    route: {
      adapter: ctx.adapterId,
      scenarioId,
      tool,
      enabled: route.enabled !== false,
      slotNames: placeholderNames,
      promptTemplates: prompts,
      patterns,
      args: argsSpec,
      guardNegative,
    },
    errors,
    warnings,
  }
}

/** 编译形态二（多跳入口）。终点工具与输入键由 `plan-terminals.json` 白名单约束。 */
export function compilePlanRoute(ctx: {
  adapterId: string
  scenario: RegistryScenarioDef
  planTerminals?: PlanTerminalsFile | null
  toolDef: CompileToolInfo | undefined
}): { route: CompiledScenarioRoute | null; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const scenarioId = ctx.scenario?.id ?? '(未命名)'
  const label = `${ctx.adapterId}:${scenarioId}`
  const route = ctx.scenario?.route ?? {}
  const plan = route.plan

  if (!plan || typeof plan !== 'object' || typeof plan.terminal !== 'string' || !plan.terminal) {
    errors.push(`${label}: route.plan.terminal 缺失`)
    return { route: null, errors, warnings }
  }
  if (route.tool || route.direct === false) {
    errors.push(`${label}: route 三形态互斥（tool / plan / direct:false），不可混用`)
  }

  const spec = ctx.planTerminals?.adapters?.[ctx.adapterId]?.[plan.terminal]
  if (!spec) {
    errors.push(
      `${label}: route.plan.terminal "${plan.terminal}" 不在 plan-terminals.json 的 ${ctx.adapterId} 白名单（新增 DAG 入口须先登记白名单）`,
    )
    return { route: null, errors, warnings }
  }

  // ① 终点工具可直调 + 只读（白名单声明 → 与形态一同一门）。
  const tool = spec.tool
  if (!isApiBackground(ctx.toolDef?.execution)) {
    errors.push(`${label}: plan 终点工具 ${tool} 未声明 execution.type:api + runtime:background（不可直调）`)
  }
  if (!ctx.toolDef) {
    errors.push(`${label}: plan 终点工具 ${tool} 不在本 adapter 的 commands 里（只读性无从校验）`)
  } else if (ctx.toolDef.safety !== 'read') {
    errors.push(`${label}: plan 终点工具 ${tool} safety=${ctx.toolDef.safety ?? '(缺失)'}（路由面仅收显式 safety:"read" 的工具）`)
  } else if (ctx.toolDef.requiresConfirmation === true) {
    errors.push(`${label}: plan 终点工具 ${tool} 需要二次确认，不得进路由面`)
  }

  const prompts = promptsOf(ctx.scenario)
  if (!prompts.length) {
    errors.push(`${label}: scenario 无可用 prompts`)
    return { route: null, errors, warnings }
  }

  const placeholderNames = [...new Set(prompts.flatMap((text) => collectPlaceholders(text)))]
  const slotIndex: SlotIndex = {}
  placeholderNames.forEach((name, index) => {
    slotIndex[name] = index
  })

  const inputSpec: Record<string, CompiledScenarioArgSpec> = {}
  const referencedSlots = new Set<string>()
  for (const [key, value] of Object.entries(plan.input ?? {})) {
    const keySpec = spec.input?.[key]
    if (!keySpec) {
      errors.push(`${label}: route.input.${key} 不在 ${plan.terminal} 的输入键白名单里`)
      continue
    }
    if (typeof value !== 'string') {
      errors.push(`${label}: route.input.${key} 必须是字符串（\${槽位} 或常量）`)
      continue
    }
    const slotRef = /^\$\{(.+)\}$/.exec(value)?.[1]
    if (slotRef !== undefined) {
      if (!placeholderNames.includes(slotRef)) {
        errors.push(`${label}: route.input.${key} 引用占位符 \${${slotRef}}，但 prompts 中未出现`)
        continue
      }
      referencedSlots.add(slotRef)
      slotIndex.__params = slotIndex.__params ?? {}
      slotIndex.__params[slotRef] = { type: keySpec.type ?? 'string' }
      inputSpec[key] = { slot: `s${slotIndex[slotRef]}`, type: keySpec.type ?? 'string' }
    } else {
      inputSpec[key] = { const: value }
    }
  }
  checkClosure({ label, placeholderNames, referencedSlots, targetName: 'route.input', errors })
  for (const [key, keySpec] of Object.entries(spec.input ?? {})) {
    if (keySpec?.required && !(key in inputSpec)) {
      errors.push(`${label}: 必填输入键 ${key} 未在 route.input 中提供`)
    }
  }

  const guardNegative = compileGuard({ label, route, errors })
  if (errors.length) return { route: null, errors, warnings }

  const patterns = prompts.map((text) => compilePatternRegex(text, slotIndex))
  validatePatterns(label, patterns, errors)
  if (errors.length) return { route: null, errors, warnings }
  return {
    route: {
      adapter: ctx.adapterId,
      scenarioId,
      // 无 tool：引擎走 plan matcher 而非单工具派发。
      plan: { terminal: plan.terminal, input: inputSpec },
      enabled: route.enabled !== false,
      slotNames: placeholderNames,
      promptTemplates: prompts,
      patterns,
      guardNegative,
    },
    errors,
    warnings,
  }
}

/** 编译形态三（显式不直连）：不产出任何直连目标，但产出抑制条目。`reason` 必填。 */
export function compileOptOutRoute(ctx: {
  adapterId: string
  scenario: RegistryScenarioDef
}): { route: CompiledScenarioRoute | null; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const scenarioId = ctx.scenario?.id ?? '(未命名)'
  const label = `${ctx.adapterId}:${scenarioId}`
  const route = ctx.scenario?.route ?? {}

  if (route.direct !== false) {
    errors.push(`${label}: route.direct 必须为 false`)
    return { route: null, errors, warnings }
  }
  if (route.tool || route.plan) {
    errors.push(`${label}: route 三形态互斥（tool / plan / direct:false），不可混用`)
  }
  const reason = typeof route.reason === 'string' ? route.reason.trim() : ''
  if (!reason) {
    errors.push(`${label}: route.direct:false 必须给出 reason（写操作 / 多跳未建 DAG / 无只读工具 / 参数不可映射…）`)
  }

  const prompts = promptsOf(ctx.scenario)
  if (!prompts.length) {
    errors.push(`${label}: scenario 无可用 prompts`)
    return { route: null, errors, warnings }
  }

  const guardNegative = compileGuard({ label, route, errors })
  if (errors.length) return { route: null, errors, warnings }

  const placeholderNames = [...new Set(prompts.flatMap((text) => collectPlaceholders(text)))]
  const slotIndex: SlotIndex = {}
  placeholderNames.forEach((name, index) => {
    slotIndex[name] = index
  })
  const patterns = prompts.map((text) => compilePatternRegex(text, slotIndex))
  validatePatterns(label, patterns, errors)
  if (errors.length) return { route: null, errors, warnings }
  return {
    route: {
      adapter: ctx.adapterId,
      scenarioId,
      optout: true,
      reason,
      enabled: route.enabled !== false,
      slotNames: placeholderNames,
      promptTemplates: prompts,
      patterns,
      guardNegative,
    },
    errors,
    warnings,
  }
}

/** 编译单张卡片（三形态分流）。形态混用 / `route` 缺失且含 `${}` → error（规则 ⑤）。 */
export function compileScenarioRoute(ctx: {
  adapterId: string
  scenario: RegistryScenarioDef
  toolDef: CompileToolInfo | undefined
  planTerminals?: PlanTerminalsFile | null
  configuredTools?: readonly string[]
}): { route: CompiledScenarioRoute | null; errors: string[]; warnings: string[] } {
  const label = `${ctx.adapterId}:${ctx.scenario?.id ?? '(未命名)'}`
  const shape = routeShape(ctx.scenario?.route)
  if (shape === 'tool') return compileToolRoute(ctx)
  if (shape === 'plan') return compilePlanRoute(ctx)
  if (shape === 'optout') return compileOptOutRoute(ctx)
  const errors: string[] = []
  if (ctx.scenario?.route) {
    errors.push(`${label}: route 形态无法判定（须为 tool / plan / direct:false 之一，不可混用、不可全空）`)
  } else if (promptsOf(ctx.scenario).some((text) => /\$\{/.test(text))) {
    errors.push(`${label}: 含 \${} 的卡片必须有 route 决策（规则 ⑤）：tool / plan / direct:false+reason 三选一`)
  }
  return { route: null, errors, warnings: [] }
}

/**
 * ⑥ 遮蔽 lint：把每条路由的 `promptTemplates` 用样本值渲染成句子，跑同 adapter 内其余路由的正则。
 * 同 adapter 命中 = error（示例句被他人吞掉，级联顺序决定结果、不可预期）；跨 adapter = warning。
 * opt-out 之间不比较：两者都不派发（只抑制宽泛层），谁先命中语义等价，不构成歧义。
 */
export function shadowingLint(routes: readonly CompiledScenarioRoute[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const compiled = routes.map((route) => ({
    route,
    res: (route.patterns ?? [])
      .map((pattern) => {
        try {
          return new RegExp(pattern.regex, pattern.flags || '')
        } catch {
          return null
        }
      })
      .filter((re): re is RegExp => re !== null),
  }))
  for (const { route } of compiled) {
    for (const template of route.promptTemplates ?? []) {
      for (const value of SAMPLE_VALUES) {
        const sample = renderSample(template, value)
        for (const other of compiled) {
          if (other.route === route) continue
          if (route.optout && other.route.optout) continue
          if (!other.res.some((re) => re.test(sample))) continue
          const message = `${route.adapter}:${route.scenarioId} 样本句「${sample}」被同层路由 ${other.route.adapter}:${other.route.scenarioId} 的正则吃掉`
          if (other.route.adapter === route.adapter) errors.push(`遮蔽：${message}（同 adapter 必须消歧）`)
          else warnings.push(`跨 adapter 同形：${message}`)
        }
      }
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] }
}

/** 扫描全部 adapter 输入并编译（三形态分流 + 规则 ①~⑥）。 */
export function compileScenarioRoutes(
  inputs: readonly CompileAdapterInput[],
  options: CompileOptions = {},
): CompileResult {
  const routes: CompiledScenarioRoute[] = []
  const errors: string[] = []
  const warnings: string[] = []
  let scenariosWithRoute = 0

  for (const input of inputs) {
    const toolByName = new Map<string, CompileToolInfo>()
    for (const tool of input.tools) {
      toolByName.set(tool.name, tool)
      toolByName.set(`${input.adapterId}.${tool.name}`, tool)
      for (const alias of tool.aliases ?? []) toolByName.set(alias, tool)
    }
    for (const scenario of input.scenarios ?? []) {
      if (scenario?.route) scenariosWithRoute++
      const declared = scenario?.route
      const terminalTool =
        declared?.plan?.terminal != null
          ? options.planTerminals?.adapters?.[input.adapterId]?.[declared.plan.terminal]?.tool
          : undefined
      const rawTool = declared?.tool ?? terminalTool
      const toolDef =
        rawTool != null
          ? (toolByName.get(rawTool) ??
            toolByName.get(`${input.adapterId}.${rawTool}`) ??
            // 兼容 `adapter.tool` 全名写法：去掉 adapter 前缀再查
            toolByName.get(String(rawTool).split('.').pop() ?? ''))
          : undefined
      const out = compileScenarioRoute({
        adapterId: input.adapterId,
        scenario,
        toolDef,
        planTerminals: options.planTerminals,
        configuredTools: options.configuredTools,
      })
      errors.push(...out.errors)
      warnings.push(...out.warnings)
      if (out.route) routes.push(out.route)
    }
  }

  const lint = shadowingLint(routes)
  errors.push(...lint.errors)
  warnings.push(...lint.warnings)

  return {
    routes,
    errors,
    warnings,
    stats: {
      adapters: inputs.length,
      scenariosWithRoute,
      byShape: {
        tool: routes.filter((route) => !!route.tool).length,
        plan: routes.filter((route) => !!route.plan).length,
        optout: routes.filter((route) => route.optout).length,
      },
    },
  }
}

/**
 * 从 manifest 原始 JSON 构造编译输入（CLI 路径：直接读 `adapters/<site>/manifest.json`，
 * 不依赖运行时的 profile / 状态目录）。
 */
export function buildCompileInputFromManifest(dirName: string, manifest: unknown): CompileAdapterInput {
  const record = (manifest ?? {}) as Record<string, unknown>
  const adapterId = typeof record.id === 'string' && record.id ? record.id : dirName
  const scenarios = Array.isArray(record.scenarios) ? (record.scenarios as RegistryScenarioDef[]) : []
  const commands = Array.isArray(record.commands) ? (record.commands as Record<string, unknown>[]) : []
  const tools: CompileToolInfo[] = commands
    .filter((command) => typeof command.id === 'string' && command.id)
    .map((command) => ({
      name: String(command.id),
      safety: typeof command.safety === 'string' ? command.safety : undefined,
      requiresConfirmation: command.requires_confirmation === true,
      parameters: (command.schema ?? {}) as Record<string, unknown>,
      execution: (command.execution ?? undefined) as CompileToolInfo['execution'],
      aliases: Array.isArray(command.aliases) ? command.aliases.map(String) : [],
    }))
  // 旧版 manifest 用 tools[] 声明工具，同样纳入（保持向后兼容）。
  const legacyTools = Array.isArray(record.tools) ? (record.tools as Record<string, unknown>[]) : []
  for (const tool of legacyTools) {
    if (typeof tool.name !== 'string' || !tool.name) continue
    tools.push({
      name: tool.name,
      safety: typeof tool.safety === 'string' ? tool.safety : undefined,
      requiresConfirmation: tool.requiresConfirmation === true,
      parameters: (tool.parameters ?? {}) as Record<string, unknown>,
      execution: (tool.execution ?? undefined) as CompileToolInfo['execution'],
      aliases: Array.isArray(tool.aliases) ? tool.aliases.map(String) : [],
    })
  }
  return { adapterId, scenarios, tools }
}

/** route_templates 的编译期校验（Tier -2 的数据同源，避免只在运行时才发现写错）。 */
export function checkRouteTemplates(inputs: readonly CompileAdapterInput[], templates: readonly { adapterId: string; defs: readonly ManifestRouteTemplateDef[] }[]): string[] {
  const errors: string[] = []
  const directByAdapter = new Map<string, Set<string>>()
  for (const input of inputs) {
    const direct = new Set<string>()
    for (const tool of input.tools) {
      if (tool.execution?.type === 'api' && tool.execution?.runtime === 'background' && tool.safety === 'read') {
        direct.add(`${input.adapterId}.${tool.name}`)
        direct.add(tool.name)
        for (const alias of tool.aliases ?? []) direct.add(alias)
      }
    }
    directByAdapter.set(input.adapterId, direct)
  }
  for (const { adapterId, defs } of templates) {
    const direct = directByAdapter.get(adapterId) ?? new Set<string>()
    for (const def of defs ?? []) {
      const tool = typeof def?.tool === 'string' ? def.tool : ''
      if (!tool) {
        errors.push(`${adapterId}: route_templates[${def?.id ?? '?'}] 缺少 tool`)
        continue
      }
      if (!direct.has(tool)) {
        errors.push(
          `${adapterId}: route_templates[${def?.id ?? '?'}] 的 ${tool} 不是「只读 + 可直调」工具（execution:api+background 且 safety:read）`,
        )
      }
      for (const slot of Object.values(def?.slots ?? {})) {
        const validate = typeof slot?.validate === 'string' ? slot.validate : ''
        const invalid = checkTemplateValidate(validate)
        if (invalid) {
          errors.push(`${adapterId}: route_templates[${def?.id ?? '?'}] 自由槽 validate 非法：${invalid}`)
        }
      }
    }
  }
  return errors
}
