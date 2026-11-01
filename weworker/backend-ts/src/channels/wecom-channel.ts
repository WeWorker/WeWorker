/**
 * 企业微信智能机器人通道 — WebSocket 长连接模式
 *
 * 协议文档: https://developer.work.weixin.qq.com/document/path/101463
 *
 * 流程:
 *   1. WebSocket 连接 wss://openws.work.weixin.qq.com
 *   2. 发送 aibot_subscribe 订阅请求（BotID + Secret）
 *   3. 接收 aibot_msg_callback / aibot_event_callback
 *   4. 通过 aibot_respond_msg 回复消息（支持流式）
 *   5. 通过 aibot_send_msg 主动推送消息
 *   6. 每 30 秒发送 ping 心跳
 */

import WebSocket from 'ws'
import { ProbeError, probeExistingWecomSocket } from './channel-probe.js'
import { randomUUID } from 'node:crypto'
import crypto from 'node:crypto'

import type { Channel, ChannelImage, ChannelStatus } from './channel-manager.js'
import { runChannelChat } from './channel-manager.js'
import { siteAuthChannelNotifier } from './site-auth-notifier.js'
import { streamChat } from '../agent.js'
import { createChannelUserMedia, userFileBlock } from '../user-media.js'
import { resolveStyleId } from '../style-settings.js'
import { CHANNEL_MYID_HINT, CHANNEL_EMPTY_REPLY_FALLBACK, getChannelPermissionMode } from './channel-permissions.js'
import type { ChannelPermissionMode } from './channel-permissions.js'
import { parseChannelCommand } from './channel-profile.js'
import type { ChannelAccessDecision, ChannelProfile, ChannelProfileChatOptions } from './channel-profile.js'
import { resolveToolDisplayName } from '../tools.js'
import { getSettings } from '../config.js'
import { generateTitle, generateTitleWithLLM } from '../title-utils.js'
import * as store from '../works-store.js'
import { createLogger } from '../logger.js'
import { createTurnTimingLedger } from '../turn-timing.js'

const log = createLogger('wecom')

const WS_URL = 'wss://openws.work.weixin.qq.com'
const HEARTBEAT_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 5_000
const MAX_MSG_LEN = 4000

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
    chunks.push(text.slice(i, i + MAX_MSG_LEN))
  }
  return chunks
}

function stripAtMention(content: string): string {
  return content.replace(/@\S+\s?/g, '').trim()
}

export { parseChannelCommand, type ChannelCommand } from './channel-profile.js'

export interface WecomChannelConfig {
  enabled: boolean
  bot_id: string
  secret: string
}

/** Aliases kept for callers written against the WeCom-only profile. */
export type WecomAccessDecision = ChannelAccessDecision
export type WecomProfileChatOptions = ChannelProfileChatOptions
export type WecomChannelProfile = ChannelProfile

export function createDefaultWecomProfile(): WecomChannelProfile {
  return {
    channelKey: 'wecom',
    titleLabel: (chatType) => (chatType === 'group' ? '企微群聊' : '企微'),
    welcomeText: () => '你好！我是 WeWorker 智能助手，有什么可以帮你的吗？发送 /new 开启新对话，发送 /id 查看对话 ID。',
    authorize: (userId) => ({ kind: 'allow', mode: getChannelPermissionMode('wecom', userId) }),
    memoryScope: (userId) => ({ user: `wecom:${userId}` }),
    chatOptions: () => ({}),
  }
}

export class WecomChannel implements Channel {
  private _config: WecomChannelConfig
  private _profile: WecomChannelProfile

  private _ws: WebSocket | null = null
  private _subscribeReqId: string | null = null
  // In-flight agent turns per user, so /new and /stop can interrupt them
  private _activeTurns = new Map<string, AbortController>()
  private _running = false
  private _status: ChannelStatus = { status: 'starting' }
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Track last user who messaged (for sendNotification)
  private _lastUserId: string | null = null
  private _lastChatId: string | null = null
  private _lastChatType: number = 1 // 1=single, 2=group
  // Pending ask_user resolvers: userId → resolve function
  private _pendingChoiceResolvers = new Map<string, (answer: string) => void>()
  // Pending WebSocket request resolvers: reqId → resolve function
  private _pendingWsRequests = new Map<string, (resp: Record<string, unknown>) => void>()

  constructor(config: WecomChannelConfig, profile: WecomChannelProfile = createDefaultWecomProfile()) {
    this._config = config
    this._profile = profile
  }

