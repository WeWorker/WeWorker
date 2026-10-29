/**
 * 飞书机器人通道 — 飞书开放平台长连接模式。
 *
 * 使用飞书官方 Node SDK 的 Channel 封装，消息处理和企微通道保持一致：
 * 私聊／群聊、/new、/id、/myid、主人权限、会话持久化和定时通知均复用同一套规则。
 */

import * as Lark from '@larksuiteoapi/node-sdk'

import type { Channel, ChannelStatus } from './channel-manager.js'
import { runChannelChat } from './channel-manager.js'
import { CHANNEL_MYID_HINT, CHANNEL_EMPTY_REPLY_FALLBACK, getChannelPermissionMode } from './channel-permissions.js'
import { getSettings } from '../config.js'
import { generateTitle, generateTitleWithLLM } from '../title-utils.js'
import * as store from '../works-store.js'
import { createLogger } from '../logger.js'

const log = createLogger('feishu')
const MAX_MSG_LEN = 4000

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text]
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += MAX_MSG_LEN) {
    chunks.push(text.slice(index, index + MAX_MSG_LEN))
  }
  return chunks
}

export interface FeishuChannelConfig {
  enabled: boolean
  app_id: string
  app_secret: string
}

export class FeishuChannel implements Channel {
  private readonly _config: FeishuChannelConfig
  private _channel: Lark.LarkChannel | null = null
  private _running = false
  private _status: ChannelStatus = { status: 'starting' }
  private _lastChatId: string | null = null

  constructor(config: FeishuChannelConfig) {
    this._config = config
  }

  getStatus(): ChannelStatus {
    return this._status
  }

  async start(): Promise<void> {
    this._running = true
    this._status = { status: 'starting' }
    const saved = store.getLatestChannelNotifyTarget('feishu')
    this._lastChatId = saved?.user_id || null

    const channel = Lark.createLarkChannel({
      appId: this._config.app_id,
      appSecret: this._config.app_secret,
      transport: 'websocket',
      policy: { dmMode: 'open', requireMention: true },
      source: 'weworker',
    })
    this._channel = channel
    const isCurrent = () => this._running && this._channel === channel
    channel.on('message', (message) => {
      if (!isCurrent()) return
      this._handleMessage(message).catch((error) => {
        log.error('message handling error:', error instanceof Error ? error.message : String(error))
      })
    })
    channel.on('reconnecting', () => {
      if (isCurrent()) this._status = { status: 'starting' }
    })
    channel.on('reconnected', () => {
      if (isCurrent()) this._status = { status: 'connected' }
    })
    channel.on('error', (error) => {
      if (!isCurrent()) return
      this._status = { status: 'error', error: error.message }
      log.error('channel error:', error.message)
    })

    try {
      await channel.connect()
      if (isCurrent()) this._status = { status: 'connected' }
      else await this._disconnect(channel)
    } catch (error) {
      if (isCurrent()) {
        this._running = false
        this._channel = null
        this._status = { status: 'error', error: error instanceof Error ? error.message : String(error) }
      }
      await this._disconnect(channel)
      throw error
    }
  }

  async stop(): Promise<void> {
    const channel = this._channel
    this._running = false
    this._channel = null
    this._status = { status: 'error', error: 'stopped' }
    if (channel) await this._disconnect(channel)
  }

  private async _disconnect(channel: Lark.LarkChannel): Promise<void> {
    // LarkChannel.disconnect() is a no-op before a successful handshake. Close
    // its public transport as well to cancel pending reconnects after failure.
    try {
      channel.rawWsClient?.close({ force: true })
    } catch { /* Still let the channel release its remaining resources. */ }
    await channel.disconnect().catch(() => {})
  }

  async sendNotification(text: string): Promise<void> {
    if (!this._lastChatId) {
      throw new Error('没有可用的飞书会话，无法发送通知（需要用户先跟机器人对话过）')
    }
    if (!this._channel || this._status.status !== 'connected') {
      throw new Error('飞书长连接未连接')
    }
    for (const chunk of splitMessage(text)) {
      await this._channel.send(this._lastChatId, { markdown: chunk })
    }
    try {
      const { work } = store.getOrCreateChannelWork('feishu', this._lastChatId, '')
      store.appendMessage(work.id, 'assistant', [{ type: 'text', text }])
      store.markExternalWrite()
    } catch (error) {
      log.error('failed to persist notification:', error instanceof Error ? error.message : String(error))
    }
  }

