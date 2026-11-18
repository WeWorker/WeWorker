import type { ModelConfiguration } from './model-configurations.js'
import { isOpenAiProtocol, normalizeLlmUrlInput } from './llm-egress.js'
import { getProvider } from './provider-registry.js'
import { probeProviderProtocol } from './provider-model-services.js'

type WorkshopPatch = Partial<Pick<ModelConfiguration,
  'openai_base_url' | 'openai_base_url_is_full' | 'openai_api_key' | 'openai_model'>>

function workshopAddress(configuration: ModelConfiguration) {
  const openai = isOpenAiProtocol(configuration.weworker_protocol)
  let url = normalizeLlmUrlInput(configuration.base_url, configuration.base_url_is_full ?? false)
  if (openai) {
    if (configuration.base_url_is_full && configuration.weworker_protocol === 'openai_responses') {
      // Only standard endpoints have a known Chat Completions sibling.
      if (!/\/responses\/?$/.test(url)) return undefined
      url = url.replace(/\/responses\/?$/, '/chat/completions')
    }
    return { openai_base_url: url, openai_base_url_is_full: configuration.base_url_is_full === true }
  }
  if (configuration.base_url_is_full) {
    if (!/\/v1\/messages\/?$/.test(url)) return undefined
    url = url.replace(/\/messages\/?$/, '')
  }
  url = url.replace(/\/+$/, '')
  return { openai_base_url: /\/v1$/i.test(url) ? url : `${url}/v1`, openai_base_url_is_full: false }
}

/** Anthropic availability never proves OpenAI support: verify a separate request. */
export async function discoverWorkshopConfig(
  configuration: ModelConfiguration,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<WorkshopPatch> {
  if (!configuration.api_key || !configuration.base_url) return {}
  try {
    const address = workshopAddress(configuration)
    if (!address) return {}
    let model = configuration.model
    if (!isOpenAiProtocol(configuration.weworker_protocol)) {
      const signal = AbortSignal.timeout(timeoutMs)
      const boundedFetch: typeof fetch = (url, init) => fetchImpl(url, {
        ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      })
      if (!model) {
        const response = await boundedFetch(`${address.openai_base_url}/models`, {
          headers: { authorization: `Bearer ${configuration.api_key}` }, redirect: 'error',
        })
        if (!response.ok) return {}
        const data = await response.json() as { data?: Array<{ id?: unknown }> }
        const id = data.data?.find(item => typeof item.id === 'string' && item.id.trim())?.id
        if (typeof id !== 'string' || id.length > 200) return {}
        model = id.trim()
      }
      const result = await probeProviderProtocol({ provider: getProvider('custom')!,
        apiKey: configuration.api_key, openaiApiKey: configuration.api_key,
        model, openaiModel: model, openaiBaseUrl: address.openai_base_url,
        openaiFullUrl: address.openai_base_url_is_full, target: 'webwright', verifyResponse: true,
      }, boundedFetch)
      if (!result.ok) return {}
    }
    return { ...address, openai_api_key: configuration.api_key, ...(model ? { openai_model: model } : {}) }
  } catch { return {} }
}

/** Keep deliberate advanced overrides; auto-derived settings follow the main connection. */
export async function automaticWorkshopUpdate(
  current: ModelConfiguration,
  next: ModelConfiguration,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkshopPatch> {
  if (next.provider_id !== 'custom' || !['api_key', 'base_url', 'base_url_is_full', 'weworker_protocol', 'model']
    .some(field => input[field] !== undefined)) return {}
  for (const field of ['openai_base_url', 'openai_api_key', 'openai_model'] as const) {
    const value = input[field]
    if (typeof value === 'string' && value.trim() && value.trim() !== current[field]
      && !(field === 'openai_model' && value.trim() === next.model)) return {}
  }
  if (current.openai_base_url) {
    try {
      const previous = workshopAddress(current)
      if (current.openai_base_url !== previous?.openai_base_url ||
        Boolean(current.openai_base_url_is_full) !== previous?.openai_base_url_is_full ||
        (current.openai_api_key && current.openai_api_key !== current.api_key) ||
        (current.openai_model && current.openai_model !== current.model)) return {}
    } catch { return {} }
  }
  return discoverWorkshopConfig(next, fetchImpl)
}
