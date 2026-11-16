import { appendWorkLog } from './work-log-file.js'
import { bridgeRpcClient, type BridgeTraceEvent } from './bridge-rpc-client.js'
import { chatTurns } from './chat-turn-lifecycle.js'

/** Subset of the Bridge client this module needs; injectable for tests. */
export interface TraceClient {
  onTraceEvent(listener: (event: BridgeTraceEvent) => void): () => void
  request(payload: Record<string, unknown>, expectedTypes: string[], timeoutMs: number): Promise<Record<string, unknown>>
}

/**
 * Bridge → work log bridge for `webcli call` execution stages.
 *
 * The Bridge broadcasts `trace_event` notifications (metadata only) for every
 * call that carries a desktop work ID. This module writes them to the
 * per-conversation log and pulls the extension-side trace buffer:
 *  - once when the call completes (done/error), and
 *  - repeatedly while a dispatched call stays silent (the classic "stuck"
 *    window between dispatch and the extension's reply).
 */

const WORK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const TRACE_ID = /^[a-zA-Z0-9_-]{1,64}$/
/** First silence snapshot after dispatch; late enough to avoid racing fast calls. */
const STUCK_FIRST_MS = 60_000
/** Re-snapshot cadence after the first one for long-stuck calls. */
const STUCK_REPEAT_MS = 300_000
/** Extension buffers are capped (300 lines); take the tail, it has the stall point. */
const EXT_LOG_MAX_LINES = 120
const GET_TRACE_LOGS_TIMEOUT_MS = 10_000
/** Bound tracking state; missed done/error events (restart, crash) must not leak. */
const MAX_IN_FLIGHT = 32

interface InFlight {
  workId: string
  traceId: string
  stuckTimer?: ReturnType<typeof setTimeout>
}

const inFlight = new Map<string, InFlight>() // key: traceId (insertion order = age)
let wired = false
let wiredClient: TraceClient = bridgeRpcClient
let unsubscribeTraceListener: (() => void) | undefined

export function wireWebcliTraceLogging(client: TraceClient = bridgeRpcClient): void {
  if (wired && wiredClient === client) return
  unsubscribeTraceListener?.()
  wired = true
  wiredClient = client
  unsubscribeTraceListener = client.onTraceEvent(handleTraceEvent)
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function handleTraceEvent(event: BridgeTraceEvent): void {
  if (!WORK_ID.test(event.workId) || !TRACE_ID.test(event.traceID)) return
  const workId = event.workId
  const traceId = event.traceID
  const turnId = chatTurns.activeTurnId(workId)
  const fields: Record<string, unknown> = { stage: event.stage, traceId }
  if (event.toolName) fields.toolName = event.toolName
  for (const key of ['loginWaitMs', 'timeoutMs', 'durationMs', 'code', 'site'] as const) {
    const value = event[key]
    if (value !== undefined && value !== null && value !== '') fields[key] = value
  }
  if (event.prepared === true) fields.prepared = true
  if (event.auth && typeof event.auth === 'object') {
    const site = typeof event.auth.site === 'string' ? event.auth.site : ''
    const status = typeof event.auth.status === 'string' ? event.auth.status : ''
    if (site || status) fields.auth = { ...(site ? { site } : {}), ...(status ? { status } : {}) }
  }
  appendWorkLog(workId, 'webcli.stage', fields, turnId)

  if (event.stage === 'received') {
    trackInFlight({ workId, traceId })
    return
  }
  if (event.stage === 'dispatched' || event.stage === 'http_run' || event.stage === 'toolkit_run') {
    const entry = trackInFlight({ workId, traceId })
    armStuckSnapshot(entry)
    return
  }
  if (event.stage === 'auth_required') {
    // Waiting for the user to log in is a known wait, not a stall: silence the
    // stuck snapshot. The post-login retry re-arms it via its own dispatched.
    const entry = inFlight.get(traceId)
    if (entry?.stuckTimer) { clearTimeout(entry.stuckTimer); entry.stuckTimer = undefined }
    return
  }
  if (event.stage === 'done' || event.stage === 'error') {
    const entry = inFlight.get(traceId)
    if (entry?.stuckTimer) clearTimeout(entry.stuckTimer)
    inFlight.delete(traceId)
    void pullExtensionLogs(workId, traceId, 'completion', turnId)
  }
}

function trackInFlight(fresh: InFlight): InFlight {
  const existing = inFlight.get(fresh.traceId)
  if (existing) return existing
  inFlight.set(fresh.traceId, fresh)
  while (inFlight.size > MAX_IN_FLIGHT) {
    const oldest = inFlight.keys().next().value
    if (oldest === undefined) break
    const entry = inFlight.get(oldest)
    if (entry?.stuckTimer) clearTimeout(entry.stuckTimer)
    inFlight.delete(oldest)
  }
  return fresh
}

function armStuckSnapshot(entry: InFlight): void {
  if (entry.stuckTimer) clearTimeout(entry.stuckTimer)
  const schedule = (delayMs: number) => {
    const timer = setTimeout(() => {
      entry.stuckTimer = undefined
      const activeTurnId = chatTurns.activeTurnId(entry.workId)
      void pullExtensionLogs(entry.workId, entry.traceId, `stuck_${delayMs / 1000}s`, activeTurnId)
      if (inFlight.get(entry.traceId) === entry) schedule(STUCK_REPEAT_MS)
    }, delayMs)
    timer.unref?.()
    entry.stuckTimer = timer
  }
  schedule(STUCK_FIRST_MS)
}

async function pullExtensionLogs(workId: string, traceId: string, trigger: string, turnId: string | undefined): Promise<void> {
  try {
    const message = await wiredClient.request(
      { type: 'get_trace_logs', traceID: traceId },
      ['get_trace_logs_result'],
      GET_TRACE_LOGS_TIMEOUT_MS,
    )
    const rawLogs = Array.isArray(message.logs) ? message.logs : []
    const logs = rawLogs.filter((line): line is string => typeof line === 'string').slice(-EXT_LOG_MAX_LINES)
    if (!logs.length) return
    appendWorkLog(workId, 'webcli.ext_log', {
      traceId, trigger, count: logs.length, logs,
    }, turnId ?? chatTurns.activeTurnId(workId))
  } catch {
    // Bridge or extension unavailable: the webcli.stage trail already in the
    // log is the diagnostic; a missing buffer must not raise errors here.
  }
}
