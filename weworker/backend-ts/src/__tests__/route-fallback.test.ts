import { describe, expect, it, vi } from 'vitest'
import { executeRoutePlan, type RouteEngine } from '../api-query-router/index.js'
import { dispatchOnce } from '../api-query-router/route-dispatch.js'
import type { CascadePlan } from '../api-query-router/cascade.js'

const tool = 'example.list'
const engine = { routableTools: new Set([tool]), bundle: {} } as RouteEngine
const ctx = () => ({ message: '查询示例', workId: 'work-1', turnId: 'turn-1', chatStartTime: Date.now(), send: vi.fn(), log: vi.fn() })
const plan: CascadePlan = {
  suppressed: [],
  steps: [
    { layer: 'template', decision: { kind: 'tool', tool, args: {}, source: 'template', render: {}, label: 'first' }, onFailure: { action: 'continue' } },
    { layer: 'scenario', decision: { kind: 'tool', tool, args: {}, source: 'scenario', render: {}, label: 'second' }, onFailure: { action: 'continue' } },
  ],
}

describe('route dispatch fallback', () => {
  it.each([
    ['API error envelope', async () => '{"error":"request failed"}'],
    ['HTTP-style failure envelope', async () => '{"ok":false,"message":"request failed"}'],
    ['empty payload', async () => '  '],
    ['CLI crash', async () => 'Error: process crashed'],
    ['rejected request', async () => { throw new Error('request failed') }],
    ['timeout', () => new Promise<string>(() => {})],
  ])('%s goes straight to LLM, without trying another routing layer', async (_name, dispatch) => {
    const mocked = vi.fn(dispatch)
    const input = ctx()
    expect(await executeRoutePlan(plan, input, { engine, dispatch: mocked, dispatchTimeoutMs: 10, persistAssistantMessage: vi.fn() })).toBe(false)
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(input.send).not.toHaveBeenCalled()
  })

  it('unavailable spill falls back without trying another layer', async () => {
    const mocked = vi.fn(async () => '{"type":"large_output","file":"missing"}')
    const input = ctx()
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: mocked, rehydrate: () => null, persistAssistantMessage: vi.fn(),
    })).toBe(false)
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(input.send).not.toHaveBeenCalled()
  })

  it('a rehydrated error also falls back', async () => {
    const mocked = vi.fn(async () => '{"type":"large_output","file":"missing"}')
    const input = ctx()
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: mocked, rehydrate: () => '{"error":"cached request failed"}', persistAssistantMessage: vi.fn(),
    })).toBe(false)
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(input.send).not.toHaveBeenCalled()
  })

  it('a valid empty result still counts as an answer', async () => {
    const mocked = vi.fn(async () => '{"items":[]}')
    const input = ctx()
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: mocked, persistAssistantMessage: vi.fn(),
    })).toBe(true)
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(input.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta', content: '未查询到相关数据。' }))
  })

  it('categorizes a tool timeout before routing can render it', async () => {
    const outcome = await dispatchOnce({ dispatch: () => new Promise<string>(() => {}), workId: 'work-1', tool, timeoutMs: 10 })
    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' })
  })
})
