import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event?: unknown) => void>()
  const sdk = {
    on: vi.fn((event: string, handler: (event?: unknown) => void) => handlers.set(event, handler)),
    connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
    rawWsClient: { close: vi.fn() },
  }
  return {
    handlers, sdk, createLarkChannel: vi.fn(() => sdk),
    settings: { api_key: 'fixture-model-key' },
    runChannelChat: vi.fn(), getChannelPermissionMode: vi.fn(),
    getLatestChannelNotifyTarget: vi.fn(), saveChannelNotifyTarget: vi.fn(),
    getOrCreateChannelWork: vi.fn(), appendMessage: vi.fn(), markExternalWrite: vi.fn(),
    resetChannelWork: vi.fn(), updateTitle: vi.fn(), getWorkWithMessages: vi.fn(),
    generateTitle: vi.fn(), generateTitleWithLLM: vi.fn(), logError: vi.fn(),
  }
})

vi.mock('@larksuiteoapi/node-sdk', () => ({ createLarkChannel: mocks.createLarkChannel }))
vi.mock('../channels/channel-manager.js', () => ({ runChannelChat: mocks.runChannelChat }))
vi.mock('../channels/channel-permissions.js', () => ({
  CHANNEL_MYID_HINT: 'fixture owner configuration hint',
  CHANNEL_EMPTY_REPLY_FALLBACK: 'fixture empty reply',
  getChannelPermissionMode: mocks.getChannelPermissionMode,
}))
vi.mock('../config.js', () => ({ getSettings: () => mocks.settings }))
vi.mock('../title-utils.js', () => ({ generateTitle: mocks.generateTitle, generateTitleWithLLM: mocks.generateTitleWithLLM }))
vi.mock('../works-store.js', () => ({
  getLatestChannelNotifyTarget: mocks.getLatestChannelNotifyTarget,
  saveChannelNotifyTarget: mocks.saveChannelNotifyTarget,
  getOrCreateChannelWork: mocks.getOrCreateChannelWork,
  appendMessage: mocks.appendMessage, markExternalWrite: mocks.markExternalWrite,
  resetChannelWork: mocks.resetChannelWork, updateTitle: mocks.updateTitle,
  getWorkWithMessages: mocks.getWorkWithMessages,
}))
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: mocks.logError }) }))

import { FeishuChannel } from '../channels/feishu-channel.js'

const config = { enabled: true, app_id: 'fixture-feishu-app', app_secret: 'fixture-feishu-secret' }
const incoming = (content: string) => ({
  chatId: 'fixture-chat', senderId: 'fixture-user', messageId: 'fixture-message', chatType: 'private', content,
})
const emit = (event: string, value?: unknown) => mocks.handlers.get(event)?.(value)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.createLarkChannel.mockReturnValue(mocks.sdk)
  mocks.settings.api_key = 'fixture-model-key'
  mocks.sdk.connect.mockResolvedValue(undefined)
  mocks.sdk.disconnect.mockResolvedValue(undefined)
  mocks.sdk.send.mockResolvedValue(undefined)
  mocks.sdk.rawWsClient.close.mockReset()
  mocks.getLatestChannelNotifyTarget.mockReturnValue(null)
  mocks.getOrCreateChannelWork.mockReturnValue({ work: { id: 'fixture-work', title: 'Saved conversation' } })
  mocks.getWorkWithMessages.mockReturnValue({ messages: [{ role: 'user', content: 'fixture question' }] })
  mocks.getChannelPermissionMode.mockReturnValue('qa_only')
  mocks.runChannelChat.mockResolvedValue({ text: 'fixture model answer', images: [], toolCalls: [], timing: null })
  mocks.generateTitle.mockReturnValue('fixture title')
  mocks.generateTitleWithLLM.mockResolvedValue(null)
})

