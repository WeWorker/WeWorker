import type { ProviderEntry } from './llm-egress.js'
import { resolveAnthropicEndpoint, resolveOpenAiEndpoint, isOpenAiProtocol, type LlmProtocol } from './llm-egress.js'
import { resolveModelCatalogEndpoint, type ModelCatalogAuthType } from './model-catalog-config.js'
import { buildAnthropicAuthHeaders } from './anthropic-auth.js'
import type { AnthropicAuthType } from './anthropic-auth.js'
import { findProviderByWeWorkerBaseUrl } from './provider-registry.js'

export type ModelCatalogSource = 'remote' | 'fallback'
export type ProbeTarget = 'weworker' | 'webwright'
export type ProbeErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'model_unavailable'
  | 'rate_limited'
  | 'endpoint_missing'
  | 'protocol_mismatch'
  | 'network_error'
  | 'timeout'
  | 'service_unavailable'

export interface ProviderAccessInput {
  provider: ProviderEntry
  apiKey: string
  openaiApiKey?: string
  target?: ProbeTarget
  anthropicBaseUrl?: string
  anthropicFullUrl?: boolean
  openaiBaseUrl?: string
  openaiFullUrl?: boolean
  anthropicAuthType?: AnthropicAuthType
  modelsUrl?: string
  modelsUrlIsFull?: boolean
  modelsAuthType?: ModelCatalogAuthType
  openaiModelsUrl?: string
  openaiModelsUrlIsFull?: boolean
  weworkerProtocol?: LlmProtocol
  weworkerBaseUrl?: string
  weworkerFullUrl?: boolean
}

export interface ProviderConnectionInput extends ProviderAccessInput {
  model: string
  openaiModel?: string
}

export interface ModelCatalogResult {
  models: string[]
  source: ModelCatalogSource
  warning?: string
}

export interface ProtocolProbeResult {
  ok: boolean
  target: ProbeTarget
  protocol: LlmProtocol
  model: string
  error?: ProbeErrorCode
  detail?: string
  auth_type?: AnthropicAuthType
}

type FetchLike = typeof fetch
type ProviderProtocolProbeInput = ProviderConnectionInput & {
  target: ProbeTarget
  verifyResponse?: boolean
  forceAnthropicTextProbe?: boolean
}

function uniqueModels(values: unknown[]): string[] {
  return [...new Set(values
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean))]
}

function formatRemoteResponse(response: Response, body: string): string {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  return `${status}\n${body || '（空响应体）'}`
}

async function readRemoteResponse(response: Response): Promise<{ body: string; detail: string }> {
  const body = await response.text()
  return { body, detail: formatRemoteResponse(response, body) }
}

function parseModelList(body: string, detail: string): string[] {
  try {
    const data = JSON.parse(body) as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(data.data)) throw new Error('模型列表响应格式无效')
    return uniqueModels(data.data.map(item => item.id))
  } catch (error) {
    const reason = error instanceof SyntaxError ? '模型列表响应不是有效 JSON' : '模型列表响应格式无效'
    throw new Error(`${reason}\n${detail}`)
  }
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string, providerId: string, authType: AnthropicAuthType | undefined, fetchImpl: FetchLike): Promise<string[]> {
  const response = await fetchImpl(`${baseUrl}/v1/models?limit=1000`, {
    headers: {
      ...buildAnthropicAuthHeaders(apiKey, providerId, authType),
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(15000),
  })
  const remote = await readRemoteResponse(response)
  if (!response.ok) throw new Error(remote.detail)
  return parseModelList(remote.body, remote.detail)
}

async function fetchOpenAiModels(baseUrl: string, apiKey: string, fetchImpl: FetchLike): Promise<string[]> {
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  })
  const remote = await readRemoteResponse(response)
  if (!response.ok) throw new Error(remote.detail)
  return parseModelList(remote.body, remote.detail)
}

