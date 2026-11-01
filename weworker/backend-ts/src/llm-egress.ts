export type LlmProtocol = 'anthropic_messages' | 'openai_chat_completions' | 'openai_responses'

export function isLlmProtocol(value: unknown): value is LlmProtocol {
  return value === 'anthropic_messages' || value === 'openai_chat_completions' || value === 'openai_responses'
}

export function isOpenAiProtocol(value: LlmProtocol | string | undefined): boolean {
  return value === 'openai_chat_completions' || value === 'openai_responses'
}

export interface ProviderEntry {
  id: string
  name: string
  models: string[]
  defaultModel: string
  fixed?: boolean
  builtin?: boolean
  fixedModel?: boolean
  allowMultiple?: boolean
  authType?: 'auth_token' | 'api_key'
  apiKeyEnv?: string
  baseUrlEnv?: string
  presentation?: { subtitle: string; color: string; bg: string }
  weworker: { protocol: LlmProtocol; baseUrl: string }
  webwright: {
    protocol: 'anthropic_messages' | 'openai_chat_completions'
    modelClass: 'anthropic' | 'zhipu' | 'openai_chat'
    baseUrl: string
    structuredOutput: 'anthropic_json_schema' | 'openai_json_object'
  }
}

export function normalizeLlmBaseUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('LLM base URL must use HTTP or HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('LLM base URL must not include credentials, query, or fragment')
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (/(?:\/v1\/messages|\/chat\/completions|\/responses)$/i.test(url.pathname)) {
    throw new Error('LLM base URL must not include the request endpoint')
  }
  return url.toString().replace(/\/$/, '')
}

export function normalizeLlmUrlInput(raw: string, fullUrl: unknown = false): string {
  if (typeof fullUrl !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
  if (!fullUrl) return normalizeLlmBaseUrl(raw)
  const value = raw.trim()
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('接口 URL 必须使用 HTTP 或 HTTPS')
  if (url.username || url.password || url.hash) throw new Error('接口 URL 不允许包含用户凭据或片段')
  return value
}

export function resolveAnthropicEndpoint(settings: { base_url: string; base_url_is_full?: boolean }): string {
  const url = normalizeLlmUrlInput(settings.base_url || (settings.base_url_is_full ? '' : 'https://api.anthropic.com'), settings.base_url_is_full ?? false)
  return settings.base_url_is_full ? url : `${url}/v1/messages`
}

export function resolveOpenAiEndpoint(url: string, fullUrl = false, protocol: LlmProtocol = 'openai_chat_completions'): string {
  const value = normalizeLlmUrlInput(url, fullUrl)
  return fullUrl ? value : `${value}/${protocol === 'openai_responses' ? 'responses' : 'chat/completions'}`
}

export function buildAllowedLlmBaseUrls(providers: ProviderEntry[], extraCsv = process.env.WEWORKER_ALLOWED_LLM_BASE_URLS || ''): Set<string> {
  const urls = new Set<string>()
  for (const provider of providers) {
    for (const baseUrl of [provider.weworker?.baseUrl, provider.webwright?.baseUrl]) {
      if (baseUrl?.trim()) urls.add(normalizeLlmBaseUrl(baseUrl))
    }
  }
  for (const raw of extraCsv.split(',')) {
    const value = raw.trim()
    if (!value) continue
    urls.add(normalizeLlmBaseUrl(value))
  }
  return urls
}

export function assertAllowedLlmBaseUrl(raw: string | undefined, allowedBaseUrls: Set<string>): string {
  const value = raw?.trim() || 'https://api.anthropic.com'
  let normalized: string
  try {
    normalized = normalizeLlmBaseUrl(value)
  } catch {
    throw new Error('LLM base URL is invalid')
  }
  if (!allowedBaseUrls.has(normalized)) {
    throw new Error(`LLM base URL is not allowed: ${normalized}`)
  }
  return normalized
}
