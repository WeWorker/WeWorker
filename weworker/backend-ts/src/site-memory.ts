import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger } from './logger.js'
import {
  analyzeApiEvidenceEntry,
  analyzeApiExplorationWorkflow,
  type ApiEndpointEvidence,
  type ApiExplorationAnalysisV2,
} from './api-exploration-evidence.js'

const log = createLogger('site-memory')

const SITE_MEMORY_ENV = 'WEWORKER_SITE_MEMORY_FILE'
const SITE_MEMORY_SCHEMA_VERSION = 1

interface WorkflowActionEntry {
  url?: string
  method?: string
  status?: number
  requestBodyPreview?: string
  requestBodyFullSize?: number
  requestBodyTruncated?: boolean
  requestEvidence?: RequestBodyEvidence
  responsePreview?: string
  responseContentType?: string
}

interface ActionCaptureEntry extends WorkflowActionEntry {
  intercepted?: boolean
  blockedReason?: string
  aiIsPrimary?: boolean
  aiPurpose?: string
  aiWhy?: string
  userSelectedPrimary?: boolean
}

interface WorkflowAction {
  step?: string
  result?: Record<string, unknown>
  networkDelta?: {
    entries?: WorkflowActionEntry[]
  }
}

interface WorkflowResult {
  schemaVersion?: string
  tabId?: number
  opened?: { url?: string }
  pageStateBefore?: { url?: string }
  resultPageState?: { url?: string; listCandidates?: number; paginationCandidates?: number }
  pageStateAfter?: { url?: string }
  verdict?: { pattern?: string; recommendedStrategy?: string; reason?: string }
  workflow?: { version?: string }
  actions?: WorkflowAction[]
  network?: { entries?: WorkflowActionEntry[] }
  analysisV2?: ApiExplorationAnalysisV2
}

interface ActionCaptureResult {
  site?: string
  actionName?: string
  mode?: string
  workflow?: { version?: string }
  capturedActions?: ActionCaptureEntry[]
  recommendation?: { toolName?: string }
}

export interface SiteApiCandidate {
  url: string
  method: string
  status?: number
  requestBodyPreview?: string
  requestEvidence?: RequestBodyEvidence
  responsePreview?: string
  responseContentType?: string
  responseHints?: ActionResponseHints
  sourceSteps: string[]
  apiEvidence?: ApiEndpointEvidence
}

export interface ActionResponseHints {
  topLevelKeys: string[]
  listPath: string
  itemKeys: string[]
  idLikeKeys: string[]
  displayLikeKeys: string[]
  availabilityLikeKeys: string[]
  preferredIdKey: string
  preferredDisplayKey: string
  preferredAvailabilityKey: string
}

export interface StoredActionCandidate {
  actionName: string
  mode: string
  toolName: string
  url: string
  method: string
  requestBodyPreview?: string
  requestEvidence?: RequestBodyEvidence
  responsePreview?: string
  responseContentType?: string
  responseHints?: ActionResponseHints
  intercepted: boolean
  blockedReason?: string
  aiIsPrimary?: boolean
  aiPurpose?: string
  aiWhy?: string
  primarySelection?: 'user' | 'ai' | 'heuristic' | ''
  capturedAt: string
  sourceWorkflowVersion: string
  apiEvidence?: ApiEndpointEvidence
}

export interface RequestBodyEvidence {
  version: 'request-evidence-v1'
  bodyKind: 'none' | 'json' | 'form' | 'opaque'
  bodyShape: Record<string, unknown> | null
  bodyKeys: string[]
  bodyFullSize: number
  bodyTruncated: boolean
  bodyOmitted: boolean
}

export interface ActionCandidateQuality {
  score: number
  signals: string[]
}

export interface ActionToolEvidenceSummary {
  toolName: string
  actionName: string
  historyCount: number
  selectedUrl: string
  selectedMethod: string
  selectedScore: number
  selectedSignals: string[]
  candidates: Array<{
    url: string
    method: string
    capturedAt: string
    score: number
    signals: string[]
    selected: boolean
  }>
}

export interface ActionEvidenceSummary {
  historyCount: number
  bestViewCount: number
  toolSummaries: ActionToolEvidenceSummary[]
}

export interface SiteMemoryRecord {
  siteKey: string
  siteHost: string
  siteOrigin: string
  updatedAt: string
  firstCapturedAt: string
  captureCount: number
  workflowVersion: string
  workflowVersionsSeen: string[]
  lastSourceUrl: string
  canonicalEntryUrl: string
  canonicalResultUrl: string
  verdictPattern: string
  recommendedStrategy: string
  verdictReason: string
  search: {
    executed: boolean
    action: string
    keywordSeed: string
  }
  resultSignals: {
    listCandidates: number
    paginationCandidates: number
  }
  listApiCandidates: SiteApiCandidate[]
  apiAnalysisV2?: ApiExplorationAnalysisV2
  actionApiCandidates: StoredActionCandidate[]
  actionCaptureHistory?: StoredActionCandidate[]
  actionEvidenceSummary?: ActionEvidenceSummary
  detailHints: {
    mode: string
    bestCandidateHref: string
    bestCandidateText: string
    networkDetailCandidates: string[]
  }
  pagination: {
    attempted: boolean
    verified: boolean
    mode: string
    targetPage: number | null
    activePageBefore: number | null
    activePageAfter: number | null
    reason: string
  }
  rawSummary: {
    tabId: number | null
    resultPageUrl: string
    finalPageUrl: string
  }
}

interface SiteMemoryStore {
  version: number
  sites: Record<string, SiteMemoryRecord>
}

function defaultStore(): SiteMemoryStore {
  return {
    version: SITE_MEMORY_SCHEMA_VERSION,
    sites: {},
  }
}

function resolveSiteMemoryFile(): string {
  const override = (process.env[SITE_MEMORY_ENV] || '').trim()
  if (override) return override
  return path.join(os.homedir(), '.weworker', 'site-memory.json')
}

function resolveSiteMemoryDir(): string {
  return path.dirname(resolveSiteMemoryFile())
}

function readStore(): SiteMemoryStore {
  try {
    const raw = fs.readFileSync(resolveSiteMemoryFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SiteMemoryStore>
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sites !== 'object' || parsed.sites === null) {
      return defaultStore()
    }
    return {
      version: SITE_MEMORY_SCHEMA_VERSION,
      sites: parsed.sites as Record<string, SiteMemoryRecord>,
    }
  } catch {
    return defaultStore()
  }
}

function writeStore(store: SiteMemoryStore): void {
  fs.mkdirSync(resolveSiteMemoryDir(), { recursive: true })
  fs.writeFileSync(resolveSiteMemoryFile(), JSON.stringify(store, null, 2), 'utf8')
}

function safeUrl(input: unknown): string {
  return typeof input === 'string' ? input.trim() : ''
}

const TRUNCATION_MARKER_RE = /(?:\.{0,3}\[truncated\]|…\s*\[truncated\])\s*$/i

function requestValueShape(value: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 8) return { type: 'unknown' }
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length > 0 ? requestValueShape(value[0], depth + 1) : { type: 'unknown' } }
  }
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, requestValueShape(nested, depth + 1)])),
    }
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (typeof value === 'string') return { type: 'string' }
  return { type: 'unknown' }
}

function requestBodyKeys(shape: Record<string, unknown> | null): string[] {
  if (shape?.type !== 'object' || !shape.properties || typeof shape.properties !== 'object') return []
  return Object.keys(shape.properties as Record<string, unknown>).sort()
}

