import { describe, it, expect } from 'vitest'
import { createTurnTimingLedger } from '../turn-timing.js'

/** 可控时钟：所有记账取时都走它，测试里不依赖真实时间。 */
function clock(start = 0) {
  let now = start
  return {
    now: () => now,
    at: (value: number) => { now = value },
  }
}

describe('turn timing ledger', () => {
  it('counts a normal tool: think + tool time + trailing text', () => {
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })

    expect(ledger.toolStarted('tool-a', 1000)).toBe(1000)
    expect(ledger.toolSettled('tool-a', 3000)).toBe(2000)
    const timing = ledger.finish(5000)

    expect(timing).toEqual({ totalMs: 5000, llmMs: 3000, execMs: 2000 })
    expect(timing.llmMs + timing.execMs).toBe(timing.totalMs)
    expect(ledger.remainingModelMs()).toBe(2000)
  })

  it('never charges a tool without a result event to llmMs', () => {
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })

    expect(ledger.toolStarted('read-image', 1000)).toBe(1000)
    // 只有图片产物、没有 tool_call_result：也算作该工具的独占时间。
    expect(ledger.toolObserved('read-image', 4000)).toBe(3000)
    const timing = ledger.finish(6000)

    expect(timing).toEqual({ totalMs: 6000, llmMs: 3000, execMs: 3000 })
    expect(timing.llmMs + timing.execMs).toBe(timing.totalMs)
  })

  it('keeps llm + exec === total for the reported regression shape', () => {
    // 旧口径在这里算出 total=8656 / llm=9656 / exec=2000（llm+exec=11656 > total）：
    // 没有结果事件的工具让 lastStepEndTime 停住，同一段时间被后续 think 重复计入 llm。
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })

    ledger.toolStarted('tool-a', 1000)
    ledger.toolSettled('tool-a', 2000)
    ledger.toolStarted('read-image', 5000)
    ledger.toolStarted('tool-b', 6000)
    ledger.toolSettled('tool-b', 7000)
    const timing = ledger.finish(8656)

    expect(timing.totalMs).toBe(8656)
    expect(timing.llmMs + timing.execMs).toBe(8656)
    expect(timing.execMs).toBeGreaterThanOrEqual(2000)
    expect(timing.llmMs).toBeLessThanOrEqual(8656)
  })

  it('counts overlapping tools once', () => {
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })

    expect(ledger.toolStarted('tool-a', 1000)).toBe(1000)
    expect(ledger.toolStarted('tool-b', 1000)).toBe(0)
    expect(ledger.toolSettled('tool-a', 3000)).toBe(2000)
    expect(ledger.toolSettled('tool-b', 4000)).toBe(1000)
    const timing = ledger.finish(5000)

    expect(timing).toEqual({ totalMs: 5000, llmMs: 2000, execMs: 3000 })
  })

  it('charges all overlapping tool time to execution even when starts precede results', () => {
    const ledger = createTurnTimingLedger({ startedAt: 0 })
    expect(ledger.toolStarted('a', 100)).toBe(100)
    expect(ledger.toolStarted('b', 200)).toBe(0)
    expect(ledger.toolSettled('a', 300)).toBe(200)
    expect(ledger.toolSettled('b', 400)).toBe(100)
    expect(ledger.toolExecutionMs('a')).toBe(200)
    expect(ledger.toolExecutionMs('b')).toBe(100)
    expect(ledger.finish(500)).toEqual({ totalMs: 500, llmMs: 200, execMs: 300 })
  })

  it('charges an unfinished tool through turn end to execution', () => {
    const ledger = createTurnTimingLedger({ startedAt: 0 })
    ledger.toolStarted('a', 100)
    expect(ledger.toolStarted('b', 200)).toBe(0)
    expect(ledger.finish(500)).toEqual({ totalMs: 500, llmMs: 100, execMs: 400 })
    expect((ledger.toolExecutionMs('a') ?? 0) + (ledger.toolExecutionMs('b') ?? 0)).toBe(400)
    expect(ledger.remainingModelMs()).toBe(0)
  })

  it('reconciles every step and the unassigned tail to the turn totals', () => {
    const ledger = createTurnTimingLedger({ startedAt: 0 })
    const thinkA = ledger.toolStarted('a', 100) ?? 0
    const thinkB = ledger.toolStarted('b', 200) ?? 0
    ledger.toolSettled('a', 300)
    ledger.toolSettled('b', 400)
    const thinkC = ledger.toolStarted('c', 450) ?? 0
    ledger.toolSettled('c', 500)
    const totals = ledger.finish(600)
    expect(thinkA + thinkB + thinkC + ledger.remainingModelMs()).toBe(totals.llmMs)
    expect(['a', 'b', 'c'].reduce((sum, id) => sum + (ledger.toolExecutionMs(id) ?? 0), 0)).toBe(totals.execMs)
    expect(totals.llmMs + totals.execMs).toBe(totals.totalMs)
    expect(ledger.remainingModelMs()).toBe(100)
  })

  it('ignores duplicate start events and unknown results', () => {
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })

    expect(ledger.toolStarted('tool-a', 1000)).toBe(1000)
    // 流式模式会把同一个工具的开始事件发两次：第二次不改变记账。
    expect(ledger.toolStarted('tool-a', 1200)).toBeUndefined()
    // 没有开始记录的 id 不参与记账。
    expect(ledger.toolSettled('tool-missing', 1500)).toBeUndefined()
    expect(ledger.toolObserved('tool-missing', 1600)).toBeUndefined()
    expect(ledger.toolSettled('tool-a', 3000)).toBe(2000)
    expect(ledger.toolStarted('tool-a', 3500)).toBeUndefined()
    const timing = ledger.finish(4000)

    expect(timing).toEqual({ totalMs: 4000, llmMs: 2000, execMs: 2000 })
  })

  it('freezes the snapshot at turn end', () => {
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })

    ledger.toolStarted('tool-a', 1000)
    const first = ledger.finish(2000)
    c.at(10_000)
    const second = ledger.finish()

    expect(first).toEqual({ totalMs: 2000, llmMs: 1000, execMs: 1000 })
    expect(second).toEqual(first)
  })

  it('reports llm + exec === total for every event order', () => {
    const c = clock()
    const ledger = createTurnTimingLedger({ now: c.now })
    const events: Array<() => void> = [
      () => { ledger.toolStarted('a', 500) },
      () => { ledger.toolStarted('b', 700) },
      () => { ledger.toolObserved('a', 900) },
      () => { ledger.toolStarted('c', 1500) },
      () => { ledger.toolSettled('c', 1800) },
      () => { ledger.toolSettled('b', 2200) },
    ]
    for (const event of events) event()
    const timing = ledger.finish(2600)

    expect(timing.llmMs + timing.execMs).toBe(timing.totalMs)
    expect(timing.llmMs).toBeGreaterThanOrEqual(0)
    expect(timing.execMs).toBeGreaterThanOrEqual(0)
  })

  it('uses an explicit turn start when given one', () => {
    const c = clock(50_000)
    const ledger = createTurnTimingLedger({ now: c.now, startedAt: 49_000 })

    expect(ledger.startedAt).toBe(49_000)
    expect(ledger.finish(50_000)).toEqual({ totalMs: 1000, llmMs: 1000, execMs: 0 })
  })
})
