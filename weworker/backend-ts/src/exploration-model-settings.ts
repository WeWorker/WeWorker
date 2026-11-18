import { createHash } from 'node:crypto'
import type { Express } from 'express'
import type { Settings } from './config.js'
import type { ProviderEntry } from './llm-egress.js'
import { probeProviderProtocol, listProviderModels, type ProtocolProbeResult } from './provider-model-services.js'
import { defaultWebwrightModelSelection, modelSettingsExplorationEntry, resolveWebwrightModelConfig } from './webwright-model-config.js'
import { resolveConversationModelSettings, parseConversationModel, type ConversationModel } from './conversation-models.js'
import { getProvider, PROVIDERS } from './provider-registry.js'
import { buildModelConfigurationNames, getModelConfiguration } from './model-configurations.js'

export function explorationConversationSettings(settings: Settings, input?: unknown): Settings {
  if (input === undefined || input === null) return settings
  const selection = parseConversationModel(input)
  if (selection.provider === '__independent__') throw new Error('旧独立配置已停用，请重新选择模型配置中的 Adapter 工坊接口')
  return { ...settings, exploration_model_selection: selection }
}

export function defaultExplorationModel(settings: Settings): ConversationModel {
  return defaultWebwrightModelSelection(settings)
}

function fingerprint(settings: Settings): string {
  try { return createHash('sha256').update(JSON.stringify(resolveWebwrightModelConfig(settings))).digest('hex') }
  catch { return 'invalid' }
}

function transactionFingerprint(settings: Settings): string {
  return createHash('sha256').update(JSON.stringify([
    settings.exploration_active_provider,
    PROVIDERS.map(provider => modelSettingsExplorationEntry(settings, provider.id)),
    settings.exploration_model_selection,
    settings.active_provider, settings.active_model_configuration, settings.model_configurations,
    settings.api_key, settings.base_url, settings.model,
  ])).digest('hex')
}

