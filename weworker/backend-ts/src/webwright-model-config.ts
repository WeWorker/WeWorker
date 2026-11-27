import { timingSafeEqual } from 'node:crypto'
import type { Settings } from './config.js'
import { assertAllowedLlmBaseUrl, isOpenAiProtocol, normalizeLlmBaseUrl, normalizeLlmUrlInput, type ProviderEntry } from './llm-egress.js'
import { sharedOpenAiWorkshopAddress } from './adapter-workshop-config.js'
import { normalizeCompactionMaxAttempts, normalizeCompactionRatio } from './context/conversation-compaction.js'
import { DEFAULT_BUILTIN_CONTEXT_LIMIT, normalizeContextLimit } from './context-window.js'
import { defaultConversationModel, explorationProviderId, resolveConversationModelSettings, type ConversationModel } from './conversation-models.js'
import { buildRuntimeAllowedLlmBaseUrls, getProvider, PROVIDERS } from './provider-registry.js'
import { builtinProviderAccess } from './builtin-provider.js'
import { getModelConfiguration } from './model-configurations.js'
export { explorationResetPatch } from './provider-config.js'

export function builtinExplorationAccess(provider: ProviderEntry) {
  try {
    const access = builtinProviderAccess(provider)
    if (access.provider.webwright.protocol === 'openai_chat_completions' && access.openaiBaseUrl) return access
  } catch { /* An incomplete deployment is unavailable. */ }
}

// The model settings page owns these fields. Never substitute the retired
// independent exploration store for an explicit model-configuration reference.
export function modelSettingsExplorationEntry(saved: Settings, id: string) {
  const configuration = getModelConfiguration(saved, id)
  const provider = getProvider(configuration?.provider_id || id)
  if (!provider || provider.builtin || provider.webwright.protocol !== 'openai_chat_completions') return undefined
  const legacy = saved as unknown as Record<string, string>
  const activeModel = id === (saved.active_model_configuration || saved.active_provider) ? saved.model : ''
  const legacyModel = legacy[`model_${id}`] || activeModel
  const mainModel = configuration?.model ?? legacyModel
  if (provider.id === 'custom' && isOpenAiProtocol(configuration ? configuration.weworker_protocol : saved.weworker_protocol_custom)) {
    const main = resolveConversationModelSettings(saved, { provider: id, model: mainModel || 'unconfigured' })
    const address = sharedOpenAiWorkshopAddress({ base_url: configuration ? configuration.base_url : main.base_url,
      base_url_is_full: main.base_url_is_full, weworker_protocol: main.active_weworker_protocol })
    return { api_key: main.api_key, model: mainModel, base_url: address?.openai_base_url,
      base_url_is_full: address?.openai_base_url_is_full === true, protocol: provider.webwright.protocol,
      auth_type: 'auth_token' as const, use_main_key: true, shared: true,
      models_url: configuration ? configuration.models_url : saved.models_url_custom,
      models_url_is_full: configuration ? configuration.models_url_is_full : saved.models_url_is_full_custom }
  }
  const model = configuration?.openai_model || (!configuration && provider.id === 'custom' ? saved.openai_model_custom : '')
    || mainModel || activeModel || provider.defaultModel
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
    use_main_key: !(configuration ? configuration.openai_api_key : provider.id === 'custom' && saved.openai_api_key_custom),
    shared: false,
    models_url: configuration?.openai_models_url || (!configuration && id === 'custom' ? saved.openai_models_url_custom : undefined),
    models_url_is_full: configuration ? configuration.openai_models_url_is_full : id === 'custom' ? saved.openai_models_url_is_full_custom : undefined,
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
  const stored = saved.exploration_model_selection
  const selected = !saved.model_selection_revision || stored?.selection_revision === saved.model_selection_revision ? stored : undefined
  if (selected) {
    const id = selected.provider.startsWith('__exploration__') ? explorationProviderId(saved, selected) || selected.provider : selected.provider
    const entry = modelSettingsExplorationEntry(saved, id)
    return { ...selected, ...(entry?.shared ? { model: entry.model } : {}),
      thinking_effort: selected.thinking_effort || saved.exploration_thinking_effort || 'off' }
  }
  const main = defaultConversationModel(saved)
  return { ...main, model: modelSettingsExplorationEntry(saved, main.provider)?.model || main.model,
    thinking_effort: saved.exploration_thinking_effort || 'off' }
}

