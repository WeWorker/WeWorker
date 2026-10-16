/**
 * 锚点依赖图（DAG）解析引擎——**域无关、纯逻辑**（详见设计文档 §2 第 10 行）。
 *
 * 多跳、跨接口的依赖查询（如 A → B → C）在此表达为：
 *   - Anchor：可在一回合内复用的解析标识（某个 id / 名称）；
 *   - Resolver：声明 `produces` + `needs`（先后关系在此）的解析器；
 *   - Terminal：用户真正要的功能，只声明 `needs` + `tool`，不含解析逻辑。
 *
 * 引擎惰性按需解析 terminal 的 `needs`，已解析锚点直接复用（同一回合多个 terminal 共享前置，
 * 只派发一次）；任一跳歧义 / 未命中 / 鉴权失败 / 派发异常 → 抛 `PlanFallback` → 调用方落回 LLM。
 *
 * **业务规则不在这里**：本文件只有机制；「哪一跳依赖哪一跳」全部来自 `plans.json`。
 */

import { renderGeneric } from './generic-renderer.js'
import type { RenderCtx } from './types.js'
import type { RenderSchemaContext } from './declarative-renderer.js'
import { renderFromSchema } from './declarative-renderer.js'
import type { RouterRenderSchema } from '../router-config/types.js'

/** 锚点表：key = 锚点名，value = 已解析值。 */
export type AnchorMap = Record<string, unknown>

/** 用户文本抽出的输入线索（名称 / 数字 ID…），由入口 matcher 产出。 */
export type PlanInput = {
  [key: string]: unknown
  /** 用户文本里直接给出的锚点（如数字 ID），短路注入、跳过对应解析。 */
  directAnchors?: AnchorMap
}

/** resolver 抽取的返回：成功带值；失败给原因 → 引擎落回 LLM。 */
export type ExtractResult = { ok: true; value: unknown } | { ok: false; reason: 'ambiguous' | 'notFound'; detail?: string }

/** 确认门候选项：label = 用户可见名称；value = 内部锚点值（绝不展示给用户）。 */
export type Candidate = { label: string; description?: string; value: unknown }

/** 确认门：声明在 resolver 上即启用「向用户主动确认」。 */
export type ConfirmGate = {
  question: (anchors: AnchorMap, input: PlanInput) => string
  candidates: (raw: string, anchors: AnchorMap, input: PlanInput) => Candidate[]
}

/** askUser 注入：发 user_choice + 等用户点选，返回用户选中的 option label。 */
export type AskUserFn = (question: string, options: { label: string; description?: string }[]) => Promise<string>

export type AnchorResolver = {
  produces: string
  needs: string[]
  tool: string
  args: (anchors: AnchorMap, input: PlanInput) => Record<string, unknown>
  extract: (raw: string, anchors: AnchorMap, input: PlanInput) => ExtractResult
  /** 声明即启用确认门（用户主动确认）；与 extract 互斥使用。 */
  confirm?: ConfirmGate
}

export type Terminal = {
  key: string
  needs: string[]
  tool: string
  args: (anchors: AnchorMap, input: PlanInput) => Record<string, unknown>
  render?: (raw: string, anchors: AnchorMap, ctx: RenderCtx) => string
}

/** 引擎抛此错误 → 调用方落回 LLM（与鉴权 / 缺参失败同语义）。 */
export class PlanFallback extends Error {
  constructor(
    public readonly reason: 'ambiguous' | 'notFound' | 'auth' | 'error',
    message?: string,
  ) {
    super(message ?? reason)
    this.name = 'PlanFallback'
  }
}

export type PlanDeps = {
  dispatch: (tool: string, args: string, workId: string) => Promise<string>
  workId: string
  resolvers: Record<string, AnchorResolver>
  terminals: Record<string, Terminal>
  /** 鉴权失败检测（命中 → 落回 LLM 处理登录）；缺省不检。 */
  isAuthFailure?: (raw: string) => boolean
  /** 缺参检测（命中 → 落回 LLM）；缺省不检。 */
  isMissingArg?: (raw: string) => boolean
  /** 确认门交互注入（交互式解析用）。 */
  askUser?: AskUserFn
  log?: (msg: string) => void
}

