/**
 * Long-lived Claude Code sessions for desktop chat.
 *
 * A cold `query()` spawns a new Claude Code CLI for every turn, which costs
 * several seconds before the first model request, and the conversation must
 * be replayed as text. A desktop work instead keeps one CLI in streaming-input
 * mode: later turns push only the new user message into the same process.
 *
 * Safety rules:
 * - A session is reused only when its configuration fingerprint matches and
 *   the stored history extends exactly what the session has already seen.
 * - Any abort, error, unfinished turn or configuration change closes the
 *   session; the next turn starts a fresh one from stored history.
 * - A busy session is never shared; concurrent turns fall back to a one-off query.
 * - Idle sessions are closed after CHAT_SESSION_IDLE_MS and the pool keeps at
 *   most CHAT_SESSION_MAX_SESSIONS processes. Process-tree cleanup on exit is
 *   handled by claude-process.ts; an idle CLI also exits when its stdin closes.
 *
 * Pre-start (warm-up): while the user types, the Renderer asks the Backend to
 * start the CLI ahead of the first turn. A work-bound warm session waits in the
 * pool; a "spare" session for a conversation that has no work yet (welcome
 * screen) waits in a single slot and is bound to the work on its first turn.
 * A warm session has not seen any history, so its first turn sends the full
 * prompt like a new session. Unused warm sessions close after
 * CHAT_SESSION_WARM_IDLE_MS.
 */
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createLogger } from './logger.js'
import type { UserMediaSink } from './user-media.js'
import { createApiDurationTracker, type ApiDurationTracker } from './usage-metrics.js'

const log = createLogger('chat-session')

export const CHAT_SESSION_IDLE_MS = 10 * 60_000
export const CHAT_SESSION_MAX_SESSIONS = 3
export const CHAT_SESSION_WARM_IDLE_MS = 3 * 60_000
const SWEEP_INTERVAL_MS = 60_000

type AskUserEvent = { type: string; id: string; question: string; options: Array<{ label: string; description?: string }> }
type ToolGuard = (toolName: string, input: Record<string, unknown>) => { behavior: 'allow' } | { behavior: 'deny'; message: string }

/** Callbacks owned by the current turn. A reused session rebinds them before every turn. */
export interface ChatTurnBindings {
  /** Work used by the session's MCP tools; set when a spare session is bound to a work. */
  workIdRef: { current: string | null }
  fileChangeTurnId?: string
  onAskUser: ((event: AskUserEvent) => void) | null
  /** Delivery of send_image_to_user / send_file_to_user to the current turn's conversation. */
  userMedia?: UserMediaSink | null
  extraToolGuard?: ToolGuard
  memory: { userPromptInjections: number; postToolBatchInjections: number }
}

export interface ChatHistoryEntry {
  id: string
  role: string
  digest?: string
}

/** Push-based prompt stream for streaming-input mode. */
export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private waiter: (() => void) | null = null
  private ended = false

  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error('Prompt queue is closed')
    this.pending.push(message)
    this.wake()
  }

  end(): void {
    this.ended = true
    this.wake()
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (this.pending.length > 0) {
        yield this.pending.shift()!
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => { this.waiter = resolve })
    }
  }
}

export interface ChatSessionQuery extends AsyncIterable<SDKMessage> {
  close(): void
}

export class ChatSession {
  workId: string | null
  readonly fingerprint: string
  readonly bindings: ChatTurnBindings
  busy = false
  closed = false
  lastUsedAt = Date.now()
  completedTurns = 0
  /**
   * One CLI process = one cost ledger: the result field `duration_api_ms` is a
   * session-cumulative API duration, so the per-turn value is a delta against
   * the previous turn of this same session. A new session gets a fresh tracker.
   */
  readonly apiDuration: ApiDurationTracker = createApiDurationTracker()
  private consumed: ChatHistoryEntry[] = []
  private acceptingSteering = false
  private pendingSteering = new Set<string>()
  private steeredHistory: ChatHistoryEntry[] = []
  private started = false
  private closeStarted = false
  private iterator: AsyncIterator<SDKMessage> | undefined
  private readonly queue: PromptQueue
  private readonly query: ChatSessionQuery
  private readonly onClose?: () => void | Promise<void>

  constructor(input: {
    workId: string | null
    fingerprint: string
    bindings: ChatTurnBindings
    queue: PromptQueue
    query: ChatSessionQuery
    onClose?: () => void | Promise<void>
  }) {
    this.workId = input.workId
    this.fingerprint = input.fingerprint
    this.bindings = input.bindings
    this.queue = input.queue
    this.query = input.query
    this.onClose = input.onClose
  }