async function fetchExplicitModels(url: string, apiKey: string, authType: AnthropicAuthType, fetchImpl: FetchLike, fullUrl = true, protocol: LlmProtocol = 'anthropic_messages'): Promise<string[]> {
  const response = await fetchImpl(resolveModelCatalogEndpoint(url, fullUrl), {
    headers: {
      ...(isOpenAiProtocol(protocol)
        ? { authorization: `Bearer ${apiKey}` }
        : { ...buildAnthropicAuthHeaders(apiKey, 'custom', authType), ...(authType === 'api_key' ? { 'anthropic-version': '2023-06-01' } : {}) }),
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  })
  const remote = await readRemoteResponse(response)
  if (!response.ok) throw new Error(remote.detail.split(apiKey).join('[已隐藏]'))
  return parseModelList(remote.body, remote.detail)
}

export async function listProviderModels(
  input: ProviderAccessInput,
  fetchImpl: FetchLike = fetch,
): Promise<ModelCatalogResult> {
  const targetedCustom = input.provider.id === 'custom' && Boolean(input.target)
  const fallbackModels = targetedCustom ? [] : [...input.provider.models]
  if (targetedCustom) {
    const openai = input.target === 'webwright' || (input.target === 'weworker' && isOpenAiProtocol(input.weworkerProtocol))
    const explicitUrl = input.target === 'webwright' ? input.openaiModelsUrl : input.modelsUrl
    const address = explicitUrl || (input.target === 'webwright'
      ? input.openaiBaseUrl
      : input.weworkerBaseUrl || input.anthropicBaseUrl)
    const key = input.target === 'webwright' ? input.openaiApiKey : input.apiKey
    const fullUrl = input.target === 'webwright'
      ? input.openaiFullUrl
      : input.weworkerFullUrl ?? input.anthropicFullUrl
    if (!address?.trim() || !key?.trim()) return { models: [], source: 'fallback', warning: '请先填写此接口的地址和 API Key' }
    if (fullUrl && !explicitUrl) return { models: [], source: 'fallback', warning: '完整 URL 模式请单独填写模型列表地址' }
  }
  if (!input.apiKey && !input.openaiApiKey) {
    return { models: [...input.provider.models], source: 'fallback', warning: '未配置 API Key，显示内置模型列表' }
  }

  const requests: Array<{ label: string; promise: Promise<string[]> }> = []
  if (input.provider.id === 'custom') {
    const weworkerProtocol = input.weworkerProtocol || input.provider.weworker.protocol
    const weworkerOpenAi = isOpenAiProtocol(weworkerProtocol)
    if ((!input.target || input.target === 'weworker') && input.apiKey) {
      if (input.modelsUrl) requests.push({ label: weworkerOpenAi ? 'OpenAI 模型列表' : 'Claude Code 模型列表', promise: fetchExplicitModels(input.modelsUrl, input.apiKey, input.modelsAuthType === 'inherit' || !input.modelsAuthType ? input.anthropicAuthType || 'auth_token' : input.modelsAuthType, fetchImpl, input.modelsUrlIsFull, weworkerOpenAi ? weworkerProtocol : 'anthropic_messages') })
      else if (weworkerOpenAi && (input.weworkerBaseUrl || input.anthropicBaseUrl) && !(input.weworkerFullUrl ?? input.anthropicFullUrl)) requests.push({ label: 'OpenAI 模型列表', promise: fetchOpenAiModels(input.weworkerBaseUrl || input.anthropicBaseUrl!, input.apiKey, fetchImpl) })
      else if (input.anthropicBaseUrl && !input.anthropicFullUrl && findProviderByWeWorkerBaseUrl(input.anthropicBaseUrl)) {
        const knownProvider = findProviderByWeWorkerBaseUrl(input.anthropicBaseUrl)!
        requests.push({
          label: 'Claude Code 模型列表',
          promise: knownProvider.webwright.protocol === 'openai_chat_completions'
            ? fetchOpenAiModels(knownProvider.webwright.baseUrl, input.apiKey, fetchImpl)
            : fetchAnthropicModels(knownProvider.weworker.baseUrl, input.apiKey, knownProvider.id, input.anthropicAuthType, fetchImpl),
        })
      }
      else if (!weworkerOpenAi && input.anthropicBaseUrl && !input.anthropicFullUrl) requests.push({ label: 'Claude Code 接口', promise: fetchAnthropicModels(input.anthropicBaseUrl, input.apiKey, input.provider.id, input.anthropicAuthType, fetchImpl) })
    }
    const openaiCatalogKey = input.openaiApiKey || (!input.target ? input.apiKey : '')
    if ((!input.target || input.target === 'webwright') && openaiCatalogKey) {
      if (input.openaiModelsUrl) requests.push({ label: 'OpenAI 模型列表', promise: fetchExplicitModels(input.openaiModelsUrl, openaiCatalogKey, 'auth_token', fetchImpl, input.openaiModelsUrlIsFull) })
      else if (input.openaiBaseUrl && !input.openaiFullUrl) requests.push({ label: 'OpenAI 接口', promise: fetchOpenAiModels(input.openaiBaseUrl, openaiCatalogKey, fetchImpl) })
    }
  } else if (input.provider.webwright.protocol === 'openai_chat_completions') {
    requests.push({ label: 'OpenAI 接口', promise: fetchOpenAiModels(input.provider.webwright.baseUrl, input.openaiApiKey || input.apiKey, fetchImpl) })
  } else {
    requests.push({ label: 'Claude Code 接口', promise: fetchAnthropicModels(input.provider.weworker.baseUrl, input.apiKey, input.provider.id, input.anthropicAuthType, fetchImpl) })
  }

  if (requests.length === 0) {
    return { models: fallbackModels, source: 'fallback', warning: input.weworkerFullUrl || input.anthropicFullUrl || input.openaiFullUrl
      ? '完整 URL 模式不推断模型列表地址，请手动填写模型名称，或为任一协议配置基础 URL'
      : '模型列表接口未配置，显示内置模型列表' }
  }

  const results = await Promise.allSettled(requests.map(request => request.promise))
  const succeeded = results.filter((result): result is PromiseFulfilledResult<string[]> => result.status === 'fulfilled')
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${requests[index].label}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
    : [])
  if (succeeded.length > 0) {
    return {
      models: uniqueModels(succeeded.flatMap(result => result.value)),
      source: 'remote',
      ...(failures.length > 0 ? { warning: failures.join('\n\n') } : {}),
    }
  }

  return { models: fallbackModels, source: 'fallback', warning: failures.join('\n\n') || '远程模型列表获取失败' }
}

