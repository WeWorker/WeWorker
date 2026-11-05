/**
 * 回合耗时记账（turn timing ledger）。
 *
 * 事件流里工具的「开始」和「结束」并不对称：`tool_call_start` 一定会出现，
 * 但结果可能以 `tool_call_result`（文本）、`tool_call_image`（图片）出现，
 * 也可能整轮都没有对应事件（例如只回图片的 Read）。旧实现只在
 * `tool_call_result` 上推进「上一步结束时间」，于是没有结果事件的工具所占的时间
 * 会被后续每一次 think 以及收尾的 trailing 重复计入 `llmMs`，
 * 出现 `llmMs + execMs > totalMs` 的矛盾值。
 *
 * 这里把一轮的时间切成互不重叠的两部分：
 * - `execMs` = 所有工具占用区间的**并集**（同时进行的工具只算一次）；
 * - `llmMs` = 其余时间（模型生成、工具参数流式、回合收尾等）。
 *
 * 因此恒有 `llmMs + execMs === totalMs`，且不会出现 `llm + exec > total`。
 * 缺结果事件的工具在回合结束时按「到回合结束」计入 `execMs`（上界），绝不计入
 * `llmMs`。所有取时都走注入的时钟，逻辑本身是纯函数，便于单测。
 */

export interface TurnTimingSnapshot {
  totalMs: number
  llmMs: number
  execMs: number
}

export interface TurnTimingLedger {
  readonly startedAt: number
  /** 已记账区间的末端（单调递增，等于 startedAt + llmMs + execMs）。 */
  readonly coveredUntil: number
  /**
   * 工具调用开始。闭合到此刻为止的模型时间并返回该工具的 `thinkMs`；
   * 同一个 id 的重复事件（流式模式会重发）不改变记账，返回 `undefined`。
   */
  toolStarted(id: string, at?: number): number | undefined
  /** 工具返回文本结果：按 id 闭合区间并返回该工具分摊的非重叠执行时间。 */
  toolSettled(id: string, at?: number): number | undefined
  /** 工具只留下中间产物（图片等）：同样闭合区间，避免其耗时漏进 llmMs。 */
  toolObserved(id: string, at?: number): number | undefined
  /** 已分配给该工具的独占执行时间（回合结束后也可读取）。 */
  toolExecutionMs(id: string): number | undefined
  /** 未归入任何工具开始前 think 的非执行时间（含回合收尾）。 */
  remainingModelMs(): number
  /** 回合结束：结算仍在运行的工具并冻结本次快照（可重复调用，结果相同）。 */
  finish(at?: number): TurnTimingSnapshot
}

export interface TurnTimingOptions {
  now?: () => number
  /** 回合起点；缺省为创建账本的时刻。传入后 totalMs 与该起点严格一致。 */
  startedAt?: number
}

export function createTurnTimingLedger(options: TurnTimingOptions = {}): TurnTimingLedger {
  const now = options.now ?? Date.now
  const startedAt = options.startedAt ?? now()
  /** 已记账区间的末端：任何区间都只从它往后计，保证不重叠。 */
  let coveredUntil = startedAt
  let llmMs = 0
  let assignedThinkMs = 0
  let execMs = 0
  /** 已开始、尚未结算的工具：id -> 开始时间。 */
  const open = new Map<string, number>()
  const allocated = new Map<string, number>()
  const seen = new Set<string>()
  /** 回合结束快照：第一次 finish() 之后冻结，重复调用结果一致。 */
  let frozen: TurnTimingSnapshot | null = null

  /** 按事件发生前仍在运行的工具，把尚未记账的时间归入执行或非执行。 */
  function chargeUntil(at: number): number {
    if (at <= coveredUntil) return 0
    const gap = at - coveredUntil
    if (open.size) {
      execMs += gap
      // Attribute each wall-clock millisecond to one tool only. The first
      // still-open tool owns overlap, so step totals equal the turn's execMs.
      const owner = open.keys().next().value as string
      allocated.set(owner, (allocated.get(owner) ?? 0) + gap)
    } else llmMs += gap
    coveredUntil = at
    return gap
  }

  function settle(id: string, at: number): number | undefined {
    if (!open.has(id)) return undefined
    chargeUntil(at)
    open.delete(id)
    return allocated.get(id) ?? 0
  }

  return {
    startedAt,
    get coveredUntil() { return coveredUntil },
    toolStarted(id, at = now()) {
      if (frozen || seen.has(id)) return undefined
      seen.add(id)
      const wasExecuting = open.size > 0
      const gap = chargeUntil(at)
      const thinkMs = wasExecuting ? 0 : gap
      assignedThinkMs += thinkMs
      open.set(id, at)
      return thinkMs
    },
    toolSettled(id, at = now()) {
      return settle(id, at)
    },
    toolObserved(id, at = now()) {
      return settle(id, at)
    },
    toolExecutionMs(id) {
      return allocated.get(id)
    },
    remainingModelMs() {
      return llmMs - assignedThinkMs
    },
    finish(at = now()) {
      if (frozen) return frozen
      // 没有结果事件的工具确实执行过：按到回合结束为止计入 exec（上界），
      // 这样它绝不会被算进 llmMs。
      chargeUntil(at)
      open.clear()
      frozen = { totalMs: llmMs + execMs, llmMs, execMs }
      return frozen
    },
  }
}