function normalizeRequestBodyEvidence(entry: WorkflowActionEntry | StoredActionCandidate): RequestBodyEvidence {
  const supplied = entry.requestEvidence
  if (supplied && typeof supplied === 'object') {
    const bodyTruncated = Boolean(supplied.bodyTruncated)
    const bodyOmitted = bodyTruncated || Boolean(supplied.bodyOmitted)
    const bodyShape = bodyOmitted || !supplied.bodyShape || typeof supplied.bodyShape !== 'object' ? null : supplied.bodyShape
    return {
      version: 'request-evidence-v1',
      bodyKind: bodyOmitted ? 'opaque' : supplied.bodyKind,
      bodyShape,
      bodyKeys: requestBodyKeys(bodyShape),
      bodyFullSize: Number.isFinite(Number(supplied.bodyFullSize)) ? Number(supplied.bodyFullSize) : 0,
      bodyTruncated,
      bodyOmitted,
    }
  }
  const text = safeUrl(entry.requestBodyPreview)
  if (!text) return { version: 'request-evidence-v1', bodyKind: 'none', bodyShape: null, bodyKeys: [], bodyFullSize: 0, bodyTruncated: false, bodyOmitted: false }
  const truncated = Boolean((entry as WorkflowActionEntry).requestBodyTruncated)
    || TRUNCATION_MARKER_RE.test(text)
    || (Number.isFinite(Number((entry as WorkflowActionEntry).requestBodyFullSize)) && Number((entry as WorkflowActionEntry).requestBodyFullSize) > text.length)
  if (truncated) {
    return {
      version: 'request-evidence-v1', bodyKind: 'opaque', bodyShape: null, bodyKeys: [],
      bodyFullSize: Number((entry as WorkflowActionEntry).requestBodyFullSize) || text.length,
      bodyTruncated: true, bodyOmitted: true,
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    const bodyShape = requestValueShape(parsed)
    return { version: 'request-evidence-v1', bodyKind: 'json', bodyShape, bodyKeys: requestBodyKeys(bodyShape), bodyFullSize: text.length, bodyTruncated: false, bodyOmitted: false }
  } catch {
    if (text.startsWith('{') || text.startsWith('[')) {
      return { version: 'request-evidence-v1', bodyKind: 'opaque', bodyShape: null, bodyKeys: [], bodyFullSize: text.length, bodyTruncated: false, bodyOmitted: true }
    }
  }
  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(text)) {
    const bodyShape = requestValueShape(Object.fromEntries(new URLSearchParams(text)))
    return { version: 'request-evidence-v1', bodyKind: 'form', bodyShape, bodyKeys: requestBodyKeys(bodyShape), bodyFullSize: text.length, bodyTruncated: false, bodyOmitted: false }
  }
  return { version: 'request-evidence-v1', bodyKind: 'opaque', bodyShape: null, bodyKeys: [], bodyFullSize: text.length, bodyTruncated: false, bodyOmitted: true }
}

function structuralUrl(input: unknown): string {
  const value = safeUrl(input)
  if (!value) return ''
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, ':value')
    if (url.hash.includes('?')) {
      const queryIndex = url.hash.indexOf('?')
      const hashPrefix = url.hash.slice(0, queryIndex + 1)
      const params = new URLSearchParams(url.hash.slice(queryIndex + 1))
      for (const key of [...params.keys()]) params.set(key, ':value')
      url.hash = `${hashPrefix}${params.toString()}`
    }
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return '[invalid-url]'
  }
}

function parseUrl(input: string): URL | null {
  if (!input) return null
  try {
    return new URL(input)
  } catch {
    return null
  }
}

function toSiteIdentity(result: WorkflowResult): { siteKey: string; siteHost: string; siteOrigin: string; sourceUrl: string } | null {
  const candidates = [
    safeUrl(result.opened?.url),
    safeUrl(result.resultPageState?.url),
    safeUrl(result.pageStateAfter?.url),
    safeUrl(result.pageStateBefore?.url),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const parsed = parseUrl(candidate)
    if (!parsed) continue
    return {
      siteKey: parsed.hostname,
      siteHost: parsed.hostname,
      siteOrigin: parsed.origin,
      sourceUrl: candidate,
    }
  }

  return null
}

function isNoiseProbe(probe: string): boolean {
  return /globalsearch\.html|static\/tpls|systemmanage\/getsysvaluebykey|getmappinguser|getenv|menu\/getmenus|gettotalitems|horn_info|contact_users|append_keyword|is_new_transfer/.test(probe)
}

function isLikelyListApiEntry(entry: WorkflowActionEntry): boolean {
  const probe = `${entry.url || ''} ${entry.requestBodyPreview || ''}`.toLowerCase()
  if (!probe || isNoiseProbe(probe)) return false
  if (/gerequestsdetail|getstatuslistbyrequestid|requestdetail|eventdetail|changedetail|problemdetail/.test(probe)) return false
  if (/getcilist|getcigroup/.test(probe)) return true
  if (/(list|search|query|get[a-z0-9]*list|currentpage|pagesize|totalcount|keyword|history=|rows|records)/.test(probe)) {
    return true
  }

  // Passive exploration may expose a useful collection endpoint without a
  // conventional "list" name. A successful GET returning JSON is still a
  // safe, reusable read candidate (for example, /api/projects?status=active).
  const method = safeUrl(entry.method).toUpperCase() || 'GET'
  const contentType = safeUrl(entry.responseContentType).toLowerCase()
  const responsePreview = safeUrl(entry.responsePreview).trim()
  const hasJsonResponse = /(?:application|text)\/json/.test(contentType)
    || responsePreview.startsWith('{')
    || responsePreview.startsWith('[')
  return method === 'GET' && hasJsonResponse
}

function responseHintsFromApiShape(shape: ApiEndpointEvidence['responseShape']): ActionResponseHints | undefined {
  if (!shape || (shape.kind !== 'object' && shape.kind !== 'array')) return undefined
  const itemKeys = [...(shape.itemKeys || [])]
  const idLikeKeys = itemKeys.filter((key) => /(^id$|id$|code$|key$|uuid$)/i.test(key))
  const displayLikeKeys = itemKeys.filter((key) => /(name|title|label|code|display|desc|room)/i.test(key))
  const availabilityLikeKeys = itemKeys.filter((key) => /(availability|schedule|calendar|slot|time|map)/i.test(key))
  return {
    topLevelKeys: [...(shape.topLevelKeys || [])],
    listPath: shape.listPath || '',
    itemKeys,
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey: pickPreferredIdKey(idLikeKeys),
    preferredDisplayKey: pickPreferredDisplayKey(displayLikeKeys),
    preferredAvailabilityKey: pickPreferredAvailabilityKey(availabilityLikeKeys),
  }
}

function sanitizeApiAnalysisForPersistence(analysis: ApiExplorationAnalysisV2): ApiExplorationAnalysisV2 {
  return {
    ...analysis,
    candidates: analysis.candidates.map((candidate) => ({
      ...candidate,
      observedUrl: structuralUrl(candidate.observedUrl),
      strategyNote: {
        ...candidate.strategyNote,
        reasons: candidate.strategyNote.reasons.map(structuralizeTextUrls),
      },
    })),
  }
}

function structuralizeTextUrls(value: string): string {
  return safeUrl(value).replace(/https?:\/\/[^\s，。；）)]+/g, (url) => structuralUrl(url))
}

function syntheticRequestPreview(candidate: ApiEndpointEvidence): string {
  if (!candidate.requestShape.keys.length) return ''
  return JSON.stringify(Object.fromEntries(candidate.requestShape.keys.map((key) => [key, '<value>'])))
}