function classifyProbeFailure(status: number, detail: string): ProbeErrorCode {
  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'service_unavailable'
  if (/model/i.test(detail) && (status === 400 || status === 404)) return 'model_unavailable'
  if (status === 404) return 'endpoint_missing'
  return 'protocol_mismatch'
}

function shouldProbeWithAnthropicToolChoice(input: ProviderProtocolProbeInput): boolean {
  if (!input.verifyResponse || input.target !== 'weworker') return false
  const knownProvider = input.provider.id === 'custom'
    ? findProviderByWeWorkerBaseUrl(input.anthropicBaseUrl)
    : undefined
  // DeepSeek's Anthropic-compatible endpoint rejects forced tool_choice when
  // thinking/reasoning mode is active. Use a plain JSON text probe for this
  // provider so the settings connection check does not fail before chat starts.
  if (input.provider.id === 'deepseek' || knownProvider?.id === 'deepseek') return false
  return input.provider.weworker.protocol === 'anthropic_messages'
}

function effectiveAnthropicProviderId(input: ProviderProtocolProbeInput, baseUrl: string): string {
  if (input.provider.id !== 'custom') return input.provider.id
  return findProviderByWeWorkerBaseUrl(baseUrl)?.id || input.provider.id
}

function shouldRetryAnthropicTextProbe(input: ProviderProtocolProbeInput, detail: string): boolean {
  if (input.forceAnthropicTextProbe) return false
  if (input.provider.id !== 'custom') return false
  if (!shouldProbeWithAnthropicToolChoice(input)) return false
  return /\btool_choice\b|\btool choice\b|\btools?\b|\bthinking\b|\breasoning\b/i.test(detail)
}