describe('Feishu channel lifecycle', () => {
  it('connects using the configured application and reports success', async () => {
    const channel = new FeishuChannel(config)
    expect(channel.getStatus()).toEqual({ status: 'starting' })
    await channel.start()
    expect(mocks.createLarkChannel).toHaveBeenCalledWith({
      appId: config.app_id, appSecret: config.app_secret, transport: 'websocket',
      policy: { dmMode: 'open', requireMention: true }, source: 'weworker',
    })
    expect(mocks.sdk.connect).toHaveBeenCalledOnce()
    expect(channel.getStatus()).toEqual({ status: 'connected' })
  })

  it('propagates connection failures and exposes the error status', async () => {
    mocks.sdk.connect.mockRejectedValueOnce(new Error('fixture connection failure'))
    const channel = new FeishuChannel(config)
    await expect(channel.start()).rejects.toThrow('fixture connection failure')
    expect(channel.getStatus()).toEqual({ status: 'error', error: 'fixture connection failure' })
  })

  it('tracks reconnect events and prevents late events from reviving a stopped channel', async () => {
    const channel = new FeishuChannel(config)
    await channel.start()
    emit('reconnecting')
    expect(channel.getStatus()).toEqual({ status: 'starting' })
    emit('reconnected')
    expect(channel.getStatus()).toEqual({ status: 'connected' })
    emit('error', new Error('fixture stream failure'))
    expect(channel.getStatus()).toEqual({ status: 'error', error: 'fixture stream failure' })
    await channel.stop()
    expect(mocks.sdk.disconnect).toHaveBeenCalledOnce()
    emit('reconnecting')
    emit('reconnected')
    expect(channel.getStatus()).toEqual({ status: 'error', error: 'stopped' })
  })

  it('finishes stopping when the SDK disconnect rejects', async () => {
    const channel = new FeishuChannel(config)
    await channel.start()
    mocks.sdk.disconnect.mockRejectedValueOnce(new Error('fixture disconnect failure'))
    await expect(channel.stop()).resolves.toBeUndefined()
    expect(channel.getStatus()).toEqual({ status: 'error', error: 'stopped' })
  })

  it('closes a connection that finishes after stop even when the first disconnect was a no-op', async () => {
    let finishConnection!: () => void
    let connected = false
    let transportOpen = false
    mocks.sdk.connect.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishConnection = () => { connected = true; transportOpen = true; resolve() }
    }))
    // The SDK does not disconnect a channel until its handshake has completed.
    mocks.sdk.disconnect.mockImplementation(async () => {
      if (connected) { connected = false; transportOpen = false }
    })
    mocks.sdk.rawWsClient.close.mockImplementation(() => { transportOpen = false })
    const channel = new FeishuChannel(config)
    const starting = channel.start()
    await channel.stop()
    finishConnection()
    await starting
    expect(transportOpen).toBe(false)
    expect(connected).toBe(false)
    expect(channel.getStatus()).toEqual({ status: 'error', error: 'stopped' })
  })

  it('releases the reconnecting transport after the initial handshake fails', async () => {
    let reconnecting = true
    mocks.sdk.connect.mockRejectedValueOnce(new Error('fixture handshake failure'))
    mocks.sdk.rawWsClient.close.mockImplementation(() => { reconnecting = false })
    const channel = new FeishuChannel(config)
    await expect(channel.start()).rejects.toThrow('fixture handshake failure')
    expect(reconnecting).toBe(false)
    expect(mocks.sdk.rawWsClient.close).toHaveBeenCalledWith({ force: true })
    emit('message', incoming('fixture late message'))
    expect(mocks.saveChannelNotifyTarget).not.toHaveBeenCalled()
  })

  it('ignores incoming messages after the channel is stopped', async () => {
    const channel = new FeishuChannel(config)
    await channel.start()
    await channel.stop()
    emit('message', incoming('fixture late message'))
    expect(mocks.saveChannelNotifyTarget).not.toHaveBeenCalled()
    expect(mocks.appendMessage).not.toHaveBeenCalled()
    expect(mocks.runChannelChat).not.toHaveBeenCalled()
  })

  it('ignores old instance events after restarting with a new connection', async () => {
    const channel = new FeishuChannel(config)
    await channel.start()
    const oldHandlers = new Map(mocks.handlers)
    await channel.stop()
    const replacement = { ...mocks.sdk, rawWsClient: { close: vi.fn() } }
    mocks.createLarkChannel.mockReturnValueOnce(replacement)
    await channel.start()
    oldHandlers.get('message')?.(incoming('fixture old connection message'))
    oldHandlers.get('reconnecting')?.()
    oldHandlers.get('error')?.(new Error('fixture old connection error'))
    expect(channel.getStatus()).toEqual({ status: 'connected' })
    expect(mocks.saveChannelNotifyTarget).not.toHaveBeenCalled()
    emit('reconnecting')
    oldHandlers.get('reconnected')?.()
    expect(channel.getStatus()).toEqual({ status: 'starting' })
  })

  it.each(['success', 'failure'])('cleans up late startup %s without changing the replacement connection', async outcome => {
    let resolveConnection!: () => void
    let rejectConnection!: (error: Error) => void
    mocks.sdk.connect.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      resolveConnection = resolve
      rejectConnection = reject
    }))
    const channel = new FeishuChannel(config)
    const firstStart = channel.start()
    const settled = firstStart.catch(error => error)
    await channel.stop()
    const replacement = {
      ...mocks.sdk,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      rawWsClient: { close: vi.fn() },
    }
    mocks.createLarkChannel.mockReturnValueOnce(replacement)
    await channel.start()
    mocks.sdk.rawWsClient.close.mockClear()
    if (outcome === 'success') resolveConnection()
    else rejectConnection(new Error('fixture stale failure'))
    await settled
    expect(mocks.sdk.rawWsClient.close).toHaveBeenCalledWith({ force: true })
    expect(replacement.disconnect).not.toHaveBeenCalled()
    expect(replacement.rawWsClient.close).not.toHaveBeenCalled()
    expect(channel.getStatus()).toEqual({ status: 'connected' })
  })
})