export type PlanRunResult = {
  md: string
  terminalTool: string
  /** 实际派发次数（resolver + terminal），写入 turn_end.steps */
  steps: number
  /** 实际派发耗时之和（不含确认门等用户等待），写入 turn_end.execMs */
  dispatchMs: number
}

/** 派发 + 守卫 + 计步/计时：鉴权 / 缺参 → PlanFallback；异常 → PlanFallback('error')。 */
async function guardedDispatch(
  deps: PlanDeps,
  tool: string,
  argsObj: Record<string, unknown>,
  stats: { n: number; ms: number },
): Promise<string> {
  const started = Date.now()
  let raw: string
  try {
    raw = await deps.dispatch(tool, JSON.stringify(argsObj), deps.workId)
  } catch (error) {
    throw new PlanFallback('error', error instanceof Error ? error.message : String(error))
  }
  stats.n += 1
  stats.ms += Date.now() - started
  if (deps.isAuthFailure?.(raw)) throw new PlanFallback('auth', `${tool} auth failure`)
  if (deps.isMissingArg?.(raw)) throw new PlanFallback('error', `${tool} missing-arg`)
  return raw
}

/** 惰性按需解析一个锚点：递归先解析 needs；已解析的直接复用。`resolving` 防成环死递归。 */
async function resolveAnchor(
  key: string,
  anchors: AnchorMap,
  input: PlanInput,
  deps: PlanDeps,
  stats: { n: number; ms: number },
  resolving: Set<string>,
): Promise<void> {
  if (key in anchors) return
  if (resolving.has(key)) throw new PlanFallback('error', `circular anchor dependency: ${key}`)
  const resolver = deps.resolvers[key]
  if (!resolver) throw new PlanFallback('error', `no resolver for anchor "${key}"`)
  resolving.add(key)
  try {
    for (const dep of resolver.needs) await resolveAnchor(dep, anchors, input, deps, stats, resolving)
    const raw = await guardedDispatch(deps, resolver.tool, resolver.args(anchors, input), stats)
    if (resolver.confirm) {
      anchors[resolver.produces] = await confirmAnchor(resolver, raw, anchors, input, deps)
    } else {
      const extracted = resolver.extract(raw, anchors, input)
      if (!extracted.ok) throw new PlanFallback(extracted.reason, extracted.detail ?? `${resolver.produces} ${extracted.reason}`)
      anchors[resolver.produces] = extracted.value
    }
  } finally {
    resolving.delete(key)
  }
}

/** 跑一个终端：解析 needs → 派发终端工具 → 渲染。任一环节失败 → PlanFallback。 */
export async function runPlan(
  terminalKey: string,
  input: PlanInput,
  deps: PlanDeps,
  ctx: RenderCtx,
): Promise<PlanRunResult> {
  const terminal = deps.terminals[terminalKey]
  if (!terminal) throw new PlanFallback('error', `no terminal "${terminalKey}"`)

  const anchors: AnchorMap = {}
  if (input.directAnchors && typeof input.directAnchors === 'object') Object.assign(anchors, input.directAnchors)
  const stats = { n: 0, ms: 0 }
  const resolving = new Set<string>()
  for (const dep of terminal.needs) await resolveAnchor(dep, anchors, input, deps, stats, resolving)
  const raw = await guardedDispatch(deps, terminal.tool, terminal.args(anchors, input), stats)
  const md = terminal.render ? safeRenderPlan(terminal.render, raw, anchors, ctx) : renderGeneric(raw)
  return { md, terminalTool: terminal.tool, steps: stats.n, dispatchMs: stats.ms }
}

