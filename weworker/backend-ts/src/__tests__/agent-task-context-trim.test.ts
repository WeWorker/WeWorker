import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Store from '../works-store.js'

vi.mock('../config.js', () => ({
  ensureUserDirectory: () => 'C:/weworker-fixtures',
  ensureProjectDirectory: (...segments: string[]) => `C:/weworker-fixtures/${segments.join('/')}`,
}))

const store = await import('../works-store.js')

const text = (value: string) => [{ type: 'text', text: value }] as Store.ContentBlock[]

describe('scheduled task durable conversation trimming', () => {
  beforeEach(() => { store._initTestDb() })

  it('trimWorkMessages keeps the newest user turns plus everything after them', () => {
    const work = store.createWork('【定时】fixture')
    for (let round = 1; round <= 5; round++) {
      store.appendMessage(work.id, 'user', text(`run-${round}`))
      store.appendMessage(work.id, 'assistant', text(`result-${round}`))
    }
    // 最后一轮之后模型可能追加多条消息：同属最后一个用户轮次，必须保留。
    store.appendMessage(work.id, 'assistant', text('timing-tail'))

    const removed = store.trimWorkMessages(work.id, 3)

    expect(removed).toBe(4)
    const remaining = store.getWorkWithMessages(work.id)!.messages
    expect(remaining.map((message) => (message.content[0] as { text: string }).text))
      .toEqual(['run-3', 'result-3', 'run-4', 'result-4', 'run-5', 'result-5', 'timing-tail'])
  })

  it('trimWorkMessages is a no-op while the conversation is within budget', () => {
    const work = store.createWork('【定时】fixture')
    store.appendMessage(work.id, 'user', text('run-1'))
    store.appendMessage(work.id, 'assistant', text('result-1'))
    store.appendMessage(work.id, 'user', text('summary-req-1'))

    expect(store.trimWorkMessages(work.id, 10)).toBe(0)
    expect(store.getWorkWithMessages(work.id)!.messages).toHaveLength(3)
  })

  it('a high-frequency task converges: steady state stays around the newest executions', () => {
    const work = store.createWork('【定时】fixture')
    const keepTurns = 10
    // 模拟 executor 的节奏：每轮执行前先截断，再追加本轮「执行 + 总结」消息。
    for (let round = 1; round <= 30; round++) {
      store.trimWorkMessages(work.id, keepTurns)
      store.appendMessage(work.id, 'user', text(`run-${round}`))
      store.appendMessage(work.id, 'assistant', text(`result-${round}`))
      store.appendMessage(work.id, 'user', text(`summary-req-${round}`))
      store.appendMessage(work.id, 'assistant', text(`summary-${round}`))
    }
    const messages = store.getWorkWithMessages(work.id)!.messages
    // 30 轮 × 4 条 = 120 条不截断；截断后应稳定在 keepTurns 个用户轮次附近。
    const userTurns = messages.filter((message) => message.role === 'user').length
    expect(userTurns).toBeLessThanOrEqual(keepTurns + 2)
    expect(messages.length).toBeLessThan(30)
    const firstText = (messages[0].content[0] as { text: string }).text
    expect(firstText).toMatch(/^(run|summary-req)-2[5-9]$/)
  })

  it('task-executor trims the durable agent conversation before appending the run prompt', () => {
    const source = fs.readFileSync(new URL('../task-executor.ts', import.meta.url), 'utf8')
    const guardIndex = source.indexOf('if (agent && task.context_work_id)')
    const trimIndex = source.indexOf('trimWorkMessages(work.id, AGENT_TASK_CONTEXT_TURNS)')
    const appendIndex = source.indexOf("store.appendMessage(work.id, 'user'")
    expect(guardIndex).toBeGreaterThan(-1)
    expect(trimIndex).toBeGreaterThan(guardIndex)
    expect(appendIndex).toBeGreaterThan(trimIndex)
    // 截断是尽力而为：失败不允许把一次正常的执行变成失败。
    expect(source).toContain('agent task context trim failed')
  })
})
