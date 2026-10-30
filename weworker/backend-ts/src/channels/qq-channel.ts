/**
 * QQ Bot channel — connects to QQ's WebSocket gateway (botpy-compatible).
 * Supports: group @ messages, C2C (direct), guild @ messages, guild DMs.
 *
 * QQ Bot API docs: https://bot.q.qq.com/wiki/develop/api/
 */
import WebSocket from 'ws'

import { getSettings } from '../config.js'
import { generateTitle, generateTitleWithLLM } from '../title-utils.js'
import * as store from '../works-store.js'
import { runChannelChat } from './channel-manager.js'
import type { Channel, ChannelStatus } from './channel-manager.js'
import { CHANNEL_MYID_HINT, CHANNEL_EMPTY_REPLY_FALLBACK, getChannelPermissionModeByType } from './channel-permissions.js'
import { createLogger } from '../logger.js'

const log = createLogger('qq')

const MAX_MSG_LEN = 1900
const QQ_GATEWAY = 'wss://api.sgroup.qq.com/websocket'

// Intents bitmask
const INTENT_GUILD_MESSAGES = 1 << 9       // private guild bots only
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30
const INTENT_DIRECT_MESSAGE = 1 << 12      // guild DMs
const INTENT_GROUP_AND_C2C = 1 << 25       // group @ messages and C2C messages
// Public guild bots, legacy private guild bots, then QR-created group/C2C bots.
// QQ rejects the entire Identify packet if any requested event is unauthorized.
const INTENT_PROFILES = [
  INTENT_PUBLIC_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE | INTENT_GROUP_AND_C2C,
  INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGE | INTENT_GROUP_AND_C2C,
  INTENT_GROUP_AND_C2C,
]

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
    chunks.push(text.slice(i, i + MAX_MSG_LEN))
  }
  return chunks
}

function stripAtMention(content: string): string {
  return content.replace(/<@!\d+>/g, '').trim()
}

interface QQChannelConfig {
  app_id: string
  app_secret: string
}

export class QQChannel implements Channel {
  private _config: QQChannelConfig

  private _ws: WebSocket | null = null
  private _status: ChannelStatus = { status: 'starting' }
  private _running = false
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _readyTimer: ReturnType<typeof setTimeout> | null = null
  private _intentIndex = 0
  private _sessionId = ''
  private _seq: number | null = null
  private _token = ''
  private _tokenExpiry = 0
  /** 最近一个 C2C 私聊用户的 openid，用于主动发送通知 */
  private _lastC2CUserOpenid: string | null = null
  /** Pending ask_user resolvers: userId → resolve function */
  private _pendingChoiceResolvers = new Map<string, (answer: string) => void>()

  constructor(config: QQChannelConfig) {
    this._config = config

  }

  getStatus(): ChannelStatus {
    return this._status
  }

  async start(): Promise<void> {
    this._running = true
    this._status = { status: 'starting' }

    // Restore persisted notify target from DB
    const saved = store.getLatestChannelNotifyTarget('qq')
    if (saved?.user_id) {
      this._lastC2CUserOpenid = saved.user_id
      log.info(`restored notify target: ${saved.user_id}`)
    }

    try {
      await this._connect()
    } catch (e) {
      this._status = { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  async stop(): Promise<void> {
    this._running = false
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    if (this._readyTimer) clearTimeout(this._readyTimer)
    this._reconnectTimer = null
    this._readyTimer = null
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
  }

  /**
   * 主动发送通知消息到最近一个 C2C 私聊用户。
   * QQ Bot API 的 C2C 主动消息有频率限制，但通知场景下频率很低。
   */
  async sendNotification(text: string): Promise<void> {
    if (!this._lastC2CUserOpenid) {
      throw new Error('没有可用的 QQ 私聊用户，无法发送通知（需要用户先跟 bot 私聊过）')
    }
    const token = await this._getToken()
    for (const chunk of splitMessage(text)) {
      await fetch(`https://api.sgroup.qq.com/v2/users/${this._lastC2CUserOpenid}/messages`, {
        method: 'POST',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk, msg_type: 0, msg_seq: Date.now() }),
      })
    }
    log.info(`notification sent to C2C user ${this._lastC2CUserOpenid}`)

    // 把通知内容记录到该用户对应的 work 中，桌面端可查看
    try {
      const { work } = store.getOrCreateChannelWork('qq', this._lastC2CUserOpenid, '')
      store.appendMessage(work.id, 'assistant', [{ type: 'text', text }])
      store.markExternalWrite()
    } catch (e) {
      log.error('failed to persist notification to work:', e)
    }
  }

  private async _getToken(): Promise<string> {
    if (this._token && Date.now() < this._tokenExpiry) return this._token
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appId: this._config.app_id,
        clientSecret: this._config.app_secret,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`QQ token fetch failed: ${res.status}`)
    const data = await res.json() as { access_token: string; expires_in: number }
    if (!data.access_token) throw new Error('QQ 鉴权失败，请重新扫码或检查 App ID 和 App Secret')
    this._token = `QQBot ${data.access_token}`
    this._tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
    return this._token
  }

