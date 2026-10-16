/**
 * 层 9：多跳锚点 DAG 的**配置化装配**（`router-config/plans.json`，详见设计文档 §2 第 10 行）。
 *
 * 分工：引擎（`anchor-plan.ts`）只提供机制——惰性解析、复用、失败落回；本模块把配置里的
 * 声明式 `resolvers` / `terminals` 编译成引擎认识的函数，并把入口正则编成 matcher。
 * **业务链路不在代码里**：哪一跳依赖哪一跳、从哪个字段取值，全部来自配置文件。
 *
 * 取值引用语法（`args` 与 `extract.equals` 共用）：
 *   - `"$name"`：已解析锚点优先，其次入口 input；
 *   - `"$$name"`：只从入口 input 取（严格），锚点同名时不误取；
 *   - 其它字面量：原样常量。
 *
 * 失败姿态与全链一致：链路断了（缺 resolver / 多义 / 未命中）→ `PlanFallback` → 落回 LLM。
 */

import { PlanFallback, renderWithSchema, type AnchorResolver, type AskUserFn, type PlanDeps, type PlanInput, type PlanSchemaLookup, type Terminal } from './anchor-plan.js'
import type { PlanEntry, PlanExtractRule, PlanResolver, RouterRenderSpec } from '../router-config/types.js'
import { detectMainArray } from '../webcli-result-project.js'
import { getFieldValue, locateRows } from './declarative-renderer.js'
import { createLogger } from '../logger.js'

const log = createLogger('api-query-router')

const REF_STRICT = '$$'
const REF_LOOSE = '$'
const DEFAULT_VALUE_FIELD = 'id'

export type CompiledPlan = {
  id: string
  adapterId?: string
  entry: { terminal: string; positive: RegExp[]; negative: RegExp[] }
  resolvers: Record<string, AnchorResolver>
  terminals: Record<string, Terminal>
  /** 入口命中后要跑的终端（缺省 terminals 首条） */
  defaultTerminal: string
}

export type PlanDagDeps = {
  /** 声明式渲染的 schema 查询（来自 renderers.json）；缺省退回通用渲染 */
  lookupSchema?: PlanSchemaLookup
  /** 确认门注入（`onAmbiguous: 'ask'` 时使用）；缺省则多义一律落回 */
  askUser?: AskUserFn
  log?: (msg: string) => void
}

export type PlanHit = {
  plan: CompiledPlan
  terminalKey: string
  /** 入口正则里抽到的具名捕获组，作为 PlanInput */
  input: PlanInput
  /** 匹配到的入口片段，仅日志用 */
  matched: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compileRegexList(sources: readonly string[] | undefined): RegExp[] {
  const out: RegExp[] = []
  for (const source of sources ?? []) {
    if (typeof source !== 'string' || !source) continue
    try {
      out.push(new RegExp(source, 'i'))
    } catch (error) {
      log.warn(`plans: invalid entry regex dropped: ${source}`, error)
    }
  }
  return out
}

/** 引用解析：`$k` / `$$k` → 锚点或入口 input；其它按常量。 */
function resolveRef(value: unknown, anchors: Record<string, unknown>, input: PlanInput): unknown {
  if (typeof value !== 'string') return value
  if (value.startsWith(REF_STRICT)) {
    const key = value.slice(REF_STRICT.length)
    return input[key]
  }
  if (value.startsWith(REF_LOOSE)) {
    const key = value.slice(REF_LOOSE.length)
    return key in anchors ? anchors[key] : input[key]
  }
  return value
}

function resolveArgs(
  spec: Record<string, unknown> | undefined,
  anchors: Record<string, unknown>,
  input: PlanInput,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec ?? {})) {
    const resolved = resolveRef(value, anchors, input)
    // 未解析到值（用户在话术里没给出该参数）→ 不下发该键，让工具自己报缺参并落回 LLM，
    // 而不是把 undefined 序列化成 null 蒙一个值。
    if (resolved !== undefined) out[key] = resolved
  }
  return out
}

/** 从结果里定位主数组：显式 path 优先，否则自动探测。 */
function rowsOf(raw: string, path?: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (isPlainObject(parsed) && 'error' in parsed) return null
  if (path) {
    const value = getFieldValue(parsed, path)
    return Array.isArray(value) ? value : null
  }
  const located = locateRows(parsed)
  if (located) return located
  const main = detectMainArray(parsed)
  return main?.array ?? null
}

