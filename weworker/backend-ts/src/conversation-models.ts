import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Express } from 'express'
import type { Settings } from './config.js'
import { getModelConfiguration, savedModelConfigurationKey } from './model-configurations.js'
import { getProvider } from './provider-registry.js'
import { builtinProviderAccess, isBuiltinProvider } from './builtin-provider.js'
import { DEFAULT_BUILTIN_CONTEXT_LIMIT, DEFAULT_CONTEXT_LIMIT, normalizeContextLimit } from './context-window.js'

export interface ConversationModel {
  provider: string
  model: string
  thinking_effort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export function parseConversationModel(value: unknown): ConversationModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话模型配置无效')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['provider', 'model', 'thinking_effort'].includes(key))
    || typeof v.provider !== 'string' || !v.provider.trim() || v.provider.length > 200
    || typeof v.model !== 'string' || !v.model.trim() || v.model.length > 200
    || (v.thinking_effort !== undefined && !['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(v.thinking_effort)))) {
    throw new Error('会话模型配置无效')
  }
  return { provider: v.provider.trim(), model: v.model.trim(), thinking_effort: (v.thinking_effort || 'off') as ConversationModel['thinking_effort'] }
}

export function defaultConversationModel(settings: Settings): ConversationModel {
  return { provider: settings.active_model_configuration || settings.active_provider, model: settings.model, thinking_effort: 'off' }
}

// Resolve credentials from their existing source; persist only the configuration
// reference and model name. Never activate or rewrite a default configuration.
export function resolveConversationModelSettings(settings: Settings, value: ConversationModel): Settings {
  const selection = parseConversationModel(value)
  const config = getModelConfiguration(settings, selection.provider)
  const provider = getProvider(config?.provider_id || selection.provider)
  if (!provider) throw new Error('会话使用的模型配置已不存在，请重新选择')
  const builtin = isBuiltinProvider(provider.id) ? builtinProviderAccess(provider) : null
  const legacy = settings as unknown as Record<string, unknown>
  const sameDefault = selection.provider === (settings.active_model_configuration || settings.active_provider)
  return {
    ...settings,
    active_provider: provider.id,
    active_model_configuration: config ? selection.provider : '',
    model: provider.fixedModel ? provider.defaultModel : selection.model,
    api_key: builtin ? builtin.apiKey : config?.api_key || savedModelConfigurationKey(settings, selection.provider, 'weworker') || (sameDefault ? settings.api_key : ''),
    base_url: builtin?.provider.weworker.baseUrl || config?.base_url || (provider.id === 'custom' ? settings.base_url_custom || (sameDefault ? settings.base_url : '') : provider.weworker.baseUrl),
    base_url_is_full: config ? config.base_url_is_full === true : provider.id === 'custom' && settings.base_url_is_full_custom === true,
    active_auth_type: config?.auth_type || builtin?.anthropicAuthType || (provider.id === 'custom' ? settings.custom_auth_type : provider.authType) || 'api_key',
    active_weworker_protocol: config?.weworker_protocol || builtin?.provider.weworker.protocol || (provider.id === 'custom' ? settings.weworker_protocol_custom : provider.weworker.protocol) || 'anthropic_messages',
    context_limit: builtin ? normalizeContextLimit(settings.builtin_context_limits?.[provider.id], DEFAULT_BUILTIN_CONTEXT_LIMIT)
      : normalizeContextLimit(config?.context_limit ?? legacy[`context_limit_${provider.id}`] ?? (sameDefault ? settings.context_limit : DEFAULT_CONTEXT_LIMIT)),
  }
}

export function conversationModelStatus(settings: Settings, selection: ConversationModel) {
  const resolved = resolveConversationModelSettings(settings, selection)
  return { ...selection, model: resolved.model, context_limit: resolved.context_limit }
}

export function createConversationModelStore(file = path.join(os.homedir(), '.weworker', 'conversation-models.json')) {
  function read(): Record<string, ConversationModel> {
    if (!fs.existsSync(file)) return {}
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data?.version !== 1 || !data.models || typeof data.models !== 'object' || Array.isArray(data.models)) throw new Error('会话模型记录读取失败')
    return data.models
  }
  const get = (id: string) => { const all = read(); return Object.hasOwn(all, id) ? parseConversationModel(all[id]) : undefined }
  const set = (id: string, selection: ConversationModel) => {
    const value = parseConversationModel(selection)
    const models = { ...read(), [id]: value }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, models }) + '\n', 'utf8')
    fs.renameSync(temporary, file)
    return value
  }
  return { get, set, ensure: (id: string, fallback: ConversationModel) => get(id) || set(id, fallback) }
}

export const conversationModels = createConversationModelStore()
export function workModelSelection(workId: string, settings: Settings): ConversationModel {
  return conversationModels.ensure(workId, defaultConversationModel(settings))
}
export function resolveWorkModelSettings(workId: string, settings: Settings): Settings {
  return resolveConversationModelSettings(settings, workModelSelection(workId, settings))
}

export function registerConversationModelRoutes(app: Express, deps: {
  getSettings: () => Settings
  hasWork: (id: string) => boolean
  isBusy: (id: string) => boolean
  models?: ReturnType<typeof createConversationModelStore>
}) {
  const models = deps.models || conversationModels
  app.post('/chat/model/resolve', (req, res) => {
    try {
      const settings = deps.getSettings()
      const selection = parseConversationModel(req.body?.selection || defaultConversationModel(settings))
      res.json(conversationModelStatus(settings, selection))
    } catch (e) { res.status(400).json({ detail: e instanceof Error ? e.message : '会话模型配置无效' }) }
  })
  app.get('/works/:id/model', (req, res) => {
    if (!deps.hasWork(req.params.id)) { res.status(404).json({ detail: '对话不存在' }); return }
    try {
      const settings = deps.getSettings()
      const selection = models.ensure(req.params.id, defaultConversationModel(settings))
      try { res.json(conversationModelStatus(settings, selection)) }
      catch (e) {
        // Keep the missing reference visible so users can select a replacement;
        // never display the default as if it belonged to this conversation.
        res.json({ ...selection, unavailable: true, error: e instanceof Error ? e.message : '会话模型不可用，请重新选择' })
      }
    } catch (e) { res.status(400).json({ detail: e instanceof Error ? e.message : '会话模型读取失败' }) }
  })
  app.post('/works/:id/model', (req, res) => {
    if (!deps.hasWork(req.params.id)) { res.status(404).json({ detail: '对话不存在' }); return }
    if (deps.isBusy(req.params.id)) { res.status(409).json({ detail: '请等待当前回复结束后切换模型' }); return }
    try {
      const selection = parseConversationModel(req.body)
      const result = conversationModelStatus(deps.getSettings(), selection)
      models.set(req.params.id, selection)
      res.json(result)
    } catch (e) { res.status(400).json({ detail: e instanceof Error ? e.message : '会话模型保存失败' }) }
  })
}
