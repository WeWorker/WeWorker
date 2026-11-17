import { createHash } from 'node:crypto'
import type { Express } from 'express'
import type { Settings } from './config.js'
import type { ProviderEntry } from './llm-egress.js'
import { normalizeLlmBaseUrl, normalizeLlmUrlInput } from './llm-egress.js'
import { probeProviderProtocol, listProviderModels, type ProtocolProbeResult } from './provider-model-services.js'
import { resolveWebwrightModelConfig } from './webwright-model-config.js'
import { defaultConversationModel, explorationProviderId, resolveConversationModelSettings, parseConversationModel, type ConversationModel } from './conversation-models.js'
import { getProvider, PROVIDERS } from './provider-registry.js'
import { buildModelConfigurationNames, getModelConfiguration } from './model-configurations.js'

export function explorationConversationSettings(settings: Settings, input?: unknown): Settings {
  if (input === undefined || input === null) return settings
  const selection = parseConversationModel(input)
  if (selection.provider === '__independent__') throw new Error('旧独立配置已停用，网站探索已统一使用对话接口，请重新选择模型配置')
  return { ...settings, exploration_model_selection: selection }
}

export function defaultExplorationModel(settings: Settings): ConversationModel {
  const selection = settings.exploration_model_selection
  if (selection) return { ...selection, thinking_effort: selection.thinking_effort || settings.exploration_thinking_effort || 'off' }
  if (settings.exploration_active_provider) {
    const saved = settings.exploration_providers?.[settings.exploration_active_provider]
    if (saved) return { provider: '__exploration__', model: saved.model || settings.model, thinking_effort: 'off' }
  }
  return { provider: settings.active_model_configuration || settings.active_provider, model: settings.model, thinking_effort: 'off' }
}

function fingerprint(settings: Settings): string {
  try { return createHash('sha256').update(JSON.stringify(resolveWebwrightModelConfig(settings))).digest('hex') }
  catch { return 'invalid' }
}

function transactionFingerprint(settings: Settings): string {
  return createHash('sha256').update(JSON.stringify([
    settings.exploration_active_provider, settings.exploration_providers,
    settings.exploration_model_selection,
    settings.active_provider, settings.active_model_configuration, settings.model_configurations,
    settings.api_key, settings.base_url, settings.model,
  ])).digest('hex')
}