export function createExplorationModelService(fetchImpl: typeof fetch = fetch) {
  let verified = ''
  const pending = new Map<string, Promise<ProtocolProbeResult>>()
  function status(settings: Settings, configurationId?: string) {
    let effective: ReturnType<typeof resolveWebwrightModelConfig> | undefined
    try { effective = resolveWebwrightModelConfig(settings) } catch { /* Keep incomplete configurations editable. */ }
    const selection = defaultExplorationModel(settings)
    const reference = configurationId || selection.provider
    const selectedExplorationProvider = reference === '__exploration__'
      ? settings.exploration_active_provider || '' : reference.replace(/^__exploration__:/, '')
    const configuration = getModelConfiguration(settings, selectedExplorationProvider)
    const formProvider = getProvider(configuration?.provider_id || selectedExplorationProvider)
    const saved = modelSettingsExplorationEntry(settings, selectedExplorationProvider)
    let formMain: Settings | undefined
    try { formMain = resolveConversationModelSettings(settings, { provider: selectedExplorationProvider,
      model: saved?.model || formProvider?.defaultModel || selection.model }) } catch { /* Incomplete configuration. */ }
    const candidateUrl = saved?.base_url || (formProvider?.builtin ? formProvider.webwright.baseUrl : '')
    const scoped = configurationId ? { ...settings, exploration_model_selection: {
      provider: configurationId, model: saved?.model || formProvider?.defaultModel || '', thinking_effort: 'off' as const,
    } } : settings
    if (configurationId) {
      try { effective = resolveWebwrightModelConfig(scoped) } catch { effective = undefined }
    }
    const names = buildModelConfigurationNames(settings)
    return {
      health_scope: effective ? createHash('sha256').update(JSON.stringify([
        effective.provider_id, effective.protocol, effective.base_url, effective.base_url_is_full, effective.api_key, effective.auth_type,
      ])).digest('hex') : '',
      selected_provider: selection.provider,
      effective_model: effective?.model || '',
      model_class: effective?.model_class || '',
      context_limit: effective?.context_limit || settings.context_limit,
      thinking_effort: settings.exploration_model_selection?.thinking_effort || settings.exploration_thinking_effort || 'off',
      base_url: effective?.base_url || '',
      base_url_is_full: effective?.base_url_is_full === true,
      candidate_url: candidateUrl,
      suggested: false,
      configured_base_url: candidateUrl,
      has_independent_key: false,
      main_model: formMain?.model || settings.model,
      use_main_key: !configuration?.openai_api_key && !(selectedExplorationProvider === 'custom' && settings.openai_api_key_custom),
      has_key: Boolean(effective?.api_key),
      status: verified === fingerprint(scoped) ? 'connected' : 'pending',
      active_provider: selectedExplorationProvider,
      configuration_id: configurationId,
      fixed_provider: Boolean(formProvider && formProvider.id !== 'custom'),
      fixed_model: formProvider?.fixedModel === true,
      builtin: formProvider?.builtin === true,
      protocol: 'openai_chat_completions' as const,
      auth_type: 'auth_token',
      candidate_url_is_full: saved?.base_url_is_full === true,
      configured_model: saved?.model || (formProvider?.builtin ? formProvider.defaultModel : ''),
      configured_base_url_is_full: saved?.base_url_is_full === true,
      providers: [...PROVIDERS.map(provider => ({ id: provider.id, provider })),
        ...Object.keys(settings.model_configurations || {}).flatMap(id => {
          const configuration = getModelConfiguration(settings, id)
          const provider = configuration && getProvider(configuration.provider_id)
          return provider ? [{ id, provider }] : []
        })].map(({ id, provider }) => {
        const saved = modelSettingsExplorationEntry(settings, id)
        let builtinAvailable = false
        if (provider.builtin) {
          try { builtinAvailable = Boolean(resolveConversationModelSettings(settings, { provider: provider.id, model: provider.defaultModel }).api_key) }
          catch { builtinAvailable = false }
        }
        return {
          id, name: names[id] || provider.name, selection_provider: provider.builtin ? id : `__exploration__:${id}`,
          models: [...new Set([saved?.model, ...(getModelConfiguration(settings, id)?.custom_models || []), ...provider.models].filter(Boolean))],
          default_model: provider.defaultModel, model: provider.fixedModel ? provider.defaultModel : saved ? saved.model || getModelConfiguration(settings, id)?.model
            || (settings as unknown as Record<string, string>)[`model_${id}`] || settings.model : provider.defaultModel,
          fixed_model: provider.fixedModel === true,
          fixed_provider: id === provider.id && provider.fixed === true,
          builtin: provider.builtin === true,
          saved_exploration: Boolean(saved),
          base_url: provider.id === 'custom' ? saved?.base_url || '' : provider.webwright.baseUrl,
          protocol: provider.id === 'custom' ? saved?.protocol || 'openai_chat_completions' : provider.webwright.protocol,
          base_url_is_full: saved?.base_url_is_full === true,
          auth_type: saved?.auth_type || 'api_key', has_key: Boolean(builtinAvailable || saved?.api_key),
          configured: Boolean(names[id] && (builtinAvailable || (saved?.api_key && saved.model
            && saved.base_url))),
        }
      }),
    }
  }
  async function check(settings: Settings, force = false): Promise<ProtocolProbeResult> {
    const id = fingerprint(settings)
    const config = resolveWebwrightModelConfig(settings)
    if (!force && verified === id) return { ok: true, target: 'webwright', protocol: config.protocol, model: config.model }
    if (pending.has(id)) return pending.get(id)!
    const provider: ProviderEntry = {
      id: 'custom', name: 'Adapter工坊·探索模型', models: [], defaultModel: '',
      weworker: { protocol: 'anthropic_messages', baseUrl: '' },
      webwright: { protocol: config.protocol, baseUrl: config.base_url, modelClass: config.model_class, structuredOutput: config.structured_output },
    }
    const request = probeProviderProtocol({ provider, apiKey: config.api_key, model: config.model, target: 'webwright', verifyResponse: true,
      anthropicBaseUrl: config.base_url, openaiBaseUrl: config.base_url,
      anthropicFullUrl: config.base_url_is_full === true, openaiFullUrl: config.base_url_is_full === true,
      anthropicAuthType: config.auth_type }, fetchImpl)
      .then(result => { if (result.ok) verified = id; else if (verified === id) verified = ''; return result })
      .finally(() => pending.delete(id))
    pending.set(id, request)
    return request
  }
  return { status, check }
}

