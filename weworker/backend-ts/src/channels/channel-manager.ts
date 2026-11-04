import type { Settings } from '../config.js'
import type { ChannelPermissionMode } from './channel-permissions.js'
import * as store from '../works-store.js'
import { streamChat } from '../agent.js'
import { createLogger } from '../logger.js'
import type { MemoryScope } from '../memory/memory-types.js'
import type { ChannelProfileChatOptions } from './channel-profile.js'
import { createChannelUserMedia, type UserMediaSink } from '../user-media.js'
import { createTurnTimingLedger } from '../turn-timing.js'
import { historyBeforeLastUser, lastUserMessageText, tryRoutedTurn } from '../routed-turn.js'

const log = createLogger('channel-manager')

export interface ChannelStatus {
  status: 'starting' | 'connected' | 'error'
  error?: string
}

export interface ChannelNotificationTarget {
  id: string
  chatType: 1 | 2
}

export interface ChannelImage {
  data: Buffer
  filename: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
}

export interface Channel {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): ChannelStatus
  /** 主动发送通知消息（可选，不是所有通道都支持） */
  sendNotification?(text: string): Promise<void>
  /** Actively send to an explicitly authorized target (no last-chat fallback). */
  sendNotificationToTarget?(target: ChannelNotificationTarget, text: string): Promise<void>
  /** Send a validated in-memory image to an explicit target. */
  sendImageToTarget?(target: ChannelNotificationTarget, image: ChannelImage): Promise<void>
}

export class ChannelManager {
  private _channels = new Map<string, Channel>()

  register(name: string, channel: Channel): void {
    this._channels.set(name, channel)
  }

  async unregister(name: string): Promise<void> {
    const ch = this._channels.get(name)
    if (ch) {
      await ch.stop()
      this._channels.delete(name)
    }
  }

  has(name: string): boolean {
    return this._channels.has(name)
  }

  getChannel(name: string): Channel | undefined {
    return this._channels.get(name)
  }

  async startAll(): Promise<void> {
    await Promise.allSettled([...this._channels.values()].map(c => c.start()))
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this._channels.values()].map(c => c.stop()))
  }

  getStatuses(): Record<string, ChannelStatus> {
    const result: Record<string, ChannelStatus> = {}
    for (const [name, channel] of this._channels) {
      result[name] = channel.getStatus()
    }
    return result
  }
}

export const channelManager = new ChannelManager()

