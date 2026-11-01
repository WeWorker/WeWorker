import { randomUUID } from 'node:crypto'
import type { Settings } from './config.js'
import { getProvider, PROVIDERS } from './provider-registry.js'
import { configuredModel } from './provider-config.js'
import { buildProviderVisibility, isFixedProvider } from './provider-visibility.js'
import { isBuiltinProvider } from './builtin-provider.js'
import { DEFAULT_CONTEXT_LIMIT, parseContextLimit } from './context-window.js'
import { isAnthropicAuthType, type AnthropicAuthType } from './anthropic-auth.js'
import { isLlmProtocol, normalizeLlmUrlInput } from './llm-egress.js'
import { modelCatalogConfigPatch, type ModelCatalogConfig } from './model-catalog-config.js'

export interface ModelConfiguration extends ModelCatalogConfig {
  name?: string
  provider_id: string
  model: string
  api_key: string
  context_limit: number
  base_url: string
  base_url_is_full?: boolean
  openai_base_url: string
  openai_base_url_is_full?: boolean
  openai_api_key?: string
  openai_model?: string
  custom_models?: string[]
  auth_type: AnthropicAuthType
  weworker_protocol?: import('./llm-egress.js').LlmProtocol
}

export function validateModelConfigurationName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) {
    throw new Error('配置名称请输入 1 到 80 个字符')
  }
  return value.trim()
}

export function buildModelConfigurationNames(settings: Settings): Record<string, string> {
  const visible = buildProviderVisibility(settings)
  const entries = [
    ...PROVIDERS.filter(provider => isBuiltinProvider(provider.id) || visible(provider.id))
      .map(provider => ({ id: provider.id, provider, name: isFixedProvider(provider.id) ? provider.name : settings.model_configuration_names?.[provider.id] })),
    ...Object.entries(settings.model_configurations || {}).flatMap(([id, configuration]) => {
      const provider = configuration && getProvider(configuration.provider_id)
      return provider ? [{ id, provider, name: configuration.name }] : []
    }),
  ]
  const used = new Set(entries.map(entry => entry.name?.trim()).filter(Boolean))
  const result: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.name?.trim()) {
      result[entry.id] = entry.name.trim()
    } else if (isBuiltinProvider(entry.id)) {
      result[entry.id] = entry.provider.name
    } else {
      let number = 1
      while (used.has(`${entry.provider.name}(${number})`)) number++
      result[entry.id] = `${entry.provider.name}(${number})`
      used.add(result[entry.id])
    }
  }
  return result
}

// Freeze generated names on the next write so later additions cannot renumber old entries.
export function modelConfigurationNameUpdates(settings: Settings): Partial<Settings> {
  const names = buildModelConfigurationNames(settings)
  return {
    model_configuration_names: {
      ...settings.model_configuration_names,
      ...Object.fromEntries(PROVIDERS.filter(provider => names[provider.id]).map(provider => [provider.id, names[provider.id]])),
    },
    model_configurations: Object.fromEntries(Object.entries(settings.model_configurations || {}).map(([id, configuration]) => [
      id, { ...configuration, ...(names[id] ? { name: names[id] } : {}) },
    ])),
  }
}

export function renameModelConfiguration(settings: Settings, id: string, value: unknown): Partial<Settings> {
  const name = validateModelConfigurationName(value)
  if (isFixedProvider(id)) {
    if (name !== getProvider(id)!.name) throw new Error('固定供应商名称不能修改')
    return {}
  }
  if (!getProvider(id) && !getModelConfiguration(settings, id)) throw new Error('模型配置不存在')
  const updates = modelConfigurationNameUpdates(settings)
  if (getModelConfiguration(settings, id)) {
    updates.model_configurations = { ...updates.model_configurations, [id]: { ...settings.model_configurations![id], name } }
  } else {
    updates.model_configuration_names = { ...updates.model_configuration_names, [id]: name }
  }
  return updates
}

