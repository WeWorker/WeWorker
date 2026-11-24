/**
 * 普通桌面聊天的 WebCLI 多轮快捷直答（openspec: add-desktop-contextual-quick-replies）。
 *
 * 位置：现有确定性路由（含本地批准路由）都没答出之后、文本 Agent 之前。
 * 只接管一次能可靠绑定的单对象只读调用；其余一切带上下文交还原 Agent 链路。
 * 预算：多轮决策 3s、详情调用 3s、本路径端到端 8s；超时不重试。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { appendWorkLog } from './work-log-file.js'
import { resolveWebcliEntry } from './webcli-path.js'
import { runWebcliCallEx, WebcliTimeoutError, type WebcliContextReceipt, type WebcliCallContextControl } from './webcli-runner.js'
import { rehydratePointer } from './webcli-result-cache.js'
import { renderGeneric } from './api-query-router/generic-renderer.js'
import { isUnrenderableAnswer, classifyDispatchPayload } from './api-query-router/route-dispatch.js'
import { getCatalog, isReadOnlyTool } from './api-query-router/tool-catalog.js'
import {
  clearDesktopDisplay,
  commitDeliveredDisplay,
  currentDesktopDisplay,
  recordWebcliReceipt,
  type DesktopDisplayRecord,
} from './desktop-webcli-context.js'

const execFileAsync = promisify(execFile)

const DECISION_TIMEOUT_MS = 3_000
const CALL_TIMEOUT_MS = 3_000
const TOTAL_BUDGET_MS = 8_000
const MAX_RESULT_TEXT_CHARS = 8_000

/** 交给文本 Agent 的快捷路径参考；字段全部为参考信息，不改变权限与工具定义。 */
export interface QuickReplyForAgent {
  attempted: true
  kind: 'resolved' | 'needs_input' | 'handoff' | 'unrelated' | 'route_failed'
  reasonCode?: string
  question?: string
  tool?: string
  resultText?: string
}

export interface PrecomputedRecommendation {
  status: 'recommended' | 'low_confidence'
  result: Record<string, unknown>
}

export interface QuickReplyOutcome {
  handled: boolean
  forAgent?: QuickReplyForAgent
  precomputedRecommendation?: PrecomputedRecommendation
}

export interface QuickReplyInput {
  message: string
  workId: string
  turnId: string
  chatStartTime: number
  send: (event: object) => void
  signal?: AbortSignal
  /** 当前已启用的 adapter 集合；工具所属站点不在其中即不直答。 */
  enabledAdapterIds?: ReadonlySet<string>
  persistAssistantMessage?: (workId: string, text: string, timing: Record<string, unknown>) => void
  now?: () => number
  /** 测试注入：多轮决策子进程。 */
  route?: (args: { contextId: string; message: string; timeoutMs: number; signal?: AbortSignal }) =>
    Promise<{ stdout: string; stderr: string }>
  /** 测试注入：详情调用。 */
  execute?: (toolName: string, argsJson: string, workId: string | null | undefined,
    options: Parameters<typeof runWebcliCallEx>[3]) => Promise<string>
}

type ContextRouteEnvelope = {
  contextProtocolVersion?: number
  kind: string
  reasonCode?: string
  clarificationId?: string
  question?: string
  missingFields?: string[]
  decisionId?: string
  roundId?: string
  executionEligibility?: string
  selection?: { snapshotId?: string; sourceRoundId?: string; displayVersion?: string; entityRefs?: string[]; actionId?: string }
  steps?: Array<{ stepId?: string; tool?: string; args?: Record<string, unknown>; invocation?: { command?: string; tool?: string; args?: Record<string, unknown>; decision?: string; step?: string } }>
  singleTurnRoute?: unknown
  context?: { id?: string; epoch?: string; revision?: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateSingleTurnRecommendation(value: unknown): PrecomputedRecommendation | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'routed') {
    if (!isRecord(value.site) || typeof (value.site as Record<string, unknown>).adapterId !== 'string'
      || !isRecord(value.command) || typeof (value.command as Record<string, unknown>).name !== 'string'
      || typeof value.callCommand !== 'string') return undefined
    return { status: 'recommended', result: value }
  }
  if (value.kind === 'low-confidence' && isRecord(value.stoppedAt)) {
    return { status: 'low_confidence', result: value }
  }
  return undefined
}