export async function runChannelChat(
  messages: store.Message[],
  settings: Settings,
  opts?: {
    channelPermissionMode?: ChannelPermissionMode
    memoryScope?: MemoryScope
    /** Called when ask_user tool fires — channel should send options to user and wait for reply */
    askUserHandler?: (question: string, options: Array<{ label: string; description?: string }>) => Promise<string>
    /** Lets /stop and /new interrupt the running turn. */
    abortController?: AbortController
    /** Per-turn agent options from a channel profile (e.g. a dedicated agent). */
    profileOptions?: ChannelProfileChatOptions
    /** Sends a file from send_file_to_user to this turn's chat; channels without it cannot send files. */
    sendFile?: UserMediaSink['file']
    /** False for channels that do not send the returned images, so the tool reports it cannot deliver. */
    sendsImages?: boolean
    /**
     * True when this turn is served by a dedicated Agent's channel profile.
     * Those turns never use deterministic routing: an Agent is bound to one
     * site/skill, and routing could answer with a different site.
     */
    dedicatedAgent?: boolean
  },
): Promise<{ text: string; images: string[]; toolCalls: store.ContentBlock[]; timing: store.ContentBlock | null }> {
  let text = ''
  const images: string[] = []
  // Collect tool call records for desktop-side debugging
  const toolCalls: store.ContentBlock[] = []
  // send_image_to_user goes back to this turn's chat with the turn's other images.
  const channelMedia = createChannelUserMedia(images, toolCalls, opts?.sendFile)
  const userMedia: UserMediaSink = opts?.sendsImages === false ? { ...(channelMedia.file ? { file: channelMedia.file } : {}) } : channelMedia
  const toolCallMap = new Map<string, { name: string; args: unknown; thinkMs?: number }>()

  // Per-turn timing (mirrors server.ts / task-executor.ts so channel turns are observable).
  // llm 与 exec 互不重叠：llm + exec === total，缺 tool_call_result 的工具不会计进 llm。
  const chatStartTime = Date.now()
  const turnTiming = createTurnTimingLedger({ startedAt: chatStartTime })
  let stepIndex = 0
  const seenToolIds = new Set<string>()

  // Deterministic routing (shared entry, see routed-turn.ts): channels answer a
  // plain query with a read-only tool instead of paying for a model turn.
  // `qa_only` turns are skipped inside the shared entry — those turns register no
  // tools at all, so routing them would hand a guest a channel the model lacks.
  const currentUserText = lastUserMessageText(messages)
  const turnWorkId = messages[messages.length - 1]?.work_id ?? ''
  const routed = opts?.dedicatedAgent || !currentUserText || !turnWorkId
    ? null
    : await tryRoutedTurn({
        message: currentUserText,
        workId: turnWorkId,
        chatStartTime,
        persist: false,
        channelPermissionMode: opts?.channelPermissionMode,
        // Messages *before* the current turn: the follow-up gate needs them.
        history: historyBeforeLastUser(messages),
        log: (m: string) => log.info(m),
      })
  if (routed?.handled) {
    const routedTiming: store.ContentBlock | null = routed.timing ? { type: 'timing', ...routed.timing } : null
    log.info(
      `runChannelChat routed — tool=${routed.timing?.routeTool ?? '?'} total=${((routed.timing?.totalMs ?? 0) / 1000).toFixed(2)}s`,
    )
    return { text: routed.text, images, toolCalls, timing: routedTiming }
  }

  for await (const event of streamChat(messages, settings, opts?.abortController, {
    ...(opts?.profileOptions ?? {}),
    directRoute: routed?.directRoute ?? { status: 'skipped', reason: opts?.dedicatedAgent ? 'dedicated_agent' : 'no_text' },
    streaming: false,
    channelPermissionMode: opts?.channelPermissionMode ?? 'full',
    memoryScope: opts?.memoryScope,
    channelAskUserHandler: opts?.askUserHandler,
    userMedia,
  })) {
    if (event.type === 'skill_context' && event.skillContext) {
      toolCalls.push(event.skillContext)
    } else if (event.type === 'text_delta' && event.content) {
      text += event.content
    } else if (event.type === 'tool_call_start' && event.id) {
      const isNew = !seenToolIds.has(event.id)
      let thinkMs: number | undefined
      if (isNew) {
        seenToolIds.add(event.id)
        stepIndex++
        thinkMs = turnTiming.toolStarted(event.id)
      }
      toolCallMap.set(event.id, {
        ...toolCallMap.get(event.id),
        name: event.name ?? '',
        args: event.args,
        ...(thinkMs !== undefined ? { thinkMs } : {}),
      })
    } else if (event.type === 'tool_call_result' && event.id) {
      const started = toolCallMap.get(event.id)
      const toolDuration = turnTiming.toolSettled(event.id)
      const existing = toolCalls.find(block => block.type === 'tool_use' && block.id === event.id) as Extract<store.ContentBlock, { type: 'tool_use' }> | undefined
      const updated: store.ContentBlock = {
        ...existing,
        type: 'tool_use', id: event.id,
        name: started?.name ?? existing?.name ?? '', args: started?.args ?? existing?.args ?? {},
        result: event.result ?? '', status: event.isError ? 'failed' : 'done',
        ...(toolDuration !== undefined ? { execMs: toolDuration } : {}),
        ...(started?.thinkMs !== undefined ? { thinkMs: started.thinkMs } : {}),
      }
      if (existing) Object.assign(existing, updated)
      else toolCalls.push(updated)
    } else if (event.type === 'tool_call_image' && event.data) {
      // 只回图片的工具没有 result 事件：同样结算，避免其耗时漏进 llm。
      const imageToolDuration = event.id ? turnTiming.toolObserved(event.id) : undefined
      images.push(event.data)
      if (event.id) {
        const existing = toolCalls.find(block => block.type === 'tool_use' && block.id === event.id) as Extract<store.ContentBlock, { type: 'tool_use' }> | undefined
        if (existing) {
          existing.image = event.data
          if (imageToolDuration !== undefined) existing.execMs = imageToolDuration
        } else {
          const started = toolCallMap.get(event.id)
          toolCalls.push({ type: 'tool_use', id: event.id, name: started?.name ?? '', args: started?.args ?? {}, image: event.data, status: 'done', ...(imageToolDuration !== undefined ? { execMs: imageToolDuration } : {}), ...(started?.thinkMs !== undefined ? { thinkMs: started.thinkMs } : {}) })
        }
      }
    } else if (event.type === 'error' && event.content) {
      text = event.content
      break
    } else if (event.type === 'done') {
      break
    }
    if (opts?.abortController?.signal.aborted) break
  }

  // Close the turn: trailing LLM text plus any tool that never reported a result.
  const snapshot = turnTiming.finish()
  for (const block of toolCalls) {
    if (block.type === 'tool_use') {
      block.execMs = turnTiming.toolExecutionMs(block.id) ?? block.execMs
      if (block.status === 'running') block.status = 'done'
    }
  }
  const timing: store.ContentBlock = { type: 'timing', totalMs: snapshot.totalMs, llmMs: snapshot.llmMs, execMs: snapshot.execMs, remainingModelMs: turnTiming.remainingModelMs(), steps: stepIndex }
  log.info(`runChannelChat turn — total=${(snapshot.totalMs / 1000).toFixed(2)}s llm=${(snapshot.llmMs / 1000).toFixed(2)}s exec=${(snapshot.execMs / 1000).toFixed(2)}s steps=${stepIndex}`)

  return { text, images, toolCalls, timing }
}