export function createModelConfiguration(settings: Settings, providerId: string) {
  const provider = getProvider(providerId)
  if (!provider || provider.builtin || provider.allowMultiple === false) throw new Error('请选择预置或自定义供应商')
  const id = `model-${randomUUID()}`
  const nameUpdates = modelConfigurationNameUpdates(settings)
  const names = new Set(Object.values(buildModelConfigurationNames(settings)))
  let number = 1
  while (names.has(`${provider.name}(${number})`)) number++
  // Adding a custom configuration creates a blank draft, never a credential clone.
  const active = providerId === 'custom' ? undefined : Object.values(settings.model_configurations || {})
    .find(configuration => configuration.provider_id === providerId && configuration.api_key)
  const legacyKey = providerId === 'anthropic' ? settings.api_key_anthropic
    : providerId === 'glm' ? settings.api_key_glm
      : providerId === 'deepseek' ? settings.api_key_deepseek : ''
  const configuration: ModelConfiguration = {
    name: `${provider.name}(${number})`,
    provider_id: providerId,
    model: provider.defaultModel,
    api_key: active?.api_key || legacyKey || '',
    openai_api_key: active?.openai_api_key || active?.api_key || legacyKey || '',
    openai_model: active?.openai_model || active?.model || provider.defaultModel,
    context_limit: DEFAULT_CONTEXT_LIMIT,
    base_url: active?.base_url || provider.weworker.baseUrl,
    base_url_is_full: false,
    openai_base_url: active?.openai_base_url ?? provider.webwright.baseUrl,
    openai_base_url_is_full: false,
    auth_type: active?.auth_type || (providerId === 'custom' ? 'api_key' : provider.authType) || 'api_key',
    ...(providerId === 'custom' ? {
      weworker_protocol: active?.weworker_protocol || 'anthropic_messages',
      models_url: '',
      models_url_is_full: false,
      models_auth_type: 'inherit' as const,
      openai_models_url: '',
      openai_models_url_is_full: false,
    } : {}),
  }
  return { id, updates: { ...nameUpdates, model_configurations: { ...nameUpdates.model_configurations, [id]: configuration } } }
}

export function getModelConfiguration(settings: Settings, id: string | undefined): ModelConfiguration | undefined {
  const configuration = id && Object.hasOwn(settings.model_configurations || {}, id)
    ? settings.model_configurations?.[id]
    : undefined
  const provider = configuration && getProvider(configuration.provider_id)
  if (!configuration || !provider) return undefined
  return { ...configuration, model: configuredModel(provider.id, configuration.model),
    ...(provider.fixedModel ? { openai_model: provider.defaultModel } : {}),
    ...(provider.id === 'custom' ? { weworker_protocol: configuration.weworker_protocol === 'openai_chat_completions' ? 'openai_chat_completions' : 'anthropic_messages' } : {
      base_url: provider.weworker.baseUrl, openai_base_url: provider.webwright.baseUrl,
      base_url_is_full: false, openai_base_url_is_full: false,
      auth_type: provider.authType || 'api_key',
    }),
  }
}

export function deleteModelConfiguration(settings: Settings, id: string): Partial<Settings> {
  if (isFixedProvider(id)) throw new Error('固定供应商不能删除')
  if (!getModelConfiguration(settings, id)) throw new Error('模型配置不存在')
  if (settings.active_model_configuration === id) throw new Error('当前使用中的模型配置不能删除，请先切换其他模型')
  const model_configurations = { ...(settings.model_configurations || {}) }
  delete model_configurations[id]
  return { model_configurations }
}

export function activateModelConfiguration(settings: Settings, id: string): Partial<Settings> {
  const configuration = getModelConfiguration(settings, id)
  if (!configuration || !getProvider(configuration.provider_id)) throw new Error('模型配置不存在')
  if (!configuration.api_key || !configuration.model || !configuration.base_url) throw new Error('请先保存 API Key、模型和 Claude Code 接口地址')
  return {
    active_model_configuration: id,
    active_provider: configuration.provider_id,
    api_key: configuration.api_key,
    model: configuration.model,
    base_url: configuration.base_url,
    base_url_is_full: configuration.base_url_is_full === true,
    context_limit: configuration.context_limit,
    active_auth_type: configuration.auth_type,
    active_weworker_protocol: configuration.weworker_protocol === 'openai_chat_completions' ? 'openai_chat_completions' : 'anthropic_messages',
  }
}