export async function probeProviderProtocol(
  input: ProviderProtocolProbeInput,
  fetchImpl: FetchLike = fetch,
): Promise<ProtocolProbeResult> {
  const config = input.target === 'weworker' ? input.provider.weworker : input.provider.webwright
  const protocol = input.target === 'weworker' ? input.weworkerProtocol || config.protocol : config.protocol
  const baseUrl = input.provider.id === 'custom'
    ? input.target === 'weworker'
      ? input.weworkerBaseUrl || input.anthropicBaseUrl
      : (protocol === 'anthropic_messages' ? input.anthropicBaseUrl : input.openaiBaseUrl)
    : config.baseUrl
  const apiKey = input.target === 'webwright' ? (input.openaiApiKey || input.apiKey) : input.apiKey
  const model = input.target === 'webwright' ? (input.openaiModel || input.model) : input.model
  if (!apiKey || !model || !baseUrl) {
    return { ok: false, target: input.target, protocol, model, error: 'not_configured', detail: 'API Key、模型或 Base URL 未配置完整' }
  }

  const isAnthropic = protocol === 'anthropic_messages'
  const weworkerFullUrl = input.weworkerFullUrl ?? input.anthropicFullUrl
  const endpoint = isAnthropic
    ? resolveAnthropicEndpoint({ base_url: baseUrl, base_url_is_full: input.provider.id === 'custom' && (input.target === 'weworker' ? weworkerFullUrl : input.anthropicFullUrl) === true })
    : resolveOpenAiEndpoint(baseUrl, input.provider.id === 'custom' && (input.target === 'weworker' ? weworkerFullUrl : input.openaiFullUrl) === true, protocol)
  const headers: Record<string, string> = isAnthropic
    ? { ...buildAnthropicAuthHeaders(apiKey, effectiveAnthropicProviderId(input, baseUrl), input.anthropicAuthType), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const requiresToolCall = isAnthropic && !input.forceAnthropicTextProbe && shouldProbeWithAnthropicToolChoice(input)
  const body = (useToolCall: boolean) => isAnthropic
    ? {
        model,
        max_tokens: input.verifyResponse ? 256 : 20,
        messages: [{ role: 'user', content: 'Return {"ok":true}.' }],
        ...(useToolCall ? {
          tools: [{ name: 'connection_check', description: 'Confirm the connection without performing any action.', input_schema: schema }],
          tool_choice: { type: 'tool', name: 'connection_check' },
        } : {}),
        ...(input.target === 'webwright' ? { output_config: { format: { type: 'json_schema', schema } } } : {}),
      }
    : protocol === 'openai_responses' ? {
        model,
        max_output_tokens: input.verifyResponse ? 256 : 20,
        input: 'Return JSON: {"ok":true}.',
        text: { format: { type: 'json_object' } },
      } : {
        model,
        max_tokens: input.verifyResponse ? 256 : 20,
        messages: [{ role: 'user', content: 'Return JSON: {"ok":true}.' }],
        response_format: { type: 'json_object' },
      }
  const isThinkingToolChoiceConflict = (status: number, detail: string) => status === 400
    && /tool_choice/i.test(detail) && /thinking/i.test(detail)

  const execute = async (useToolCall: boolean): Promise<ProtocolProbeResult> => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body(useToolCall)),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    })
    if (response.ok) {
      if (input.verifyResponse) {
        try {
          const data = await response.json() as any
          if (useToolCall) {
            if (!data.content?.some((block: any) => block.type === 'tool_use' && block.name === 'connection_check' && block.input?.ok === true)) throw new Error()
          } else {
            const content = isAnthropic
              ? data.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
              : protocol === 'openai_responses'
                ? data.output?.flatMap((item: any) => item.content || []).filter((block: any) => block.type === 'output_text').map((block: any) => block.text).join('')
                : data.choices?.[0]?.message?.content
            if (JSON.parse(content).ok !== true) throw new Error()
          }
        } catch {
          return {
            ok: false,
            target: input.target,
            protocol,
            model,
            error: 'protocol_mismatch',
            detail: useToolCall ? '服务未返回有效的工具调用，请确认此模型支持 Claude Code' : '服务未返回有效的结构化 JSON，请检查接口地址和模型能力',
          }
        }
      }
      return { ok: true, target: input.target, protocol, model }
    }
    const detail = (await readRemoteResponse(response)).detail.split(apiKey).join('[已隐藏]')
    if (requiresToolCall && useToolCall && (isThinkingToolChoiceConflict(response.status, detail) || shouldRetryAnthropicTextProbe(input, detail))) {
      return execute(false)
    }
    return { ok: false, target: input.target, protocol, model, error: classifyProbeFailure(response.status, detail), detail }
  }

  try {
    return await execute(requiresToolCall)
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return {
      ok: false,
      target: input.target,
      protocol,
      model,
      error: timedOut ? 'timeout' : 'network_error',
      detail: timedOut ? '连接超时' : (error instanceof Error ? error.message : '连接失败').split(apiKey).join('[已隐藏]'),
    }
  }
}

export async function probeMainConnection(input: ProviderConnectionInput & { autoAuth?: boolean }, fetchImpl: FetchLike = fetch): Promise<ProtocolProbeResult> {
  if (isOpenAiProtocol(input.weworkerProtocol || input.provider.weworker.protocol)) {
    return probeProviderProtocol({ ...input, target: 'weworker', verifyResponse: true }, fetchImpl)
  }
  const authType = input.provider.id === 'custom' && findProviderByWeWorkerBaseUrl(input.anthropicBaseUrl)
    ? 'api_key'
    : input.anthropicAuthType || 'auth_token'
  const result = await probeProviderProtocol({ ...input, target: 'weworker', verifyResponse: true }, fetchImpl)
  if (input.provider.id !== 'custom') return result
  if (result.ok) return { ...result, auth_type: authType }
  if (!input.autoAuth || result.error !== 'auth_failed') return result
  const alternate = authType === 'auth_token' ? 'api_key' : 'auth_token'
  const retried = await probeProviderProtocol({ ...input, anthropicAuthType: alternate, target: 'weworker', verifyResponse: true }, fetchImpl)
  return retried.ok ? { ...retried, auth_type: alternate } : retried
}

// Measures the complete verified conversation request, including any protocol
// compatibility retry. This is not a first-token or network-only measurement.
export async function probeTimedMainConnection(
  input: ProviderConnectionInput & { autoAuth?: boolean },
  fetchImpl: FetchLike = fetch,
  now: () => number = () => performance.now(),
) {
  const started = now()
  const result = await probeMainConnection(input, fetchImpl)
  return { ...result, elapsed_ms: Math.max(1, Math.round(now() - started)), checked_at: Date.now() }
}
