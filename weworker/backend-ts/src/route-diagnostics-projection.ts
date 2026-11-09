import fs from 'node:fs'
import path from 'node:path'
import { getWorkLogDirectory } from './work-log-file.js'

/** Read-only, bounded projection of existing work logs. Never return source lines or arbitrary event data. */
const MAX_BYTES = 16 * 1024 * 1024
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const TOOL = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){1,3}$/
const PHASES = new Set([
  'route_skipped', 'route_disabled', 'route_config', 'route_plan', 'route_unmatched',
  'candidate_selected', 'candidate_skipped', 'candidate_outcome', 'dispatch_start',
  'dispatch_skipped', 'dispatch_result', 'dispatch_failed', 'render_failed',
  'render_succeeded', 'plan_skipped', 'plan_failed', 'route_finished', 'route_failed',
  'route_attempt', 'gate', 'candidate', 'dispatch', 'render', 'handoff', 'route_complete', 'turn_outcome',
])
const REASONS = new Set([
  'environment_switch', 'no_eligible_candidate', 'gate_blocked', 'layer_pruned',
  'tool_not_routable', 'terminal_unavailable', 'plan_not_compiled', 'unexpected_exception',
  'permission_ask', 'permission_requires_confirmation', 'dedicated_agent', 'retry', 'compaction_retry', 'qa_only', 'disabled', 'empty_message',
  'no_candidate', 'gate_discussion', 'gate_follow_up', 'sequential',
  'route_answered', 'auth_required', 'authentication_required', 'timeout', 'api_error',
  'invalid_payload', 'empty_unconfirmed', 'render_failed', 'tool_unavailable',
  'agent_answered', 'agent_failed', 'agent_cancelled', 'partial_visible_no_fallback',
  'config_rejected_using_last_good',
])
const CATEGORIES = new Set([
  'timeout', 'thrown', 'error_payload', 'process_error', 'empty', 'authentication',
  'missing_argument', 'unavailable_cached_result', 'cache_read_failed', 'renderer_exception',
  'no_renderable_data', 'unexpected_exception', 'error', 'cancelled', 'missing', 'local_route_failed',
])
const STATUSES = new Set(['started', 'skipped', 'missed', 'selected', 'succeeded', 'failed', 'partial_visible'])
const OUTCOMES = new Set(['handled', 'skip', 'fallback'])
const LAYERS = new Set(['route', 'scenario', 'scenario-a', 'template', 'pattern', 'plan', 'alias', 'shortcut'])
const SOURCES = new Set(['system', 'adapter', 'user_local', 'local-approved', 'scenario-a', 'route', 'pattern', 'plan', 'alias', 'shortcut', 'template', 'scenario'])
const FALLBACKS = new Set(['llm', 'agent', 'none', 'blocked'])
const ENGINES = new Set(['legacy_profile', 'deterministic', 'user_local', 'webcli_recommendation', 'agent'])
const ENTRIES = new Set(['desktop', 'task', 'channel'])
const SHAPES = new Set(['array', 'object', 'text', 'string', 'number', 'boolean', 'null', 'undefined'])

type JsonObject = Record<string, unknown>
export type RouteDiagnosticEvent = {
  phase: string
  time: string
  status?: string
  reason?: string
  category?: string
  layer?: string
  tool?: string
  source?: string
  fallback?: string
  outcome?: string
  fingerprint?: string
  type?: string
  durationMs?: number
  candidateCount?: number
  handled?: boolean
  engine?: string
  entry?: string
}
export type RouteDiagnosticTurn = { turnId: string; startedAt: string; status: 'answered' | 'fallback' | 'missed' | 'skipped' | 'incomplete'; events: RouteDiagnosticEvent[] }
export type RouteDiagnosticsProjection = { turns: RouteDiagnosticTurn[]; incomplete: boolean }