function settingsPatch(body: Record<string, unknown>, settings: Settings): Partial<Settings> {
  if (typeof body.configuration === 'string') {
    const id = body.configuration
    const configuration = getModelConfiguration(settings, id)
    const provider = getProvider(configuration?.provider_id || id)
    if (!provider || provider.builtin) throw new Error('请选择可编辑的模型配置')
    const previous = settings.exploration_providers?.[id]
    const main = resolveConversationModelSettings(settings, { provider: id, model: configuration?.model || provider.defaultModel })
    if (typeof body.model !== 'string' || typeof body.base_url !== 'string'
      || typeof body.use_main_key !== 'boolean' || (body.api_key !== undefined && typeof body.api_key !== 'string')
      || (body.base_url_is_full !== undefined && typeof body.base_url_is_full !== 'boolean')) throw new Error('网站探索配置无效')
    const custom = provider.id === 'custom'
    const protocol = custom ? body.protocol ?? previous?.protocol ?? main.active_weworker_protocol : provider.webwright.protocol
    if (!['anthropic_messages', 'openai_chat_completions', 'openai_responses'].includes(String(protocol))) throw new Error('请选择有效的模型协议')
    const auth = custom ? body.auth_type ?? previous?.auth_type ?? main.active_auth_type : provider.authType || 'api_key'
    if (auth !== 'api_key' && auth !== 'auth_token') throw new Error('请选择有效的鉴权方式')
    const full = custom && body.base_url_is_full === true
    return { exploration_providers: { ...settings.exploration_providers, [id]: {
      api_key: body.use_main_key ? '' : (typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : previous?.api_key || ''),
      model: provider.fixedModel ? provider.defaultModel : body.model.trim(),
      base_url: custom ? normalizeLlmUrlInput(body.base_url.trim(), full) : provider.webwright.baseUrl,
      base_url_is_full: full, protocol: protocol as import('./llm-egress.js').LlmProtocol,
      auth_type: auth, use_main_key: body.use_main_key, key_source: id,
    } } }
  }
  if (body.provider === undefined && body.base_url !== undefined) {
    if (typeof body.base_url !== 'string' || !body.base_url.trim()) throw new Error('请填写网站探索服务地址')
    if (typeof body.use_main_key !== 'boolean') throw new Error('请选择是否使用现有 API Key')
    if (typeof body.model !== 'string') throw new Error('模型名称必须为文本')
    if (body.api_key !== undefined && typeof body.api_key !== 'string') throw new Error('API Key 必须为文本')
    if (body.base_url_is_full !== undefined && typeof body.base_url_is_full !== 'boolean') throw new Error('请选择有效的接口地址模式')
    const previous = settings.exploration_providers?.custom
    const fullUrl = body.base_url_is_full === true
    const baseUrl = normalizeLlmUrlInput(body.base_url.trim(), fullUrl)
    const mapped = !fullUrl && PROVIDERS.find(provider => provider.id !== 'custom'
      && normalizeLlmBaseUrl(provider.webwright.baseUrl) === baseUrl)
    return {
      exploration_active_provider: 'custom',
      exploration_providers: { ...settings.exploration_providers, custom: {
        base_url: baseUrl, base_url_is_full: fullUrl, use_main_key: body.use_main_key,
        api_key: body.use_main_key ? '' : typeof body.api_key === 'string' && body.api_key.trim()
          ? body.api_key.trim() : previous?.api_key || settings.exploration_api_key || '',
        model: body.model.trim(), protocol: mapped && mapped.webwright.protocol === 'anthropic_messages' ? 'anthropic_messages' : 'openai_chat_completions', auth_type: 'api_key',
      } },
    }
  }
  if (typeof body.provider !== 'string' || !body.provider.trim()) throw new Error('请选择有效的网站探索供应商')
  const provider = getProvider(body.provider)
  if (!provider) throw new Error('请选择有效的网站探索供应商')
  if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('请填写网站探索模型')
  if (body.api_key !== undefined && typeof body.api_key !== 'string') throw new Error('API Key 必须为文本')
  const previous = settings.exploration_providers?.[provider.id]
  const custom = provider.id === 'custom'
  const protocol = custom ? body.protocol ?? previous?.protocol ?? 'openai_chat_completions' : provider.webwright.protocol
  if (protocol !== 'anthropic_messages' && protocol !== 'openai_chat_completions') throw new Error('请选择有效的模型协议')
  const auth_type = custom ? body.auth_type ?? previous?.auth_type ?? 'api_key' : 'api_key'
  if (auth_type !== 'api_key' && auth_type !== 'auth_token') throw new Error('请选择有效的鉴权方式')
  const base_url_is_full = custom && (body.base_url_is_full === undefined ? previous?.base_url_is_full === true : body.base_url_is_full === true)
  const base_url = custom ? normalizeLlmUrlInput(String(body.base_url ?? previous?.base_url ?? '').trim(), base_url_is_full) : provider.webwright.baseUrl
  const use_main_key = body.use_main_key === undefined ? previous?.use_main_key === true : body.use_main_key === true
  const api_key = typeof body.api_key === 'string' && body.api_key.trim() ? body.api_key.trim() : previous?.api_key || ''
  return {
    exploration_active_provider: provider.id,
    exploration_providers: { ...settings.exploration_providers, [provider.id]: {
      api_key: use_main_key ? '' : api_key, model: body.model.trim(), base_url, protocol, auth_type, use_main_key, base_url_is_full,
    } },
  }
}

