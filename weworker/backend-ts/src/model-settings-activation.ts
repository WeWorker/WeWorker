import type { Settings } from './config.js'
import { randomUUID } from 'node:crypto'
import { activateBuiltinProvider, builtinProviderAccess, isBuiltinProvider } from './builtin-provider.js'
import { defaultConversationModel, resolveConversationModelSettings } from './conversation-models.js'
import { getModelConfiguration, activateModelConfiguration, updateModelConfiguration, renameModelConfiguration } from './model-configurations.js'
import { getProvider } from './provider-registry.js'
import { explorationResetPatch } from './provider-config.js'
import { DEFAULT_BUILTIN_CONTEXT_LIMIT, DEFAULT_CONTEXT_LIMIT, parseContextLimit } from './context-window.js'
import { automaticWorkshopUpdate } from './adapter-workshop-config.js'
import type { ModelConfiguration } from './model-configurations.js'

export async function prepareCheckedModelSave(settings: Settings, id: string, input: Record<string, unknown>): Promise<Partial<Settings>> {
  const stored = getModelConfiguration(settings, id)
  const provider = getProvider(stored?.provider_id || id)
  if (!provider) throw new Error('模型配置不存在')
  if (provider.builtin) {
    if (Object.keys(input).some(key => !['provider', 'activate', 'name', 'context_limit'].includes(key))) throw new Error('内置模型仅支持修改名称和上下文窗口')
    const limit = parseContextLimit(input.context_limit)
    if (limit === null) throw new Error('上下文窗口请输入 1K 到 100M 之间的数值，并使用 K 或 M 单位')
    return { ...(input.name === undefined ? {} : renameModelConfiguration(settings, id, input.name)),
      builtin_context_limits: { ...settings.builtin_context_limits, [id]: limit } }
  }
  // Promote legacy fixed/custom entries into the existing encrypted collection.
  // Keep their public ID so conversation references and menus remain valid.
  const legacy = settings as unknown as Record<string, unknown>
  const current: ModelConfiguration = stored || {
    provider_id: id, name: settings.model_configuration_names?.[id] || provider.name,
    api_key: String(legacy[`api_key_${id}`] || ''), model: String(legacy[`model_${id}`] || provider.defaultModel),
    context_limit: Number(legacy[`context_limit_${id}`]) || DEFAULT_CONTEXT_LIMIT,
    base_url: id === 'custom' ? settings.base_url_custom : provider.weworker.baseUrl,
    base_url_is_full: id === 'custom' && settings.base_url_is_full_custom === true,
    auth_type: id === 'custom' ? settings.custom_auth_type : provider.authType || 'api_key',
    weworker_protocol: id === 'custom' ? settings.weworker_protocol_custom : provider.weworker.protocol,
    openai_base_url: id === 'custom' ? settings.openai_base_url_custom : provider.webwright.baseUrl,
    openai_base_url_is_full: id === 'custom' && settings.openai_base_url_is_full_custom === true,
    openai_api_key: id === 'custom' ? settings.openai_api_key_custom : undefined,
    openai_model: id === 'custom' ? settings.openai_model_custom : undefined,
    ...(id === 'custom' ? {
      models_url: settings.models_url_custom, models_url_is_full: settings.models_url_is_full_custom,
      models_auth_type: settings.models_auth_type_custom, openai_models_url: settings.openai_models_url_custom,
      openai_models_url_is_full: settings.openai_models_url_is_full_custom,
    } : {}),
  }
  const draft = { ...settings, model_configurations: { ...settings.model_configurations, [id]: current } }
  const pending = updateModelConfiguration(draft, id, input)
  const automatic = await automaticWorkshopUpdate(current, pending.model_configurations![id], input)
  return updateModelConfiguration(draft, id, { ...input, ...automatic })
}
import { probeTimedMainConnection, probeProviderProtocol, type ProviderConnectionInput } from './provider-model-services.js'
import { resolveWebwrightModelConfig } from './webwright-model-config.js'

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

type Dependencies = {
  getSettings: () => Settings
  updateSettings: (patch: Partial<Settings>) => Settings
  probeMain?: typeof probeTimedMainConnection
  probeExploration?: typeof probeProviderProtocol
}

// Do not write drafts, credentials or selections until every required probe has
// succeeded. Running requests hold their existing Settings snapshot.
export async function activateCheckedModelSettings(id: string, patch: Partial<Settings>, deps: Dependencies, expected = deps.getSettings()): Promise<Settings> {
  const fingerprint = JSON.stringify(expected)
  const assertUnchanged = () => {
    if (JSON.stringify(deps.getSettings()) !== fingerprint) throw new Error('检测期间设置已变更，请重试保存或切换')
  }
  assertUnchanged()
  const candidate = { ...expected, ...patch }
  const activation = providerActivationPatch(candidate, id)
  const active = { ...candidate, ...activation }
  const main = resolveConversationModelSettings(active, defaultConversationModel(active))
  const selectedProvider = getProvider(main.active_provider)!
  const builtin = selectedProvider.builtin ? builtinProviderAccess(selectedProvider) : undefined
  const provider = builtin?.provider || selectedProvider
  const input: ProviderConnectionInput = {
    provider, apiKey: main.api_key, model: main.model,
    weworkerProtocol: main.active_weworker_protocol, weworkerBaseUrl: main.base_url,
    weworkerFullUrl: main.base_url_is_full, anthropicBaseUrl: main.base_url,
    anthropicFullUrl: main.base_url_is_full, anthropicAuthType: main.active_auth_type,
  }
  const result = await (deps.probeMain || probeTimedMainConnection)(input)
  if (!result.ok) throw new Error(`对话模型不可用：${result.detail || result.error || '检测失败'}`)
  const exploration = builtin ? {
    protocol: provider.webwright.protocol, base_url: builtin.openaiBaseUrl, base_url_is_full: false,
    api_key: builtin.apiKey, model: builtin.model,
  } : resolveWebwrightModelConfig({ ...active, exploration_model_selection: undefined })
  const explored = await (deps.probeExploration || probeProviderProtocol)({
    provider: { ...provider, webwright: { ...provider.webwright, protocol: exploration.protocol, baseUrl: exploration.base_url } },
    apiKey: exploration.api_key, openaiApiKey: exploration.api_key, model: exploration.model,
    openaiModel: exploration.model, openaiBaseUrl: exploration.base_url,
    openaiFullUrl: exploration.base_url_is_full, target: 'webwright', verifyResponse: true,
  })
  if (!explored.ok) throw new Error(`网站探索模型不可用：${explored.detail || explored.error || '检测失败'}`)
  assertUnchanged()
  return deps.updateSettings({ ...patch, ...activation, model_selection_revision: randomUUID(), exploration_model_selection: undefined })
}
