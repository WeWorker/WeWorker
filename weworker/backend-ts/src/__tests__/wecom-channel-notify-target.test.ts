/**
 * wecom-channel.ts 入站消息的通知目标记录顺序。
 *
 * 修复的约束：专属 Agent 的配对消息（「绑定 123456」）authorize 返回 reply，
 * 但它就是主人与 Bot 的第一次接触 —— reply 分支也必须把这个会话记录为
 * 「已观察到的通知目标」，否则快速创建流程在配对完成后找不到可用的推送目标。
 * 主通道（无 dedicatedAgentId）不记录 reply 消息，保持原有行为。
 *
 * handleMessage 依赖企微长连接，无法整体实例化，这里按仓库既有做法抽取
 * 源码片段在 vm 中执行（见 api-scheduled-tasks.test.ts）。
 */
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

function runMessageGate(input: {
  access: { kind: 'reply' | 'allow'; text?: string }
  dedicatedAgentId?: string
  chatType: 'single' | 'group'
}) {
  const source = fs.readFileSync(new URL('../channels/wecom-channel.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const access = this._profile.authorize')
  const end = source.indexOf('// Commands take priority', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  const saved: Array<{ key: string; id: string; extra: Record<string, string> }> = []
  const replyOnce = vi.fn()
  const context = vm.createContext({
    // `this` of the transpiled top-level statements resolves to the context.
    _profile: {
      channelKey: input.dedicatedAgentId ? `agent:${input.dedicatedAgentId}` : 'wecom',
      dedicatedAgentId: input.dedicatedAgentId,
      authorize: () => input.access,
    },
    _lastUserId: null as string | null,
    _lastChatType: 0,
    store: { saveChannelNotifyTarget: (key: string, id: string, extra: Record<string, string>) => saved.push({ key, id, extra }) },
    replyOnce,
    text: '绑定 123456',
    chatType: input.chatType,
    userId: 'owner-placeholder',
    chatId: 'group-chat-placeholder',
  })
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  // The slice sits inside a method and contains `return`: wrap it in a function
  // bound to the context so `this._profile` resolves like the real handler.
  vm.runInContext(`(function () {\n${code}\n}).call(this)`, context)
  return { saved, replyOnce, context: context as unknown as { _lastUserId: string | null; _lastChatType: number } }
}

describe('wecom inbound notify target recording', () => {
  it('records the pairing chat for dedicated agents even though authorize replies', () => {
    const { saved, replyOnce } = runMessageGate({
      access: { kind: 'reply', text: '✅ 绑定成功' },
      dedicatedAgentId: 'agent-fixture',
      chatType: 'single',
    })
    // The pairing message itself is the owner's direct chat.
    expect(saved).toEqual([{
      key: 'agent:agent-fixture',
      id: 'owner-placeholder',
      extra: { chat_type: '1', user_id: 'owner-placeholder' },
    }])
    expect(replyOnce).toHaveBeenCalledWith('✅ 绑定成功')
  })

  it('records group chats with the group chat id for dedicated agents', () => {
    const { saved } = runMessageGate({
      access: { kind: 'reply', text: '绑定码不正确' },
      dedicatedAgentId: 'agent-fixture',
      chatType: 'group',
    })
    expect(saved).toEqual([{
      key: 'agent:agent-fixture',
      id: 'group-chat-placeholder',
      extra: { chat_type: '2', user_id: 'owner-placeholder' },
    }])
  })

  it('keeps main channels recording reply messages nowhere', () => {
    const { saved } = runMessageGate({ access: { kind: 'reply', text: '请先绑定' }, chatType: 'single' })
    expect(saved).toEqual([])
  })

  it('still records and caches the chat for allowed messages on every channel', () => {
    const { saved, context } = runMessageGate({ access: { kind: 'allow' }, chatType: 'single' })
    expect(saved).toEqual([{ key: 'wecom', id: 'owner-placeholder', extra: { chat_type: '1', user_id: 'owner-placeholder' } }])
    expect(context._lastUserId).toBe('owner-placeholder')
    expect(context._lastChatType).toBe(1)
  })
})
