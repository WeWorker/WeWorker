import { describe, expect, it, vi } from 'vitest'
import { executeRoutePlan, type RouteEngine } from '../api-query-router/index.js'
import { dispatchOnce, isUnrenderableAnswer } from '../api-query-router/route-dispatch.js'
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
  it('reports sanitized failure context to the Agent without forwarding a raw tool error', async () => {
    const onFallback = vi.fn()
    const input = { ...ctx(), onFallback }
    expect(await executeRoutePlan(plan, input, { engine, dispatch: async () => '{"error":"fixture-private-response"}' })).toBe(false)
    expect(onFallback).toHaveBeenCalledWith({ status: 'failed', reason: 'error_payload' })
    expect(JSON.stringify(onFallback.mock.calls)).not.toContain('fixture-private-response')
  })
  it.each([
    ['API error envelope', async () => '{"error":"request failed"}'],
    ['HTTP-style failure envelope', async () => '{"ok":false,"message":"request failed"}'],
    ['API authentication failure in HTTP 200', async () => '{"code":4001,"msg":"Authentication credentials were not provided.","data":null,"level":"error"}'],
    ['wrapped API authentication failure', async () => '{"result":{"code":4001,"msg":"Authentication credentials were not provided.","data":null},"trace_id":"example-trace"}'],
    ['CLI authentication failure', async () => '{"error":"Authentication credentials were not provided.","code":"FETCH_ERROR","trace_id":"example-trace"}'],
    ['HTTP unauthorized status', async () => '{"status":401,"message":"login required"}'],
    ['login failure without a code', async () => '{"level":"error","msg":"请先登录","data":null}'],
    ['plain-text login failure', async () => '请先登录后重试'],
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

  it('a successful API response with a numeric business code remains routable', async () => {
    const mocked = vi.fn(async () => '{"code":200,"data":{"items":[{"id":"example"}]}}')
    const input = ctx()
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: mocked, persistAssistantMessage: vi.fn(),
    })).toBe(true)
    expect(input.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta', content: expect.stringContaining('example') }))
  })

  it.each([
    ['empty items', '{"items":[]}'],
    ['empty data', '{"code":200,"data":[]}'],
    ['bare empty array', '[]'],
    ['wrapped empty result', '{"result":{"items":[]},"trace_id":"example-trace"}'],
  ])('%s falls back to LLM without emitting an empty-result answer', async (_name, raw) => {
    const mocked = vi.fn(async () => raw)
    const input = ctx()
    const persistAssistantMessage = vi.fn()
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: mocked, persistAssistantMessage,
    })).toBe(false)
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(input.send).not.toHaveBeenCalled()
    expect(persistAssistantMessage).not.toHaveBeenCalled()
  })

  it('falls back when a declarative renderer produces only an empty-result message', () => {
    expect(isUnrenderableAnswer('### 查询结果\n\n未查询到相关数据。')).toBe(true)
    expect(isUnrenderableAnswer('### 查询结果\n\n（无数据）')).toBe(true)
    expect(isUnrenderableAnswer('### 查询结果\n\n未查询到相关数据。\n\n### 其它结果\n\n| 名称 |\n| --- |\n| 示例 |')).toBe(false)
  })

  it('categorizes a tool timeout before routing can render it', async () => {
    const outcome = await dispatchOnce({ dispatch: () => new Promise<string>(() => {}), workId: 'work-1', tool, timeoutMs: 10 })
    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' })
  })
})