function candidateFromAnalysis(candidate: ApiEndpointEvidence): SiteApiCandidate {
  const structuralRequest = syntheticRequestPreview(candidate)
  return {
    url: structuralUrl(candidate.observedUrl),
    method: candidate.method,
    status: candidate.status ?? undefined,
    requestEvidence: normalizeRequestBodyEvidence({ requestBodyPreview: structuralRequest }),
    responseContentType: candidate.contentType,
    responseHints: responseHintsFromApiShape(candidate.replay?.responseShape || candidate.responseShape),
    sourceSteps: candidate.sourceSteps.length ? candidate.sourceSteps : ['analysis_v2'],
    apiEvidence: candidate,
  }
}

function extractListApiCandidates(result: WorkflowResult, analysis: ApiExplorationAnalysisV2): SiteApiCandidate[] {
  const rankedSteps = ['search', 'refine_search', 'pagination']
  const byKey = new Map<string, SiteApiCandidate>()
  const actions = Array.isArray(result.actions) ? result.actions : []

  for (const step of rankedSteps) {
    const action = actions.find((item) => item?.step === step)
    const entries = action?.networkDelta?.entries || []
    for (const entry of entries) {
      if (!isLikelyListApiEntry(entry)) continue
      const url = safeUrl(entry.url)
      if (!url) continue
      const method = safeUrl(entry.method) || 'GET'
      const key = `${method} ${url}`
      const existing = byKey.get(key)
      if (existing) {
        if (!existing.sourceSteps.includes(step)) existing.sourceSteps.push(step)
        existing.requestEvidence = pickRicherRequestEvidence(
          existing.requestEvidence || normalizeRequestBodyEvidence(existing),
          normalizeRequestBodyEvidence(entry),
        )
        existing.responseHints = mergeActionResponseHints(existing.responseHints, extractActionResponseHints(entry.responsePreview))
        existing.responseContentType ||= safeUrl(entry.responseContentType)
        if (existing.status == null && typeof entry.status === 'number') existing.status = entry.status
        continue
      }
      byKey.set(key, {
        url: structuralUrl(url),
        method,
        status: typeof entry.status === 'number' ? entry.status : undefined,
        requestEvidence: normalizeRequestBodyEvidence(entry),
        responseContentType: safeUrl(entry.responseContentType),
        responseHints: extractActionResponseHints(entry.responsePreview),
        sourceSteps: [step],
      })
    }
  }

  if (byKey.size === 0) {
    for (const entry of result.network?.entries || []) {
      if (!isLikelyListApiEntry(entry)) continue
      const url = safeUrl(entry.url)
      if (!url) continue
      const method = safeUrl(entry.method) || 'GET'
      const key = `${method} ${url}`
      if (!byKey.has(key)) {
        byKey.set(key, {
          url: structuralUrl(url),
          method,
          status: typeof entry.status === 'number' ? entry.status : undefined,
          requestEvidence: normalizeRequestBodyEvidence(entry),
          responseContentType: safeUrl(entry.responseContentType),
          responseHints: extractActionResponseHints(entry.responsePreview),
          sourceSteps: ['final_network'],
        })
      } else {
        const existing = byKey.get(key)
        if (!existing) continue
        existing.requestEvidence = pickRicherRequestEvidence(
          existing.requestEvidence || normalizeRequestBodyEvidence(existing),
          normalizeRequestBodyEvidence(entry),
        )
        existing.responseHints = mergeActionResponseHints(existing.responseHints, extractActionResponseHints(entry.responsePreview))
        existing.responseContentType ||= safeUrl(entry.responseContentType)
        if (existing.status == null && typeof entry.status === 'number') existing.status = entry.status
      }
    }
  }

  if (byKey.size === 0) {
    for (const candidate of analysis.candidates) {
      if (candidate.verdict === 'noise' || candidate.risk !== 'read' || !candidate.observedUrl) continue
      byKey.set(`${candidate.method} ${candidate.observedUrl}`, candidateFromAnalysis(candidate))
    }
  }

  return [...byKey.values()].map((candidate) => {
    const endpointFamily = analyzeApiEvidenceEntry(candidate, candidate.sourceSteps).endpointFamily
    const apiEvidence = analysis.candidates.find((item) => item.endpointFamily === endpointFamily)
    return apiEvidence ? { ...candidate, apiEvidence } : candidate
  }).sort((a, b) => {
    const replayOrder = (candidate: SiteApiCandidate) => candidate.apiEvidence?.strategyNote.replayStatus === 'verified'
      ? 2
      : candidate.apiEvidence?.strategyNote.replayStatus === 'failed'
        ? 1
        : 0
    const aReplay = replayOrder(a)
    const bReplay = replayOrder(b)
    if (aReplay !== bReplay) return bReplay - aReplay
    const aVerdict = a.apiEvidence?.verdict === 'likely_data' ? 2 : (a.apiEvidence?.verdict === 'maybe_data' ? 1 : 0)
    const bVerdict = b.apiEvidence?.verdict === 'likely_data' ? 2 : (b.apiEvidence?.verdict === 'maybe_data' ? 1 : 0)
    if (aVerdict !== bVerdict) return bVerdict - aVerdict
    const scoreDifference = Number(b.apiEvidence?.score || 0) - Number(a.apiEvidence?.score || 0)
    if (scoreDifference !== 0) return scoreDifference
    const aCanonical = /getcilist|getcigroup/i.test(a.url) ? 1 : 0
    const bCanonical = /getcilist|getcigroup/i.test(b.url) ? 1 : 0
    if (aCanonical !== bCanonical) return bCanonical - aCanonical
    return a.url.localeCompare(b.url)
  }).slice(0, 8)
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function deriveSiteMemoryFromWorkflow(result: Record<string, unknown>): SiteMemoryRecord | null {
  const workflowResult = result as WorkflowResult
  const identity = toSiteIdentity(workflowResult)
  if (!identity) return null

  const actions = Array.isArray(workflowResult.actions) ? workflowResult.actions : []
  const searchAction = actions.find((item) => item?.step === 'search')
  const paginationAction = actions.find((item) => item?.step === 'pagination')
  const detailAction = actions.find((item) => item?.step === 'detail')
  const now = new Date().toISOString()
  const rawApiAnalysisV2 = workflowResult.analysisV2?.schemaVersion === 2
    ? workflowResult.analysisV2
    : analyzeApiExplorationWorkflow(result)
  const apiAnalysisV2 = sanitizeApiAnalysisForPersistence(rawApiAnalysisV2)
  const persistedUrl = structuralUrl

  return {
    siteKey: identity.siteKey,
    siteHost: identity.siteHost,
    siteOrigin: identity.siteOrigin,
    updatedAt: now,
    firstCapturedAt: now,
    captureCount: 1,
    workflowVersion: asString(workflowResult.workflow?.version),
    workflowVersionsSeen: asString(workflowResult.workflow?.version) ? [asString(workflowResult.workflow?.version)] : [],
    lastSourceUrl: persistedUrl(identity.sourceUrl),
    canonicalEntryUrl: persistedUrl(workflowResult.pageStateBefore?.url),
    canonicalResultUrl: persistedUrl(workflowResult.resultPageState?.url) || persistedUrl(workflowResult.pageStateAfter?.url),
    verdictPattern: asString(workflowResult.verdict?.pattern),
    recommendedStrategy: asString(workflowResult.verdict?.recommendedStrategy),
    verdictReason: structuralizeTextUrls(asString(workflowResult.verdict?.reason)),
    search: {
      executed: Boolean(searchAction?.result?.executed),
      action: asString(searchAction?.result?.action),
      keywordSeed: '',
    },
    resultSignals: {
      listCandidates: Number(workflowResult.resultPageState?.listCandidates || 0),
      paginationCandidates: Number(workflowResult.resultPageState?.paginationCandidates || 0),
    },
    listApiCandidates: extractListApiCandidates(workflowResult, apiAnalysisV2),
    apiAnalysisV2,
    actionApiCandidates: [],
    detailHints: {
      mode: asString(detailAction?.result?.mode),
      bestCandidateHref: asString((detailAction?.result as Record<string, unknown> | undefined)?.bestCandidate && (detailAction?.result as Record<string, unknown>).bestCandidate && ((detailAction?.result as Record<string, unknown>).bestCandidate as Record<string, unknown>).href),
      bestCandidateText: '',
      networkDetailCandidates: Array.isArray((detailAction?.result as Record<string, unknown> | undefined)?.networkDetailCandidates)
        ? ((detailAction?.result as Record<string, unknown>).networkDetailCandidates as unknown[]).map(structuralUrl).filter(Boolean)
        : [],
    },
    pagination: {
      attempted: Boolean(paginationAction?.result?.executed),
      verified: Boolean(paginationAction?.result?.verified),
      mode: asString(paginationAction?.result?.mode),
      targetPage: asNumber(paginationAction?.result?.targetPage),
      activePageBefore: asNumber(paginationAction?.result?.activePageBefore),
      activePageAfter: asNumber(paginationAction?.result?.activePageAfter),
      reason: asString(paginationAction?.result?.reason),
    },
    rawSummary: {
      tabId: asNumber(workflowResult.tabId),
      resultPageUrl: persistedUrl(workflowResult.resultPageState?.url),
      finalPageUrl: persistedUrl(workflowResult.pageStateAfter?.url),
    },
  }
}

export function saveSiteMemoryFromWorkflow(result: Record<string, unknown>): SiteMemoryRecord | null {
  const derived = deriveSiteMemoryFromWorkflow(result)
  if (!derived) return null

  const store = readStore()
  const existingRecord = store.sites[derived.siteKey]
  const existing = existingRecord ? enrichSiteMemoryRecord(existingRecord) : undefined
  const workflowVersionsSeen = new Set<string>(existing?.workflowVersionsSeen || [])
  if (derived.workflowVersion) workflowVersionsSeen.add(derived.workflowVersion)
  const isV2Memory = derived.apiAnalysisV2?.schemaVersion === 2
    || derived.workflowVersion === 'exploration-evidence-v2-persisted'

  // 动作证据（含写操作捕获）是站点级沉淀，不随某次被动探索的保存被清除：
  // V2 过滤只约束生成期消费（readOnlyV2Memory），存储层永远保留已有动作证据，
  // 且随 merged 记录带回任务内存，供写工具生成（三层确认门约束）使用。
  const existingActionApiCandidates = existing?.actionApiCandidates || []
  const existingActionCaptureHistory = existing?.actionCaptureHistory
    || existing?.actionApiCandidates
    || derived.actionApiCandidates
    || []
  const merged: SiteMemoryRecord = {
    ...derived,
    firstCapturedAt: existing?.firstCapturedAt || derived.firstCapturedAt,
    captureCount: Number(existing?.captureCount || 0) + 1,
    workflowVersionsSeen: [...workflowVersionsSeen],
    actionApiCandidates: existingActionApiCandidates,
    actionCaptureHistory: existingActionCaptureHistory,
    actionEvidenceSummary: existing?.actionEvidenceSummary,
  }

  store.sites[derived.siteKey] = merged
  writeStore(store)
  log.info('site memory updated', { siteKey: merged.siteKey, workflowVersion: merged.workflowVersion })
  return merged
}

export function saveSiteMemoryFromActionCapture(result: Record<string, unknown>): SiteMemoryRecord | null {
  const capture = result as ActionCaptureResult
  const siteKey = normalizeSiteLookup(asString(capture.site))
  if (!siteKey) return null

  const store = readStore()
  const existingRecord = store.sites[siteKey]
  const existing = existingRecord ? enrichSiteMemoryRecord(existingRecord) : undefined
  const now = new Date().toISOString()
  const actionName = asString(capture.actionName) || 'captured_action'
  const mode = asString(capture.mode) || 'intercept'
  const workflowVersion = asString(capture.workflow?.version)
  const toolName = asString(capture.recommendation?.toolName) || `${siteKey}.${actionName}_draft`
  const capturedEntries = Array.isArray(capture.capturedActions) ? capture.capturedActions : []
  const candidate = selectBestActionCaptureEntry(capturedEntries, actionName)
  if (!candidate) return existing || null
  const requestEvidence = normalizeRequestBodyEvidence(candidate)

  const nextActionCandidate: StoredActionCandidate = {
    actionName,
    mode,
    toolName,
    url: structuralUrl(candidate.url),
    method: asString(candidate.method) || 'GET',
    requestEvidence,
    responseContentType: asString(candidate.responseContentType),
    responseHints: extractActionResponseHints(candidate.responsePreview),
    intercepted: Boolean(candidate.intercepted),
    blockedReason: asString(candidate.blockedReason),
    aiIsPrimary: Boolean(candidate.aiIsPrimary),
    aiPurpose: asString(candidate.aiPurpose),
    aiWhy: asString(candidate.aiWhy),
    primarySelection: candidate.userSelectedPrimary ? 'user' : (candidate.aiIsPrimary ? 'ai' : 'heuristic'),
    capturedAt: now,
    sourceWorkflowVersion: workflowVersion,
    apiEvidence: analyzeApiEvidenceEntry(candidate, ['action_capture']),
  }

  const base: SiteMemoryRecord = existing || {
    siteKey,
    siteHost: siteKey,
    siteOrigin: '',
    updatedAt: now,
    firstCapturedAt: now,
    captureCount: 0,
    workflowVersion,
    workflowVersionsSeen: workflowVersion ? [workflowVersion] : [],
    lastSourceUrl: '',
    canonicalEntryUrl: '',
    canonicalResultUrl: '',
    verdictPattern: '',
    recommendedStrategy: '',
    verdictReason: '',
    search: {
      executed: false,
      action: '',
      keywordSeed: '',
    },
    resultSignals: {
      listCandidates: 0,
      paginationCandidates: 0,
    },
    listApiCandidates: [],
    actionApiCandidates: [],
    detailHints: {
      mode: '',
      bestCandidateHref: '',
      bestCandidateText: '',
      networkDetailCandidates: [],
    },
    pagination: {
      attempted: false,
      verified: false,
      mode: '',
      targetPage: null,
      activePageBefore: null,
      activePageAfter: null,
      reason: '',
    },
    rawSummary: {
      tabId: null,
      resultPageUrl: '',
      finalPageUrl: '',
    },
  }

  const existingHistory = Array.isArray(base.actionCaptureHistory) && base.actionCaptureHistory.length > 0
    ? base.actionCaptureHistory
    : (Array.isArray(base.actionApiCandidates) ? base.actionApiCandidates : [])
  const mergedExact = existingHistory.find((item) => isSameStoredActionCandidate(item, nextActionCandidate))
  const canonicalNextCandidate = mergedExact ? mergeStoredActionCandidate(mergedExact, nextActionCandidate) : nextActionCandidate
  const dedupedHistory = existingHistory.filter((item) => !isSameStoredActionCandidate(item, nextActionCandidate))
  const nextHistory = sortActionCaptureHistory([canonicalNextCandidate, ...dedupedHistory]).slice(0, 60)
  const workflowVersionsSeen = new Set<string>(base.workflowVersionsSeen || [])
  if (workflowVersion) workflowVersionsSeen.add(workflowVersion)

  const merged: SiteMemoryRecord = {
    ...base,
    updatedAt: now,
    captureCount: Number(base.captureCount || 0) + 1,
    workflowVersion: workflowVersion || base.workflowVersion,
    workflowVersionsSeen: [...workflowVersionsSeen],
    actionCaptureHistory: nextHistory,
    actionApiCandidates: deriveBestActionCandidates(nextHistory, base.actionApiCandidates),
  }
  merged.actionEvidenceSummary = buildActionEvidenceSummary(merged.actionCaptureHistory || [], merged.actionApiCandidates)

  store.sites[siteKey] = merged
  writeStore(store)
  log.info('site memory action capture updated', { siteKey, actionName, workflowVersion })
  return merged
}

export function listSiteMemories(): SiteMemoryRecord[] {
  const store = readStore()
  let changed = false
  const records = Object.values(store.sites).map((record) => {
    const enriched = enrichSiteMemoryRecord(record)
    if (enriched !== record) changed = true
    return enriched
  })
  if (changed) {
    store.sites = Object.fromEntries(records.map((record) => [record.siteKey, record]))
    writeStore(store)
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getSiteMemory(siteOrUrl: string): SiteMemoryRecord | null {
  const key = normalizeSiteLookup(siteOrUrl)
  if (!key) return null
  const store = readStore()
  const record = store.sites[key]
  if (!record) return null

  const enriched = enrichSiteMemoryRecord(record)
  if (enriched !== record) {
    store.sites[key] = enriched
    writeStore(store)
  }
  return enriched
}

function normalizeSiteLookup(siteOrUrl: string): string {
  const trimmed = siteOrUrl.trim()
  if (!trimmed) return ''
  const parsed = parseUrl(trimmed)
  if (parsed) return parsed.hostname
  return trimmed
}

function selectBestActionCaptureEntry(entries: ActionCaptureEntry[], actionName: string): ActionCaptureEntry | null {
  const usable = entries.filter((entry) => safeUrl(entry.url))
  if (usable.length === 0) return null

  const userSelected = usable.find((entry) => Boolean(entry.userSelectedPrimary))
  if (userSelected) return userSelected
  const aiPrimary = usable.filter((entry) => Boolean(entry.aiIsPrimary))
  if (aiPrimary.length === 1) return aiPrimary[0]

  const tokens = normalizeActionTokens(actionName)
  return [...usable]
    .sort((left, right) => scoreActionCaptureEntry(right, tokens) - scoreActionCaptureEntry(left, tokens))[0] || null
}

function scoreActionCaptureEntry(entry: ActionCaptureEntry, tokens: string[]): number {
  const url = safeUrl(entry.url).toLowerCase()
  const method = asString(entry.method).toUpperCase() || 'GET'
  const requestBody = safeUrl(entry.requestBodyPreview).toLowerCase()
  const responsePreview = safeUrl(entry.responsePreview).toLowerCase()

  let score = 0
  if (entry.userSelectedPrimary) score += 100
  if (entry.aiIsPrimary) score += 30
  if (Boolean(entry.intercepted)) score += 6
  if (method !== 'GET') score += 4
  if (requestBody) score += 3
  if (responsePreview) score += 2
  if (hasQueryParams(url)) score += 2
  if (url.includes('/api/') || url.includes('/meeting/') || url.includes('/list') || url.includes('/query') || url.includes('/search') || url.includes('/get')) score += 2
  if (url.endsWith('/') || /https?:\/\/[^/]+\/?$/.test(url)) score -= 5
  if (/staff|orgstaff|avatar|static|favicon|login|logout/.test(url)) score -= 3
  if (hasWriteActionIntent(tokens) && isReadLikeActionUrl(url)) score -= 12
  if (/approve|agree|reject|audit|submit|commit|complete|deal|process|handle/.test(url)) score += 10

  for (const token of tokens) {
    if (token.length < 2) continue
    if (url.includes(token)) score += 3
    if (requestBody.includes(token)) score += 1
    if (responsePreview.includes(token)) score += 1
  }

  return score
}

function normalizeActionTokens(actionName: string): string[] {
  const raw = actionName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  const expanded = new Set<string>()
  for (const token of raw) {
    expanded.add(token)
    if (token.endsWith('s') && token.length > 3) expanded.add(token.slice(0, -1))
  }
  const semanticAliases: Array<[RegExp, string[]]> = [
    [/批阅|审批|审核|同意|通过/, ['approve', 'agree', 'audit', 'myapprove']],
    [/驳回|拒绝|退回/, ['reject', 'return']],
    [/提交|确认/, ['submit', 'commit', 'confirm']],
    [/保存/, ['save']],
    [/取消|撤销/, ['cancel', 'revoke']],
    [/转交|转发/, ['transfer', 'forward']],
    [/完成|办结/, ['complete', 'finish']],
  ]
  for (const [pattern, aliases] of semanticAliases) {
    if (!pattern.test(actionName)) continue
    for (const alias of aliases) expanded.add(alias)
  }
  return [...expanded]
}

function hasWriteActionIntent(tokens: string[]): boolean {
  return tokens.some((token) => /approve|agree|audit|reject|return|submit|commit|confirm|save|cancel|revoke|transfer|forward|complete|finish|create|update|delete|book|reserve/.test(token))
}

function isReadLikeActionUrl(input: string | undefined): boolean {
  const url = safeUrl(input).toLowerCase()
  return /(?:^|[\/_-])(info|detail|summary|list|query|search|get|history|count)(?:[\/_?&=-]|$)/.test(url)
}

function hasQueryParams(input: string): boolean {
  try {
    const parsed = new URL(input)
    return [...parsed.searchParams.keys()].length > 0
  } catch {
    return false
  }
}

function enrichSiteMemoryRecord(record: SiteMemoryRecord): SiteMemoryRecord {
  const legacyCandidates = Array.isArray(record.actionApiCandidates) ? record.actionApiCandidates : []
  const history = Array.isArray(record.actionCaptureHistory) && record.actionCaptureHistory.length > 0
    ? record.actionCaptureHistory
    : legacyCandidates
  let changed = false
  const listApiCandidates = (Array.isArray(record.listApiCandidates) ? record.listApiCandidates : []).map((candidate) => {
    const requestEvidence = normalizeRequestBodyEvidence(candidate)
    const url = structuralUrl(candidate.url)
    const responseHints = mergeActionResponseHints(candidate.responseHints, extractActionResponseHints(candidate.responsePreview))
    if (!candidate.requestBodyPreview
      && !candidate.responsePreview
      && candidate.url === url
      && JSON.stringify(candidate.requestEvidence || null) === JSON.stringify(requestEvidence)
      && JSON.stringify(candidate.responseHints || null) === JSON.stringify(responseHints || null)) return candidate
    changed = true
    return { ...candidate, url, requestBodyPreview: undefined, responsePreview: undefined, requestEvidence, responseHints }
  })
  const firstPassHistory = history.map((candidate) => {
    const responseHints = enrichActionResponseHints(candidate.responseHints, candidate.responsePreview)
    const requestEvidence = normalizeRequestBodyEvidence(candidate)
    const requestEvidenceChanged = Boolean(candidate.requestBodyPreview)
      || JSON.stringify(candidate.requestEvidence || null) !== JSON.stringify(requestEvidence)
    if (responseHints === candidate.responseHints && !requestEvidenceChanged && !candidate.responsePreview) return candidate
    changed = true
    return {
      ...candidate,
      requestBodyPreview: undefined,
      responsePreview: undefined,
      requestEvidence,
      responseHints,
    }
  })
  const bestHintsByToolName = new Map<string, StoredActionCandidate['responseHints']>()
  for (const candidate of firstPassHistory) {
    if (!candidate.toolName) continue
    bestHintsByToolName.set(
      candidate.toolName,
      mergeActionResponseHints(bestHintsByToolName.get(candidate.toolName), candidate.responseHints),
    )
  }
  const enrichedHistory = firstPassHistory.map((candidate) => {
    const merged = candidate.toolName ? mergeActionResponseHints(candidate.responseHints, bestHintsByToolName.get(candidate.toolName)) : candidate.responseHints
    if (merged === candidate.responseHints) return candidate
    changed = true
    return {
      ...candidate,
      responseHints: merged,
    }
  })
  const sortedHistory = sortActionCaptureHistory(enrichedHistory)
  if (sortedHistory.some((candidate, index) => candidate !== enrichedHistory[index])) {
    changed = true
  }
  const derivedCandidates = deriveBestActionCandidates(sortedHistory, legacyCandidates)
  const actionEvidenceSummary = buildActionEvidenceSummary(sortedHistory, derivedCandidates)
  if (
    !Array.isArray(record.actionCaptureHistory)
    || record.actionCaptureHistory.length !== sortedHistory.length
    || sortedHistory.some((candidate, index) => candidate !== record.actionCaptureHistory?.[index])
  ) {
    changed = true
  }
  if (
    derivedCandidates.length !== legacyCandidates.length
    || derivedCandidates.some((candidate, index) => candidate !== legacyCandidates[index])
  ) {
    changed = true
  }
  if (JSON.stringify(record.actionEvidenceSummary || null) !== JSON.stringify(actionEvidenceSummary)) {
    changed = true
  }

  if (!changed) return record
  return {
    ...record,
    listApiCandidates,
    actionApiCandidates: derivedCandidates,
    actionCaptureHistory: sortedHistory,
    actionEvidenceSummary,
  }
}

function isSameStoredActionCandidate(
  left: SiteMemoryRecord['actionApiCandidates'][number],
  right: SiteMemoryRecord['actionApiCandidates'][number],
): boolean {
  return left.actionName === right.actionName
    && left.url === right.url
    && left.method === right.method
}

function sortStoredActionCandidates(
  candidates: SiteMemoryRecord['actionApiCandidates'],
): SiteMemoryRecord['actionApiCandidates'] {
  return [...candidates].sort((left, right) => {
    const leftScore = scoreStoredActionCandidate(left)
    const rightScore = scoreStoredActionCandidate(right)
    if (leftScore !== rightScore) return rightScore - leftScore
    return compareIsoTimestamps(right.capturedAt, left.capturedAt)
  })
}

function sortActionCaptureHistory(candidates: StoredActionCandidate[]): StoredActionCandidate[] {
  return [...candidates].sort((left, right) => compareIsoTimestamps(right.capturedAt, left.capturedAt))
}

function deriveBestActionCandidates(
  history: StoredActionCandidate[],
  legacyBestView: StoredActionCandidate[] = [],
): StoredActionCandidate[] {
  const seeded = [...history]
  for (const candidate of legacyBestView) {
    if (!seeded.some((item) => isSameStoredActionCandidate(item, candidate))) {
      seeded.push(candidate)
    }
  }

  const bestByToolName = new Map<string, StoredActionCandidate>()
  for (const candidate of sortStoredActionCandidates(seeded)) {
    const key = candidate.toolName || `${candidate.actionName} ${(candidate.method || '').toUpperCase()}`
    const current = bestByToolName.get(key)
    if (!current) {
      bestByToolName.set(key, candidate)
      continue
    }
    bestByToolName.set(key, mergeStoredActionCandidate(current, candidate))
  }

  return sortStoredActionCandidates([...bestByToolName.values()]).slice(0, 20)
}

function scoreStoredActionCandidate(candidate: SiteMemoryRecord['actionApiCandidates'][number]): number {
  return describeStoredActionCandidateQuality(candidate).score
}

function describeStoredActionCandidateQuality(candidate: StoredActionCandidate): ActionCandidateQuality {
  let score = 0
  const signals: string[] = []

  if (candidate.primarySelection === 'user') {
    score += 100
    signals.push('user_selected_primary')
  } else if (candidate.primarySelection === 'ai' || candidate.aiIsPrimary) {
    score += 30
    signals.push('ai_selected_primary')
  }
  if (candidate.intercepted) {
    score += 6
    signals.push('intercepted')
  }
  if ((candidate.method || '').toUpperCase() !== 'GET') {
    score += 4
    signals.push('write_method')
  }
  if ((candidate.blockedReason || '') === 'side-effect-safe-capture') {
    score += 2
    signals.push('side_effect_safe_capture')
  }
  const requestEvidence = normalizeRequestBodyEvidence(candidate)
  if (requestEvidence.bodyKind !== 'none') {
    score += 1
    signals.push('has_request_body')
  }
  if (candidate.responseHints || candidate.apiEvidence?.responseShape) {
    score += 1
    signals.push('has_response_shape')
  }
  if ((candidate.responseContentType || '').toLowerCase().includes('json')) {
    score += 1
    signals.push('json_response')
  }
  if (hasQueryParams(candidate.url)) {
    score += 2
    signals.push('has_query_params')
  }

  const requestFieldCount = requestEvidence.bodyKeys.length
  if (requestFieldCount > 0) {
    const contribution = Math.min(requestFieldCount, 8)
    score += contribution
    signals.push(`request_fields:${requestFieldCount}`)
  }

  const hintScore = responseHintScore(candidate.responseHints)
  if (hintScore > 0) {
    score += hintScore
    signals.push(`response_hints:${hintScore}`)
  }

  if (/staff|orgstaff|avatar|static|favicon|login|logout/i.test(candidate.url)) {
    score -= 4
    signals.push('noise_penalty')
  }
  if (candidate.url.endsWith('/') || /https?:\/\/[^/]+\/?$/i.test(candidate.url)) {
    score -= 5
    signals.push('root_url_penalty')
  }

  return {
    score,
    signals,
  }
}

function responseHintScore(hints: SiteMemoryRecord['actionApiCandidates'][number]['responseHints']): number {
  if (!hints) return 0
  let score = 0
  if (hints.listPath) score += 2
  if (hints.itemKeys.length > 0) score += Math.min(hints.itemKeys.length, 6)
  if (hints.idLikeKeys.length > 0) score += 1
  if (hints.displayLikeKeys.length > 0) score += 1
  if (hints.availabilityLikeKeys.length > 0) score += 2
  if (hints.preferredIdKey) score += 1
  if (hints.preferredDisplayKey) score += 1
  if (hints.preferredAvailabilityKey) score += 2
  return score
}

function countPreviewFields(preview: unknown): number {
  const normalized = safeUrl(preview)
  if (!normalized) return 0
  if (normalized.startsWith('{') || normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>).length
      }
    } catch {
      return 0
    }
  }
  return [...new Set([...normalized.matchAll(/([A-Za-z0-9_]+)=/g)].map((match) => match[1]).filter(Boolean))].length
}

function compareIsoTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
  return left.localeCompare(right)
}

function mergeStoredActionCandidate(
  primary: SiteMemoryRecord['actionApiCandidates'][number],
  secondary: SiteMemoryRecord['actionApiCandidates'][number],
): SiteMemoryRecord['actionApiCandidates'][number] {
  const primaryEnriched = {
    ...primary,
    responseHints: enrichActionResponseHints(primary.responseHints, primary.responsePreview),
  }
  const secondaryEnriched = {
    ...secondary,
    responseHints: enrichActionResponseHints(secondary.responseHints, secondary.responsePreview),
  }
  const primaryScore = scoreStoredActionCandidate(primaryEnriched)
  const secondaryScore = scoreStoredActionCandidate(secondaryEnriched)
  const winner = secondaryScore > primaryScore ? secondaryEnriched : primaryEnriched
  const loser = winner === secondaryEnriched ? primaryEnriched : secondaryEnriched
  const preserveExplicitSelection = ['user', 'ai'].includes(winner.primarySelection || '') && winner.url !== loser.url

  return {
    ...winner,
    mode: winner.mode || loser.mode,
    toolName: winner.toolName || loser.toolName,
    requestEvidence: pickRicherRequestEvidence(winner.requestEvidence || normalizeRequestBodyEvidence(winner), loser.requestEvidence || normalizeRequestBodyEvidence(loser)),
    responsePreview: undefined,
    responseContentType: winner.responseContentType || loser.responseContentType,
    responseHints: preserveExplicitSelection ? winner.responseHints : mergeActionResponseHints(winner.responseHints, loser.responseHints),
    intercepted: winner.intercepted || loser.intercepted,
    blockedReason: winner.blockedReason || loser.blockedReason,
    aiIsPrimary: winner.aiIsPrimary || loser.aiIsPrimary,
    aiPurpose: winner.aiPurpose || loser.aiPurpose,
    aiWhy: winner.aiWhy || loser.aiWhy,
    primarySelection: winner.primarySelection || loser.primarySelection,
    capturedAt: compareIsoTimestamps(winner.capturedAt, loser.capturedAt) >= 0 ? winner.capturedAt : loser.capturedAt,
    sourceWorkflowVersion: winner.sourceWorkflowVersion || loser.sourceWorkflowVersion,
  }
}

