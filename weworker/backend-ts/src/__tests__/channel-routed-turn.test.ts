/**
 * 渠道入口（runChannelChat）接入智能路由的接线约束。
 *
 * 覆盖三件必须成立的事：
 * 1. 命中确定性路由时**不再**跑模型回合，且把带 `routeTool` 的 timing 交回调用方落库
 *    （各渠道都是「返回 text/timing，由自己 appendMessage」，所以来源必须经这里传出去）；
 * 2. 专属 Agent 的渠道回合不接入路由（它绑定单一站点，路由可能换成别站作答）；
 * 3. 拿不到本轮用户正文时不路由（漏判免费）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tryRoutedTurn: vi.fn(),
  streamChat: vi.fn(),
}))

// 路由引擎本身不在这里测（routed-turn.test.ts 覆盖），只桩掉 API 免得加载全部配置。
vi.mock('../api-query-router/index.js', () => ({ tryIntelligentQueryRoute: vi.fn() }))

vi.mock('../routed-turn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routed-turn.js')>()
  return { ...actual, tryRoutedTurn: mocks.tryRoutedTurn }
})

vi.mock('../agent.js', () => ({ streamChat: mocks.streamChat }))

import type { Message } from '../works-store.js'
import { runChannelChat } from '../channels/channel-manager.js'

function message(role: string, text: string, workId = 'work-1'): Message {
  return {
    id: `${role}-${text}`,
    work_id: workId,
    role,
    content: [{ type: 'text', text }],
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

const settings = {} as never

describe('runChannelChat 的路由接线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text_delta', content: '模型回答' }
    })
    mocks.tryRoutedTurn.mockResolvedValue({ handled: false, text: '', timing: null, directRoute: { status: 'miss' } })
  })

  it('命中路由时跳过模型回合，并交回带 routeTool 的 timing', async () => {
    mocks.tryRoutedTurn.mockResolvedValue({
      handled: true,
      text: '| 名称 | 状态 |',
      timing: { totalMs: 42, llmMs: 0, execMs: 40, steps: 1, routeTool: 'example.com.list' },
    })
    const messages = [message('user', '上一问'), message('assistant', '上一答'), message('user', '示例 仓库列表')]

    const result = await runChannelChat(messages, settings, { channelPermissionMode: 'full' })

    expect(result.text).toBe('| 名称 | 状态 |')
    expect(result.timing).toEqual({
      type: 'timing',
      totalMs: 42,
      llmMs: 0,
      execMs: 40,
      steps: 1,
      routeTool: 'example.com.list',
    })
    expect(result.images).toEqual([])
    expect(result.toolCalls).toEqual([])
    // 关键：路由命中后不再为这一轮付模型成本。
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('把当前消息、历史、workId 与权限级别透传给共享入口', async () => {
    const messages = [message('user', '上一问'), message('assistant', '上一答'), message('user', '  示例 仓库列表 ')]

    await runChannelChat(messages, settings, { channelPermissionMode: 'qa_only' })

    const input = mocks.tryRoutedTurn.mock.calls[0][0]
    expect(input).toMatchObject({
      message: '示例 仓库列表',
      workId: 'work-1',
      persist: false,
      channelPermissionMode: 'qa_only',
    })
    // 追问闸门要「本轮之前」的历史：当前 user 消息必须被裁掉，否则闸门永远看不到回指对象。
    expect(input.history).toEqual(messages.slice(0, 2))
  })

  it('未命中时照常跑模型回合', async () => {
    const messages = [message('user', '解释一下这个问题')]

    const result = await runChannelChat(messages, settings, { channelPermissionMode: 'full' })

    expect(result.text).toBe('模型回答')
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(mocks.streamChat.mock.calls[0][3].directRoute).toEqual({ status: 'miss' })
  })

  it('专属 Agent 的渠道回合不接入路由', async () => {
    const messages = [message('user', '示例 仓库列表')]

    await runChannelChat(messages, settings, { channelPermissionMode: 'full', dedicatedAgent: true })

    expect(mocks.tryRoutedTurn).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    expect(mocks.streamChat.mock.calls[0][3].directRoute).toEqual({ status: 'skipped', reason: 'dedicated_agent' })
  })

  it('本轮没有用户正文时不路由', async () => {
    const messages = [message('user', '问'), message('assistant', '答')]

    await runChannelChat(messages, settings, { channelPermissionMode: 'full' })

    expect(mocks.tryRoutedTurn).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
  })
})
