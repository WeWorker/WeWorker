import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'

const fixture = vi.hoisted(() => ({ state: {} as Settings, failSave: false, notifications: [] as unknown[], turns: vi.fn() }))
vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(),
  getSettings: () => fixture.state,
  updateSettings: (updates: Partial<Settings>) => {
    if (fixture.failSave) throw new Error('fixture disk failure')
    fixture.state = { ...fixture.state, ...updates }
    return fixture.state
  },
}))
vi.mock('../agent.js', () => ({ streamChat: fixture.turns }))
vi.mock('../tools.js', () => ({ resolveToolDisplayName: () => 'fixture tool' }))
vi.mock('../routed-turn.js', () => ({ historyBeforeLastUser: () => [], tryRoutedTurn: vi.fn() }))
vi.mock('../works-store.js', () => ({ saveChannelNotifyTarget: (...args: unknown[]) => fixture.notifications.push(args) }))

import { changeChannelConfiguration, emptyChannel, type ChannelType } from '../channels/channel-configurations.js'
import { WecomChannel, createDefaultWecomProfile } from '../channels/wecom-channel.js'

const identity = { enabled: true, bot_id: 'fixture-bot', secret: 'fixture-secret' }
let profileId: string
function apply(action: string, id?: string, config = {}) {
  const change = changeChannelConfiguration(fixture.state, 'wecom', action, id, config)
  fixture.state = { ...fixture.state, ...change.updates }
  return change.id
}
function connection(config = identity) {
  const replies: string[] = []
  const channel = new WecomChannel(config)
  ;(channel as any)._send = (frame: any) => { replies.push(frame.body.stream.content) }
  return {
    replies,
    send: (text: string, userId = 'fixture-owner', chatType = 'single') => (channel as any)._onMessage({
      headers: { req_id: 'fixture-request' },
      body: { from: { userid: userId }, chattype: chatType, chatid: 'fixture-chat', msgtype: 'text', text: { content: text } },
    }),
  }
}
beforeEach(() => {
  fixture.failSave = false
  fixture.notifications = []
  fixture.turns.mockClear()
  fixture.state = { channels: Object.fromEntries(['qq', 'weixin', 'wecom', 'feishu'].map(type => [type, emptyChannel(type as ChannelType)])) } as unknown as Settings
  profileId = apply('add')
  apply('save', profileId, identity)
})
afterEach(() => vi.useRealTimers())

it('binds the authenticated sender, consumes the code and records a notification target without an AI turn', async () => {
  const bot = connection()
  const code = fixture.state.channels.wecom.pairing_code
  await bot.send(`绑定 ${code}`, 'fixture-owner')
  expect(fixture.state.channels.wecom).toMatchObject({ owner_user_id: 'fixture-owner', pairing_code: '' })
  expect(fixture.state.channel_configurations![profileId].config).toMatchObject({ owner_user_id: 'fixture-owner', pairing_code: '' })
  expect(bot.replies[0]).toContain('绑定成功')
  expect(fixture.turns).not.toHaveBeenCalled()
  expect(fixture.notifications).toEqual([['wecom', 'fixture-owner', { chat_type: '1', user_id: 'fixture-owner' }]])
  await bot.send(`绑定 ${code}`, 'fixture-stranger')
  expect(fixture.state.channels.wecom.owner_user_id).toBe('fixture-owner')
  expect(bot.replies[1]).toContain('已绑定')
})

it('handles help and invalid binding commands in code, without revealing the code or running a model', async () => {
  const bot = connection()
  for (const command of ['绑定', '/bind', '绑定 000000']) await bot.send(command)
  expect(bot.replies).toHaveLength(3)
  expect(bot.replies.every(reply => reply.includes('绑定码'))).toBe(true)
  expect(bot.replies.join('')).not.toContain(fixture.state.channels.wecom.pairing_code)
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
  expect(fixture.turns).not.toHaveBeenCalled()
})

it('requires a private message and preserves normal guest and owner permission levels', async () => {
  const bot = connection()
  await bot.send(`绑定 ${fixture.state.channels.wecom.pairing_code}`, 'fixture-owner', 'group')
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
  expect(bot.replies[0]).toContain('私聊')
  const profile = createDefaultWecomProfile(identity)
  expect(profile.authorize('fixture-guest', 'hello')).toEqual({ kind: 'allow', mode: 'qa_only' })
  await bot.send(`绑定 ${fixture.state.channels.wecom.pairing_code}`)
  apply('save', profileId, { owner_permission_level: 'no_bash' })
  expect(profile.authorize('fixture-owner', 'hello')).toEqual({ kind: 'allow', mode: 'no_bash' })
  expect(profile.authorize('fixture-guest', 'hello')).toEqual({ kind: 'allow', mode: 'qa_only' })
})

it('locks a sender after five wrong codes, then allows pairing after the lock expires', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const bot = connection()
  for (let n = 0; n < 5; n++) await bot.send('绑定 000000')
  const command = `绑定 ${fixture.state.channels.wecom.pairing_code}`
  await bot.send(command)
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
  expect(bot.replies.at(-1)).toContain('10 分钟')
  vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
  await bot.send(command)
  expect(fixture.state.channels.wecom.owner_user_id).toBe('fixture-owner')
})

it('rejects an old socket after switching robots and cannot bind an inactive profile', async () => {
  const old = connection()
  const oldCode = fixture.state.channels.wecom.pairing_code
  const otherId = apply('add')
  apply('save', otherId, { ...identity, bot_id: 'fixture-other-bot' })
  await old.send(`绑定 ${fixture.state.channels.wecom.pairing_code}`)
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
  expect(fixture.state.channel_configurations![profileId].config.owner_user_id).toBe('')
  const current = connection({ ...identity, bot_id: 'fixture-other-bot' })
  // Use an explicitly wrong old code even in the unlikely event of a random collision.
  if (oldCode === fixture.state.channels.wecom.pairing_code) apply('re-pair', otherId)
  await current.send(`绑定 ${oldCode}`)
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
})

it('keeps a stored code across reconnects and invalidates it on re-pair', async () => {
  const previous = fixture.state.channels.wecom.pairing_code
  await connection().send(`绑定 ${previous}`)
  apply('re-pair', profileId)
  const currentCode = fixture.state.channels.wecom.pairing_code
  const bot = connection()
  await bot.send(`绑定 ${previous}`, 'fixture-next-owner')
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
  await bot.send(`绑定 ${currentCode}`, 'fixture-next-owner')
  expect(fixture.state.channels.wecom.owner_user_id).toBe('fixture-next-owner')
})

it('does not announce success or save a notification recipient when persistence fails', async () => {
  fixture.failSave = true
  const bot = connection()
  await bot.send(`绑定 ${fixture.state.channels.wecom.pairing_code}`)
  expect(bot.replies[0]).toContain('失败')
  expect(fixture.state.channels.wecom.owner_user_id).toBe('')
  expect(fixture.notifications).toEqual([])
})