function buildActionEvidenceSummary(
  history: StoredActionCandidate[],
  bestView: StoredActionCandidate[],
): ActionEvidenceSummary {
  const selectedByToolName = new Map<string, StoredActionCandidate>()
  for (const candidate of bestView) {
    const key = actionToolKey(candidate)
    if (!selectedByToolName.has(key)) selectedByToolName.set(key, candidate)
  }

  const grouped = new Map<string, StoredActionCandidate[]>()
  for (const candidate of history) {
    const key = actionToolKey(candidate)
    grouped.set(key, [...(grouped.get(key) || []), candidate])
  }

  const toolSummaries = [...grouped.entries()].map(([toolName, candidates]) => {
    const selected = selectedByToolName.get(toolName) || sortStoredActionCandidates(candidates)[0]
    const selectedQuality = describeStoredActionCandidateQuality(selected)
    return {
      toolName,
      actionName: selected.actionName,
      historyCount: candidates.length,
      selectedUrl: selected.url,
      selectedMethod: selected.method,
      selectedScore: selectedQuality.score,
      selectedSignals: selectedQuality.signals,
      candidates: sortStoredActionCandidates(candidates).map((candidate) => {
        const quality = describeStoredActionCandidateQuality(candidate)
        return {
          url: candidate.url,
          method: candidate.method,
          capturedAt: candidate.capturedAt,
          score: quality.score,
          signals: quality.signals,
          selected: isSameStoredActionCandidate(candidate, selected),
        }
      }),
    }
  }).sort((left, right) => right.selectedScore - left.selectedScore)

  return {
    historyCount: history.length,
    bestViewCount: bestView.length,
    toolSummaries,
  }
}