const NAME_FIELDS = ['name', 'title', 'label', 'displayName', 'display_name']

function labelOf(row: unknown): string | undefined {
  if (!isPlainObject(row)) return undefined
  for (const field of NAME_FIELDS) {
    const value = row[field]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function valueOf(row: unknown, field: string | undefined): unknown {
  if (!isPlainObject(row)) return undefined
  const key = field && field.trim() ? field : DEFAULT_VALUE_FIELD
  const direct = row[key]
  if (direct !== undefined) return direct
  // 兜底：常见包裹形状（{node:{id}} / {item:{id}}）
  for (const wrapper of ['node', 'item', 'record', 'data']) {
    const inner = row[wrapper]
    if (isPlainObject(inner) && inner[key] !== undefined) return inner[key]
  }
  return undefined
}

/** 与用户输入比对的锚点值（`equals` 里的 `$k` 优先从入口 input 取——那是用户亲口说的名字）。 */
function equalsValue(rule: PlanExtractRule, anchors: Record<string, unknown>, input: PlanInput): unknown {
  const spec = rule.equals
  if (typeof spec !== 'string' || !spec) return undefined
  return resolveRef(spec, anchors, input)
}

function matchesRule(row: unknown, rule: PlanExtractRule, target: unknown): boolean {
  const label = labelOf(row)
  if (label === undefined) return false
  const want = String(target ?? '')
  if (!want) return false
  const pick = rule.pick ?? 'name'
  if (pick === 'contains') return label.includes(want)
  return label === want
}

/** 收集全部命中行（供 extract 与确认门共用）。 */
function selectRows(raw: string, rule: PlanExtractRule, anchors: Record<string, unknown>, input: PlanInput): unknown[] {
  const rows = rowsOf(raw, rule.path)
  if (!rows || !rows.length) return []
  const pick = rule.pick ?? 'name'
  if (pick === 'latest') return rows.slice(0, 1)
  const target = equalsValue(rule, anchors, input)
  if (target === undefined || target === '') return []
  return rows.filter((row) => matchesRule(row, rule, target))
}

/** 多义时的确认门：候选＝全部命中行；唯一命中时引擎会直接采纳、不打扰用户。 */
function buildConfirmGate(
  resolver: PlanResolver,
  rule: PlanExtractRule,
): NonNullable<AnchorResolver['confirm']> {
  const question = rule.question ?? `请确认「${resolver.produces}」指的是哪一个：`
  return {
    question: () => question,
    candidates: (raw, anchors, input) =>
      selectRows(raw, rule, anchors, input).flatMap((row) => {
        const label = labelOf(row)
        const value = valueOf(row, rule.value)
        if (label === undefined || value === undefined) return []
        return [{ label, value }]
      }),
  }
}

function buildResolver(resolver: PlanResolver, rule: PlanExtractRule | undefined): AnchorResolver {
  const base: AnchorResolver = {
    produces: resolver.produces,
    needs: resolver.needs ?? [],
    tool: resolver.tool,
    args: (anchors, input) => resolveArgs(resolver.args, anchors, input),
    extract: (raw, anchors, input) => {
      if (!rule) return { ok: false, reason: 'notFound', detail: `${resolver.produces}: 未声明 extract` }
      const rows = selectRows(raw, rule, anchors, input)
      if (!rows.length) return { ok: false, reason: 'notFound', detail: `${resolver.produces}: 未命中` }
      if (rows.length > 1) return { ok: false, reason: 'ambiguous', detail: `${resolver.produces}: 命中 ${rows.length} 条` }
      const value = valueOf(rows[0], rule.value)
      if (value === undefined) {
        return { ok: false, reason: 'notFound', detail: `${resolver.produces}: 结果里没有 ${rule.value ?? DEFAULT_VALUE_FIELD}` }
      }
      return { ok: true, value }
    },
  }
  // onAmbiguous: 'ask' → 多义时让用户点选。唯一命中不打扰（引擎侧短路）。
  if (rule?.onAmbiguous === 'ask') base.confirm = buildConfirmGate(resolver, rule)
  return base
}

function buildTerminal(
  terminal: { key: string; needs?: string[]; tool: string; args?: Record<string, unknown>; render?: RouterRenderSpec },
  deps: PlanDagDeps,
): Terminal {
  const base: Terminal = {
    key: terminal.key,
    needs: terminal.needs ?? [],
    tool: terminal.tool,
    args: (anchors, input) => resolveArgs(terminal.args, anchors, input),
  }
  // 未声明 schema 渲染时不挂 render：引擎缺省走通用渲染（与「渲染器非必需」一致）。
  const schemaId = terminal.render?.type === 'schema' ? terminal.render.schemaId : undefined
  if (schemaId) {
    base.render = (raw) => renderWithSchema(raw, schemaId, deps.lookupSchema)
  }
  return base
}

/**
 * 编译全部计划。非法入口正则只丢自己；缺 terminal 的计划整条丢弃（宁可不命中，不可半条链路）。
 */
export function compilePlans(plans: readonly PlanEntry[] | null | undefined, deps: PlanDagDeps = {}): CompiledPlan[] {
  const out: CompiledPlan[] = []
  for (const plan of plans ?? []) {
    if (!plan || typeof plan.id !== 'string' || plan.enabled === false) continue
    const terminals = (plan.terminals ?? []).filter(
      (terminal) => terminal && typeof terminal.key === 'string' && typeof terminal.tool === 'string',
    )
    if (!terminals.length) {
      log.warn(`plans: ${plan.id} has no usable terminal, dropped`)
      continue
    }
    const defaultTerminal = terminals[0].key
    const terminalKey = typeof plan.entry?.terminal === 'string' && plan.entry.terminal ? plan.entry.terminal : defaultTerminal
    if (!terminals.some((terminal) => terminal.key === terminalKey)) {
      log.warn(`plans: ${plan.id} entry.terminal "${terminalKey}" not found, dropped`)
      continue
    }
    const resolvers: Record<string, AnchorResolver> = {}
    for (const resolver of plan.resolvers ?? []) {
      if (!resolver || typeof resolver.produces !== 'string' || !resolver.produces) continue
      if (typeof resolver.tool !== 'string' || !resolver.tool) continue
      resolvers[resolver.produces] = buildResolver(resolver, resolver.extract)
    }
    const terminalMap: Record<string, Terminal> = {}
    for (const terminal of terminals) terminalMap[terminal.key] = buildTerminal(terminal, deps)

    out.push({
      id: plan.id,
      adapterId: plan.adapterId,
      entry: {
        terminal: terminalKey,
        positive: compileRegexList(plan.entry?.positive),
        negative: compileRegexList(plan.entry?.negative),
      },
      resolvers,
      terminals: terminalMap,
      defaultTerminal,
    })
  }
  return out
}

export type PlanMatcher = {
  plans: CompiledPlan[]
  /** 自动推断层：正则命中 → 终端 + 具名捕获组作为 input */
  match: (message: string) => PlanHit | null
  /** manifest `route.plan` 入口形态：按 adapterId 反查（无则落回） */
  findForAdapter: (adapterId: string) => CompiledPlan | undefined
}

/** 构造层 9 匹配器。纯函数、无 IO。 */
export function buildPlanMatcher(
  plans: readonly PlanEntry[] | null | undefined,
  deps: PlanDagDeps = {},
): PlanMatcher {
  const compiled = compilePlans(plans, deps)

  return {
    plans: compiled,
    findForAdapter(adapterId: string) {
      if (!adapterId) return undefined
      return compiled.find((plan) => plan.adapterId === adapterId)
    },
    match(message: string): PlanHit | null {
      const trimmed = message?.trim()
      if (!trimmed) return null
      for (const plan of compiled) {
        if (plan.entry.negative.some((re) => re.test(trimmed))) continue
        for (const re of plan.entry.positive) {
          const match = re.exec(trimmed)
          if (!match) continue
          const input: PlanInput = {}
          for (const [key, value] of Object.entries(match.groups ?? {})) {
            if (value !== undefined) input[key] = value
          }
          return { plan, terminalKey: plan.entry.terminal, input, matched: match[0] }
        }
      }
      return null
    },
  }
}

export type { PlanDeps, PlanInput }
export { PlanFallback }
