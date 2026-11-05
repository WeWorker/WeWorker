/**
 * 智能路由共享入口（routed-turn.ts）的行为约束。
 *
 * 这几条不变量是「定时任务 / 渠道接入路由」的前提，任何一条破掉都会静默出错：
 * - 未命中必须原样落回（调用方照常走 streamChat，行为与接线前一致）；
 * - 命中后才交出正文与 timing，且 timing 必须带 routeTool（否则 UI 与追问闸门都认不出 fast-path）；
 * - `persist: false` 的调用方自己落库，共享入口不得代写（否则同一条回复写两次）；
 * - `qa_only` 渠道回合连路由都不许进（那些回合不注册任何工具，路由等于开了一条模型自己没有的通道）；
 * - 任何异常都只能是「落回」，不能把定时任务或渠道回合打挂。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureWorkLogs, readWorkLog } from '../work-log-file.js'

const mocks = vi.hoisted(() => ({
  tryIntelligentQueryRoute: vi.fn(),
}))

vi.mock('../api-query-router/index.js', () => ({
  tryIntelligentQueryRoute: mocks.tryIntelligentQueryRoute,
}))

import type { Message } from '../works-store.js'
import {
  historyBeforeLastUser,
  lastUserMessageText,
  routedAssistantBlocks,
  tryRoutedTurn,
} from '../routed-turn.js'

function message(role: string, text: string, workId = 'w1'): Message {
  return {
    id: `${role}-${text}`,
    work_id: workId,
    role,
    content: [{ type: 'text', text }],
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

/** 命中时的标准事件序列（与 api-query-router 的 emitRoutedAnswer 同形）。 */
function emitRoutedAnswer(ctx: { send: (event: object) => void }, overrides: Record<string, unknown> = {}): void {
  ctx.send({ type: 'turn_start', turnId: 't1', workId: 'w1' })
  ctx.send({ type: 'text_delta', content: '| 名称 | 状态 |\n| --- | --- |\n| 示例 | 正常 |' })
  ctx.send({
    type: 'turn_end',
    turnId: 't1',
    workId: 'w1',
    totalMs: 42,
    llmMs: 0,
    execMs: 40,
    steps: 1,
    routeTool: 'example.com.list',
    routeSource: 'routes',
    routeArgs: '{"limit":5}',
    ...overrides,
  })
}

const baseInput = {
  message: '示例 仓库列表',
  workId: 'w1',
  chatStartTime: 1000,
}