function actionToolKey(candidate: StoredActionCandidate): string {
  return candidate.toolName || `${candidate.actionName} ${(candidate.method || '').toUpperCase()}`
}

function pickRicherPreview(primary: string | undefined, secondary: string | undefined): string | undefined {
  const left = safeUrl(primary)
  const right = safeUrl(secondary)
  if (!left) return right || undefined
  if (!right) return left
  const leftScore = left.length + countPreviewFields(left) * 20
  const rightScore = right.length + countPreviewFields(right) * 20
  return leftScore >= rightScore ? left : right
}

function pickRicherRequestEvidence(primary: RequestBodyEvidence, secondary: RequestBodyEvidence): RequestBodyEvidence {
  if (primary.bodyOmitted !== secondary.bodyOmitted) return primary.bodyOmitted ? secondary : primary
  if (primary.bodyKeys.length !== secondary.bodyKeys.length) return primary.bodyKeys.length > secondary.bodyKeys.length ? primary : secondary
  if (primary.bodyFullSize !== secondary.bodyFullSize) return primary.bodyFullSize > secondary.bodyFullSize ? primary : secondary
  return primary
}

function mergeActionResponseHints(
  primary: SiteMemoryRecord['actionApiCandidates'][number]['responseHints'],
  secondary: SiteMemoryRecord['actionApiCandidates'][number]['responseHints'],
): SiteMemoryRecord['actionApiCandidates'][number]['responseHints'] {
  if (!primary) return secondary
  if (!secondary) return primary

  const idLikeKeys = nonEmptyArray(primary.idLikeKeys) ? primary.idLikeKeys : secondary.idLikeKeys
  const displayLikeKeys = nonEmptyArray(primary.displayLikeKeys) ? primary.displayLikeKeys : secondary.displayLikeKeys
  const availabilityLikeKeys = nonEmptyArray(primary.availabilityLikeKeys) ? primary.availabilityLikeKeys : secondary.availabilityLikeKeys
  const merged = {
    topLevelKeys: nonEmptyArray(primary.topLevelKeys) ? primary.topLevelKeys : secondary.topLevelKeys,
    listPath: primary.listPath || secondary.listPath,
    itemKeys: nonEmptyArray(primary.itemKeys) ? primary.itemKeys : secondary.itemKeys,
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey: primary.preferredIdKey || secondary.preferredIdKey || pickPreferredIdKey(idLikeKeys),
    preferredDisplayKey: primary.preferredDisplayKey || secondary.preferredDisplayKey || pickPreferredDisplayKey(displayLikeKeys),
    preferredAvailabilityKey: primary.preferredAvailabilityKey || secondary.preferredAvailabilityKey || pickPreferredAvailabilityKey(availabilityLikeKeys),
  }

  if (JSON.stringify(primary) === JSON.stringify(merged)) return primary
  return merged
}

