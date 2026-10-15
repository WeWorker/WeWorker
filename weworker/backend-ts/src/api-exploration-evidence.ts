import { createHash } from 'node:crypto'
import { isApiResponseFailure } from '../../../extension/background/api-response-failure.mjs'

export type ApiCandidateVerdict = 'likely_data' | 'maybe_data' | 'noise' | 'blocked'
export type ApiCandidateRisk = 'read' | 'write' | 'unknown'
export type ApiStrategy = 'PUBLIC_API' | 'COOKIE_API' | 'PAGE_FETCH' | 'INTERCEPT' | 'NO_USABLE_API'

export interface RawApiEvidenceEntry {
  url?: string
  method?: string
  status?: number
  requestHeaders?: Record<string, unknown>
  requestBodyPreview?: string
  responseHeaders?: Record<string, unknown>
  responseContentType?: string
  responsePreview?: string
  timestamp?: number
  type?: string
  initiator?: unknown
}

export interface ApiValueShape {
  kind: 'none' | 'json' | 'form' | 'graphql' | 'text' | 'unknown'
  keys: string[]
  graphqlOperationName: string
  graphqlOperationType: string
}

export interface ApiResponseShape {
  kind: 'empty' | 'object' | 'array' | 'text' | 'unknown'
  topLevelKeys: string[]
  listPath: string
  itemKeys: string[]
  valueTypes: Record<string, string>
  rowCount: number | null
  truncated: boolean
}

export interface ApiVerificationFixture {
  source: 'captured_response'
  status: number[]
  contentTypes: string[]
  rowCount: { min: number; max: number } | null
  requiredPaths: string[]
  types: Record<string, string>
  notEmpty: string[]
  mustNotContain: string[]
  mustBeTruthy: string[]
}

export interface ApiStrategyNote {
  strategy: ApiStrategy
  contract: 'stable' | 'internal_unverified' | 'blocked' | 'none'
  authSource: 'none_observed' | 'cookie' | 'csrf' | 'bearer' | 'runtime_token' | 'unknown'
  replayStatus: 'not_run' | 'verified' | 'failed' | 'blocked'
  replayRequired: boolean
  evidenceIds: string[]
  reasons: string[]
}

export interface ApiReplayEvidence {
  transport: 'direct_no_auth' | 'browser_page'
  status: number | null
  ok: boolean
  contentType: string
  nonEmpty: boolean
  responseShape: ApiResponseShape
  durationMs: number
  errorCode: string
  verificationFixture?: ApiVerificationFixture | null
}

export interface ApiEndpointEvidence {
  evidenceId: string
  endpointFamily: string
  method: string
  origin: string
  path: string
  queryKeys: string[]
  status: number | null
  contentType: string
  sourceSteps: string[]
  requestShape: ApiValueShape
  responseShape: ApiResponseShape
  verdict: ApiCandidateVerdict
  score: number
  signals: string[]
  risk: ApiCandidateRisk
  strategyNote: ApiStrategyNote
  verificationFixture: ApiVerificationFixture | null
  replay?: ApiReplayEvidence
  replayCaptureDigest?: string
  observedUrl: string
}

export interface ApiExplorationAnalysisV2 {
  schemaVersion: 2
  selectedEvidenceIds?: string[]
  candidates: ApiEndpointEvidence[]
  likelyDataCount: number
  maybeDataCount: number
  noiseCount: number
  blockedCount: number
  recommendedNextProbe: 'replay_top_candidate' | 'capture_safe_read_action' | 'resolve_auth' | 'no_usable_api'
}