describe('Feishu notifications', () => {
  it('requires a target conversation and an active connection', async () => {
    const channel = new FeishuChannel(config)
    await channel.start()
    await expect(channel.sendNotification('fixture notification')).rejects.toThrow('没有可用的飞书会话')
    mocks.getLatestChannelNotifyTarget.mockReturnValue({ user_id: 'fixture-saved-chat' })
    const saved = new FeishuChannel(config)
    await saved.start()
    emit('reconnecting')
    await expect(saved.sendNotification('fixture notification')).rejects.toThrow('飞书长连接未连接')
    await saved.stop()
    await expect(saved.sendNotification('fixture notification')).rejects.toThrow('飞书长连接未连接')
    expect(mocks.sdk.send).not.toHaveBeenCalled()
  })

  it('restores the saved target, chunks long notifications and persists the complete text', async () => {
    mocks.getLatestChannelNotifyTarget.mockReturnValue({ user_id: 'fixture-saved-chat' })
    const channel = new FeishuChannel(config)
    await channel.start()
    const text = 'a'.repeat(4001)
    await channel.sendNotification(text)
    expect(mocks.sdk.send).toHaveBeenNthCalledWith(1, 'fixture-saved-chat', { markdown: 'a'.repeat(4000) })
    expect(mocks.sdk.send).toHaveBeenNthCalledWith(2, 'fixture-saved-chat', { markdown: 'a' })
    expect(mocks.appendMessage).toHaveBeenCalledWith('fixture-work', 'assistant', [{ type: 'text', text }])
    expect(mocks.markExternalWrite).toHaveBeenCalledOnce()
  })
})

describe('Feishu incoming messages', () => {
  it('answers /myid without requiring model credentials or starting a model turn', async () => {
    mocks.settings.api_key = ''
    const channel = new FeishuChannel(config)
    await channel.start()
    emit('message', incoming('/myid'))
    await vi.waitFor(() => expect(mocks.sdk.send).toHaveBeenCalledWith('fixture-chat',
      { markdown: '你的用户 ID：fixture-user\nfixture owner configuration hint' }, { replyTo: 'fixture-message' }))
    expect(mocks.saveChannelNotifyTarget).toHaveBeenCalledWith('feishu', 'fixture-chat', { user_id: 'fixture-user', chat_type: 'private' })
    expect(mocks.runChannelChat).not.toHaveBeenCalled()
    expect(mocks.getOrCreateChannelWork).not.toHaveBeenCalled()
  })

  it('explains missing API key configuration without persisting a chat turn', async () => {
    mocks.settings.api_key = ''
    const channel = new FeishuChannel(config)
    await channel.start()
    emit('message', incoming('fixture question'))
    await vi.waitFor(() => expect(mocks.sdk.send).toHaveBeenCalledWith('fixture-chat',
      { markdown: 'WeWorker 尚未配置 API Key，请在设置中配置后重试。' }, { replyTo: 'fixture-message' }))
    expect(mocks.runChannelChat).not.toHaveBeenCalled()
    expect(mocks.appendMessage).not.toHaveBeenCalled()
  })

  it('runs configured messages with scoped permissions, stores the exchange and replies', async () => {
    const channel = new FeishuChannel(config)
    await channel.start()
    emit('message', incoming(' fixture question '))
    await vi.waitFor(() => expect(mocks.sdk.send).toHaveBeenCalledWith('fixture-chat',
      { markdown: 'fixture model answer' }, { replyTo: 'fixture-message' }))
    expect(mocks.getChannelPermissionMode).toHaveBeenCalledWith('feishu', 'fixture-user')
    expect(mocks.runChannelChat).toHaveBeenCalledWith(mocks.getWorkWithMessages().messages, mocks.settings, {
      workId: 'fixture-work',
      channelPermissionMode: 'qa_only', memoryScope: { user: 'feishu:fixture-user' }, askUserHandler: expect.any(Function),
      // Feishu replies with text only, so image tools must report they cannot deliver here.
      sendsImages: false,
    })
    expect(mocks.appendMessage).toHaveBeenNthCalledWith(1, 'fixture-work', 'user', [{ type: 'text', text: 'fixture question' }])
    expect(mocks.appendMessage).toHaveBeenNthCalledWith(2, 'fixture-work', 'assistant', [{ type: 'text', text: 'fixture model answer' }])
  })

  it('returns a model failure to the originating conversation', async () => {
    mocks.runChannelChat.mockRejectedValueOnce(new Error('fixture model failure'))
    const channel = new FeishuChannel(config)
    await channel.start()
    emit('message', incoming('fixture question'))
    await vi.waitFor(() => expect(mocks.sdk.send).toHaveBeenCalledWith('fixture-chat',
      { markdown: '处理失败：fixture model failure' }, { replyTo: 'fixture-message' }))
    expect(mocks.appendMessage).toHaveBeenCalledTimes(1)
  })
})