function enrichActionResponseHints(
  hints: SiteMemoryRecord['actionApiCandidates'][number]['responseHints'],
  responsePreview: unknown,
): SiteMemoryRecord['actionApiCandidates'][number]['responseHints'] {
  const fallback = extractActionResponseHints(responsePreview)
  if (!hints) return fallback

  const idLikeKeys = nonEmptyArray(hints.idLikeKeys) ? hints.idLikeKeys : (fallback?.idLikeKeys || [])
  const displayLikeKeys = nonEmptyArray(hints.displayLikeKeys) ? hints.displayLikeKeys : (fallback?.displayLikeKeys || [])
  const availabilityLikeKeys = nonEmptyArray(hints.availabilityLikeKeys)
    ? hints.availabilityLikeKeys
    : (fallback?.availabilityLikeKeys || [])
  const preferredIdKey = hints.preferredIdKey || fallback?.preferredIdKey || pickPreferredIdKey(idLikeKeys)
  const preferredDisplayKey = hints.preferredDisplayKey || fallback?.preferredDisplayKey || pickPreferredDisplayKey(displayLikeKeys)
  const preferredAvailabilityKey = hints.preferredAvailabilityKey
    || fallback?.preferredAvailabilityKey
    || pickPreferredAvailabilityKey(availabilityLikeKeys)

  if (
    hints.preferredIdKey === preferredIdKey
    && hints.preferredDisplayKey === preferredDisplayKey
    && hints.preferredAvailabilityKey === preferredAvailabilityKey
    && hints.listPath
  ) {
    return hints
  }

  return {
    topLevelKeys: hints.topLevelKeys?.length ? hints.topLevelKeys : (fallback?.topLevelKeys || []),
    listPath: hints.listPath || fallback?.listPath || '',
    itemKeys: hints.itemKeys?.length ? hints.itemKeys : (fallback?.itemKeys || []),
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey,
    preferredDisplayKey,
    preferredAvailabilityKey,
  }
}