  getBotId(): string {
    return this._config.bot_id
  }

  getStatus(): ChannelStatus {
    return this._status
  }

  async probeConnection(config: { bot_id: string; secret: string }): Promise<void> {
    if (config.bot_id !== this._config.bot_id || config.secret !== this._config.secret) {
      throw new ProbeError('企业微信凭证已修改，请先保存再检测，避免中断正在使用的连接')
    }
    if (!this._ws || this._status.status !== 'connected') {
      throw new ProbeError('企业微信尚未连接，请检查凭证和网络后重试')
    }
    await probeExistingWecomSocket(this._ws)
  }

  async start(): Promise<void> {
    this._running = true
    this._status = { status: 'starting' }

    // Restore persisted notify target from DB
    const saved = store.getLatestChannelNotifyTarget(this._profile.channelKey)
    if (saved?.user_id) {
      this._lastUserId = saved.user_id
      if (saved.extra?.chat_type) this._lastChatType = parseInt(saved.extra.chat_type, 10) || 1
      log.info(`restored notify target: ${saved.user_id}`)
    }

    this._connect()
  }

  async stop(): Promise<void> {
    this._running = false
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    if (this._ws) {
      this._ws.removeAllListeners()
      this._ws.close()
      this._ws = null
    }
    this._status = { status: 'error', error: 'stopped' }
  }

  async sendNotification(text: string): Promise<void> {
    if (!this._lastUserId) {
      throw new Error('没有可用的企业微信用户，无法发送通知（需要用户先跟机器人对话过）')
    }
    await this.sendNotificationToTarget({ id: this._lastUserId, chatType: this._lastChatType as 1 | 2 }, text)

    // Persist to work
    try {
      const { work, created } = store.getOrCreateChannelWork(this._profile.channelKey, this._lastUserId, '', this._profile.projectId?.() ?? null)
      if (created) this._profile.onWorkCreated?.(work.id)
      store.appendMessage(work.id, 'assistant', [{ type: 'text', text }])
      store.markExternalWrite()
    } catch (e) {
      log.error('failed to persist notification to work:', e)
    }
  }