export function registerExplorationModelRoutes(app: Express, deps: {
  getSettings: () => Settings
  updateSettings: (patch: Partial<Settings>) => Settings
  fetchImpl?: typeof fetch
}) {
  const service = createExplorationModelService(deps.fetchImpl)
  app.get('/settings/exploration-model', (req, res) => {
    const id = req.query?.configuration
    if (id !== undefined && (typeof id !== 'string' || (!getProvider(id) && !getModelConfiguration(deps.getSettings(), id)))) {
      res.status(400).json({ detail: '模型配置不存在' }); return
    }
    res.json(service.status(deps.getSettings(), id as string | undefined))
  })
  app.post('/settings/exploration-model/resolve', (req, res) => {
    try {
      const settings = explorationConversationSettings(deps.getSettings(), req.body?.selection)
      resolveWebwrightModelConfig(settings)
      res.json({ ...service.status(settings), selection: defaultExplorationModel(settings) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '探索模型无效' }) }
  })
  app.post('/settings/exploration-model/selection', (req, res) => {
    try {
      const settings = explorationConversationSettings(deps.getSettings(), req.body)
      resolveWebwrightModelConfig(settings)
      res.json(service.status(deps.updateSettings({ exploration_model_selection: settings.exploration_model_selection })))
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '探索模型切换失败' }) }
  })
  app.post('/settings/exploration-model/check', async (req, res) => {
    try {
      const original = deps.getSettings()
      const transaction = transactionFingerprint(original)
      const settings = explorationConversationSettings(original, req.body?.selection || defaultExplorationModel(original))
      const result = await service.check(settings, req.body?.force === true)
      if (transaction !== transactionFingerprint(deps.getSettings())) {
        res.status(409).json({ detail: '模型配置已改变，请重新检测' }); return
      }
      res.json({ ...result, ...service.status(settings) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '请先配置模型' }) }
  })
  app.post('/settings/exploration-model/probe', async (req, res) => {
    const started = Date.now()
    try {
      const body = req.body || {}
      const original = deps.getSettings()
      const transaction = transactionFingerprint(original)
      const settings = explorationConversationSettings(original, body)
      const result = await service.check(settings, true)
      if (transaction !== transactionFingerprint(deps.getSettings())) {
        res.status(409).json({ detail: '模型配置已改变，请重新检测' }); return
      }
      res.json({ ...result, elapsed_ms: Math.max(1, Date.now() - started), checked_at: Date.now() })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '探索模型检测失败' }) }
  })
  // The model settings APIs own interface edits. Reject obsolete clients so
  // they cannot silently save an unused second set of credentials.
  for (const route of ['/settings/exploration-model', '/settings/exploration-model/activate']) {
    app.post(route, (_req, res) => {
      res.status(410).json({ detail: '独立探索配置已停用，请在设置 → 模型配置中编辑 Adapter 工坊接口' })
    })
  }
  app.post('/settings/exploration-model/models', async (req, res) => {
    try {
      const settings = deps.getSettings()
      const reference = typeof req.body?.provider === 'string' ? req.body.provider : ''
      const id = reference.replace(/^__exploration__:/, '')
      const configuration = getModelConfiguration(settings, id)
      const provider = getProvider(configuration?.provider_id || id)
      if (!provider) throw new Error('请选择有效的网站探索供应商')
      if (provider.builtin && provider.fixedModel) { res.json({ models: [provider.defaultModel], source: 'fallback' }); return }
      const saved = modelSettingsExplorationEntry(settings, id)
      if (!saved?.api_key) throw new Error('请先在模型配置中保存 Adapter 工坊的 API Key')
      const candidate = { ...settings, exploration_model_selection: { provider: `__exploration__:${id}`, model: req.body?.model || saved.model || configuration?.model || settings.model } }
      const config = resolveWebwrightModelConfig(candidate)
      const entry: ProviderEntry = { ...provider, id: 'custom', weworker: { protocol: config.protocol, baseUrl: config.base_url },
        webwright: { protocol: config.protocol, baseUrl: config.base_url, modelClass: config.model_class, structuredOutput: config.structured_output } }
      const catalog = await listProviderModels({ provider: entry, apiKey: config.api_key, openaiApiKey: config.api_key,
        target: 'webwright', openaiBaseUrl: config.base_url, openaiFullUrl: config.base_url_is_full,
        openaiModelsUrl: configuration?.openai_models_url || (id === 'custom' ? settings.openai_models_url_custom : undefined),
        openaiModelsUrlIsFull: configuration ? configuration.openai_models_url_is_full : settings.openai_models_url_is_full_custom,
      }, deps.fetchImpl)
      const redact = (value: string) => value.split(config.api_key).join('[REDACTED]')
      res.json({ ...catalog, models: catalog.models.map(redact), ...(catalog.warning ? { warning: redact(catalog.warning) } : {}) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '获取模型列表失败' }) }
  })
}