function nonEmptyArray<T>(value: T[] | undefined): value is T[] {
  return Array.isArray(value) && value.length > 0
}

function extractActionResponseHints(responsePreview: unknown): {
  topLevelKeys: string[]
  listPath: string
  itemKeys: string[]
  idLikeKeys: string[]
  displayLikeKeys: string[]
  availabilityLikeKeys: string[]
  preferredIdKey: string
  preferredDisplayKey: string
  preferredAvailabilityKey: string
} | undefined {
  const text = safeUrl(responsePreview)
  if (!text) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const sanitized = sanitizePreviewForJsonParse(text)
    if (!sanitized) return extractActionResponseHintsByPattern(text)
    try {
      parsed = JSON.parse(sanitized)
    } catch {
      return extractActionResponseHintsByPattern(text)
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const topLevelKeys = Object.keys(parsed as Record<string, unknown>)
  const listHit = findFirstObjectList(parsed, '')
  const itemKeys = listHit?.item && typeof listHit.item === 'object' && !Array.isArray(listHit.item)
    ? Object.keys(listHit.item as Record<string, unknown>)
    : []
  const patternFallback = (!listHit || itemKeys.length === 0) ? extractActionResponseHintsByPattern(text) : undefined

  const idLikeKeys = itemKeys.filter((key) => /(^id$|id$|code$|key$|uuid$)/i.test(key))
  const displayLikeKeys = itemKeys.filter((key) => /(name|title|label|code|display|desc|room)/i.test(key))
  const availabilityLikeKeys = itemKeys.filter((key) => /(availability|schedule|calendar|slot|time|map)/i.test(key))
  const mergedIdLikeKeys = idLikeKeys.length > 0 ? idLikeKeys : (patternFallback?.idLikeKeys || [])
  const mergedDisplayLikeKeys = displayLikeKeys.length > 0 ? displayLikeKeys : (patternFallback?.displayLikeKeys || [])
  const mergedAvailabilityLikeKeys = availabilityLikeKeys.length > 0
    ? availabilityLikeKeys
    : (patternFallback?.availabilityLikeKeys || [])

  return {
    topLevelKeys: topLevelKeys.length > 0 ? topLevelKeys : (patternFallback?.topLevelKeys || []),
    listPath: listHit?.path || patternFallback?.listPath || '',
    itemKeys: itemKeys.length > 0 ? itemKeys : (patternFallback?.itemKeys || []),
    idLikeKeys: mergedIdLikeKeys,
    displayLikeKeys: mergedDisplayLikeKeys,
    availabilityLikeKeys: mergedAvailabilityLikeKeys,
    preferredIdKey: pickPreferredIdKey(mergedIdLikeKeys),
    preferredDisplayKey: pickPreferredDisplayKey(mergedDisplayLikeKeys),
    preferredAvailabilityKey: pickPreferredAvailabilityKey(mergedAvailabilityLikeKeys),
  }
}

function sanitizePreviewForJsonParse(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  return normalized
    .replace(/\[\s*\.\.\.\s*\]/g, '[]')
    .replace(/\{\s*\.\.\.\s*\}/g, '{}')
    .replace(/:\s*\.\.\.(?=[,\]}])/g, ': null')
}

function extractActionResponseHintsByPattern(text: string): {
  topLevelKeys: string[]
  listPath: string
  itemKeys: string[]
  idLikeKeys: string[]
  displayLikeKeys: string[]
  availabilityLikeKeys: string[]
  preferredIdKey: string
  preferredDisplayKey: string
  preferredAvailabilityKey: string
} | undefined {
  const normalized = text.trim()
  if (!normalized) return undefined

  const topLevelKeys = collectObjectKeys(normalized)
  const listPath = inferListPathFromPreview(normalized)
  const itemKeys = collectLikelyItemKeys(normalized)
  if (topLevelKeys.length === 0 && !listPath && itemKeys.length === 0) return undefined

  const idLikeKeys = itemKeys.filter((key) => /(^id$|id$|code$|key$|uuid$)/i.test(key))
  const displayLikeKeys = itemKeys.filter((key) => /(name|title|label|code|display|desc|room)/i.test(key))
  const availabilityLikeKeys = itemKeys.filter((key) => /(availability|schedule|calendar|slot|time|map)/i.test(key))

  return {
    topLevelKeys,
    listPath,
    itemKeys,
    idLikeKeys,
    displayLikeKeys,
    availabilityLikeKeys,
    preferredIdKey: pickPreferredIdKey(idLikeKeys),
    preferredDisplayKey: pickPreferredDisplayKey(displayLikeKeys),
    preferredAvailabilityKey: pickPreferredAvailabilityKey(availabilityLikeKeys),
  }
}

function collectObjectKeys(text: string): string[] {
  const matches = [...text.matchAll(/"([A-Za-z0-9_]+)"\s*:/g)].map((match) => match[1]).filter(Boolean)
  return [...new Set(matches)].slice(0, 30)
}

function inferListPathFromPreview(text: string): string {
  if (/"data"\s*:\s*\{[\s\S]*?"list"\s*:/i.test(text)) return 'data.list'
  if (/"data"\s*:\s*\{[\s\S]*?"rows"\s*:/i.test(text)) return 'data.rows'
  if (/"list"\s*:/i.test(text)) return 'list'
  if (/"rows"\s*:/i.test(text)) return 'rows'
  if (/"records"\s*:/i.test(text)) return 'records'
  if (/"items"\s*:/i.test(text)) return 'items'
  return ''
}

function collectLikelyItemKeys(text: string): string[] {
  const preferred = ['id', 'roomId', 'roomcode', 'roomCode', 'name', 'title', 'meetingType', 'equipment', 'capacity', 'meetingInfoMaps']
  const found = preferred.filter((key) => new RegExp(`"${key}"\\s*:`, 'i').test(text))
  return [...new Set(found)]
}

function pickPreferredIdKey(keys: string[]): string {
  const ordered = ['id', 'roomId', 'roomcode', 'roomCode', 'code']
  return ordered.find((key) => keys.includes(key)) || keys[0] || ''
}

function pickPreferredDisplayKey(keys: string[]): string {
  const ordered = ['roomcode', 'roomCode', 'name', 'title', 'label', 'code']
  return ordered.find((key) => keys.includes(key)) || keys[0] || ''
}

function pickPreferredAvailabilityKey(keys: string[]): string {
  const ordered = ['meetingInfoMaps', 'availability', 'schedule', 'calendar', 'slotMap']
  return ordered.find((key) => keys.includes(key)) || keys[0] || ''
}

function findFirstObjectList(value: unknown, path: string): { path: string; item: unknown } | null {
  if (Array.isArray(value)) {
    const firstObject = value.find((item) => item && typeof item === 'object' && !Array.isArray(item))
    if (firstObject) {
      return {
        path,
        item: firstObject,
      }
    }
    return null
  }

  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const preferredKeys = ['list', 'rows', 'records', 'items', 'data']
  for (const key of preferredKeys) {
    if (!(key in record)) continue
    const hit = findFirstObjectList(record[key], path ? `${path}.${key}` : key)
    if (hit) return hit
  }

  for (const [key, nested] of Object.entries(record)) {
    if (preferredKeys.includes(key)) continue
    const hit = findFirstObjectList(nested, path ? `${path}.${key}` : key)
    if (hit) return hit
  }

  return null
}