export function resolveWebwrightModelConfig(saved: Settings, pinnedSelection?: ConversationModel) {
  const selection = pinnedSelection ?? defaultWebwrightModelSelection(saved)
  const id = selection.provider === '__exploration__' || selection.provider.startsWith('__exploration__:')
    ? explorationProviderId(saved, selection) : selection.provider
  const configuration = getModelConfiguration(saved, id)
  const provider = getProvider(configuration?.provider_id || id)
  if (!provider || provider.webwright.protocol !== 'openai_chat_completions') {
    throw new Error('请在模型配置中选择已配置 OpenAI 接口的 Adapter 工坊模型')
  }
  const common = {
    provider_id: provider.id,
    protocol: 'openai_chat_completions' as const,
    structured_output: 'openai_json_object' as const,
    auth_type: 'auth_token' as const,
    compaction_ratio: normalizeCompactionRatio(saved.compaction_ratio),
    compaction_max_attempts: normalizeCompactionMaxAttempts(saved.compaction_max_attempts),
    thinking_effort: selection.thinking_effort || saved.exploration_thinking_effort || 'off',
  }
  // A prepared generation keeps its model even if the shared configuration's default changes.
  const selectedModel = pinnedSelection?.model ?? (provider.fixedModel ? provider.defaultModel : selection.model)
  if (provider.builtin) {
    const access = builtinExplorationAccess(provider)
    if (!access || !selectedModel) throw new Error('内置模型的 Adapter 工坊 OpenAI 接口尚未配置，请联系应用提供方或选择其他模型')
    return {
      ...common,
      model: selectedModel,
      model_class: access.provider.webwright.modelClass,
      base_url: assertAllowedLlmBaseUrl(access.openaiBaseUrl, buildRuntimeAllowedLlmBaseUrls(access.openaiBaseUrl)),
      base_url_is_full: false,
      api_key: access.apiKey,
      context_limit: normalizeContextLimit(saved.builtin_context_limits?.[provider.id], DEFAULT_BUILTIN_CONTEXT_LIMIT),
    }
  }

  const entry = modelSettingsExplorationEntry(saved, id)
  const model = pinnedSelection?.model ?? (entry?.shared ? entry.model : selectedModel)
  if (!entry?.api_key || !model) throw new Error('请先在模型配置中配置 Adapter 工坊的 API Key 和模型')
  if (!entry.base_url) throw new Error('请在模型配置中填写网站探索 OpenAI 接口地址')
  const main = resolveConversationModelSettings(saved, { provider: id, model })
  const custom = provider.id === 'custom'
  const baseUrl = entry.base_url
  const mapped = custom && !entry.base_url_is_full ? PROVIDERS.find(item => item.id !== 'custom'
    && item.webwright.protocol === 'openai_chat_completions' && Boolean(item.webwright.baseUrl)
    && normalizeLlmBaseUrl(item.webwright.baseUrl) === normalizeLlmBaseUrl(baseUrl)) : undefined
  return {
    ...common,
    model,
    model_class: custom ? mapped?.webwright.modelClass || 'openai_chat' as const : provider.webwright.modelClass,
    base_url: custom && entry.base_url_is_full
      ? normalizeLlmUrlInput(baseUrl, true)
      : assertAllowedLlmBaseUrl(baseUrl, buildRuntimeAllowedLlmBaseUrls(custom ? baseUrl : undefined)),
    base_url_is_full: custom && entry.base_url_is_full === true,
    api_key: entry.api_key,
    context_limit: main.context_limit,
  }
}
