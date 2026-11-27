import type { ModelConfiguration } from './model-configurations.js'
import { isOpenAiProtocol, normalizeLlmBaseUrl, normalizeLlmUrlInput, type LlmProtocol } from './llm-egress.js'
import { getProvider, PROVIDERS } from './provider-registry.js'
import { probeProviderProtocol, validateProviderConnection } from './provider-model-services.js'

type WorkshopAddress = Pick<ModelConfiguration, 'openai_base_url' | 'openai_base_url_is_full'>
export type WorkshopPatch = Partial<Pick<ModelConfiguration,
  'openai_base_url' | 'openai_base_url_is_full' | 'openai_api_key' | 'openai_model' | 'workshop_auto_configured'>>

/** Workshop always uses Chat Completions. Only full Responses URLs need a sibling. */
export function sharedOpenAiWorkshopAddress(configuration: Pick<ModelConfiguration,
  'base_url' | 'base_url_is_full' | 'weworker_protocol'>): WorkshopAddress | undefined {
  const { base_url: baseUrl, weworker_protocol: protocol } = configuration
  const fullUrl = configuration.base_url_is_full === true
  if (!baseUrl || !isOpenAiProtocol(protocol)) return undefined
  try {
    let address = normalizeLlmUrlInput(baseUrl, fullUrl)
    if (fullUrl && protocol === 'openai_responses') {
      const endpoint = new URL(address)
      if (!/\/responses\/?$/.test(endpoint.pathname)) return undefined
      endpoint.pathname = endpoint.pathname.replace(/\/responses\/?$/, '/chat/completions')
      address = endpoint.href
    }
    return { openai_base_url: address, openai_base_url_is_full: fullUrl }
  } catch { return undefined }
}

function sourceBase(configuration: ModelConfiguration): string | undefined {
  if (!configuration.base_url_is_full) return normalizeLlmBaseUrl(configuration.base_url)
  const endpoint = new URL(normalizeLlmUrlInput(configuration.base_url, true))
  if (endpoint.search) return undefined
  const suffix = configuration.weworker_protocol === 'openai_responses' ? /\/responses\/?$/
    : configuration.weworker_protocol === 'openai_chat_completions' ? /\/chat\/completions\/?$/ : /\/v1\/messages\/?$/
  if (!suffix.test(endpoint.pathname)) return undefined
  endpoint.pathname = endpoint.pathname.replace(suffix, '')
  return normalizeLlmBaseUrl(endpoint.href)
}

function knownWorkshopBase(base: string | undefined, protocol: LlmProtocol): string | undefined {
  if (!base) return undefined
  // Only the catalog can make an unprobed mapping authoritative. Deployment
  // overrides and same-origin but differently routed URLs still need a probe.
  return PROVIDERS.find(provider => provider.id !== 'custom' && provider.weworker.baseUrl
    && provider.webwright.protocol === 'openai_chat_completions' && provider.webwright.baseUrl
    && (provider.weworker.protocol === protocol || (protocol === 'openai_responses' && provider.weworker.protocol === 'openai_chat_completions'))
    && normalizeLlmBaseUrl(provider.weworker.baseUrl) === base)?.webwright.baseUrl
}

async function probeWorkshop(configuration: ModelConfiguration, address: WorkshopAddress, fetchImpl: typeof fetch, timeoutMs: number): Promise<WorkshopPatch> {
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    const boundedFetch: typeof fetch = (url, init) => fetchImpl(url, {
      ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    })
    let model = configuration.model
    if (!model) {
      if (address.openai_base_url_is_full) return {}
      const response = await boundedFetch(`${address.openai_base_url}/models`, {
        headers: { authorization: `Bearer ${configuration.api_key}` }, redirect: 'error',
      })
      if (!response.ok) return {}
      const data = await response.json() as { data?: Array<{ id?: unknown }> }
      const id = data.data?.find(item => typeof item?.id === 'string' && item.id.trim())?.id
      if (typeof id !== 'string' || id.length > 200) return {}
      model = id.trim()
    }
    const result = await probeProviderProtocol({ provider: getProvider('custom')!, apiKey: configuration.api_key,
      model, openaiBaseUrl: address.openai_base_url, openaiFullUrl: address.openai_base_url_is_full,
      target: 'webwright', verifyResponse: true,
    }, boundedFetch)
    return result.ok ? { ...address, openai_api_key: configuration.api_key, openai_model: model } : {}
  } catch { return {} }
}

