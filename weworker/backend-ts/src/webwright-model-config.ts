import { timingSafeEqual } from 'node:crypto'
import type { Settings } from './config.js'
import { normalizeLlmBaseUrl, normalizeLlmUrlInput } from './llm-egress.js'
import { normalizeCompactionMaxAttempts, normalizeCompactionRatio } from './context/conversation-compaction.js'
import { defaultConversationModel, resolveConversationModelSettings } from './conversation-models.js'
import { getProvider, findProviderByWeWorkerBaseUrl, PROVIDERS } from './provider-registry.js'
import { usesAnthropicBearerToken } from './anthropic-auth.js'
import { assertAllowedLlmBaseUrl } from './llm-egress.js'
import { buildRuntimeAllowedLlmBaseUrls } from './provider-registry.js'
export { explorationResetPatch } from './provider-config.js'

export function isAuthorizedModelConfigRequest(authorization: string | undefined, expectedToken: string): boolean {
  const actual = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!actual || !expectedToken) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function resolveWebwrightModelConfig(saved: Settings) {
  const independentModel = saved.exploration_active_provider
    ? saved.exploration_providers?.[saved.exploration_active_provider]?.model || saved.model : ''
  const selection = saved.exploration_model_selection || (saved.exploration_active_provider
    ? { provider: '__exploration__', model: independentModel }
    : defaultConversationModel(saved))
  if (selection.provider === '__exploration__') {
    const provider = getProvider(saved.exploration_active_provider || '')
    const entry = provider && saved.exploration_providers?.[provider.id]
    const apiKey = entry?.use_main_key
      ? resolveConversationModelSettings(saved, defaultConversationModel(saved)).api_key : entry?.api_key
    if (!provider || !entry || !apiKey || !selection.model) throw new Error('请先在高级设置中配置网站探索模型')
    const custom = provider.id === 'custom'
    const protocol = custom ? entry.protocol : provider.webwright.protocol
    const baseUrl = custom ? entry.base_url : provider.webwright.baseUrl
    if (!baseUrl) throw new Error('请填写网站探索服务地址')
    const mapped = custom && !entry.base_url_is_full ? PROVIDERS.find(item => item.id !== 'custom'
      && normalizeLlmBaseUrl(item.webwright.baseUrl) === normalizeLlmBaseUrl(baseUrl)) : undefined
    return {
      provider_id: provider.id,
      protocol,
      model_class: custom ? mapped ? mapped.webwright.modelClass : protocol === 'anthropic_messages' ? 'anthropic' as const : 'openai_chat' as const : provider.webwright.modelClass,
      base_url: custom && entry.base_url_is_full
        ? normalizeLlmUrlInput(baseUrl, true)
        : assertAllowedLlmBaseUrl(baseUrl, buildRuntimeAllowedLlmBaseUrls(custom ? baseUrl : undefined)),
      base_url_is_full: custom && entry.base_url_is_full === true,
      model: selection.model,
      api_key: apiKey,
      structured_output: protocol === 'anthropic_messages' ? 'anthropic_json_schema' as const : 'openai_json_object' as const,
      auth_type: protocol === 'anthropic_messages' ? custom && entry.auth_type === 'auth_token' ? 'auth_token' as const : 'api_key' as const : 'auth_token' as const,
      context_limit: saved.context_limit,
      compaction_ratio: normalizeCompactionRatio(saved.compaction_ratio),
      compaction_max_attempts: normalizeCompactionMaxAttempts(saved.compaction_max_attempts),
      thinking_effort: selection.thinking_effort || saved.exploration_thinking_effort || 'off',
    } as const
  }

  const settings = resolveConversationModelSettings(saved, selection)
  if (!settings.api_key || !settings.model) throw new Error('请先配置对话接口的 API Key 和模型')
  if (!settings.base_url) throw new Error('请填写对话接口地址')
  const protocol = settings.active_weworker_protocol || 'anthropic_messages'
  const authProvider = settings.active_provider === 'custom'
    ? findProviderByWeWorkerBaseUrl(settings.base_url)?.id || settings.active_provider : settings.active_provider
  const modelClass = protocol === 'anthropic_messages' ? 'anthropic'
    : protocol === 'openai_responses' ? 'openai' : 'openai_chat'
  const structuredOutput = protocol === 'anthropic_messages' ? 'anthropic_json_schema'
    : protocol === 'openai_responses' ? 'openai_json_schema' : 'openai_json_object'
  return {
    provider_id: settings.active_provider,
    protocol,
    model_class: modelClass,
    base_url: normalizeLlmUrlInput(settings.base_url, settings.base_url_is_full === true),
    ...(settings.base_url_is_full ? { base_url_is_full: true } : {}),
    auth_type: protocol === 'anthropic_messages'
      ? usesAnthropicBearerToken(authProvider, settings.active_auth_type) ? 'auth_token' : 'api_key'
      : settings.active_auth_type || 'api_key',
    model: settings.model,
    api_key: settings.api_key,
    structured_output: structuredOutput,
    context_limit: settings.context_limit,
    compaction_ratio: normalizeCompactionRatio(settings.compaction_ratio),
    compaction_max_attempts: normalizeCompactionMaxAttempts(settings.compaction_max_attempts),
    thinking_effort: selection.thinking_effort || saved.exploration_thinking_effort || 'off',
  } as const
}
