import { timingSafeEqual } from 'node:crypto'
import type { Settings } from './config.js'
import { normalizeLlmBaseUrl, normalizeLlmUrlInput } from './llm-egress.js'
import { normalizeCompactionMaxAttempts, normalizeCompactionRatio } from './context/conversation-compaction.js'
import { defaultConversationModel, explorationProviderId, resolveConversationModelSettings, type ConversationModel } from './conversation-models.js'
import { getProvider, PROVIDERS } from './provider-registry.js'
import { assertAllowedLlmBaseUrl } from './llm-egress.js'
import { buildRuntimeAllowedLlmBaseUrls } from './provider-registry.js'
import { getModelConfiguration } from './model-configurations.js'
export { explorationResetPatch } from './provider-config.js'

// The model settings page owns these fields. Never substitute the retired
// independent exploration store for an explicit model-configuration reference.
export function modelSettingsExplorationEntry(saved: Settings, id: string) {
  const configuration = getModelConfiguration(saved, id)
  const provider = getProvider(configuration?.provider_id || id)
  if (!provider || provider.builtin || provider.webwright.protocol !== 'openai_chat_completions') return undefined
  const legacy = saved as unknown as Record<string, string>
  const model = configuration?.openai_model || configuration?.model
    || (provider.id === 'custom' ? saved.openai_model_custom || saved.model_custom : legacy[`model_${id}`])
    || (id === (saved.active_model_configuration || saved.active_provider) ? saved.model : '') || provider.defaultModel
  const main = resolveConversationModelSettings(saved, { provider: id, model: model || 'unconfigured' })
  return {
    api_key: provider.id === 'custom'
      ? configuration ? configuration.openai_api_key || configuration.api_key : saved.openai_api_key_custom || main.api_key
      : configuration?.openai_api_key || main.api_key,
    model: provider.fixedModel ? provider.defaultModel : model,
    base_url: provider.id === 'custom' ? configuration ? configuration.openai_base_url : saved.openai_base_url_custom : provider.webwright.baseUrl,
    base_url_is_full: provider.id === 'custom' && (configuration ? configuration.openai_base_url_is_full === true : saved.openai_base_url_is_full_custom === true),
    protocol: provider.webwright.protocol,
    auth_type: 'auth_token' as const,
  }
}

export function isAuthorizedModelConfigRequest(authorization: string | undefined, expectedToken: string): boolean {
  const actual = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!actual || !expectedToken) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expectedToken)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

// Selections persist a reference and optional session model, never a second
// endpoint or credential. Old sentinel records resolve the same canonical source.
export function defaultWebwrightModelSelection(saved: Settings): ConversationModel {
  const selected = saved.exploration_model_selection
  if (selected) return { ...selected, thinking_effort: selected.thinking_effort || saved.exploration_thinking_effort || 'off' }
  const main = defaultConversationModel(saved)
  return { ...main, model: modelSettingsExplorationEntry(saved, main.provider)?.model || main.model,
    thinking_effort: saved.exploration_thinking_effort || 'off' }
}

export function resolveWebwrightModelConfig(saved: Settings) {
  const selection = defaultWebwrightModelSelection(saved)
  const id = selection.provider === '__exploration__' || selection.provider.startsWith('__exploration__:')
    ? explorationProviderId(saved, selection) : selection.provider
  const configuration = getModelConfiguration(saved, id)
  const provider = getProvider(configuration?.provider_id || id)
  if (!provider || provider.webwright.protocol !== 'openai_chat_completions') {
    throw new Error('请在模型配置中选择已配置 OpenAI 接口的 Adapter 工坊模型')
  }
  const main = resolveConversationModelSettings(saved, { provider: id, model: selection.model })
  const entry = provider.builtin ? {
    api_key: main.api_key, base_url: provider.webwright.baseUrl, base_url_is_full: false,
  } : modelSettingsExplorationEntry(saved, id)
  if (!entry?.api_key || !selection.model) throw new Error('请先在模型配置中配置 Adapter 工坊的 API Key 和模型')
  if (!entry.base_url) throw new Error('请在模型配置中填写网站探索 OpenAI 接口地址')
  const custom = provider.id === 'custom'
  const mapped = custom && !entry.base_url_is_full ? PROVIDERS.find(item => item.id !== 'custom'
    && item.webwright.protocol === 'openai_chat_completions' && Boolean(item.webwright.baseUrl)
    && normalizeLlmBaseUrl(item.webwright.baseUrl) === normalizeLlmBaseUrl(entry.base_url!)) : undefined
  return {
    provider_id: provider.id,
    protocol: 'openai_chat_completions' as const,
    model_class: custom ? mapped?.webwright.modelClass || 'openai_chat' as const : provider.webwright.modelClass,
    base_url: custom && entry.base_url_is_full
      ? normalizeLlmUrlInput(entry.base_url, true)
      : assertAllowedLlmBaseUrl(entry.base_url, buildRuntimeAllowedLlmBaseUrls(custom ? entry.base_url : undefined)),
    base_url_is_full: custom && entry.base_url_is_full === true,
    model: provider.fixedModel ? provider.defaultModel : selection.model,
    api_key: entry.api_key,
    structured_output: 'openai_json_object' as const,
    auth_type: 'auth_token' as const,
    context_limit: main.context_limit,
    compaction_ratio: normalizeCompactionRatio(saved.compaction_ratio),
    compaction_max_attempts: normalizeCompactionMaxAttempts(saved.compaction_max_attempts),
    thinking_effort: selection.thinking_effort || saved.exploration_thinking_effort || 'off',
  }
}