/** Manual save and local discovery give Anthropic the same validation and mapping rules. */
export async function detectValidatedWorkshop(configuration: ModelConfiguration, fetchImpl: typeof fetch = fetch, timeoutMs = 6000) {
  const validation = await validateProviderConnection(configuration, fetchImpl, timeoutMs, true)
  const empty: WorkshopPatch = {}
  if (!validation.ok) return { validation, workshop: empty, preset: false }
  try {
    const protocol = configuration.weworker_protocol || 'anthropic_messages'
    const base = sourceBase(configuration)
    const preset = knownWorkshopBase(base, protocol)
    if (isOpenAiProtocol(protocol)) {
      const address = sharedOpenAiWorkshopAddress(configuration)
      if (!address) return { validation, workshop: empty, preset: false }
      // Discovery continues verifying unknown Responses gateways can also serve
      // Chat Completions before importing them automatically.
      if (protocol === 'openai_responses' && !preset) {
        return { validation, workshop: await probeWorkshop(configuration, address, fetchImpl, timeoutMs), preset: false }
      }
      const workshopAddress = preset ? { openai_base_url: preset, openai_base_url_is_full: false } : address
      return { validation, workshop: { ...workshopAddress, openai_api_key: configuration.api_key, openai_model: configuration.model }, preset: Boolean(preset) }
    }
    if (preset) {
      return { validation, workshop: { openai_base_url: preset, openai_base_url_is_full: false,
        openai_api_key: configuration.api_key, ...(configuration.model ? { openai_model: configuration.model } : {}),
        workshop_auto_configured: true }, preset: true }
    }
    if (!base) return { validation, workshop: empty, preset: false }
    const workshop = await probeWorkshop(configuration, { openai_base_url: /\/v1$/i.test(base) ? base : `${base}/v1`,
      openai_base_url_is_full: false }, fetchImpl, timeoutMs)
    return { validation, workshop: workshop.openai_base_url ? { ...workshop, workshop_auto_configured: true } : empty, preset: false }
  } catch { return { validation, workshop: empty, preset: false } }
}

export function workshopSettingsEdited(current: ModelConfiguration, next: ModelConfiguration): boolean {
  return (current.openai_base_url || '') !== (next.openai_base_url || '')
    || Boolean(current.openai_base_url_is_full) !== Boolean(next.openai_base_url_is_full)
    || (current.openai_api_key || '') !== (next.openai_api_key || '')
    || ((current.openai_model || '') !== (next.openai_model || '')
      && Boolean(current.openai_model || next.openai_model !== next.model))
    || (current.openai_models_url || '') !== (next.openai_models_url || '')
    || (Boolean(current.openai_models_url || next.openai_models_url)
      && (current.openai_models_url_is_full ?? true) !== (next.openai_models_url_is_full ?? true))
}

export function hasIndependentWorkshopSettings(configuration: ModelConfiguration): boolean {
  return configuration.workshop_auto_configured !== true && Boolean(configuration.openai_base_url
    || configuration.openai_api_key || configuration.openai_models_url
    || (configuration.openai_model && configuration.openai_model !== configuration.model))
}

export async function automaticWorkshopUpdate(
  current: ModelConfiguration,
  next: ModelConfiguration,
  input: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkshopPatch> {
  const mainFields = ['api_key', 'base_url', 'base_url_is_full', 'weworker_protocol', 'model', 'auth_type'] as const
  if (next.provider_id !== 'custom' || isOpenAiProtocol(next.weworker_protocol) || !next.api_key || !next.base_url
    || !mainFields.some(field => input[field] !== undefined)
    || hasIndependentWorkshopSettings(current) || workshopSettingsEdited(current, next)) return {}
  if (current.workshop_auto_configured && current.openai_base_url && mainFields.every(field => current[field] === next[field])) return {}
  const { workshop } = await detectValidatedWorkshop(next, fetchImpl)
  // A failed probe must not leave the previous auto-derived route or key in use.
  return workshop.openai_base_url ? workshop : current.workshop_auto_configured
    ? { openai_base_url: '', openai_base_url_is_full: false, openai_api_key: '', openai_model: '', workshop_auto_configured: false } : {}
}