  /**
   * True when `history` (ending with the new user message) appends to what
   * this session already holds: the same stored messages in the same order,
   * then only this session's own assistant replies, then one new user message.
   */
  continues(history: ChatHistoryEntry[]): boolean {
    if (this.closed || this.busy) return false
    // A warm session holds no history yet; its first turn carries the full prompt.
    if (this.fresh) return history.length > 0 && history[history.length - 1].role === 'user'
    if (this.consumed.length === 0) return false
    if (history.length <= this.consumed.length) return false
    for (let index = 0; index < this.consumed.length; index++) {
      const previous = this.consumed[index]
      if (history[index]?.id !== previous.id || history[index]?.role !== previous.role
        || history[index]?.digest !== previous.digest) return false
    }
    const added = history.slice(this.consumed.length)
    if (added[added.length - 1]?.role !== 'user') return false
    return added.slice(0, -1).every((entry) => entry.role === 'assistant')
  }

  /** True until the first turn starts: the CLI has been started but holds no conversation. */
  get fresh(): boolean {
    return !this.started && this.completedTurns === 0
  }

  /** Bind a spare session to the work whose first turn it serves. */
  adoptWork(workId: string): void {
    this.workId = workId
    this.bindings.workIdRef.current = workId
  }

  /** Send one user message and yield SDK messages until that turn's result. */
  async *runTurn(message: SDKUserMessage): AsyncGenerator<SDKMessage> {
    if (this.closed) throw new Error('Chat session is closed')
    this.started = true
    this.busy = true
    this.acceptingSteering = true
    this.steeredHistory = []
    this.lastUsedAt = Date.now()
    this.queue.push(message)
    this.iterator ??= this.query[Symbol.asyncIterator]()
    for (;;) {
      const next = await this.iterator.next()
      if (next.done) {
        // The CLI exited; the caller sees an unfinished turn and disposes the session.
        this.closed = true
        this.acceptingSteering = false
        if (this.pendingSteering.size > 0) throw new Error('模型进程已退出，补充指令尚未确认处理，请检查对话后继续')
        return
      }
      if (next.value.type === 'user' && next.value.uuid) this.pendingSteering.delete(next.value.uuid)
      const terminal = next.value.type === 'result' && (this.pendingSteering.size === 0 || next.value.is_error)
      if (terminal) this.acceptingSteering = false
      yield next.value
      if (terminal) return
    }
  }

  /** Record that the CLI now holds `history` and accept the next turn. */
  complete(history: ChatHistoryEntry[]): void {
    this.consumed = [...history, ...this.steeredHistory].map((entry) => ({ ...entry }))
    this.completedTurns += 1
    this.busy = false
    this.lastUsedAt = Date.now()
  }

  get canSteer(): boolean { return this.busy && this.acceptingSteering && !this.closed }

  /** The CLI folds streaming input into the next model step after current tools finish. */
  steer(message: SDKUserMessage, history: ChatHistoryEntry, previousAssistant?: ChatHistoryEntry): boolean {
    if (!this.canSteer || !message.uuid) return false
    this.pendingSteering.add(message.uuid)
    if (previousAssistant?.role === 'assistant') this.steeredHistory.push({ ...previousAssistant })
    this.steeredHistory.push({ ...history })
    this.queue.push(message)
    return true
  }

  /** Only refresh assistant segments registered by this turn, never arbitrary history. */
  refreshSteeredAssistant(entry: ChatHistoryEntry): void {
    if (entry.role !== 'assistant') return
    const previous = this.steeredHistory.find(item => item.id === entry.id && item.role === 'assistant')
    if (!previous) return
    previous.digest = entry.digest
    const consumed = this.consumed.find(item => item.id === entry.id && item.role === 'assistant')
    if (consumed) consumed.digest = entry.digest
  }

  /** Idempotent: ends the prompt stream, closes the CLI process tree and runs cleanup once. */
  close(reason: string): void {
    this.closed = true
    this.busy = false
    if (this.closeStarted) return
    this.closeStarted = true
    log.info('chat_session_closed', { work_id: this.workId, reason, turns: this.completedTurns })
    this.queue.end()
    try {
      this.query.close()
    } catch (error) {
      log.warn('chat session close failed', error instanceof Error ? error.message : String(error))
    }
    Promise.resolve(this.onClose?.()).catch((error) => {
      log.warn('chat session cleanup failed', error instanceof Error ? error.message : String(error))
    })
  }
}

/** Detect edits to Skill instructions and supporting files without rereading their bodies. */
export function fingerprintSkillFiles(roots: string[]): string {
  const hash = createHash('sha256')
  const visit = (directory: string, depth: number) => {
    if (depth > 8) return
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) visit(file, depth + 1)
        else {
          const stat = fs.lstatSync(file)
          hash.update(`${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}\n`)
        }
      }
    } catch { hash.update(`${directory}:unavailable`) }
  }
  roots.forEach(root => visit(root, 0))
  return hash.digest('hex')
}

const sessions = new Map<string, ChatSession>()
/** Pre-started session for a conversation that has no work yet. */
let spare: ChatSession | null = null
let sweeper: ReturnType<typeof setInterval> | null = null

function ensureSweeper(): void {
  if (sweeper) return
  sweeper = setInterval(() => sweepIdleChatSessions(), SWEEP_INTERVAL_MS)
  sweeper.unref?.()
}

