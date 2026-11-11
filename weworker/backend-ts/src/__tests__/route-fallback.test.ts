import { describe, expect, it, vi } from 'vitest'
import { executeRoutePlan, type RouteEngine } from '../api-query-router/index.js'
import { classifyDispatchPayload, dispatchOnce, isUnrenderableAnswer } from '../api-query-router/route-dispatch.js'
import { renderGeneric } from '../api-query-router/generic-renderer.js'
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

  it.each([
    ['HTTP 200 auth code', '{"code":401,"msg":"login required","data":null}'],
    ['extension auth code', '{"error":"login required","code":"AUTH_REQUIRED"}'],
    ['wrapped auth error', '{"result":{"code":4001,"msg":"请先登录","data":null},"trace_id":"example-trace"}'],
    ['CLI auth envelope', '{"error":"Authentication credentials were not provided.","code":"FETCH_ERROR"}'],
  ])('%s is diagnosed as authentication and hands off once', async (_name, raw) => {
    const onFallback = vi.fn()
    const dispatch = vi.fn(async () => raw)
    const input = { ...ctx(), onFallback }
    expect(await executeRoutePlan(plan, input, { engine, dispatch })).toBe(false)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledWith({ status: 'failed', reason: 'authentication_required' })
    expect(input.send).not.toHaveBeenCalled()
  })

  it('does not diagnose a successful payload mentioning login as authentication', async () => {
    const input = { ...ctx(), onFallback: vi.fn() }
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: async () => '{"items":[{"note":"login required for another feature"}]}', persistAssistantMessage: vi.fn(),
    })).toBe(true)
    expect(input.onFallback).not.toHaveBeenCalled()
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
    ['empty items without success marker', '{"items":[]}'],
    ['empty data', '{"data":[]}'],
    ['bare empty array', '[]'],
    ['wrapped empty result', '{"result":{"items":[]},"trace_id":"example-trace"}'],
    ['confirmed empty list', '{"ok":true,"items":[]}'],
    ['nested confirmed empty list', '{"success":true,"data":{"items":[],"count":0}}'],
    ['numeric business code with empty data', '{"code":200,"data":[]}'],
  ])('%s renders a friendly no-records answer instead of falling back %s', async (_name, raw) => {
    const input = ctx()
    const persistAssistantMessage = vi.fn()
    expect(classifyDispatchPayload(raw)).toBeNull()
    expect(await executeRoutePlan(plan, input, {
      engine, dispatch: async () => raw, persistAssistantMessage,
    })).toBe(true)
    expect(input.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'text_delta',
      content: expect.stringContaining('经查询，没有符合条件的数据。'),
    }))
    expect(persistAssistantMessage).toHaveBeenCalledTimes(1)
  })

  it('uses the schema emptyMessage instead of the generic wording', async () => {
    const raw = '{"ok":true,"items":[]}'
    const schema = { id: 'example', dataSource: 'items', emptyMessage: '经查询，当前没有待办要处理。' }
    expect(renderGeneric(raw, undefined, { schemaId: 'example' }, { lookupSchema: () => schema }))
      .toBe('经查询，当前没有待办要处理。')
    const input = ctx()
    const schemaEngine = { ...engine, bundle: { renderers: { schemas: { example: schema } } } } as unknown as RouteEngine
    const schemaPlan = { ...plan, steps: [{ ...plan.steps[0], decision: { ...plan.steps[0].decision, render: { schemaId: 'example' } } }] } as CascadePlan
    expect(await executeRoutePlan(schemaPlan, input, { engine: schemaEngine, dispatch: async () => raw, persistAssistantMessage: vi.fn() })).toBe(true)
    expect(input.send).toHaveBeenCalledWith({ type: 'text_delta', content: '经查询，当前没有待办要处理。' })
  })

  it('treats a render with no content as unrenderable but keeps friendly no-records answers', () => {
    expect(isUnrenderableAnswer('')).toBe(true)
    expect(isUnrenderableAnswer('### 查询结果\n\n')).toBe(true)
    expect(isUnrenderableAnswer('### 查询结果\n\n⚠️ 查询失败：request failed')).toBe(true)
    // 空结果话术是有效回答：不能被当成「没答出来」再丢回模型
    expect(isUnrenderableAnswer('经查询，没有符合条件的数据。')).toBe(false)
    expect(isUnrenderableAnswer('### 企业微信会议室\n\n经查询，当前没有符合条件的空闲会议室。')).toBe(false)
    expect(isUnrenderableAnswer('### 查询结果\n\n| 名称 |\n| --- |\n| 示例 |')).toBe(false)
  })

  it.each([
    ['error envelope on top of an empty array', '{"ok":true,"items":[],"error":"request failed"}'],
    ['positive total contradicting an empty array', '{"ok":true,"items":[],"total":3}'],
    ['nested positive total contradicting an empty array', '{"ok":true,"data":{"items":[],"total":2}}'],
  ])('%s still falls back instead of claiming there is no data', async (_name, raw) => {
    const input = ctx()
    expect(classifyDispatchPayload(raw)).not.toBeNull()
    expect(await executeRoutePlan(plan, input, { engine, dispatch: async () => raw, persistAssistantMessage: vi.fn() })).toBe(false)
    expect(input.send).not.toHaveBeenCalled()
  })

  it('categorizes a tool timeout before routing can render it', async () => {
    const outcome = await dispatchOnce({ dispatch: () => new Promise<string>(() => {}), workId: 'work-1', tool, timeoutMs: 10 })
    expect(outcome).toMatchObject({ ok: false, kind: 'timeout' })
  })
})