function record(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) }
function known(value: unknown, values: Set<string>): string | undefined {
  return typeof value === 'string' && values.has(value) ? value : undefined
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000 ? value : undefined
}
function projectEvent(time: unknown, data: unknown): RouteDiagnosticEvent | undefined {
  if (!record(data) || typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) || !Number.isFinite(Date.parse(time))) return undefined
  const phase = known(data.phase, PHASES)
  if (!phase) return undefined
  const event: RouteDiagnosticEvent = { phase, time }
  const fields = {
    status: known(data.status, STATUSES), reason: known(data.reasonCode, REASONS) ?? known(data.reason, REASONS),
    category: known(data.category, CATEGORIES), layer: known(data.layer, LAYERS),
    tool: typeof data.tool === 'string' && TOOL.test(data.tool) && data.tool.length <= 128 ? data.tool : undefined,
    source: known(data.source, SOURCES), fallback: known(data.fallbackTarget, FALLBACKS) ?? known(data.fallback, FALLBACKS),
    outcome: known(data.outcome, OUTCOMES), fingerprint: typeof data.fingerprint === 'string' && /^[0-9a-f]{16,64}$/.test(data.fingerprint) ? data.fingerprint : undefined,
    type: known(data.type, SHAPES), durationMs: number(data.durationMs), candidateCount: number(data.candidateCount),
    engine: known(data.engine, ENGINES), entry: known(data.entry, ENTRIES),
  }
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) Object.assign(event, { [key]: value })
  if (typeof data.handled === 'boolean') event.handled = data.handled
  // No rule/label or free-text fields: existing rule labels can contain user-supplied content.
  return event
}

export function projectRouteDiagnostics(log: string, truncated = false): RouteDiagnosticsProjection {
  const turns = new Map<string, RouteDiagnosticTurn>()
  let incomplete = truncated
  for (const line of log.split('\n')) {
    if (!line.startsWith('{')) continue
    let raw: unknown
    try { raw = JSON.parse(line) } catch { incomplete = true; continue }
    if (!record(raw)) continue
    if (raw.type === 'log_write_gap') { incomplete = true; continue }
    if (raw.type !== 'route_diagnostic' || typeof raw.turnId !== 'string' || !ID.test(raw.turnId)) continue
    const event = projectEvent(raw.time, raw.data)
    if (!event) { incomplete = true; continue }
    let turn = turns.get(raw.turnId)
    if (!turn) {
      turn = { turnId: raw.turnId, startedAt: event.time, status: 'incomplete', events: [] }
      turns.set(raw.turnId, turn)
    }
    if (turn.events.length >= 200) { incomplete = true; continue }
    turn.events.push(event)
  }
  for (const turn of turns.values()) {
    const events = turn.events
    if (events.some(e => e.phase === 'route_finished' && e.handled === true) || events.some(e => e.phase === 'route_complete' && e.status === 'succeeded')) turn.status = 'answered'
    else if (events.some(e => ['dispatch_failed', 'render_failed', 'plan_failed', 'route_failed'].includes(e.phase)) || events.some(e => e.phase === 'route_finished' && e.handled === false)) turn.status = 'fallback'
    else if (events.some(e => e.phase === 'route_unmatched')) turn.status = 'missed'
    else if (events.some(e => ['route_skipped', 'route_disabled'].includes(e.phase))) turn.status = 'skipped'
    // Do not infer Agent success from routing handoff or a missing terminal event.
  }
  return { turns: [...turns.values()], incomplete }
}

/** Caller must verify that the work exists and the local HTTP auth middleware authorized access. */
export function readRouteDiagnostics(workId: string): RouteDiagnosticsProjection {
  if (!ID.test(workId)) throw new Error('Invalid work ID')
  const directory = getWorkLogDirectory()
  if (!directory) return { turns: [], incomplete: true }
  const file = path.join(directory, workId + '.log')
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { turns: [], incomplete: true }
    throw error
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - MAX_BYTES)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    if (start) text = text.slice(text.indexOf('\n') + 1)
    return projectRouteDiagnostics(text, !!start || !text.endsWith('\n'))
  } finally { fs.closeSync(fd) }
}