  private async _send(chatId: string, content: string, replyTo?: string): Promise<void> {
    if (!this._channel) return
    await this._channel.send(chatId, { markdown: content }, replyTo ? { replyTo } : undefined)
  }

  private async _handleMessage(message: Lark.NormalizedMessage): Promise<void> {
    const chatId = message.chatId
    const userId = message.senderId
    const text = message.content.trim()
    if (!chatId || !userId || !text) return

    this._lastChatId = chatId
    store.saveChannelNotifyTarget('feishu', chatId, { user_id: userId, chat_type: message.chatType })

    const pendingChoice = this._pendingChoices.get(userId)
    if (pendingChoice) {
      this._pendingChoices.delete(userId)
      pendingChoice(text)
      return
    }

    if (text === '/new') {
      store.resetChannelWork('feishu', userId, '')
      await this._send(chatId, '已开启新对话 ✓', message.messageId)
      return
    }
    if (text === '/id') {
      const existing = store.getOrCreateChannelWork('feishu', userId, '')
      await this._send(chatId, `当前对话 ID: ${existing.work.id.slice(0, 8)}`, message.messageId)
      return
    }
    if (text === '/myid') {
      await this._send(chatId, `你的用户 ID：${userId}\n${CHANNEL_MYID_HINT}`, message.messageId)
      return
    }

    const settings = getSettings()
    if (!settings.api_key) {
      await this._send(chatId, 'WeWorker 尚未配置 API Key，请在设置中配置后重试。', message.messageId)
      return
    }

    const { work } = store.getOrCreateChannelWork('feishu', userId, '')
    store.appendMessage(work.id, 'user', [{ type: 'text', text }])
    store.markExternalWrite()
    if (!work.title) {
      store.updateTitle(work.id, `（飞书）${generateTitle(text)}`)
      generateTitleWithLLM(text, settings).then((title) => {
        if (title) {
          store.updateTitle(work.id, `（飞书）${title}`)
          store.markExternalWrite()
        }
      })
    }

    const workWithMessages = store.getWorkWithMessages(work.id)!
    await this._send(chatId, '正在思考...', message.messageId)

    try {
      const result = await runChannelChat(workWithMessages.messages, settings, {
        workId: work.id,
        channelPermissionMode: getChannelPermissionMode('feishu', userId),
        memoryScope: { user: `feishu:${userId}` },
        // This channel sends text only; image tools report that they cannot deliver here.
        sendsImages: false,
        askUserHandler: async (question, options) => {
          const lines = [question]
          options.forEach((option, index) => {
            lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`)
          })
          lines.push('', '回复数字选择，或直接输入你的答案')
          await this._send(chatId, lines.join('\n'), message.messageId)
          return new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              this._pendingChoices.delete(userId)
              resolve(options[0]?.label ?? '1')
            }, 3 * 60 * 1000)
            this._pendingChoices.set(userId, (answer) => {
              clearTimeout(timer)
              const number = parseInt(answer, 10)
              resolve(number >= 1 && number <= options.length ? options[number - 1].label : answer)
            })
          })
        },
      })
      const assistantContent: store.ContentBlock[] = [...result.toolCalls]
      if (result.text) assistantContent.push({ type: 'text', text: result.text })
      if (result.timing) assistantContent.push(result.timing)
      if (assistantContent.length) {
        store.appendMessage(work.id, 'assistant', assistantContent)
        store.markExternalWrite()
      }
      if (result.text) {
        for (const chunk of splitMessage(result.text)) await this._send(chatId, chunk, message.messageId)
      } else if (!result.images.length) {
        await this._send(chatId, CHANNEL_EMPTY_REPLY_FALLBACK, message.messageId)
      }
    } catch (error) {
      log.error('chat error:', error instanceof Error ? error.message : String(error))
      await this._send(chatId, `处理失败：${error instanceof Error ? error.message : String(error)}`, message.messageId)
    }
  }

  private _pendingChoices = new Map<string, (answer: string) => void>()
}