describe('tryRoutedTurn', () => {
  it('records routed output immediately even when no model stream is used', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routed-log-'))
    configureWorkLogs(directory)
    try {
      mocks.tryIntelligentQueryRoute.mockImplementation(async (ctx: { send: (event: object) => void }) => {
        emitRoutedAnswer(ctx)
        return true
      })
      await tryRoutedTurn(baseInput)
      const text = readWorkLog({ id: baseInput.workId, messages: [] })
      expect(text).toContain('route_input')
      expect(text).toContain('示例 仓库列表')
      expect(text).toContain('| 示例 | 正常 |')
      expect(text).toContain('example.com.list')
    } finally {
      configureWorkLogs(undefined)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('distinguishes direct misses from failures for the Agent handoff', async () => {
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)
    expect((await tryRoutedTurn(baseInput)).directRoute).toEqual({ status: 'miss' })
    mocks.tryIntelligentQueryRoute.mockImplementation(async (ctx) => {
      ctx.onFallback?.({ status: 'failed', reason: 'timeout' })
      return false
    })
    expect((await tryRoutedTurn(baseInput)).directRoute).toEqual({ status: 'failed', reason: 'timeout' })
  })

  it('未命中时原样落回，不留半成品', async () => {
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)

    const result = await tryRoutedTurn({ ...baseInput })

    expect(result).toEqual({ handled: false, text: '', timing: null, directRoute: { status: 'miss' } })
  })

  it('命中时交出正文与带 routeTool 的 timing', async () => {
    mocks.tryIntelligentQueryRoute.mockImplementation(async (ctx: { send: (event: object) => void }) => {
      emitRoutedAnswer(ctx)
      return true
    })
    const onEvent = vi.fn()

    const result = await tryRoutedTurn({ ...baseInput, onEvent })

    expect(result.handled).toBe(true)
    expect(result.text).toContain('| 示例 | 正常 |')
    expect(result.timing).toEqual({
      totalMs: 42,
      llmMs: 0,
      execMs: 40,
      steps: 1,
      routeTool: 'example.com.list',
      routeSource: 'routes',
      routeArgs: '{"limit":5}',
    })
    // 事件仍原样转发给调用方（桌面端 SSE / 渠道流式推送都靠它）。
    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_end', routeTool: 'example.com.list' }))
  })

  it('turn_end 缺 routeTool 时不给 timing（不伪造来源）', async () => {
    mocks.tryIntelligentQueryRoute.mockImplementation(async (ctx: { send: (event: object) => void }) => {
      emitRoutedAnswer(ctx, { routeTool: undefined })
      return true
    })

    const result = await tryRoutedTurn({ ...baseInput })

    expect(result.handled).toBe(true)
    expect(result.timing).toBeNull()
  })

  it('persist=false 时顶掉默认落库，由调用方自己写', async () => {
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)

    await tryRoutedTurn({ ...baseInput })
    const deps = mocks.tryIntelligentQueryRoute.mock.calls[0][1] as Record<string, unknown>
    expect(typeof deps.persistAssistantMessage).toBe('function')

    vi.clearAllMocks()
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)
    await tryRoutedTurn({ ...baseInput, persist: true })
    // 桌面端保持既有行为：不传 persistAssistantMessage，路由层自己 store.appendMessage。
    expect(mocks.tryIntelligentQueryRoute.mock.calls[0][1]).toEqual({})
  })

  it('qa_only 渠道回合不进入路由', async () => {
    const log = vi.fn()

    const result = await tryRoutedTurn({ ...baseInput, channelPermissionMode: 'qa_only', log })

    expect(result).toEqual({ handled: false, text: '', timing: null, directRoute: { status: 'skipped', reason: 'qa_only' } })
    expect(mocks.tryIntelligentQueryRoute).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('qa_only'))
  })

  it.each(['full', 'no_bash'] as const)('%s 渠道回合允许路由', async (mode) => {
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)

    await tryRoutedTurn({ ...baseInput, channelPermissionMode: mode })

    expect(mocks.tryIntelligentQueryRoute).toHaveBeenCalledTimes(1)
  })

  it('空消息不进入路由', async () => {
    expect(await tryRoutedTurn({ ...baseInput, message: '   ' })).toEqual({ handled: false, text: '', timing: null, directRoute: { status: 'skipped', reason: 'no_text' } })
    expect(mocks.tryIntelligentQueryRoute).not.toHaveBeenCalled()
  })

  it('路由内部抛错时安全落回，不把回合打挂', async () => {
    mocks.tryIntelligentQueryRoute.mockRejectedValue(new Error('engine boom'))
    const log = vi.fn()

    const result = await tryRoutedTurn({ ...baseInput, log })

    expect(result).toEqual({ handled: false, text: '', timing: null, directRoute: { status: 'failed', reason: 'direct_route_error' } })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('engine boom'))
  })

  it('把 message / workId / history / 日志原样透传给级联', async () => {
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)
    const log = vi.fn()
    const history = [message('user', '上一问'), message('assistant', '上一答')]

    await tryRoutedTurn({ ...baseInput, history, log, turnId: 'turn-9' })

    const ctx = mocks.tryIntelligentQueryRoute.mock.calls[0][0] as Record<string, unknown>
    expect(ctx).toMatchObject({
      message: '示例 仓库列表',
      workId: 'w1',
      turnId: 'turn-9',
      chatStartTime: 1000,
      history,
      log,
    })
    expect(typeof ctx.send).toBe('function')
  })

  it('未指定 turnId 时自行生成，避免日志无法关联', async () => {
    mocks.tryIntelligentQueryRoute.mockResolvedValue(false)

    await tryRoutedTurn({ ...baseInput })

    const ctx = mocks.tryIntelligentQueryRoute.mock.calls[0][0] as { turnId: string }
    expect(ctx.turnId).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('routedAssistantBlocks', () => {
  it('产出「正文 + 带 routeTool 的 timing」两块，供非持久化调用方落库', () => {
    const blocks = routedAssistantBlocks({
      handled: true,
      text: '答案',
      timing: { totalMs: 1, llmMs: 0, execMs: 1, steps: 1, routeTool: 'example.com.list' },
    })

    expect(blocks).toEqual([
      { type: 'text', text: '答案' },
      { type: 'timing', totalMs: 1, llmMs: 0, execMs: 1, steps: 1, routeTool: 'example.com.list' },
    ])
  })

  it('未命中不产出任何块', () => {
    expect(routedAssistantBlocks({ handled: false, text: '', timing: null })).toEqual([])
  })
})

describe('historyBeforeLastUser', () => {
  it('裁掉尾部当前 user 消息，交给追问闸门', () => {
    const messages = [message('user', '第一问'), message('assistant', '答'), message('user', '第二问')]
    expect(historyBeforeLastUser(messages)).toEqual(messages.slice(0, 2))
  })

  it('尾部不是 user 消息时原样返回', () => {
    const messages = [message('user', '问'), message('assistant', '答')]
    expect(historyBeforeLastUser(messages)).toEqual(messages)
  })

  it('空历史返回 undefined', () => {
    expect(historyBeforeLastUser([])).toBeUndefined()
    expect(historyBeforeLastUser(undefined)).toBeUndefined()
  })
})

describe('lastUserMessageText', () => {
  it('取最后一条 user 消息的正文', () => {
    const messages = [message('user', '旧'), message('assistant', '答'), message('user', '  新问题  ')]
    expect(lastUserMessageText(messages)).toBe('新问题')
  })

  it('尾部是纯附件消息时返回空串，绝不回溯上一轮问题', () => {
    // 回溯会把「上一轮的问题」当成这一轮去路由：用户发的是附件，却收到上一条的答案。
    const messages: Message[] = [
      message('user', '上一轮的问题'),
      message('assistant', '上一轮的答案'),
      {
        id: 'att',
        work_id: 'w1',
        role: 'user',
        content: [{ type: 'file_attachment', name: 'a.txt', path: '/tmp/a.txt' }],
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    expect(lastUserMessageText(messages)).toBe('')
  })

  it('尾部不是 user 消息时返回空串', () => {
    expect(lastUserMessageText([message('user', '问'), message('assistant', '答')])).toBe('')
  })

  it('没有可用正文时返回空串', () => {
    expect(lastUserMessageText([])).toBe('')
    expect(lastUserMessageText(undefined)).toBe('')
  })
})