function stopSweeperIfEmpty(): void {
  if (sessions.size > 0 || spare || !sweeper) return
  clearInterval(sweeper)
  sweeper = null
}

export function isChatSessionBusy(workId: string): boolean {
  return sessions.get(workId)?.busy === true
}

export function getSteerableChatSession(workId: string): ChatSession | undefined {
  const session = sessions.get(workId)
  return session?.canSteer ? session : undefined
}

/** Whether the work already has a live session (used to skip redundant warm-ups). */
export function hasChatSession(workId: string): boolean {
  const session = sessions.get(workId)
  return !!session && !session.closed
}

export function hasSpareChatSession(): boolean {
  return !!spare && !spare.closed
}

/** Keep one pre-started session for the next new conversation, replacing an older one. */
export function registerSpareChatSession(session: ChatSession): void {
  if (spare && spare !== session) spare.close('replaced')
  spare = session
  ensureSweeper()
}

function takeSpareChatSession(fingerprint: string): ChatSession | undefined {
  if (!spare || spare.closed) {
    spare = null
    return undefined
  }
  // A spare built for another configuration stays for a matching conversation or expires.
  if (spare.fingerprint !== fingerprint) return undefined
  const taken = spare
  spare = null
  return taken
}

/**
 * Return the idle session for `workId` when it can continue `history` under
 * `fingerprint`. A stale idle session is closed so its process is released.
 */
export function findReusableChatSession(
  workId: string,
  fingerprint: string,
  history: ChatHistoryEntry[],
): ChatSession | undefined {
  const session = sessions.get(workId)
  if (!session) {
    const adopted = takeSpareChatSession(fingerprint)
    if (!adopted) return undefined
    adopted.adoptWork(workId)
    registerChatSession(adopted)
    return adopted
  }
  if (session.closed) {
    sessions.delete(workId)
    stopSweeperIfEmpty()
    return undefined
  }
  if (session.busy) return undefined
  if (session.fingerprint !== fingerprint) {
    disposeChatSession(workId, 'config_changed')
    return undefined
  }
  if (!session.continues(history)) {
    disposeChatSession(workId, 'history_changed')
    return undefined
  }
  return session
}

export function registerChatSession(session: ChatSession): void {
  const workId = session.workId
  if (!workId) throw new Error('A pooled chat session needs a work')
  const existing = sessions.get(workId)
  if (existing && existing !== session) existing.close('replaced')
  sessions.set(workId, session)
  // Keep the process count bounded; only idle sessions can be evicted.
  const idle = [...sessions.values()]
    .filter((entry) => entry !== session && !entry.busy)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  while (sessions.size > CHAT_SESSION_MAX_SESSIONS && idle.length > 0) {
    const oldest = idle.shift()!
    if (oldest.workId) sessions.delete(oldest.workId)
    oldest.close('evicted')
  }
  ensureSweeper()
}

/** Close the work's session unless a turn is running in it. */
export function disposeIdleChatSession(workId: string, reason: string): void {
  if (!isChatSessionBusy(workId)) disposeChatSession(workId, reason)
}

/** Close the work's session. With `only`, close it only if it is still that session. */
export function disposeChatSession(workId: string, reason: string, only?: ChatSession): void {
  const session = sessions.get(workId)
  if (only && session !== only) {
    only.close(reason)
    return
  }
  if (!session) return
  sessions.delete(workId)
  session.close(reason)
  stopSweeperIfEmpty()
}

function idleLimit(session: ChatSession): number {
  return session.fresh ? CHAT_SESSION_WARM_IDLE_MS : CHAT_SESSION_IDLE_MS
}

export function sweepIdleChatSessions(now = Date.now()): void {
  for (const [workId, session] of sessions) {
    if (session.closed || (!session.busy && now - session.lastUsedAt > idleLimit(session))) {
      sessions.delete(workId)
      session.close(session.closed ? 'process_ended' : 'idle_timeout')
    }
  }
  if (spare && (spare.closed || now - spare.lastUsedAt > CHAT_SESSION_WARM_IDLE_MS)) {
    const expired = spare
    spare = null
    expired.close(expired.closed ? 'process_ended' : 'idle_timeout')
  }
  stopSweeperIfEmpty()
}

export function disposeSpareChatSession(reason: string): void {
  if (!spare) return
  const current = spare
  spare = null
  current.close(reason)
  stopSweeperIfEmpty()
}

export function disposeAllChatSessions(reason = 'shutdown'): void {
  for (const workId of [...sessions.keys()]) disposeChatSession(workId, reason)
  disposeSpareChatSession(reason)
}

/** Test and diagnostics view. */
export function listChatSessions(): Array<{ workId: string | null; busy: boolean; turns: number }> {
  return [...sessions.values()].map((session) => ({
    workId: session.workId,
    busy: session.busy,
    turns: session.completedTurns,
  }))
}