export function updateModelConfiguration(settings: Settings, id: string, input: Record<string, unknown>): Partial<Settings> {
  const current = getModelConfiguration(settings, id)
  if (!current) throw new Error('模型配置不存在')
  const next = { ...current }
  if (input.custom_models !== undefined) {
    if (!Array.isArray(input.custom_models) || input.custom_models.length > 200 || input.custom_models.some(model => typeof model !== 'string' || !model.trim() || model.trim().length > 200)) {
      throw new Error('自定义模型列表无效')
    }
    next.custom_models = [...new Set(input.custom_models.map(model => (model as string).trim()))]
  }
  if (current.provider_id === 'custom') Object.assign(next, modelCatalogConfigPatch(input, current))
  if (input.name !== undefined) next.name = validateModelConfigurationName(input.name)
  if (current.provider_id === 'custom' && input.base_url_is_full !== undefined) {
    if (typeof input.base_url_is_full !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
    next.base_url_is_full = input.base_url_is_full
  }
  if (current.provider_id === 'custom' && input.openai_base_url_is_full !== undefined) {
    if (typeof input.openai_base_url_is_full !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
    next.openai_base_url_is_full = input.openai_base_url_is_full
  }
  for (const field of ['api_key', 'model', 'base_url', 'openai_base_url', 'openai_api_key', 'openai_model'] as const) {
    if (input[field] === undefined) continue
    if (typeof input[field] !== 'string') throw new Error(`${field} must be a string`)
    const value = input[field].trim()
    if (field === 'api_key' || field === 'openai_api_key') {
      if (value && field === 'api_key') next.api_key = value
      if (value && field === 'openai_api_key') next.openai_api_key = value
    } else if (field === 'model' || field === 'openai_model') {
      if (!value) throw new Error('请输入模型名称')
      if (getProvider(current.provider_id)?.fixedModel && value !== configuredModel(current.provider_id, value)) throw new Error('此配置使用固定模型，不支持修改模型')
      if (field === 'openai_model') next.openai_model = value
      else next.model = value
    } else if (current.provider_id === 'custom') {
      next[field] = field === 'base_url'
        ? normalizeLlmUrlInput(value, next.base_url_is_full ?? false)
        : !value ? '' : normalizeLlmUrlInput(value, next.openai_base_url_is_full ?? false)
    }
  }
  if (input.context_limit !== undefined) {
    const limit = parseContextLimit(input.context_limit)
    if (limit === null) throw new Error('上下文窗口请输入 1K 到 100M 之间的数值，并使用 K 或 M 单位')
    next.context_limit = limit
  }
  if (current.provider_id === 'custom' && input.base_url_is_full !== undefined && input.base_url === undefined && next.base_url) {
    normalizeLlmUrlInput(next.base_url, next.base_url_is_full ?? false)
  }
  if (current.provider_id === 'custom' && input.openai_base_url_is_full !== undefined && input.openai_base_url === undefined && next.openai_base_url) {
    normalizeLlmUrlInput(next.openai_base_url, next.openai_base_url_is_full ?? false)
  }
  if (input.auth_type !== undefined && current.provider_id === 'custom') {
    if (!isAnthropicAuthType(input.auth_type)) throw new Error('API Key 类型无效')
    next.auth_type = input.auth_type
  }
  if (input.weworker_protocol !== undefined && current.provider_id === 'custom') {
    if (!isLlmProtocol(input.weworker_protocol)) throw new Error('WeWorker 对话协议无效')
    next.weworker_protocol = input.weworker_protocol
  }
  const nameUpdates = modelConfigurationNameUpdates(settings)
  const model_configurations = { ...nameUpdates.model_configurations, [id]: { ...next, name: next.name || nameUpdates.model_configurations?.[id]?.name } }
  return {
    ...nameUpdates,
    model_configurations,
    ...(settings.active_model_configuration === id
      ? activateModelConfiguration({ ...settings, model_configurations }, id)
      : {}),
  }
}

export function publicModelConfigurations(settings: Settings) {
  return Object.fromEntries(Object.entries(settings.model_configurations || {}).filter(([, configuration]) =>
    configuration && getProvider(configuration.provider_id),
  ).map(([id]) => {
    const { api_key, openai_api_key, ...publicFields } = getModelConfiguration(settings, id)!
    return [id, { ...publicFields, has_key: Boolean(api_key), has_openai_key: Boolean(openai_api_key ?? api_key), added: true, visible: true }]
  }))
}