  private async _connect(): Promise<void> {
    if (!this._running) return
    this._status = { status: 'starting' }
    const token = await this._getToken()
    if (!this._running) return
    const ws = new WebSocket(QQ_GATEWAY, { handshakeTimeout: 10_000 })
    this._ws = ws
    const isCurrent = () => this._running && this._ws === ws
    let identified = false
    this._readyTimer = setTimeout(() => {
      if (!isCurrent()) return
      this._status = { status: 'error', error: 'QQ 上线确认超时，正在重连' }
      ws.terminate()
    }, 15_000)

    // Attach before open: Hello can arrive in the same network read as the upgrade.
    ws.on('message', (data) => {
      if (!isCurrent()) return
      try {
        const frame = JSON.parse(data.toString())
        this._handleFrame(frame)
        if (frame.op === 10 && !identified) {
          identified = true
          ws.send(JSON.stringify({
            op: 2,
            d: { token, intents: INTENT_PROFILES[this._intentIndex], shard: [0, 1],
              properties: { os: process.platform, browser: 'weworker', device: 'weworker' } },
          }))
        }
      } catch { /* Ignore malformed gateway frames. */ }
    })
    ws.on('error', () => {
      if (isCurrent()) this._status = { status: 'error', error: 'QQ 网关连接失败，请检查网络' }
    })
    ws.on('close', (code) => {
      if (this._ws !== ws) return
      this._ws = null
      if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
      if (this._readyTimer) clearTimeout(this._readyTimer)
      this._heartbeatTimer = null
      this._readyTimer = null
      if (!this._running) return
      let delay = 5000
      if (code === 4014) {
        if (this._intentIndex + 1 >= INTENT_PROFILES.length) {
          this._status = { status: 'error', error: 'QQ 事件订阅权限不足，请检查机器人群聊和私聊权限后重新连接' }
          this._running = false
          log.error('QQ event subscription rejected (4014)')
          return
        }
        this._intentIndex++
        this._status = { status: 'starting' }
        delay = 250
        log.info('QQ rejected optional events; retrying a compatible subscription')
      } else if (code === 4004) {
        this._status = { status: 'error', error: 'QQ 鉴权失败，请重新扫码或检查 App ID 和 App Secret' }
        this._running = false
        return
      } else {
        this._status = { status: 'error', error: 'QQ 连接已断开，正在重连（' + code + '）' }
      }
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null
        void this._connect().catch(() => {
          if (this._running) this._status = { status: 'error', error: 'QQ 重新连接失败，请检查网络后重试' }
        })
      }, delay)
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('error', reject)
      ws.once('open', resolve)
      ws.once('close', () => reject(new Error('QQ 网关在建立连接前关闭')))
    })
  }

  private _handleFrame(frame: { op: number; d?: unknown; t?: string; s?: number }): void {
    if (frame.s != null) this._seq = frame.s

    switch (frame.op) {
      case 10: { // Hello — start heartbeat
        const interval = (frame.d as { heartbeat_interval: number }).heartbeat_interval
        if (!Number.isFinite(interval) || interval <= 0) break
        if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
        this._heartbeatTimer = setInterval(() => {
          this._ws?.send(JSON.stringify({ op: 1, d: this._seq }))
        }, interval)
        break
      }
      case 0: { // Dispatch
        this._handleDispatch(frame.t ?? '', frame.d)
        break
      }
      case 9: { // Invalid session
        this._status = { status: 'error', error: 'Invalid session' }
        break
      }
    }
  }

  private _handleDispatch(type: string, data: unknown): void {
    const d = data as Record<string, unknown>
    switch (type) {
      case 'READY':
        if (this._readyTimer) clearTimeout(this._readyTimer)
        this._readyTimer = null
        this._sessionId = (d.session_id as string) ?? ''
        this._status = { status: 'connected' }
        log.info('bot connected')
        break
      case 'GROUP_AT_MESSAGE_CREATE':
        this._onGroupMessage(d).catch(e => log.error('group msg error:', e))
        break
      case 'C2C_MESSAGE_CREATE':
        this._onC2CMessage(d).catch(e => log.error('c2c msg error:', e))
        break
      case 'AT_MESSAGE_CREATE':
        this._onGuildMessage(d).catch(e => log.error('guild msg error:', e))
        break
      case 'DIRECT_MESSAGE_CREATE':
        this._onDirectMessage(d).catch(e => log.error('dm error:', e))
        break
    }
  }

  private async _onGroupMessage(d: Record<string, unknown>): Promise<void> {
    const author = d.author as Record<string, string>
    const groupOpenid = d.group_openid as string
    const msgId = d.id as string
    const text = stripAtMention((d.content as string) ?? '')

    await this._handleMessage({
      channelType: 'qq_group',
      userId: author.member_openid,
      displayName: `QQ群 ${author.member_openid.slice(-6)}`,
      text,
      replyFn: async (content, seq) => {
        await this._postGroupMessage(groupOpenid, content, msgId, seq)
      },
      replyImageFn: async (base64, seq) => {
        const fileInfo = await this._uploadGroupImage(groupOpenid, base64)
        if (fileInfo) await this._postGroupImage(groupOpenid, fileInfo, msgId, seq)
      },
    })
  }

  private async _onC2CMessage(d: Record<string, unknown>): Promise<void> {
    const author = d.author as Record<string, string>
    const msgId = d.id as string
    const text = stripAtMention((d.content as string) ?? '')

    // 缓存最近的 C2C 用户 openid，用于主动发送通知
    this._lastC2CUserOpenid = author.user_openid
    // Persist to DB so it survives restarts
    store.saveChannelNotifyTarget('qq', author.user_openid)

    await this._handleMessage({
      channelType: 'qq_c2c',
      userId: author.user_openid,
      displayName: `QQ私聊 ${author.user_openid.slice(-6)}`,
      text,
      replyFn: async (content, seq) => {
        await this._postC2CMessage(author.user_openid, content, msgId, seq)
      },
      replyImageFn: async (base64, seq) => {
        const fileInfo = await this._uploadC2CImage(author.user_openid, base64)
        if (fileInfo) await this._postC2CImage(author.user_openid, fileInfo, msgId, seq)
      },
    })
  }

  private async _onGuildMessage(d: Record<string, unknown>): Promise<void> {
    const author = d.author as Record<string, string>
    const channelId = d.channel_id as string
    const msgId = d.id as string
    const text = stripAtMention((d.content as string) ?? '')

    await this._handleMessage({
      channelType: 'qq_guild',
      userId: author.id,
      displayName: `QQ频道 ${author.username ?? author.id}`,
      text,
      replyFn: async (content, _seq) => {
        await this._postChannelMessage(channelId, content, msgId)
      },
      replyImageFn: async (base64, _seq) => {
        await this._postChannelImage(channelId, base64, msgId)
      },
    })
  }

  private async _onDirectMessage(d: Record<string, unknown>): Promise<void> {
    const author = d.author as Record<string, string>
    const guildId = d.guild_id as string
    const msgId = d.id as string
    const text = stripAtMention((d.content as string) ?? '')

    await this._handleMessage({
      channelType: 'qq_dm',
      userId: author.id,
      displayName: `QQ私信 ${author.username ?? author.id}`,
      text,
      replyFn: async (content, _seq) => {
        await this._postDMMessage(guildId, content, msgId)
      },
      replyImageFn: async (base64, _seq) => {
        await this._postDMImage(guildId, base64, msgId)
      },
    })
  }

  private async _handleMessage(opts: {
    channelType: string
    userId: string
    displayName: string
    text: string
    replyFn: (content: string, seq: number) => Promise<void>
    replyImageFn?: (base64: string, seq: number) => Promise<void>
  }): Promise<void> {
    const { channelType, userId, displayName, text, replyFn, replyImageFn } = opts
    let seq = 1

    // Check if there's a pending ask_user choice for this user
    const pendingResolver = this._pendingChoiceResolvers.get(userId)
    if (pendingResolver) {
      this._pendingChoiceResolvers.delete(userId)
      pendingResolver(text)
      return
    }

    if (text === '/new') {
      store.resetChannelWork(channelType, userId, '')
      await replyFn('已开启新对话 ✓', seq)
      return
    }

    // /id command — reply with current work short ID
    if (text === '/id') {
      const existing = store.getOrCreateChannelWork(channelType, userId, '')
      const shortId = existing.work.id.slice(0, 8)
      await replyFn(`当前对话 ID: ${shortId}`, seq)
      return
    }

    if (text === '/myid') {
      await replyFn(`你的用户 ID：${userId}\n${CHANNEL_MYID_HINT}`, seq)
      return
    }

    const settings = getSettings()
    if (!settings.api_key) {
      await replyFn('WeWorker 尚未配置 API Key，请在设置中配置后重试。', seq)
      return
    }

    const { work } = store.getOrCreateChannelWork(channelType, userId, '')
    store.appendMessage(work.id, 'user', [{ type: 'text', text }])
    store.markExternalWrite()

    // Auto-title: immediate fallback from text, then async LLM refinement
    // Source label: extract short channel name from displayName (e.g. "QQ群", "QQ私聊")
    const sourceLabel = displayName.replace(/\s+\S*$/, '') || 'QQ'
    const isFirstMessage = !work.title
    if (isFirstMessage) {
      store.updateTitle(work.id, `（${sourceLabel}）${generateTitle(text)}`)
      generateTitleWithLLM(text, settings).then(llmTitle => {
        if (llmTitle) {
          store.updateTitle(work.id, `（${sourceLabel}）${llmTitle}`)
          store.markExternalWrite()
        }
      })
    }

    const wm = store.getWorkWithMessages(work.id)!

    // Send "processing" pings every 10s while waiting for the AI response
    let pingSeq = seq
    const pingTimer = setInterval(() => {
      replyFn('正在处理...', pingSeq++).catch(() => {})
    }, 10000)

    const channelPermissionMode = getChannelPermissionModeByType(channelType, userId)

    let fullText: string
    let images: string[]
    let toolCalls: store.ContentBlock[]
    let timing: store.ContentBlock | null
    try {
      ;({ text: fullText, images, toolCalls, timing } = await runChannelChat(wm.messages, settings, {
        workId: work.id,
        channelPermissionMode,
        memoryScope: { user: `${channelType}:${userId}` },
        // Images are sent back only where this chat can receive them.
        sendsImages: !!replyImageFn,
        askUserHandler: async (question, options) => {
          // Format as numbered text
          const lines = [`${question}`]
          options.forEach((opt, i) => {
            lines.push(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
          })
          lines.push('', '回复数字选择，或直接输入你的答案')
          await replyFn(lines.join('\n'), seq++)

          // Wait for user's next message
          return new Promise<string>((resolve) => {
            const timer = setTimeout(() => {
              this._pendingChoiceResolvers.delete(userId)
              resolve(options[0]?.label ?? '1')
            }, 3 * 60 * 1000) // 3 min timeout

            this._pendingChoiceResolvers.set(userId, (answer) => {
              clearTimeout(timer)
              // Parse number → label
              const num = parseInt(answer.trim(), 10)
              if (num >= 1 && num <= options.length) {
                resolve(options[num - 1].label)
              } else {
                resolve(answer.trim())
              }
            })
          })
        },
      }))
    } finally {
      clearInterval(pingTimer)
    }
    seq = pingSeq

    // Build assistant content blocks for persistence (tool calls + text + images)
    const assistantContent: store.ContentBlock[] = []
    for (const tc of toolCalls) assistantContent.push(tc)
    if (fullText) assistantContent.push({ type: 'text', text: fullText })
    for (const img of images) {
      const alreadyAttached = toolCalls.some(tc => tc.type === 'tool_use' && tc.image === img)
      if (!alreadyAttached) {
        assistantContent.push({ type: 'tool_use', id: `img-${Date.now()}`, name: 'capture_screenshot', args: {}, image: img, status: 'done' })
      }
    }
    if (assistantContent.length > 0) {
      if (timing) assistantContent.push(timing)
      store.appendMessage(work.id, 'assistant', assistantContent)
      store.markExternalWrite()
    }

    if (fullText) {
      for (const chunk of splitMessage(fullText)) {
        await replyFn(chunk, seq++)
      }
    }

    if (replyImageFn) {
      for (const imgBase64 of images) {
        await replyImageFn(imgBase64, seq++).catch(e =>
          log.error('image send error:', e)
        )
      }
    }

    if (!fullText && images.length === 0) {
      await replyFn(CHANNEL_EMPTY_REPLY_FALLBACK, seq)
    }
  }

  private async _uploadGroupImage(groupOpenid: string, base64: string): Promise<string | null> {
    const token = await this._getToken()
    const res = await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenid}/files`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_type: 1, file_data: base64, srv_send_msg: false }),
    })
    const data = await res.json() as { file_info?: string; code?: number; message?: string }
    if (!res.ok) {
      log.error('group upload failed:', data)
      return null
    }
    return data.file_info ?? null
  }

  private async _uploadC2CImage(openid: string, base64: string): Promise<string | null> {
    const token = await this._getToken()
    const res = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/files`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_type: 1, file_data: base64, srv_send_msg: false }),
    })
    const data = await res.json() as { file_info?: string; code?: number; message?: string }
    if (!res.ok) {
      log.error('c2c upload failed:', data)
      return null
    }
    return data.file_info ?? null
  }

  private async _postGroupMessage(groupOpenid: string, content: string, msgId: string, msgSeq: number): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenid}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq }),
    })
  }

  private async _postGroupImage(groupOpenid: string, fileInfo: string, msgId: string, msgSeq: number): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenid}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 7, media: { file_info: fileInfo }, msg_id: msgId, msg_seq: msgSeq }),
    })
  }

  private async _postC2CMessage(openid: string, content: string, msgId: string, msgSeq: number): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq }),
    })
  }

  private async _postC2CImage(openid: string, fileInfo: string, msgId: string, msgSeq: number): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 7, media: { file_info: fileInfo }, msg_id: msgId, msg_seq: msgSeq }),
    })
  }

  private async _postChannelMessage(channelId: string, content: string, msgId: string): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, msg_id: msgId }),
    })
  }

  private async _postChannelImage(channelId: string, base64: string, msgId: string): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/jpeg;base64,${base64}`, msg_id: msgId }),
    })
  }

  private async _postDMMessage(guildId: string, content: string, msgId: string): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/dms/${guildId}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, msg_id: msgId }),
    })
  }

  private async _postDMImage(guildId: string, base64: string, msgId: string): Promise<void> {
    const token = await this._getToken()
    await fetch(`https://api.sgroup.qq.com/dms/${guildId}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: `data:image/jpeg;base64,${base64}`, msg_id: msgId }),
    })
  }
}
