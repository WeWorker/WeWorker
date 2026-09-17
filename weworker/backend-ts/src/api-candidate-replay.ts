import {
  analyzeApiEvidenceEntry,
  type ApiEndpointEvidence,
  type ApiReplayEvidence,
  type RawApiEvidenceEntry,
} from './api-exploration-evidence.js'

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

const SENSITIVE_HEADER_RE = /authorization|cookie|credential|password|secret|session|ticket|token|csrf|xsrf/i
const FORBIDDEN_HEADER_RE = /^(?:connection|content-length|host|origin|referer|sec-|proxy-)/i
const WRITE_SIGNAL_RE = /(?:^|[\/_-])(approve|book|cancel|commit|create|delete|pay|publish|reject|reserve|save|submit|update|upload)(?:[\s\/_?&=-]|$)/i
const WRITE_BODY_SIGNAL_RE = /approve|book|buy|cancel|commit|create|delete|edit|finish|pay|publish|reject|reserve|save|submit|update|upload/i
const MAX_REPLAY_BODY_BYTES = 16_384

export interface RawReplayResult {
  transport: 'direct_no_auth' | 'browser_page'
  status: number | null
  ok: boolean
  contentType: string
  responsePreview: string
  durationMs: number
  errorCode: string
}

function safeReplayHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADER_RE.test(name) || FORBIDDEN_HEADER_RE.test(name)) continue
    const normalized = Array.isArray(value) ? value.join(', ') : String(value ?? '')
    if (!normalized || normalized.includes('[redacted]')) continue
    result[name] = normalized.slice(0, 2_000)
  }
  if (!Object.keys(result).some((name) => name.toLowerCase() === 'accept')) result.Accept = 'application/json, text/plain;q=0.9'
  return result
}

function assertReplayAllowed(candidate: ApiEndpointEvidence, entry: RawApiEvidenceEntry): void {
  const method = String(entry.method || candidate.method || 'GET').toUpperCase()
  if (candidate.risk !== 'read') throw new Error('API_REPLAY_REQUIRES_READ_CANDIDATE')
  if (!['GET', 'HEAD', 'POST'].includes(method)) throw new Error('API_REPLAY_METHOD_NOT_ALLOWED')
  const probe = `${entry.url || ''} ${entry.requestBodyPreview || ''} ${candidate.requestShape.graphqlOperationName}`
  const unsafeBody = method === 'POST'
    && candidate.requestShape.kind !== 'graphql'
    && WRITE_BODY_SIGNAL_RE.test(String(entry.requestBodyPreview || ''))
  if (WRITE_SIGNAL_RE.test(probe) || unsafeBody || candidate.requestShape.graphqlOperationType === 'mutation') {
    throw new Error('API_REPLAY_WRITE_SIGNAL_BLOCKED')
  }
  const url = new URL(String(entry.url || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API_REPLAY_URL_NOT_ALLOWED')
}

async function readResponsePreview(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let output = ''
  try {
    while (total < MAX_REPLAY_BODY_BYTES) {
      const next = await reader.read()
      if (next.done) break
      const remaining = MAX_REPLAY_BODY_BYTES - total
      const chunk = next.value.slice(0, remaining)
      total += chunk.byteLength
      output += decoder.decode(chunk, { stream: true })
      if (chunk.byteLength < next.value.byteLength) break
    }
    output += decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
  }
  return output.length >= MAX_REPLAY_BODY_BYTES ? `${output}...[truncated]` : output
}

export async function replayApiCandidateDirect(
  candidate: ApiEndpointEvidence,
  entry: RawApiEvidenceEntry,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<RawReplayResult> {
  assertReplayAllowed(candidate, entry)
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs || 10_000))
  try {
    const method = String(entry.method || candidate.method || 'GET').toUpperCase()
    const response = await (options.fetchImpl || fetch)(String(entry.url), {
      method,
      headers: safeReplayHeaders(entry.requestHeaders),
      body: ['GET', 'HEAD'].includes(method) ? undefined : String(entry.requestBodyPreview || ''),
      redirect: 'manual',
      signal: controller.signal,
    })
    return {
      transport: 'direct_no_auth',
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') || '',
      responsePreview: await readResponsePreview(response),
      durationMs: Date.now() - startedAt,
      errorCode: '',
    }
  } catch (error) {
    return {
      transport: 'direct_no_auth',
      status: null,
      ok: false,
      contentType: '',
      responsePreview: '',
      durationMs: Date.now() - startedAt,
      errorCode: error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
    }
  } finally {
    clearTimeout(timer)
  }
}

export function summarizeReplayResult(raw: RawReplayResult, entry: RawApiEvidenceEntry): ApiReplayEvidence {
  const replayCandidate = analyzeApiEvidenceEntry({
    ...entry,
    status: raw.status ?? undefined,
    responseContentType: raw.contentType,
    responsePreview: raw.responsePreview,
  }, ['replay'])
  const nonEmpty = raw.responsePreview.trim() !== ''
    && !/^\s*(?:\[\s*\]|\{\s*\}|null)\s*$/i.test(raw.responsePreview)
    && !/<html|<!doctype|login|sign in|登录|验证码/i.test(raw.responsePreview.slice(0, 4_000))
  return {
    transport: raw.transport,
    status: raw.status,
    ok: raw.ok,
    contentType: raw.contentType.split(';')[0].toLowerCase(),
    nonEmpty,
    responseShape: replayCandidate.responseShape,
    durationMs: raw.durationMs,
    errorCode: raw.errorCode,
    verificationFixture: replayCandidate.verificationFixture,
  }
}
