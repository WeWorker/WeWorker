import type { Settings } from './config.js'
import { randomUUID } from 'node:crypto'
import { activateBuiltinProvider, isBuiltinProvider } from './builtin-provider.js'
import { defaultConversationModel, resolveConversationModelSettings } from './conversation-models.js'
import { getModelConfiguration, activateModelConfiguration, updateModelConfiguration, renameModelConfiguration } from './model-configurations.js'
import { getProvider } from './provider-registry.js'
import { explorationResetPatch } from './provider-config.js'
import { DEFAULT_BUILTIN_CONTEXT_LIMIT, MODEL_CONTEXT_LIMIT_ERROR, normalizeModelContextLimit, parseModelContextLimit } from './context-window.js'
import { automaticWorkshopUpdate } from './adapter-workshop-config.js'
import type { ModelConfiguration } from './model-configurations.js'

export async function prepareCheckedModelSave(settings: Settings, id: string, input: Record<string, unknown>): Promise<Partial<Settings>> {
  const stored = getModelConfiguration(settings, id)
  const provider = getProvider(stored?.provider_id || id)
  if (!provider) throw new Error('模型配置不存在')
  if (provider.builtin) {
    if (Object.keys(input).some(key => !['provider', 'activate', 'name', 'context_limit'].includes(key))) throw new Error('内置模型仅支持修改名称和上下文窗口')
    const limit = parseModelContextLimit(input.context_limit)
    if (limit === null) throw new Error(MODEL_CONTEXT_LIMIT_ERROR)
    return { ...(input.name === undefined ? {} : renameModelConfiguration(settings, id, input.name)),
      builtin_context_limits: { ...settings.builtin_context_limits, [id]: limit } }
  }
  // Promote legacy fixed/custom entries into the existing encrypted collection.
  // Keep their public ID so conversation references and menus remain valid.
  const legacy = settings as unknown as Record<string, unknown>
  const current: ModelConfiguration = stored || {
    provider_id: id, name: settings.model_configuration_names?.[id] || provider.name,
    api_key: String(legacy[`api_key_${id}`] || ''), model: String(legacy[`model_${id}`] || provider.defaultModel),
    context_limit: normalizeModelContextLimit(legacy[`context_limit_${id}`]),
    base_url: id === 'custom' ? settings.base_url_custom : provider.weworker.baseUrl,
    base_url_is_full: id === 'custom' && settings.base_url_is_full_custom === true,
    auth_type: id === 'custom' ? settings.custom_auth_type : provider.authType || 'api_key',
    weworker_protocol: id === 'custom' ? settings.weworker_protocol_custom : provider.weworker.protocol,
    openai_base_url: id === 'custom' ? settings.openai_base_url_custom : provider.webwright.baseUrl,
    openai_base_url_is_full: id === 'custom' && settings.openai_base_url_is_full_custom === true,
    openai_api_key: id === 'custom' ? settings.openai_api_key_custom : undefined,
    openai_model: id === 'custom' ? settings.openai_model_custom : undefined,
    workshop_auto_configured: id === 'custom' ? settings.workshop_auto_configured_custom : undefined,
    ...(id === 'custom' ? {
      models_url: settings.models_url_custom, models_url_is_full: settings.models_url_is_full_custom,
      models_auth_type: settings.models_auth_type_custom, openai_models_url: settings.openai_models_url_custom,
      openai_models_url_is_full: settings.openai_models_url_is_full_custom,
    } : {}),
  }
  const draft = { ...settings, model_configurations: { ...settings.model_configurations, [id]: current } }
  const pending = updateModelConfiguration(draft, id, input)
  const automatic = await automaticWorkshopUpdate(current, pending.model_configurations![id], input)
  return updateModelConfiguration(draft, id, input, automatic)
}

export function providerActivationPatch(settings: Settings, id: string): Partial<Settings> {
  if (getModelConfiguration(settings, id)) return activateModelConfiguration(settings, id)
  const provider = getProvider(id)
  if (!provider) throw new Error('模型供应商不存在')
  if (isBuiltinProvider(id)) return {
    ...activateBuiltinProvider(provider),
    context_limit: settings.builtin_context_limits?.[id] || DEFAULT_BUILTIN_CONTEXT_LIMIT,
  }
  const legacy = settings as unknown as Record<string, unknown>
  const model = String(legacy[`model_${id}`] || provider.defaultModel || '')
  const resolved = resolveConversationModelSettings(settings, { provider: id, model })
  if (!resolved.api_key || !resolved.base_url) throw new Error('请先配置 API Key、模型和接口地址')
  return {
    active_provider: id, active_model_configuration: '', model: resolved.model,
    api_key: resolved.api_key, base_url: resolved.base_url, base_url_is_full: resolved.base_url_is_full,
    active_auth_type: resolved.active_auth_type, active_weworker_protocol: resolved.active_weworker_protocol,
    context_limit: resolved.context_limit, ...explorationResetPatch(id),
  }
}

export type ModelActivationCheck = {
  target: 'weworker' | 'webwright'
  status: 'success' | 'failure'
  message: string
}

type Dependencies = {
  getSettings: () => Settings
  updateSettings: (patch: Partial<Settings>) => Settings
  onCheck?: (check: ModelActivationCheck) => void
}

// Activation validates locally and commits without requiring network availability.
export async function activateCheckedModelSettings(id: string, patch: Partial<Settings>, deps: Dependencies, expected = deps.getSettings()): Promise<Settings> {
  if (JSON.stringify(deps.getSettings()) !== JSON.stringify(expected)) throw new Error('设置已变更，请重试保存或切换')
  const candidate = { ...expected, ...patch }
  const activation = providerActivationPatch(candidate, id)
  const active = { ...candidate, ...activation }
  resolveConversationModelSettings(active, defaultConversationModel(active))
  return deps.updateSettings({ ...patch, ...activation, model_selection_revision: randomUUID(), exploration_model_selection: undefined })
}