/** 复用路由面的只读准入：存在 + 可直调 + 显式只读 + 无需确认 + 站点已启用。 */
function eligibleQuickReplyTool(toolName: string, enabledAdapterIds: ReadonlySet<string> | undefined): { ok: true; validate: (args: unknown) => boolean } | { ok: false } {
  const dot = toolName.lastIndexOf('.')
  const adapterId = dot > 0 ? toolName.slice(0, dot) : ''
  if (!adapterId || !enabledAdapterIds?.has(adapterId)) return { ok: false }
  const tool = getCatalog().byName.get(toolName)
  if (!tool || !getCatalog().adapterIds.has(tool.adapterId) || tool.adapterId !== adapterId) return { ok: false }
  if (!tool.direct || tool.navigateBefore || !isReadOnlyTool(tool)) return { ok: false }
  let validator: z.ZodType
  try {
    const schema = tool.parameters
    if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return { ok: false }
    validator = z.fromJSONSchema(schema)
  } catch {
    return { ok: false }
  }
  return { ok: true, validate: args => isRecord(args) && Object.keys(args).every(key => Object.hasOwn(tool.parameters.properties as object, key)) && validator.safeParse(args).success }
}

export async function tryContextualQuickReply(input: QuickReplyInput): Promise<QuickReplyOutcome> {
  const now = input.now ?? Date.now
  const startedAt = now()
  const noReply = (forAgent?: QuickReplyForAgent, precomputedRecommendation?: PrecomputedRecommendation): QuickReplyOutcome =>
    ({ handled: false, ...(forAgent ? { forAgent } : {}), ...(precomputedRecommendation ? { precomputedRecommendation } : {}) })

  const display: DesktopDisplayRecord | null = currentDesktopDisplay(input.workId)
  if (!display) return noReply()
  if (input.signal?.aborted) return noReply()

  let routeResult: { stdout: string; stderr: string }
  try {
    const runner = input.route ?? (async args => {
      const isPackaged = !!process.env.WEWORKER_PACKAGED
      const nodeBin = isPackaged ? (process.env.WEWORKER_EXEC_PATH || process.execPath) : 'node'
      return execFileAsync(nodeBin, [resolveWebcliEntry(), 'route', '--json', '--context', args.contextId, '--', args.message], {
        env: { ...process.env, ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}), WEBCLI_EMBEDDED: '1', WEBCLI_CLI_NAME: 'webgo' },
        timeout: args.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal: args.signal,
      })
    })
    routeResult = await runner({ contextId: display.contextId, message: input.message, timeoutMs: DECISION_TIMEOUT_MS, signal: input.signal })
  } catch (error) {
    if (input.signal?.aborted) return noReply()
    const reasonCode = (error as { killed?: boolean })?.killed ? 'decision_timeout' : 'decision_failed'
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_route_failed', reason: reasonCode }, input.turnId)
    return noReply({ attempted: true, kind: 'route_failed', reasonCode })
  }
  if (input.signal?.aborted) return noReply()

  let envelope: ContextRouteEnvelope
  try {
    envelope = JSON.parse(routeResult.stdout) as ContextRouteEnvelope
    if (!isRecord(envelope) || envelope.contextProtocolVersion !== 1 || envelope.context?.id !== display.contextId || envelope.context?.epoch !== display.epoch || typeof envelope.kind !== 'string') throw new Error('invalid envelope')
  } catch {
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_route_failed', reason: 'invalid_output' }, input.turnId)
    return noReply({ attempted: true, kind: 'route_failed', reasonCode: 'invalid_output' })
  }
  if (envelope.kind !== 'resolved' && envelope.kind !== 'needs_input' && envelope.kind !== 'handoff' && envelope.kind !== 'unrelated') {
    return noReply({ attempted: true, kind: 'route_failed', reasonCode: 'invalid_output' })
  }

  if (envelope.kind === 'unrelated') {
    const recommendation = validateSingleTurnRecommendation(envelope.singleTurnRoute)
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_route_complete', kind: 'unrelated', fallback: 'llm' }, input.turnId)
    return noReply({ attempted: true, kind: 'unrelated', reasonCode: envelope.reasonCode }, recommendation)
  }
  if (envelope.kind === 'needs_input' || envelope.kind === 'handoff') {
    // 不做客户端澄清续接：问题只作为参考交 Agent，由原链路回复用户。
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_route_complete', kind: envelope.kind, fallback: 'llm' }, input.turnId)
    return noReply({
      attempted: true, kind: envelope.kind, reasonCode: envelope.reasonCode,
      ...(envelope.kind === 'needs_input' && typeof envelope.question === 'string' ? { question: envelope.question } : {}),
    })
  }

  // ── resolved：单对象、单步、只读、当前展示、参数完整，缺一即交 Agent。 ──
  const ineligible = (reasonCode: string): QuickReplyOutcome => {
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_route_complete', kind: 'resolved', fallback: 'llm', reason: reasonCode }, input.turnId)
    return noReply({ attempted: true, kind: 'resolved', reasonCode })
  }
  if (envelope.executionEligibility !== 'read_only_allowed') return ineligible('not_read_only')
  const steps = Array.isArray(envelope.steps) ? envelope.steps : []
  if (steps.length !== 1) return ineligible('not_single_step')
  const step = steps[0]
  if (!isRecord(step) || !isRecord(step.args) || typeof step.tool !== 'string' || !step.tool) return ineligible('invalid_step')
  const invocation = step.invocation
  if (!isRecord(invocation) || invocation.tool !== step.tool || invocation.decision !== envelope.decisionId
    || invocation.step !== step.stepId) return ineligible('stale_invocation')
  const selection = envelope.selection
  if (!isRecord(selection) || selection.snapshotId !== display.snapshotId || selection.sourceRoundId !== display.roundId
    || selection.displayVersion !== display.displayVersion) return ineligible('stale_display')
  const entityRefs = Array.isArray(selection.entityRefs) ? selection.entityRefs : []
  if (entityRefs.length !== 1 || typeof entityRefs[0] !== 'string' || !display.orderedEntityRefs.includes(entityRefs[0])) return ineligible('not_current_object')
  const eligibility = eligibleQuickReplyTool(step.tool, input.enabledAdapterIds)
  if (!eligibility.ok) return ineligible('tool_not_eligible')
  if (!eligibility.validate(step.args)) return ineligible('invalid_arguments')

  const decisionId = envelope.decisionId
  if (typeof decisionId !== 'string' || typeof step.stepId !== 'string') return ineligible('stale_invocation')
  // 当前展示存在（上方已检查），直接构造关联；不做二次查询。
  const context: WebcliCallContextControl = { contextId: display.contextId, decisionId, stepId: step.stepId }

  const remainingBeforeCall = TOTAL_BUDGET_MS - (now() - startedAt)
  if (remainingBeforeCall <= 0) {
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_route_complete', kind: 'resolved', fallback: 'llm', reason: 'budget_exhausted' }, input.turnId)
    return noReply({ attempted: true, kind: 'resolved', reasonCode: 'budget_exhausted' })
  }
  if (input.signal?.aborted) return noReply()
  if (currentDesktopDisplay(input.workId) !== display) return ineligible('stale_display')

  let output = ''
  let receipt: WebcliContextReceipt | undefined
  try {
    const execute = input.execute ?? runWebcliCallEx
    output = await execute(step.tool, JSON.stringify(step.args), input.workId, {
      timeoutMs: Math.min(CALL_TIMEOUT_MS, remainingBeforeCall),
      context,
      signal: input.signal,
      onReceipt: value => { receipt = value },
    })
  } catch (error) {
    if (input.signal?.aborted) return noReply()
    const reasonCode = error instanceof WebcliTimeoutError ? 'call_timeout' : 'call_failed'
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_call_failed', reason: reasonCode, fallback: 'llm' }, input.turnId)
    return noReply({ attempted: true, kind: 'resolved', reasonCode })
  }
  if (input.signal?.aborted) return noReply()

  // 只有可信回执确认业务读取成功才允许直答；导航/未知/失败/无回执一律交 Agent。
  if (!receipt || receipt.contextProtocolVersion !== 1 || receipt.contextId !== display.contextId
    || receipt.epoch !== display.epoch || receipt.decisionId !== decisionId || receipt.stepId !== step.stepId
    || receipt.roundId !== envelope.roundId || receipt.toolOutcome !== 'read_success') return ineligible('unconfirmed_read')

  let renderRaw = output
  try {
    const parsed: unknown = JSON.parse(output)
    if (isRecord(parsed) && (parsed as Record<string, unknown>).type === 'large_output') {
      const hydrated = rehydratePointer(output)
      if (!hydrated || classifyDispatchPayload(hydrated)) return ineligible('unusable_result')
      renderRaw = hydrated
    }
    const payloadCheck: unknown = JSON.parse(renderRaw)
    const detail = Array.isArray(payloadCheck) && payloadCheck.length === 1 ? payloadCheck[0] : payloadCheck
    if (!isRecord(detail) || detail.status === 'navigating' || detail.status === 'prepared'
      || detail.status === 'ready_to_retry' || classifyDispatchPayload(JSON.stringify(detail))) return ineligible('failed_result')
    if (Array.isArray(payloadCheck)) renderRaw = JSON.stringify(detail)
  } catch {
    return ineligible('invalid_result')
  }

  let text = ''
  try { text = renderGeneric(renderRaw) } catch { /* hand the successful result to Agent */ }
  if (!text || isUnrenderableAnswer(text) || now() - startedAt >= TOTAL_BUDGET_MS) {
    // 已取得可信结果但渲染不出：交给 Agent 复用，不默认重查。
    appendWorkLog(input.workId, 'route_diagnostic', { phase: 'contextual_render_failed', fallback: 'llm_with_result' }, input.turnId)
    return noReply({ attempted: true, kind: 'resolved', reasonCode: 'unrenderable_result',
      tool: step.tool, resultText: renderRaw.slice(0, MAX_RESULT_TEXT_CHARS) })
  }

  if (input.signal?.aborted) return noReply()
  if (currentDesktopDisplay(input.workId) !== display) return ineligible('stale_display')
  const totalMs = now() - input.chatStartTime
  const execMs = Math.min(totalMs, Math.max(0, now() - startedAt))
  const timing = { totalMs, llmMs: 0, execMs, steps: 1, routeTool: step.tool, routeSource: 'contextual-quick-reply',
    routeArgs: JSON.stringify(step.args) }
  // Commit before any visible output: a storage failure must not yield a partial answer.
  try {
    if (input.persistAssistantMessage) input.persistAssistantMessage(input.workId, text, timing)
    else {
      const store = await import('./works-store.js')
      if (input.signal?.aborted) return noReply()
      if (now() - startedAt >= TOTAL_BUDGET_MS) throw new Error('budget exhausted')
      store.appendMessage(input.workId, 'assistant', [{ type: 'text', text }, { type: 'timing', ...timing }])
    }
  } catch {
    return noReply({ attempted: true, kind: 'resolved', reasonCode: 'reply_commit_failed', tool: step.tool,
      resultText: renderRaw.slice(0, MAX_RESULT_TEXT_CHARS) })
  }
  input.send({ type: 'turn_start', turnId: input.turnId, workId: input.workId })
  input.send({ type: 'text_delta', content: text })
  appendWorkLog(input.workId, 'route_diagnostic', { phase: 'render_succeeded', source: 'contextual-quick-reply', tool: step.tool }, input.turnId)
  appendWorkLog(input.workId, 'route_diagnostic', { phase: 'route_finished', handled: true, fallback: 'none' }, input.turnId)
  input.send({ type: 'turn_end', turnId: input.turnId, workId: input.workId, ...timing })

  // 详情快照成为新的当前展示；核对失败则禁用后续直答（宁可少命中）。
  clearDesktopDisplay(input.workId)
  const remaining = TOTAL_BUDGET_MS - (now() - startedAt)
  if (remaining > 0 && !input.signal?.aborted) {
    recordWebcliReceipt(input.workId, input.turnId, receipt)
    await commitDeliveredDisplay(input.workId, input.turnId, text, { timeoutMs: remaining, signal: input.signal }).catch(() => false)
  }
  return { handled: true }
}