export function createExplorationModelService(fetchImpl: typeof fetch = fetch) {
  let verified = ''
  const pending = new Map<string, Promise<ProtocolProbeResult>>()
  function status(settings: Settings, configurationId?: string) {
    let effective: ReturnType<typeof resolveWebwrightModelConfig> | undefined
    try { effective = resolveWebwrightModelConfig(settings) } catch { /* Keep incomplete configurations editable. */ }
    const selectedExplorationProvider = configurationId ?? (explorationProviderId(settings) || settings.exploration_active_provider || '')
    const saved = settings.exploration_providers?.[selectedExplorationProvider]
    const configuration = getModelConfiguration(settings, selectedExplorationProvider)
    const formProvider = getProvider(configuration?.provider_id || selectedExplorationProvider)
    let formMain: Settings | undefined
    let candidateUrl = ''
    let suggested = false
    let mainKeyAvailable = false
    try {
      const main = resolveConversationModelSettings(settings, configurationId
        ? { provider: configurationId, model: configuration?.model || (configurationId === (settings.active_model_configuration || settings.active_provider)
          ? settings.model : (settings as unknown as Record<string, string>)[`model_${configurationId}`]) || formProvider?.defaultModel || settings.model }
        : defaultConversationModel(settings))
      formMain = main
      mainKeyAvailable = Boolean(main.api_key)
      const provider = getProvider(main.active_provider)
      if (main.active_provider !== 'custom') candidateUrl = provider?.webwright.baseUrl || ''
      else if (!main.base_url_is_full && main.base_url) {
        const base = normalizeLlmBaseUrl(main.base_url)
        const mapped = PROVIDERS.find(item => item.id !== 'custom' && normalizeLlmBaseUrl(item.weworker.baseUrl) === base)
        candidateUrl = mapped ? mapped.webwright.baseUrl : base.endsWith('/v1') ? base : `${base}/v1`
        suggested = !mapped
      }
    } catch { /* Incomplete main configurations remain editable. */ }
    if (configurationId) candidateUrl = formProvider?.id === 'custom' ? formMain?.base_url || '' : formProvider?.webwright.baseUrl || ''
    const scoped = configurationId ? { ...settings, exploration_model_selection: {
      provider: formProvider?.builtin ? configurationId : `__exploration__:${configurationId}`,
      model: saved?.model || formMain?.model || '', thinking_effort: 'off' as const,
    } } : settings
    if (configurationId) {
      try { effective = resolveWebwrightModelConfig(scoped) } catch { effective = undefined }
    }
    const names = buildModelConfigurationNames(settings)
    return {
      health_scope: effective ? createHash('sha256').update(JSON.stringify([
        effective.provider_id, effective.protocol, effective.base_url, effective.api_key, effective.auth_type,
      ])).digest('hex') : '',
      selected_provider: settings.exploration_model_selection?.provider || (settings.exploration_active_provider ? '__exploration__' : settings.active_model_configuration || settings.active_provider),
      effective_model: effective?.model || '',
      model_class: effective?.model_class || '',
      context_limit: effective?.context_limit || settings.context_limit,
      thinking_effort: settings.exploration_model_selection?.thinking_effort || settings.exploration_thinking_effort || 'off',
      base_url: effective?.base_url || '',
      base_url_is_full: effective?.base_url_is_full === true,
      candidate_url: candidateUrl,
      suggested,
      configured_base_url: saved ? saved.base_url || formProvider?.webwright.baseUrl || '' : configurationId ? candidateUrl : settings.exploration_base_url || '',
      has_independent_key: Boolean(saved ? saved.api_key : !configurationId && settings.exploration_api_key),
      main_model: formMain?.model || settings.model,
      use_main_key: saved ? saved.use_main_key === true : settings.exploration_use_main_key !== false,
      has_key: Boolean(effective?.api_key),
      status: verified === fingerprint(scoped) ? (saved ? 'independent' : 'connected') : 'pending',
      active_provider: selectedExplorationProvider,
      configuration_id: configurationId,
      fixed_provider: Boolean(formProvider && formProvider.id !== 'custom'),
      fixed_model: formProvider?.fixedModel === true,
      builtin: formProvider?.builtin === true,
      protocol: saved?.protocol || (formProvider?.id === 'custom' ? formMain?.active_weworker_protocol : formProvider?.webwright.protocol) || 'openai_chat_completions',
      auth_type: saved?.auth_type || formMain?.active_auth_type || 'api_key',
      candidate_url_is_full: formProvider?.id === 'custom' && formMain?.base_url_is_full === true,
      configured_model: saved ? saved.model : configurationId ? '' : settings.exploration_model || '',
      configured_base_url_is_full: saved ? saved.base_url_is_full === true : configurationId ? formMain?.base_url_is_full === true : settings.exploration_base_url_is_full === true,
      providers: [...PROVIDERS.map(provider => ({ id: provider.id, provider })),
        ...Object.keys(settings.model_configurations || {}).flatMap(id => {
          const configuration = getModelConfiguration(settings, id)
          const provider = configuration && getProvider(configuration.provider_id)
          return provider ? [{ id, provider }] : []
        })].map(({ id, provider }) => {
        const saved = settings.exploration_providers?.[id]
        let mainKey = mainKeyAvailable
        if (saved?.key_source) {
          try { mainKey = Boolean(resolveConversationModelSettings(settings, { provider: saved.key_source, model: saved.model || provider.defaultModel }).api_key) }
          catch { mainKey = false }
        }
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
          builtin: provider.builtin === true,
          saved_exploration: Boolean(saved),
          base_url: provider.id === 'custom' ? saved?.base_url || '' : provider.webwright.baseUrl,
          protocol: provider.id === 'custom' ? saved?.protocol || 'openai_chat_completions' : provider.webwright.protocol,
          base_url_is_full: saved?.base_url_is_full === true,
          auth_type: saved?.auth_type || 'api_key', has_key: Boolean(builtinAvailable || saved?.api_key || (saved?.use_main_key && mainKey)),
          configured: Boolean(builtinAvailable || (saved && (saved.api_key || (saved.use_main_key && mainKey)) && (saved.model || getModelConfiguration(settings, id)?.model || settings.model)
            && (provider.id !== 'custom' || saved.base_url))),
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
  app.post('/settings/exploration-model', async (req, res) => {
    try {
      const current = deps.getSettings()
      const transaction = transactionFingerprint(current)
      const patch = settingsPatch(req.body || {}, current)
      if (typeof req.body.configuration === 'string') {
        const id = req.body.configuration
        const entry = patch.exploration_providers![id]
        const configuration = getModelConfiguration(current, id)
        const main = resolveConversationModelSettings(current, { provider: id, model: configuration?.model || getProvider(id)?.defaultModel || current.model })
        const selection = { provider: `__exploration__:${id}`, model: entry.model || main.model, thinking_effort: 'off' as const }
        const result = await service.check({ ...current, ...patch, exploration_model_selection: selection }, true)
        if (transaction !== transactionFingerprint(deps.getSettings())) { res.status(409).json({ detail: '模型配置已改变，请重新验证' }); return }
        if (!result.ok) { res.json({ ...result, ...service.status(current, id) }); return }
        const saved = deps.updateSettings(patch)
        res.json({ ...result, ...service.status(saved, id) }); return
      }
      const model = patch.exploration_providers?.[patch.exploration_active_provider || '']?.model || current.model
      const selection: ConversationModel | null = req.body.provider === undefined && !req.body.model.trim()
        ? null : { provider: '__exploration__', model, thinking_effort: 'off' }
      const candidate: Settings = { ...current, ...patch, exploration_model_selection: selection }
      const result = await service.check(candidate, true)
      if (transaction !== transactionFingerprint(deps.getSettings())) {
        res.status(409).json({ detail: '模型配置已改变，请重新验证' }); return
      }
      if (!result.ok) { res.json({ ...result, ...service.status(current) }); return }
      const saved = deps.updateSettings({ ...patch, exploration_model_selection: candidate.exploration_model_selection })
      res.json({ ...result, ...service.status(saved) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '保存探索模型失败' }) }
  })
  app.post('/settings/exploration-model/activate', async (req, res) => {
    try {
      const current = deps.getSettings()
      const provider = typeof req.body?.provider === 'string' ? getProvider(req.body.provider) : undefined
      const saved = provider && current.exploration_providers?.[provider.id]
      if (!provider || !saved || (!saved.api_key && !saved.use_main_key)) throw new Error('请先在高级设置中配置该网站探索供应商')
      const model = typeof req.body.model === 'string' && req.body.model.trim() ? req.body.model.trim() : saved.model || current.model
      const candidate = { ...current, exploration_active_provider: provider.id,
        exploration_providers: { ...current.exploration_providers, [provider.id]: { ...saved, model } },
        exploration_model_selection: { provider: '__exploration__', model, thinking_effort: 'off' as const } as const }
      const result = await service.check(candidate, true)
      if (!result.ok) { res.json({ ...result, ...service.status(current) }); return }
      const next = deps.updateSettings({ exploration_active_provider: provider.id,
        exploration_providers: candidate.exploration_providers,
        exploration_model_selection: candidate.exploration_model_selection })
      res.json({ ...result, ...service.status(next) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '切换网站探索模型失败' }) }
  })
  app.post('/settings/exploration-model/models', async (req, res) => {
    try {
      const settings = deps.getSettings()
      const reference = typeof req.body?.provider === 'string' ? req.body.provider : ''
      const id = reference.replace(/^__exploration__:/, '')
      const configuration = getModelConfiguration(settings, id)
      const provider = getProvider(configuration?.provider_id || id)
      if (!provider) throw new Error('请选择有效的网站探索供应商')
      if (provider.builtin && provider.fixedModel) { res.json({ models: [provider.defaultModel], source: 'fallback' }); return }
      const saved = settings.exploration_providers?.[id]
      if (!saved || (!saved.api_key && !saved.use_main_key)) throw new Error('请先保存该网站探索供应商的 API Key')
      const candidate = { ...settings, exploration_model_selection: { provider: `__exploration__:${id}`, model: req.body?.model || saved.model || configuration?.model || settings.model } }
      const config = resolveWebwrightModelConfig(candidate)
      const entry: ProviderEntry = { ...provider, id: 'custom', weworker: { protocol: config.protocol, baseUrl: config.base_url },
        webwright: { protocol: config.protocol, baseUrl: config.base_url, modelClass: config.model_class, structuredOutput: config.structured_output } }
      const catalog = await listProviderModels({ provider: entry, apiKey: config.api_key,
        target: 'weworker', weworkerProtocol: config.protocol, weworkerBaseUrl: config.base_url, anthropicBaseUrl: config.base_url,
        weworkerFullUrl: config.base_url_is_full, anthropicFullUrl: config.base_url_is_full,
        anthropicAuthType: config.auth_type,
      }, deps.fetchImpl)
      const redact = (value: string) => value.split(config.api_key).join('[REDACTED]')
      res.json({ ...catalog, models: catalog.models.map(redact), ...(catalog.warning ? { warning: redact(catalog.warning) } : {}) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '获取模型列表失败' }) }
  })
}