const SENSITIVE_KEY_RE = /api[_-]?key|authorization|cookie|credential|password|passwd|secret|session|ticket|token|csrf/i
const TELEMETRY_RE = /(?:^|[\/_-])(analytics|beacon|collect|log|metrics|monitor|report|rum|sentry|telemetry|trace)(?:[\/_?&=-]|$)/i
const STATIC_RE = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(?:$|[?#])/i
const STATIC_JSON_ASSET_RE = /\/(?:assets?|static|icons?|svg-next|fonts?)\/(?:[^?#]*\/)?[^/?#]+\.json(?:$|[?#])/i
const DATA_URL_RE = /(?:\/api\/|graphql|\.json(?:$|[?#])|\.spr(?:$|[?#])|\/query(?:[/?#]|$)|\/search(?:[/?#]|$)|\/list(?:[/?#]|$))/i
const LIST_SIGNAL_RE = /(?:^|[_.\-/])(items?|list|records?|results?|rows)(?:$|[_.\-/])/i
const LIST_FIELD_SUFFIX_RE = /(?:items?|list|records?|results?|rows)$/i
const WRITE_SIGNAL_RE = /(?:^|[\/_-])(approve|book|cancel|commit|create|delete|finish|pay|publish|reject|reserve|save|submit|update|upload)(?:[\s\/_?&=-]|$)/i
const WRITE_BODY_SIGNAL_RE = /approve|book|buy|cancel|commit|create|delete|edit|finish|pay|publish|reject|reserve|save|submit|update|upload/i
const READ_SIGNAL_RE = /(?:^|[\/_-])(count|detail|get|info|list|query|read|search|summary)(?:[\/_?&=-]|$)/i
const BLOCKED_STATUS = new Set([401, 403, 407, 409, 423, 429])

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function unique(values: string[], limit = 40): string[] {
  return [...new Set(values.filter(Boolean))].sort().slice(0, limit)
}

function safeUrl(value: unknown): URL | null {
  try {
    return new URL(text(value))
  } catch {
    return null
  }
}

function normalizePathSegment(segment: string): string {
  if (/^\d{3,}$/.test(segment)) return ':id'
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':id'
  if (/^[A-Za-z]+-\d{2,}$/.test(segment)) return ':id'
  return segment
}

function endpointIdentity(entry: RawApiEvidenceEntry): {
  evidenceId: string
  endpointFamily: string
  origin: string
  path: string
  queryKeys: string[]
} {
  const method = text(entry.method).toUpperCase() || 'GET'
  const parsed = safeUrl(entry.url)
  if (!parsed) {
    const path = text(entry.url).slice(0, 300)
    const endpointFamily = `${method} ${path}`
    return { evidenceId: endpointFamily, endpointFamily, origin: '', path, queryKeys: [] }
  }
  const path = parsed.pathname || '/'
  const familyPath = path.split('/').map(normalizePathSegment).join('/')
  const queryKeys = unique([...parsed.searchParams.keys()].filter((key) => !SENSITIVE_KEY_RE.test(key)))
  const suffix = queryKeys.length > 0 ? `?${queryKeys.join(',')}` : ''
  const endpointFamily = `${method} ${familyPath}${suffix}`
  return {
    evidenceId: endpointFamily,
    endpointFamily,
    origin: parsed.origin,
    path,
    queryKeys,
  }
}

function tryParseJson(value: string): unknown {
  const normalized = value.trim()
  if (!normalized || (!normalized.startsWith('{') && !normalized.startsWith('['))) return undefined
  const withoutTruncation = normalized.replace(/\.\.\.\[truncated[^\]]*\]$/i, '')
  try {
    return JSON.parse(withoutTruncation)
  } catch {
    return undefined
  }
}

function parseForm(value: string): Record<string, string> | null {
  if (!value || !value.includes('=')) return null
  try {
    const params = new URLSearchParams(value)
    if ([...params.keys()].length === 0) return null
    return Object.fromEntries(params.entries())
  } catch {
    return null
  }
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function requestShape(entry: RawApiEvidenceEntry): ApiValueShape {
  const body = text(entry.requestBodyPreview)
  if (!body) {
    return { kind: 'none', keys: [], graphqlOperationName: '', graphqlOperationType: '' }
  }
  const parsed = tryParseJson(body)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const operationName = text(record.operationName)
    const query = text(record.query)
    const graphqlOperationType = /\bmutation\b/i.test(query) ? 'mutation' : (/\bquery\b/i.test(query) ? 'query' : '')
    return {
      kind: operationName || query ? 'graphql' : 'json',
      keys: unique(Object.keys(record).filter((key) => !SENSITIVE_KEY_RE.test(key))),
      graphqlOperationName: operationName,
      graphqlOperationType,
    }
  }
  const form = parseForm(body)
  if (form) {
    return {
      kind: 'form',
      keys: unique(Object.keys(form).filter((key) => !SENSITIVE_KEY_RE.test(key))),
      graphqlOperationName: '',
      graphqlOperationType: '',
    }
  }
  return { kind: 'text', keys: [], graphqlOperationName: '', graphqlOperationType: '' }
}

function findList(value: unknown, prefix = '', depth = 0): { path: string; rows: unknown[] } | null {
  if (depth > 5) return null
  if (Array.isArray(value)) return { path: prefix, rows: value }
  if (!value || typeof value !== 'object') return null
  const entries = Object.entries(value as Record<string, unknown>)
  const isListField = (key: string) => LIST_SIGNAL_RE.test(key) || LIST_FIELD_SUFFIX_RE.test(key)
  const isDynamicListMap = entries.length > 0
    && entries.every(([, child]) => Array.isArray(child))
    && entries.some(([key]) => !isListField(key))
  if (isDynamicListMap) {
    return { path: prefix ? `${prefix}.*` : '$', rows: entries[0][1] as unknown[] }
  }
  const preferred = entries.sort(([left], [right]) => Number(isListField(right)) - Number(isListField(left)))
  for (const [key, child] of preferred) {
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(child)) return { path, rows: child }
  }
  for (const [key, child] of preferred) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue
    const path = prefix ? `${prefix}.${key}` : key
    const nested = findList(child, path, depth + 1)
    if (nested) return nested
  }
  return null
}

function responseShape(entry: RawApiEvidenceEntry): ApiResponseShape {
  const raw = text(entry.responsePreview)
  const truncated = /\.\.\.\[truncated/i.test(raw)
  if (!raw) {
    return { kind: 'empty', topLevelKeys: [], listPath: '', itemKeys: [], valueTypes: {}, rowCount: null, truncated }
  }
  const parsed = tryParseJson(raw)
  if (parsed === undefined) {
    return { kind: 'text', topLevelKeys: [], listPath: '', itemKeys: [], valueTypes: {}, rowCount: null, truncated }
  }
  if (Array.isArray(parsed)) {
    const first = parsed.find((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown> | undefined
    return {
      kind: 'array',
      topLevelKeys: [],
      listPath: '$',
      itemKeys: unique(Object.keys(first || {})),
      valueTypes: Object.fromEntries(Object.entries(first || {}).slice(0, 30).map(([key, value]) => [key, valueType(value)])),
      rowCount: parsed.length,
      truncated,
    }
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    const list = findList(record)
    const first = list?.rows.find((item) => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown> | undefined
    const valueSource = first || (list ? null : record)
    return {
      kind: 'object',
      topLevelKeys: unique(Object.keys(record)),
      listPath: list?.path || '',
      itemKeys: unique(Object.keys(first || {})),
      valueTypes: Object.fromEntries(Object.entries(valueSource || {}).slice(0, 30).map(([key, value]) => [key, valueType(value)])),
      rowCount: list ? list.rows.length : null,
      truncated,
    }
  }
  return { kind: 'unknown', topLevelKeys: [], listPath: '', itemKeys: [], valueTypes: {}, rowCount: null, truncated }
}

function contentType(entry: RawApiEvidenceEntry): string {
  const direct = text(entry.responseContentType).toLowerCase()
  if (direct) return direct.split(';')[0]
  const headers = entry.responseHeaders || {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') return text(value).toLowerCase().split(';')[0]
  }
  return ''
}

function authSource(entry: RawApiEvidenceEntry): ApiStrategyNote['authSource'] {
  const headerKeys = Object.keys(entry.requestHeaders || {}).map((key) => key.toLowerCase())
  if (headerKeys.some((key) => key === 'authorization')) return 'bearer'
  if (headerKeys.some((key) => /csrf|xsrf/.test(key))) return 'csrf'
  if (headerKeys.some((key) => key === 'cookie')) return 'cookie'
  const parsed = safeUrl(entry.url)
  if (parsed && [...parsed.searchParams.keys()].some((key) => SENSITIVE_KEY_RE.test(key))) return 'runtime_token'
  return 'none_observed'
}

function riskOf(entry: RawApiEvidenceEntry, request: ApiValueShape): ApiCandidateRisk {
  const method = text(entry.method).toUpperCase() || 'GET'
  const probe = `${entry.url || ''} ${request.graphqlOperationName}`
  if (request.graphqlOperationType === 'mutation') return 'write'
  if (WRITE_SIGNAL_RE.test(probe)) return 'write'
  if (request.kind !== 'graphql' && method === 'POST' && WRITE_BODY_SIGNAL_RE.test(text(entry.requestBodyPreview))) return 'write'
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'read'
  if (READ_SIGNAL_RE.test(probe) || request.keys.some((key) => /page|query|search|filter|sort|limit|offset|cursor/i.test(key))) return 'read'
  return 'unknown'
}

function fixtureFor(entry: RawApiEvidenceEntry, response: ApiResponseShape, verdict: ApiCandidateVerdict): ApiVerificationFixture | null {
  if (verdict === 'noise' || verdict === 'blocked' || response.kind === 'empty' || response.kind === 'text') return null
  const requiredPaths = response.listPath && response.listPath !== '$'
    ? [response.listPath]
    : response.topLevelKeys.slice(0, 8)
  const itemPrefix = response.listPath
    ? response.listPath === '$' ? '$.*.' : `${response.listPath}.*.`
    : '$.'
  const types = Object.fromEntries(Object.entries(response.valueTypes).slice(0, 12).map(([key, type]) => [`${itemPrefix}${key}`, type]))
  const identityKey = response.itemKeys.find((key) => /^(?:id|.*id|key|name|title)$/i.test(key)) || response.itemKeys[0] || ''
  const notEmpty = identityKey ? [`${itemPrefix}${identityKey}`] : []
  const mustBeTruthy = response.listPath
    ? response.rowCount != null && response.rowCount > 0 ? requiredPaths.slice(0, 3) : []
    : (() => {
        const parsed = tryParseJson(text(entry.responsePreview))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
        const record = parsed as Record<string, unknown>
        return requiredPaths.filter((path) => Boolean(record[path.replace(/^\$\./, '')])).slice(0, 3)
      })()
  return {
    source: 'captured_response',
    status: typeof entry.status === 'number' ? [entry.status] : [],
    contentTypes: contentType(entry) ? [contentType(entry)] : [],
    rowCount: response.rowCount == null ? null : { min: response.rowCount > 0 ? 1 : 0, max: Math.max(response.rowCount * 2, response.rowCount + 10) },
    requiredPaths,
    types,
    notEmpty,
    // Authentication/HTML failures are classified at the response envelope,
    // rather than forbidding words that can legitimately occur in search data.
    mustNotContain: [],
    mustBeTruthy,
  }
}

export function analyzeApiEvidenceEntry(
  entry: RawApiEvidenceEntry,
  sourceSteps: string[] = [],
): ApiEndpointEvidence {
  const identity = endpointIdentity(entry)
  const request = requestShape(entry)
  const response = responseShape(entry)
  const ct = contentType(entry)
  const status = typeof entry.status === 'number' && Number.isFinite(entry.status) ? entry.status : null
  const probe = `${entry.url || ''} ${entry.requestBodyPreview || ''}`
  const signals: string[] = []
  let score = 0

  if (DATA_URL_RE.test(text(entry.url))) { score += 4; signals.push('api_url') }
  if (/json|graphql/.test(ct)) { score += 4; signals.push('json_content_type') }
  if (status != null && status >= 200 && status < 300) { score += 3; signals.push('http_success') }
  if (response.kind === 'array' || response.kind === 'object') { score += 4; signals.push('structured_response') }
  if (response.listPath) { score += 4; signals.push('list_shape') }
  if (response.itemKeys.length > 0) { score += 2; signals.push('item_fields') }
  if (identity.queryKeys.length > 0 || request.keys.length > 0) { score += 2; signals.push('parameterized') }
  if (request.kind === 'graphql') { score += 2; signals.push(`graphql_${request.graphqlOperationType || 'operation'}`) }
  const staticJsonAsset = STATIC_JSON_ASSET_RE.test(text(entry.url)) && !/\/(?:api|graphql|rest|rpc)\//i.test(identity.path)
  if (STATIC_RE.test(text(entry.url)) || staticJsonAsset) { score -= 20; signals.push('static_asset') }
  if (TELEMETRY_RE.test(probe)) { score -= 18; signals.push('telemetry') }
  if (/text\/html/.test(ct) && response.kind === 'text') { score -= 5; signals.push('html_response') }
  if (status != null && BLOCKED_STATUS.has(status)) { score -= 12; signals.push(`blocked_status:${status}`) }
  if (isApiResponseFailure(text(entry.responsePreview))) { score -= 12; signals.push('blocked_payload') }

  const blocked = signals.some((signal) => signal.startsWith('blocked_'))
  const noise = signals.includes('static_asset') || signals.includes('telemetry')
  const verdict: ApiCandidateVerdict = blocked
    ? 'blocked'
    : noise
      ? 'noise'
      : score >= 10
        ? 'likely_data'
        : score >= 4
          ? 'maybe_data'
          : 'noise'
  const auth = authSource(entry)
  const risk = riskOf(entry, request)
  const suggestedStrategy: ApiStrategy = verdict === 'noise'
    ? 'NO_USABLE_API'
    : auth === 'none_observed'
      ? 'PUBLIC_API'
      : (auth === 'cookie' || auth === 'csrf' || auth === 'bearer')
        ? 'COOKIE_API'
        : 'PAGE_FETCH'
  const strategyNote: ApiStrategyNote = {
    strategy: suggestedStrategy,
    contract: blocked ? 'blocked' : (verdict === 'noise' ? 'none' : 'internal_unverified'),
    authSource: blocked && auth === 'none_observed' ? 'unknown' : auth,
    replayStatus: blocked ? 'blocked' : 'not_run',
    replayRequired: verdict === 'likely_data' || verdict === 'maybe_data' || verdict === 'blocked',
    evidenceIds: [identity.evidenceId],
    reasons: unique([
      ...signals,
      risk === 'write' ? 'write_like_request_never_auto_replay' : '',
      verdict === 'likely_data' || verdict === 'maybe_data' ? 'candidate_score_is_not_replay_proof' : '',
    ]),
  }

  return {
    ...identity,
    method: text(entry.method).toUpperCase() || 'GET',
    status,
    contentType: ct,
    sourceSteps: unique(sourceSteps),
    requestShape: request,
    responseShape: response,
    verdict,
    score,
    signals: unique(signals),
    risk,
    strategyNote,
    verificationFixture: fixtureFor(entry, response, verdict),
    observedUrl: text(entry.url),
  }
}

function mergeEvidence(left: ApiEndpointEvidence, right: ApiEndpointEvidence): ApiEndpointEvidence {
  const preferred = right.score > left.score ? right : left
  const other = preferred === left ? right : left
  return {
    ...preferred,
    sourceSteps: unique([...left.sourceSteps, ...right.sourceSteps]),
    signals: unique([...left.signals, ...right.signals]),
    strategyNote: {
      ...preferred.strategyNote,
      evidenceIds: unique([...left.strategyNote.evidenceIds, ...right.strategyNote.evidenceIds]),
      reasons: unique([...left.strategyNote.reasons, ...right.strategyNote.reasons]),
    },
    verificationFixture: preferred.verificationFixture || other.verificationFixture,
  }
}

function captureContractDigest(candidate: ApiEndpointEvidence): string {
  return createHash('sha256').update(JSON.stringify({
    origin: candidate.origin, path: candidate.path, method: candidate.method, status: candidate.status,
    contentType: candidate.contentType,
    queryKeys: [...candidate.queryKeys].sort(),
    requestShape: { ...candidate.requestShape, keys: [...candidate.requestShape.keys].sort() },
    responseKind: candidate.responseShape.kind, rootKeys: [...candidate.responseShape.topLevelKeys].sort(),
    listPath: candidate.responseShape.listPath, itemKeys: [...candidate.responseShape.itemKeys].sort(),
    valueTypes: Object.fromEntries(Object.entries(candidate.responseShape.valueTypes).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex')
}

export function analyzeApiExplorationWorkflow(result: Record<string, unknown>, previous?: ApiExplorationAnalysisV2): ApiExplorationAnalysisV2 {
  const byFamily = new Map<string, ApiEndpointEvidence>()
  const append = (entries: unknown, sourceStep: string) => {
    if (!Array.isArray(entries)) return
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object' || !text((raw as RawApiEvidenceEntry).url)) continue
      const evidence = analyzeApiEvidenceEntry(raw as RawApiEvidenceEntry, [sourceStep])
      const existing = byFamily.get(evidence.endpointFamily)
      byFamily.set(evidence.endpointFamily, existing ? mergeEvidence(existing, evidence) : evidence)
    }
  }

  const workflow = result as {
    initialNetwork?: { entries?: unknown[] }
    network?: { entries?: unknown[] }
    actions?: Array<{ step?: string; networkDelta?: { entries?: unknown[] } }>
  }
  append(workflow.initialNetwork?.entries, 'initial_network')
  append(workflow.network?.entries, 'final_network')
  for (const action of workflow.actions || []) append(action.networkDelta?.entries, text(action.step) || 'action')

  const candidates = [...byFamily.values()].sort((left, right) => {
    const verdictOrder: Record<ApiCandidateVerdict, number> = { likely_data: 3, maybe_data: 2, blocked: 1, noise: 0 }
    return verdictOrder[right.verdict] - verdictOrder[left.verdict]
      || right.score - left.score
      || left.endpointFamily.localeCompare(right.endpointFamily)
  })
  const count = (verdict: ApiCandidateVerdict) => candidates.filter((candidate) => candidate.verdict === verdict).length
  const likelyDataCount = count('likely_data')
  const maybeDataCount = count('maybe_data')
  const blockedCount = count('blocked')
  const noiseCount = count('noise')
  const recommendedNextProbe: ApiExplorationAnalysisV2['recommendedNextProbe'] = likelyDataCount > 0
    ? 'replay_top_candidate'
    : maybeDataCount > 0
      ? 'capture_safe_read_action'
      : blockedCount > 0
        ? 'resolve_auth'
        : 'no_usable_api'

  let analysis: ApiExplorationAnalysisV2 = {
    schemaVersion: 2,
    candidates,
    likelyDataCount,
    maybeDataCount,
    noiseCount,
    blockedCount,
    recommendedNextProbe,
  }
  // An additional probe adds evidence; it must not erase a replay already made
  // for the same origin, operation and response contract in this exploration.
  for (const prior of previous?.candidates || []) {
    if (!prior.replay || prior.risk !== 'read') continue
    const current = candidates.find(candidate => candidate.evidenceId === prior.evidenceId)
    if (!current || current.risk !== 'read' || current.verdict === 'blocked' || current.verdict === 'noise') continue
    if (captureContractDigest(current) === (prior.replayCaptureDigest || captureContractDigest(prior))) analysis = applyApiReplayEvidence(analysis, current.evidenceId, prior.replay)
  }
  return analysis
}

export function applyApiReplayEvidence(
  analysis: ApiExplorationAnalysisV2,
  evidenceId: string,
  replay: ApiReplayEvidence,
): ApiExplorationAnalysisV2 {
  const candidates = analysis.candidates.map((candidate) => {
    if (candidate.evidenceId !== evidenceId) return candidate
    const verified = replay.ok
      && replay.status != null
      && replay.status >= 200
      && replay.status < 300
      && replay.nonEmpty
      && ['object', 'array'].includes(replay.responseShape.kind)
    const strategy: ApiStrategy = verified
      ? replay.transport === 'direct_no_auth'
        ? 'PUBLIC_API'
        : ['cookie', 'csrf', 'bearer'].includes(candidate.strategyNote.authSource)
          ? 'COOKIE_API'
          : candidate.strategyNote.authSource === 'runtime_token'
            ? 'PAGE_FETCH'
            : 'COOKIE_API'
      : candidate.strategyNote.strategy
    return {
      ...candidate,
      replay,
      // Replay may have a complete JSON shape while the original CDP capture
      // was truncated. Compare later probes with that capture, not its replay.
      replayCaptureDigest: candidate.replayCaptureDigest || captureContractDigest(candidate),
      responseShape: verified ? replay.responseShape : candidate.responseShape,
      verificationFixture: replay.verificationFixture || candidate.verificationFixture,
      strategyNote: {
        ...candidate.strategyNote,
        strategy,
        contract: verified ? 'stable' as const : candidate.strategyNote.contract,
        authSource: verified && replay.transport === 'direct_no_auth'
          ? 'none_observed' as const
          : verified && candidate.strategyNote.authSource === 'none_observed'
            ? 'cookie' as const
            : candidate.strategyNote.authSource,
        replayStatus: verified ? 'verified' as const : 'failed' as const,
        replayRequired: !verified,
        reasons: unique([
          ...candidate.strategyNote.reasons,
          verified ? `replay_verified:${replay.transport}` : `replay_failed:${replay.transport}`,
          replay.errorCode ? `replay_error:${replay.errorCode}` : '',
        ]),
      },
    }
  })
  return { ...analysis, candidates }
}

export function findApiEvidenceEntry(
  result: Record<string, unknown>,
  evidenceId: string,
): RawApiEvidenceEntry | null {
  const entries: RawApiEvidenceEntry[] = []
  const append = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (entry && typeof entry === 'object' && text((entry as RawApiEvidenceEntry).url)) entries.push(entry as RawApiEvidenceEntry)
    }
  }
  const workflow = result as {
    initialNetwork?: { entries?: unknown[] }
    network?: { entries?: unknown[] }
    actions?: Array<{ networkDelta?: { entries?: unknown[] } }>
  }
  append(workflow.initialNetwork?.entries)
  append(workflow.network?.entries)
  for (const action of workflow.actions || []) append(action.networkDelta?.entries)
  return entries
    .filter((entry) => analyzeApiEvidenceEntry(entry).evidenceId === evidenceId)
    .sort((left, right) => analyzeApiEvidenceEntry(right).score - analyzeApiEvidenceEntry(left).score)[0] || null
}
