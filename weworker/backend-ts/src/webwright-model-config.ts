import { timingSafeEqual } from 'node:crypto'
import type { Settings } from './config.js'
import { assertAllowedLlmBaseUrl, normalizeLlmBaseUrl, normalizeLlmUrlInput } from './llm-egress.js'
import { buildRuntimeAllowedLlmBaseUrls, getProvider, PROVIDERS } from './provider-registry.js'
import { getModelConfiguration } from './model-configurations.js'
import { builtinProviderAccess, isBuiltinProvider } from './builtin-provider.js'
export { explorationResetPatch } from './provider-config.js'

export function isAuthorizedModelConfigRequest(authorization: string | undefined, expectedToken: string): boolean {
  const actual = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!actual || !expectedToken) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function resolveWebwrightModelConfig(settings: Settings) {
  const configuredProvider = getProvider(settings.active_provider)
  const configuration = getModelConfiguration(settings, settings.active_model_configuration)
  const customBaseUrl = configuration?.base_url ?? settings.base_url_custom
  const customOpenAiBaseUrl = configuration?.openai_base_url ?? settings.openai_base_url_custom
  const customBaseUrlIsFull = configuration ? configuration.base_url_is_full === true : settings.base_url_is_full_custom === true
  const customOpenAiBaseUrlIsFull = configuration ? configuration.openai_base_url_is_full === true : settings.openai_base_url_is_full_custom === true
  const independent = Boolean(settings.exploration_base_url)
  const independentFullUrl = independent && settings.exploration_base_url_is_full === true
  const apiKey = independent && settings.exploration_use_main_key === false
    ? settings.exploration_api_key
    : configuration?.provider_id === 'custom'
      ? configuration.openai_api_key || configuration.api_key
      : settings.active_provider === 'custom' ? settings.openai_api_key_custom || settings.api_key : settings.api_key
  const model = independent && settings.exploration_model
    ? settings.exploration_model
    : configuration?.provider_id === 'custom'
      ? configuration.openai_model || configuration.model
      : settings.active_provider === 'custom' ? settings.openai_model_custom || settings.model : settings.model
  if (!configuredProvider || !apiKey || !model) throw new Error('请先配置 API Key 和模型')
  const provider = isBuiltinProvider(configuredProvider.id)
    ? builtinProviderAccess(configuredProvider).provider
    : configuredProvider
  const mapped = settings.active_provider === 'custom' && customBaseUrl && !customBaseUrlIsFull
    ? PROVIDERS.find(item => item.id !== 'custom' && item.weworker.baseUrl
      && normalizeLlmBaseUrl(item.weworker.baseUrl) === normalizeLlmBaseUrl(customBaseUrl))
    : undefined
  const independentProvider = independent && !independentFullUrl ? PROVIDERS.find(item => item.id !== 'custom' && item.webwright.baseUrl
    && normalizeLlmBaseUrl(item.webwright.baseUrl) === normalizeLlmBaseUrl(settings.exploration_base_url)) : undefined
  const config = independent ? independentProvider?.webwright || {
    protocol: 'openai_chat_completions' as const,
    modelClass: 'openai_chat' as const,
    structuredOutput: 'openai_json_object' as const,
  } : settings.active_provider === 'custom' && !customOpenAiBaseUrl && mapped ? mapped.webwright : provider.webwright
  const baseUrl = settings.exploration_base_url || (settings.active_provider === 'custom'
    ? customOpenAiBaseUrl || mapped?.webwright.baseUrl || (customBaseUrlIsFull ? '' : customBaseUrl)
    : provider.webwright.baseUrl)
  const fullUrl = independent ? independentFullUrl
    : settings.active_provider === 'custom' && Boolean(customOpenAiBaseUrl) && customOpenAiBaseUrlIsFull
  if (!baseUrl) throw new Error('请填写网站探索服务地址（OpenAI Chat Completions 兼容接口）')
  return {
    provider_id: independent ? 'custom' : settings.active_provider,
    protocol: config.protocol,
    model_class: config.modelClass,
    base_url: fullUrl ? normalizeLlmUrlInput(baseUrl, true) : assertAllowedLlmBaseUrl(
      baseUrl,
      buildRuntimeAllowedLlmBaseUrls(
        isBuiltinProvider(provider.id) ? provider.webwright.baseUrl : undefined,
        customBaseUrlIsFull ? undefined : customBaseUrl,
        customOpenAiBaseUrlIsFull ? undefined : customOpenAiBaseUrl,
        independentFullUrl ? undefined : settings.exploration_base_url,
      ),
    ),
    ...(fullUrl ? { base_url_is_full: true } : {}),
    model,
    api_key: apiKey,
    structured_output: config.structuredOutput,
  }
}

export function suggestExplorationBaseUrl(settings: Settings): { url: string; generated: boolean; fullUrl?: boolean } {
  const configuration = getModelConfiguration(settings, settings.active_model_configuration)
  const customBaseUrl = configuration?.base_url ?? settings.base_url_custom
  const customOpenAiBaseUrl = configuration?.openai_base_url ?? settings.openai_base_url_custom
  const customBaseUrlIsFull = configuration ? configuration.base_url_is_full === true : settings.base_url_is_full_custom === true
  const customOpenAiBaseUrlIsFull = configuration ? configuration.openai_base_url_is_full === true : settings.openai_base_url_is_full_custom === true
  const saved = settings.exploration_base_url || (settings.active_provider === 'custom' ? customOpenAiBaseUrl : '')
  const savedFullUrl = settings.exploration_base_url ? settings.exploration_base_url_is_full === true : customOpenAiBaseUrlIsFull
  if (saved) return { url: normalizeLlmUrlInput(saved, savedFullUrl), generated: false, ...(savedFullUrl ? { fullUrl: true } : {}) }
  const provider = getProvider(settings.active_provider)
  if (provider && provider.id !== 'custom') return { url: provider.webwright.baseUrl, generated: false }
  if (!customBaseUrl || customBaseUrlIsFull) return { url: '', generated: false }
  const mainUrl = normalizeLlmBaseUrl(customBaseUrl)
  const mapped = PROVIDERS.find(item => item.id !== 'custom' && item.weworker.baseUrl
    && normalizeLlmBaseUrl(item.weworker.baseUrl) === mainUrl)
  if (mapped) return { url: mapped.webwright.baseUrl, generated: false }
  return { url: mainUrl.endsWith('/v1') ? mainUrl : `${mainUrl}/v1`, generated: true }
}