/** 渲染异常兜底：退回通用渲染，绝不因 render 抛错把栈错暴露给用户。 */
function safeRenderPlan(
  render: NonNullable<Terminal['render']>,
  raw: string,
  anchors: AnchorMap,
  ctx: RenderCtx,
): string {
  try {
    return render(raw, anchors, ctx)
  } catch {
    return renderGeneric(raw)
  }
}

/** 逃生项文案（用户取消 / 候选不在列表里）。 */
export const CANCEL_LABEL = '都不是 / 取消'

/** 规范化 label 以容错比对：去全部空白 + 转小写。 */
function normLabel(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 候选数上限（不含逃生项）：客户端 `user_choice` 限 2~6 选项 → 最多 5 候选 + 1 逃生。
 * 超出即截断并 log；被截断时用户可选「都不是 / 取消」落回（不分页，保持「漏判免费」）。
 */
export const MAX_CANDIDATES = 5

/** 经 askUser 发候选让用户确认；返回用户选中的 value。取消 / 超时 / 不在候选 → PlanFallback。 */
async function confirmAnchor(
  resolver: AnchorResolver,
  raw: string,
  anchors: AnchorMap,
  input: PlanInput,
  deps: PlanDeps,
): Promise<unknown> {
  const gate = resolver.confirm
  if (!gate) throw new PlanFallback('error', `resolver ${resolver.produces} has no confirm gate`)
  if (!deps.askUser) throw new PlanFallback('error', `confirm gate requires askUser (anchor ${resolver.produces})`)

  const seen = new Set<string>()
  const candidates = gate.candidates(raw, anchors, input).filter((candidate) => {
    const key = normLabel(candidate.label)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (candidates.length === 0) throw new PlanFallback('notFound', `no candidates for ${resolver.produces}`)

  // 候选唯一时不打扰用户：问「只有一个选项，要选这个吗」是纯粹的摩擦。
  if (candidates.length === 1) return candidates[0].value

  const truncated = candidates.length > MAX_CANDIDATES
  if (truncated) {
    deps.log?.(`confirm gate ${resolver.produces}: ${candidates.length} candidates, showing first ${MAX_CANDIDATES}`)
  }
  const shown = truncated ? candidates.slice(0, MAX_CANDIDATES) : candidates
  const options = [...shown.map((candidate) => ({ label: candidate.label, description: candidate.description })), { label: CANCEL_LABEL }]
  const question = truncated
    ? `${gate.question(anchors, input)}（共 ${candidates.length} 个，仅显示前 ${MAX_CANDIDATES} 个）`
    : gate.question(anchors, input)

  const answer = await deps.askUser(question, options)
  if (!answer || normLabel(answer) === normLabel(CANCEL_LABEL)) {
    throw new PlanFallback('ambiguous', `user cancelled at ${resolver.produces}`)
  }
  const hit = candidates.find((candidate) => normLabel(candidate.label) === normLabel(answer))
  if (!hit) throw new PlanFallback('ambiguous', `user answer not in candidates at ${resolver.produces}`)
  return hit.value
}

/** 声明式渲染的 schema 查询钩子（由调用方从 `renderers.json` 提供）。 */
export type PlanSchemaLookup = (schemaId: string) => RouterRenderSchema | undefined

/** 用声明式 schema 渲染；不适用时退回通用渲染。 */
export function renderWithSchema(
  raw: string,
  schemaId: string | undefined,
  lookup: PlanSchemaLookup | undefined,
  now = new Date(),
): string {
  if (!schemaId || !lookup) return renderGeneric(raw)
  try {
    const schema = lookup(schemaId)
    if (!schema) return renderGeneric(raw)
    const parsed = (() => {
      try {
        return JSON.parse(raw) as unknown
      } catch {
        return raw
      }
    })()
    const ctx: RenderSchemaContext = { now }
    const rendered = renderFromSchema(schema, parsed, ctx)
    return rendered ?? renderGeneric(raw)
  } catch {
    return renderGeneric(raw)
  }
}