  async sendNotificationToTarget(target: { id: string; chatType: 1 | 2 }, text: string): Promise<void> {
    const chatId = String(target?.id ?? '').trim()
    if (!chatId) throw new Error('通知目标无效')
    if (target.chatType !== 1 && target.chatType !== 2) throw new Error('通知目标类型无效')
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) throw new Error('企业微信 WebSocket 未连接')
    for (const chunk of splitMessage(text)) {
      this._send({
        cmd: 'aibot_send_msg',
        headers: { req_id: randomUUID() },
        body: {
          chatid: chatId,
          chat_type: target.chatType,
          msgtype: 'markdown',
          markdown: { content: chunk },
        },
      })
    }
    log.info(`notification sent to explicit target (${target.chatType})`)
  }

  async sendImageToTarget(target: { id: string; chatType: 1 | 2 }, image: ChannelImage): Promise<void> {
    const chatId = String(target?.id ?? '').trim()
    if (!chatId) throw new Error('图片通知目标无效')
    if (target.chatType !== 1 && target.chatType !== 2) throw new Error('图片通知目标类型无效')
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) throw new Error('企业微信 WebSocket 未连接')
    if (!Buffer.isBuffer(image.data) || image.data.length === 0) throw new Error('图片内容为空')
    const mediaId = await this._uploadImage(image.data.toString('base64'), image.filename)
    if (!mediaId) throw new Error('图片上传失败')
    this._send({
      cmd: 'aibot_send_msg',
      headers: { req_id: randomUUID() },
      body: {
        chatid: chatId,
        chat_type: target.chatType,
        msgtype: 'image',
        image: { media_id: mediaId },
      },
    })
    log.info(`image notification sent to explicit target (${target.chatType}), media_id=${mediaId}`)
  }

  private _send(data: object): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data))
    }
  }

  /**
   * Upload a base64 image to WeChat Work temporary media via WebSocket.
   * Returns the media_id on success, null on failure.
   *
   * Flow: aibot_upload_media_init → aibot_upload_media_chunk(s) → aibot_upload_media_finish
   */
  private async _uploadImage(base64Data: string, filename = `screenshot_${Date.now()}.jpg`): Promise<string | null> {
    const imgBuf = Buffer.from(base64Data, 'base64')
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || `screenshot_${Date.now()}.jpg`
    const md5 = crypto.createHash('md5').update(imgBuf).digest('hex')
    const totalSize = imgBuf.length
    const CHUNK_SIZE = 128 * 1024 // 128KB raw → ~170KB base64 (conservative for WS frame limits)
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE)

    log.info(`uploading image: size=${totalSize}, chunks=${totalChunks}, md5=${md5}`)

    // Step 1: Init upload
    const initReqId = randomUUID()
    const initResult = await this._wsRequest({
      cmd: 'aibot_upload_media_init',
      headers: { req_id: initReqId },
      body: {
        type: 'image',
        filename: safeFilename,
        total_size: totalSize,
        total_chunks: totalChunks,
        md5,
      },
    }, initReqId)

    log.info(`upload init result:`, JSON.stringify(initResult)?.slice(0, 200))

    const uploadId = (initResult?.body as Record<string, unknown>)?.upload_id as string
    if (!uploadId) {
      log.error('upload init failed — no upload_id:', initResult)
      return null
    }

    // Step 2: Upload chunks — must wait for each chunk response before sending next
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, totalSize)
      const chunkBase64 = imgBuf.subarray(start, end).toString('base64')
      const chunkReqId = randomUUID()

      log.info(`uploading chunk ${i + 1}/${totalChunks}, size=${end - start}`)

      const chunkResult = await this._wsRequest({
        cmd: 'aibot_upload_media_chunk',
        headers: { req_id: chunkReqId },
        body: {
          upload_id: uploadId,
          chunk_index: i,
          base64_data: chunkBase64,
        },
      }, chunkReqId)

      log.info(`chunk ${i + 1} result:`, JSON.stringify(chunkResult)?.slice(0, 200))

      if (chunkResult?.errcode !== 0 && chunkResult?.errcode !== undefined) {
        log.error(`upload chunk ${i + 1} failed:`, chunkResult)
        return null
      }
    }

    // Step 3: Finish upload
    const finishReqId = randomUUID()
    const finishResult = await this._wsRequest({
      cmd: 'aibot_upload_media_finish',
      headers: { req_id: finishReqId },
      body: { upload_id: uploadId },
    }, finishReqId)

    log.info(`upload finish result:`, JSON.stringify(finishResult)?.slice(0, 200))

    const mediaId = (finishResult?.body as Record<string, unknown>)?.media_id as string
    if (!mediaId) {
      log.error('upload finish failed:', finishResult)
      return null
    }

    log.info(`image uploaded: media_id=${mediaId}, size=${totalSize}`)
    return mediaId
  }

  /** Upload a file from disk and return media_id */
  private async _uploadMedia(filePath: string, type: 'image' | 'file'): Promise<string | null> {
    const fs = await import('node:fs')
    const path = await import('node:path')

    if (!fs.existsSync(filePath)) {
      log.error(`file not found: ${filePath}`)
      return null
    }

    const imgBuf = fs.readFileSync(filePath)
    const md5 = crypto.createHash('md5').update(imgBuf).digest('hex')
    const totalSize = imgBuf.length
    const filename = path.basename(filePath)
    const CHUNK_SIZE = 128 * 1024
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE)

    log.info(`uploading ${type}: ${filename}, size=${totalSize}, chunks=${totalChunks}`)

    const initReqId = randomUUID()
    const initResult = await this._wsRequest({
      cmd: 'aibot_upload_media_init',
      headers: { req_id: initReqId },
      body: { type, filename, total_size: totalSize, total_chunks: totalChunks, md5 },
    }, initReqId)

    const uploadId = (initResult?.body as Record<string, unknown>)?.upload_id as string
    if (!uploadId) {
      log.error('upload init failed:', initResult)
      return null
    }

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, totalSize)
      const chunkBase64 = imgBuf.subarray(start, end).toString('base64')
      const chunkReqId = randomUUID()

      const chunkResult = await this._wsRequest({
        cmd: 'aibot_upload_media_chunk',
        headers: { req_id: chunkReqId },
        body: { upload_id: uploadId, chunk_index: i, base64_data: chunkBase64 },
      }, chunkReqId)

      if (chunkResult?.errcode !== 0 && chunkResult?.errcode !== undefined) {
        log.error(`upload chunk ${i + 1} failed:`, chunkResult)
        return null
      }
    }

    const finishReqId = randomUUID()
    const finishResult = await this._wsRequest({
      cmd: 'aibot_upload_media_finish',
      headers: { req_id: finishReqId },
      body: { upload_id: uploadId },
    }, finishReqId)

    const mediaId = (finishResult?.body as Record<string, unknown>)?.media_id as string
    if (!mediaId) {
      log.error('upload finish failed:', finishResult)
      return null
    }

    log.info(`${type} uploaded: media_id=${mediaId}, file=${filename}`)
    return mediaId
  }

  /** Send a file from disk to one chat (the chat of the turn that asked for it). */
  private async _sendFileToChat(filePath: string, chatId: string, chatType: number): Promise<{ success: boolean; error?: string }> {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return { success: false, error: 'WebSocket 未连接' }

    const mediaId = await this._uploadMedia(filePath, 'file')
    if (!mediaId) return { success: false, error: '文件上传失败' }

    this._send({
      cmd: 'aibot_send_msg',
      headers: { req_id: randomUUID() },
      body: {
        chatid: chatId,
        chat_type: chatType,
        msgtype: 'file',
        file: { media_id: mediaId },
      },
    })
    log.info(`file sent: ${filePath}, media_id=${mediaId}`)
    return { success: true }
  }

  /**
   * Send a WebSocket message and wait for the response with matching req_id.
   */
  private _wsRequest(data: object, reqId: string, timeoutMs = 15000): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingWsRequests.delete(reqId)
        log.error(`ws request timeout: ${reqId}`)
        resolve(null)
      }, timeoutMs)

      this._pendingWsRequests.set(reqId, (resp) => {
        clearTimeout(timer)
        this._pendingWsRequests.delete(reqId)
        resolve(resp)
      })

      this._send(data)
    })
  }

  private _connect(): void {
    if (!this._running) return

    try {
      this._ws = new WebSocket(WS_URL)
    } catch (e) {
      log.error('WebSocket creation error:', e)
      this._scheduleReconnect()
      return
    }

    this._ws.on('open', () => {
      log.info(`[${this._profile.channelKey}] WebSocket connected, subscribing...`)
      this._subscribeReqId = randomUUID()
      this._send({
        cmd: 'aibot_subscribe',
        headers: { req_id: this._subscribeReqId },
        body: {
          bot_id: this._config.bot_id,
          secret: this._config.secret,
        },
      })
    })

    this._ws.on('message', (raw: Buffer | string) => {
      try {
        const data = JSON.parse(raw.toString())
        this._handleFrame(data)
      } catch (e) {
        log.error('failed to parse message:', e)
      }
    })

    this._ws.on('close', (code, reason) => {
      log.info(`WebSocket closed: ${code} ${reason}`)
      this._stopHeartbeat()
      if (this._running) {
        this._status = { status: 'error', error: `连接断开 (${code})` }
        this._scheduleReconnect()
      }
    })

    this._ws.on('error', (err) => {
      log.error('WebSocket error:', err.message)
      this._status = { status: 'error', error: err.message }
    })
  }

  private _scheduleReconnect(): void {
    if (!this._running) return
    if (this._reconnectTimer) return
    log.info(`reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connect()
    }, RECONNECT_DELAY_MS)
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      this._send({ cmd: 'ping', headers: { req_id: randomUUID() } })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  private _handleFrame(data: Record<string, unknown>): void {
    const cmd = data.cmd as string | undefined
    const errcode = data.errcode as number | undefined
    const headers = data.headers as Record<string, string> | undefined
    const reqId = headers?.req_id

    // Debug: log all frames when there are pending upload requests
    if (this._pendingWsRequests.size > 0) {
      const summary = JSON.stringify(data).slice(0, 300)
      log.info(`frame (${this._pendingWsRequests.size} pending): ${summary}`)
    }

    // Resolve any pending WebSocket request (upload init/chunk/finish responses)
    if (reqId && this._pendingWsRequests.has(reqId)) {
      log.info(`resolving pending ws request ${reqId.slice(0, 8)}, errcode=${errcode}`)
      this._pendingWsRequests.get(reqId)!(data)
      return
    }

    // Error responses without req_id — resolve the oldest pending request
    if (!reqId && errcode !== undefined && errcode !== 0 && this._pendingWsRequests.size > 0) {
      const [firstKey, firstResolver] = this._pendingWsRequests.entries().next().value!
      log.info(`resolving pending ws request (no req_id, error) ${firstKey.slice(0, 8)}, errcode=${errcode}`)
      this._pendingWsRequests.delete(firstKey)
      firstResolver(data)
      return
    }

    // Subscribe response (ping acks share this shape, so match the subscribe req_id)
    if (reqId && errcode !== undefined && !cmd) {
      // Pings only start after a successful subscribe, so before that any ack is the subscribe reply.
      const isSubscribeReply = reqId === this._subscribeReqId || this._status.status !== 'connected'
      if (!isSubscribeReply) return
      this._subscribeReqId = null
      if (errcode === 0) {
        log.info(`[${this._profile.channelKey}] subscribe success`)
        this._status = { status: 'connected' }
        this._startHeartbeat()
      } else {
        log.error(`[${this._profile.channelKey}] subscribe failed: ${data.errmsg}`)
        this._status = { status: 'error', error: `订阅失败: ${data.errmsg}` }
      }
      return
    }

    switch (cmd) {
      case 'aibot_msg_callback':
        this._onMessage(data).catch(e => log.error('message handler error:', e))
        break
      case 'aibot_event_callback':
        this._onEvent(data).catch(e => log.error('event handler error:', e))
        break
      default:
        // ping response or unknown — ignore
        break
    }
  }

  private async _onEvent(data: Record<string, unknown>): Promise<void> {
    const headers = data.headers as Record<string, string>
    const body = data.body as Record<string, unknown>
    const event = body?.event as Record<string, string> | undefined

    if (event?.eventtype === 'enter_chat') {
      // Reply welcome message
      this._send({
        cmd: 'aibot_respond_welcome_msg',
        headers: { req_id: headers.req_id },
        body: {
          msgtype: 'text',
          text: { content: this._profile.welcomeText() },
        },
      })
    } else if (event?.eventtype === 'disconnected_event') {
      log.info('received disconnected event (new connection replaced this one)')
    }
  }

  private async _onMessage(data: Record<string, unknown>): Promise<void> {
    const headers = data.headers as Record<string, string>
    const body = data.body as Record<string, unknown>
    const reqId = headers?.req_id
    if (!reqId) return

    const userId = (body.from as Record<string, string>)?.userid ?? ''
    if (!userId) return

    const chatType = body.chattype as string // 'single' | 'group'
    const chatId = body.chatid as string | undefined

    // Extract text content
    let text = ''
    const msgtype = body.msgtype as string
    if (msgtype === 'text') {
      text = ((body.text as Record<string, string>)?.content ?? '').trim()
    } else if (msgtype === 'mixed') {
      // Extract text parts from mixed content
      text = ((body.text as Record<string, string>)?.content ?? '').trim()
    } else {
      // Unsupported message type — inform user
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content: '暂时只支持文本消息哦' } },
      })
      return
    }

    // Strip @mention in group chats
    if (chatType === 'group') {
      text = stripAtMention(text)
    }
    if (!text) return

    const replyOnce = (content: string) => this._send({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content } },
    })

    const access = this._profile.authorize(userId, text)
    if (access.kind === 'reply') {
      replyOnce(access.text)
      return
    }
    const channelKey = this._profile.channelKey

    // Cache user info for sendNotification
    this._lastUserId = chatType === 'single' ? userId : (chatId ?? userId)
    this._lastChatType = chatType === 'single' ? 1 : 2
    store.saveChannelNotifyTarget(channelKey, this._lastUserId, {
      chat_type: String(this._lastChatType),
      user_id: userId,
    })

    // Commands take priority over a pending ask_user question, so /new always works.
    const command = parseChannelCommand(text)
    log.info(`[${channelKey}] message from ${userId.slice(0, 4)}…${command ? ` command=${command}` : ''}`)

    if (command === '/help' && this._profile.helpText) {
      replyOnce(this._profile.helpText())
      return
    }

    if (command === '/new' || command === '/stop') {
      const interrupted = this._interruptUser(userId)
      if (command === '/stop') {
        replyOnce(interrupted ? '已停止当前任务。' : '当前没有正在执行的任务。')
        return
      }
      const fresh = store.resetChannelWork(channelKey, userId, '', this._profile.projectId?.() ?? null)
      this._profile.onWorkCreated?.(fresh.id)
      store.markExternalWrite()
      log.info(`[${channelKey}] new conversation ${fresh.id.slice(0, 8)}${interrupted ? ' (previous task stopped)' : ''}`)
      replyOnce(interrupted ? '已停止上一个任务，并开启新对话 ✓' : '已开启新对话 ✓')
      return
    }

    // Check if there's a pending ask_user choice for this user
    const pendingResolver = this._pendingChoiceResolvers.get(userId)
    if (pendingResolver && !command) {
      this._pendingChoiceResolvers.delete(userId)
      pendingResolver(text.trim())
      return
    }

    if (command === '/id') {
      const existing = store.getOrCreateChannelWork(channelKey, userId, '')
      if (existing.created) this._profile.onWorkCreated?.(existing.work.id)
      const shortId = existing.work.id.slice(0, 8)
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content: `当前对话 ID: ${shortId}` } },
      })
      return
    }

    if (command === '/targetid') {
      const targetId = chatType === 'single' ? userId : (chatId ?? userId)
      const targetLabel = chatType === 'group' ? '当前群聊' : '当前单聊'
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content: `${targetLabel} ID：${targetId}\n可在 WeWorker「专属 Agent → 任务」中将它授权为定时消息通知目标。` } },
      })
      return
    }

    if (command === '/myid') {
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content: `你的用户 ID：${userId}\n${CHANNEL_MYID_HINT}` } },
      })
      return
    }

    // Normal message — process with AI
    const settings = getSettings()
    if (!settings.api_key) {
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: randomUUID(), finish: true, content: 'WeWorker 尚未配置 API Key，请在设置中配置后重试。' } },
      })
      return
    }

    if (this._profile.serializeTurns && this._activeTurns.has(userId)) {
      replyOnce('⏳ 上一个请求还在处理中。发送 /stop 可停止它，发送 /new 可停止并开启新对话。')
      return
    }
    const abortController = new AbortController()
    this._activeTurns.set(userId, abortController)
    try {
      await this._runTurn({ reqId, userId, chatType, chatId, text, settings, mode: access.mode, abortController })
    } finally {
      if (this._activeTurns.get(userId) === abortController) this._activeTurns.delete(userId)
    }
  }

  /** Abort the user's running turn and drop a pending ask_user question. */
  private _interruptUser(userId: string): boolean {
    this._pendingChoiceResolvers.delete(userId)
    const active = this._activeTurns.get(userId)
    if (!active) return false
    this._activeTurns.delete(userId)
    active.abort()
    return true
  }

  private async _runTurn(turn: {
    reqId: string
    userId: string
    chatType: string
    chatId: string | undefined
    text: string
    settings: ReturnType<typeof getSettings>
    mode: ChannelPermissionMode
    abortController: AbortController
  }): Promise<void> {
    const { reqId, userId, chatType, chatId, text, settings } = turn
    const channelKey = this._profile.channelKey
    const { work, created } = store.getOrCreateChannelWork(channelKey, userId, '', this._profile.projectId?.() ?? null)
    if (created) this._profile.onWorkCreated?.(work.id)
    store.appendMessage(work.id, 'user', [{ type: 'text', text }])
    store.markExternalWrite()

    // Auto-title
    const sourceLabel = this._profile.titleLabel(chatType === 'group' ? 'group' : 'single')
    if (!work.title) {
      store.updateTitle(work.id, `（${sourceLabel}）${generateTitle(text)}`)
      generateTitleWithLLM(text, settings).then(llmTitle => {
        if (llmTitle) {
          store.updateTitle(work.id, `（${sourceLabel}）${llmTitle}`)
          store.markExternalWrite()
        }
      })
    }

    const wm = store.getWorkWithMessages(work.id)!

    // Send initial streaming response
    const streamId = randomUUID()
    this._send({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'stream', stream: { id: streamId, finish: false, content: '正在思考...' } },
    })

    // ── Stream AI chat directly (real-time text delivery to WeCom) ──
    // Instead of runChannelChat (which waits for completion), we iterate
    // streamChat events directly so we can push text to the user as it arrives.
    const assistantContent: store.ContentBlock[] = []
    const toolCallMap = new Map<string, { name: string; args: unknown; thinkMs?: number }>()
    let fullText = ''
    let displayText = ''
    let separateNextModelText = false
    let currentTextChunk = ''
    const images: string[] = []
    let lastStreamTime = Date.now()
    const STREAM_INTERVAL_MS = 800 // send text update at most every 800ms

    // Per-turn timing (mirrors server.ts / task-executor.ts so 企微 turns are observable).
    // llm 与 exec 互不重叠：llm + exec === total，缺 tool_call_result 的工具不会计进 llm。
    const turnTiming = createTurnTimingLedger()
    let stepIndex = 0
    const seenToolIds = new Set<string>()

    // Helper: flush accumulated text to WeCom stream
    const flushText = () => {
      if (!displayText) return
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish: false, content: displayText } },
      })
      lastStreamTime = Date.now()
    }

    const authTarget = {
      id: chatType === 'single' ? userId : (chatId ?? userId),
      chatType: chatType === 'single' ? 1 as const : 2 as const,
    }
    const authTurn = siteAuthChannelNotifier.registerTurn({
      channelKey,
      sendText: async (message) => {
        displayText += `${displayText ? '\n\n' : ''}${message}`
        separateNextModelText = true
        flushText()
      },
      sendImage: (image) => this.sendImageToTarget(authTarget, image),
    })

    // Set up ask_user handler for channel mode
    const askUserHandler = async (question: string, options: Array<{ label: string; description?: string }>) => {
      const lines = [`${question}`]
      options.forEach((opt, i) => {
        lines.push(`${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
      })
      lines.push('', '回复数字选择，或直接输入你的答案')

      const choiceStreamId = randomUUID()
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: choiceStreamId, finish: true, content: lines.join('\n') } },
      })

      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this._pendingChoiceResolvers.delete(userId)
          resolve(options[0]?.label ?? '1')
        }, 3 * 60 * 1000)

        this._pendingChoiceResolvers.set(userId, (answer) => {
          clearTimeout(timer)
          const num = parseInt(answer, 10)
          if (num >= 1 && num <= options.length) {
            resolve(options[num - 1].label)
          } else {
            resolve(answer)
          }
        })
      })
    }

    const channelPermissionMode = turn.mode
    const styleId = resolveStyleId(work, settings)
    let chatFailure: unknown = null

    try {
      const profileOptions = this._profile.chatOptions(userId)
      for await (const event of streamChat(wm.messages, settings, turn.abortController, {
        ...profileOptions,
        // send_image_to_user / send_file_to_user answer this chat, not the last bot user.
        userMedia: createChannelUserMedia(images, assistantContent, async (file) => {
          const sent = await this._sendFileToChat(file.path, chatType === 'single' ? userId : (chatId ?? userId), chatType === 'single' ? 1 : 2)
          if (!sent.success) throw new Error(sent.error || '文件发送失败')
          assistantContent.push(userFileBlock(file))
        }),
        streaming: true,
        workId: work.id,
        styleId,
        channelPermissionMode,
        memoryScope: this._profile.memoryScope(userId),
        channelAskUserHandler: askUserHandler,
      })) {
        if (event.type === 'skill_context' && event.skillContext) {
          assistantContent.push(event.skillContext)
        } else if (event.type === 'text_delta' && event.content) {
          fullText += event.content
          if (separateNextModelText) {
            displayText += '\n\n'
            separateNextModelText = false
          }
          displayText += event.content
          currentTextChunk += event.content
          // Flush to WeCom periodically to avoid flooding
          if (Date.now() - lastStreamTime >= STREAM_INTERVAL_MS) {
            flushText()
            // If we accumulated enough text, also save a text block for interleaved display
            if (currentTextChunk.trim()) {
              assistantContent.push({ type: 'text', text: currentTextChunk })
              currentTextChunk = ''
            }
          }
        } else if (event.type === 'tool_call_start' && event.id) {
          // Save any pending text before the tool call
          if (currentTextChunk.trim()) {
            assistantContent.push({ type: 'text', text: currentTextChunk })
            currentTextChunk = ''
          }
          authTurn.observeToolCall(event.id, event.name, event.args)
          const cleanName = resolveToolDisplayName(event.name ?? '')
          // Dedup + capture think time (streaming emits tool_call_start twice per call)
          const isNew = !seenToolIds.has(event.id)
          let thinkMs: number | undefined
          if (isNew) {
            seenToolIds.add(event.id)
            stepIndex++
            thinkMs = turnTiming.toolStarted(event.id)
          }
          toolCallMap.set(event.id, {
            name: cleanName,
            args: event.args,
            ...(thinkMs !== undefined ? { thinkMs } : {}),
          })
          // Send tool call hint to user
          flushText()
          this._send({
            cmd: 'aibot_respond_msg',
            headers: { req_id: reqId },
            body: { msgtype: 'stream', stream: { id: streamId, finish: false, content: displayText + `\n🔧 ${cleanName}...` } },
          })
          lastStreamTime = Date.now()
        } else if (event.type === 'tool_call_result' && event.id) {
          const started = toolCallMap.get(event.id)
          const toolDuration = turnTiming.toolSettled(event.id) ?? 0
          authTurn.finishToolCall(event.id)
          assistantContent.push({
            type: 'tool_use',
            id: event.id,
            name: started?.name ?? '',
            args: started?.args ?? {},
            result: event.result ?? '',
            status: event.isError ? 'failed' : 'done',
            execMs: toolDuration,
            ...(started?.thinkMs !== undefined ? { thinkMs: started.thinkMs } : {}),
          })
        } else if (event.type === 'tool_call_image' && event.data) {
          // 只回图片的工具没有 result 事件：同样结算，避免其耗时漏进 llm。
          const imageToolDuration = event.id ? turnTiming.toolObserved(event.id) : undefined
          if (event.id) authTurn.finishToolCall(event.id)
          images.push(event.data)
          if (assistantContent.length > 0) {
            const last = assistantContent[assistantContent.length - 1]
            if (last.type === 'tool_use') {
              last.image = event.data
              if (imageToolDuration !== undefined && last.execMs === undefined) last.execMs = imageToolDuration
            }
          }
        } else if (event.type === 'error' && event.content) {
          const modelAddition = `${fullText ? '\n\n' : ''}${event.content}`
          const displayAddition = `${displayText ? '\n\n' : ''}${event.content}`
          fullText += modelAddition
          displayText += displayAddition
          currentTextChunk += modelAddition
          break
        } else if (event.type === 'done') {
          break
        }
        if (turn.abortController.signal.aborted) break
      }
    } catch (e) {
      if (!turn.abortController.signal.aborted) {
        log.error('chat error:', e)
        chatFailure = e
      }
    } finally {
      authTurn.close()
    }
    if (turn.abortController.signal.aborted) {
      if (assistantContent.length > 0 || currentTextChunk.trim()) {
        if (currentTextChunk.trim()) assistantContent.push({ type: 'text', text: currentTextChunk })
        assistantContent.push({ type: 'text', text: '（已停止）' })
        store.appendMessage(work.id, 'assistant', assistantContent)
        store.markExternalWrite()
      }
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish: true, content: `${displayText ? `${displayText}\n\n` : ''}（已停止）` } },
      })
      return
    }
    if (chatFailure) {
      const e = chatFailure
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish: true, content: `${displayText ? `${displayText}\n\n` : ''}处理失败：${e instanceof Error ? e.message : String(e)}` } },
      })
      return
    }

    // Close the turn: trailing LLM text plus any tool that never reported a result.
    const snapshot = turnTiming.finish()

    // Save any remaining text chunk
    if (currentTextChunk.trim()) {
      const suffix = fullText.slice((assistantContent
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('') + currentTextChunk).length)
      assistantContent.push({ type: 'text', text: currentTextChunk + suffix })
      currentTextChunk = ''
    } else if (fullText) {
      const existingText = assistantContent
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const suffix = fullText.slice(existingText.length)
      if (suffix) assistantContent.push({ type: 'text', text: suffix })
    }

    // Persist assistant response (tool calls interleaved with text for desktop view)
    if (assistantContent.length > 0) {
      assistantContent.push({ type: 'timing', totalMs: snapshot.totalMs, llmMs: snapshot.llmMs, execMs: snapshot.execMs, steps: stepIndex })
      store.appendMessage(work.id, 'assistant', assistantContent)
      store.markExternalWrite()
    }

    // Send final response via stream finish. Login notices are display-only and
    // deliberately excluded from the persisted model response above.
    if (displayText) {
      // For long messages, split and send as stream updates
      const chunks = splitMessage(displayText)
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1 && images.length === 0
        this._send({
          cmd: 'aibot_respond_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'stream', stream: { id: streamId, finish: isLast, content: chunks.slice(0, i + 1).join('') } },
        })
      }
    } else if (images.length === 0) {
      this._send({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'stream', stream: { id: streamId, finish: true, content: CHANNEL_EMPTY_REPLY_FALLBACK } },
      })
    }

    // Send images via upload + aibot_send_msg (stream mode only supports text)
    if (images.length > 0) {
      // Finish the stream first if still open
      if (!displayText) {
        this._send({
          cmd: 'aibot_respond_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'stream', stream: { id: streamId, finish: true, content: '请查看图片 👇' } },
        })
      }
      for (const imgBase64 of images) {
        try {
          const mediaId = await this._uploadImage(imgBase64)
          if (mediaId) {
            this._send({
              cmd: 'aibot_send_msg',
              headers: { req_id: randomUUID() },
              body: {
                chatid: chatType === 'single' ? userId : (chatId ?? userId),
                chat_type: chatType === 'single' ? 1 : 2,
                msgtype: 'image',
                image: { media_id: mediaId },
              },
            })
            log.info(`image sent via media_id=${mediaId}`)
          }
        } catch (e) {
          log.error('image upload/send error:', e)
        }
      }
    }
  }
}
