import { createHash } from 'node:crypto'
import type { Express } from 'express'
import type { Settings } from './config.js'
import type { ProviderEntry } from './llm-egress.js'
import { normalizeLlmBaseUrl, normalizeLlmUrlInput } from './llm-egress.js'
import { probeProviderProtocol, listProviderModels, type ProtocolProbeResult } from './provider-model-services.js'
import { resolveWebwrightModelConfig } from './webwright-model-config.js'
import { defaultConversationModel, resolveConversationModelSettings, parseConversationModel, type ConversationModel } from './conversation-models.js'
import { getProvider, PROVIDERS } from './provider-registry.js'

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
  function status(settings: Settings) {
    let effective: ReturnType<typeof resolveWebwrightModelConfig> | undefined
    try { effective = resolveWebwrightModelConfig(settings) } catch { /* Keep incomplete configurations editable. */ }
    const saved = settings.exploration_active_provider ? settings.exploration_providers?.[settings.exploration_active_provider] : undefined
    let candidateUrl = ''
    let suggested = false
    try {
      const main = resolveConversationModelSettings(settings, defaultConversationModel(settings))
      const provider = getProvider(main.active_provider)
      if (main.active_provider !== 'custom') candidateUrl = provider?.webwright.baseUrl || ''
      else if (!main.base_url_is_full && main.base_url) {
        const base = normalizeLlmBaseUrl(main.base_url)
        const mapped = PROVIDERS.find(item => item.id !== 'custom' && normalizeLlmBaseUrl(item.weworker.baseUrl) === base)
        candidateUrl = mapped ? mapped.webwright.baseUrl : base.endsWith('/v1') ? base : `${base}/v1`
        suggested = !mapped
      }
    } catch { /* Incomplete main configurations remain editable. */ }
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
      configured_model: saved ? saved.model : settings.exploration_model || '',
      configured_base_url: saved ? saved.base_url || getProvider(settings.exploration_active_provider!)?.webwright.baseUrl || '' : settings.exploration_base_url || '',
      configured_base_url_is_full: saved ? saved.base_url_is_full === true : settings.exploration_base_url_is_full === true,
      has_independent_key: Boolean(saved ? saved.api_key : settings.exploration_api_key),
      main_model: settings.model,
      use_main_key: saved ? saved.use_main_key === true : settings.exploration_use_main_key !== false,
      has_key: Boolean(effective?.api_key),
      status: verified === fingerprint(settings) ? settings.exploration_active_provider ? 'independent' : 'connected' : 'pending',
      active_provider: settings.exploration_active_provider || '',
      providers: PROVIDERS.map(provider => {
        const saved = settings.exploration_providers?.[provider.id]
        return {
          id: provider.id, name: provider.name, models: [...new Set([saved?.model, ...provider.models].filter(Boolean))],
          default_model: provider.defaultModel, model: saved?.model || (saved?.use_main_key ? settings.model : provider.defaultModel),
          base_url: provider.id === 'custom' ? saved?.base_url || '' : provider.webwright.baseUrl,
          protocol: provider.id === 'custom' ? saved?.protocol || 'openai_chat_completions' : provider.webwright.protocol,
          base_url_is_full: saved?.base_url_is_full === true,
          auth_type: saved?.auth_type || 'api_key', has_key: Boolean(saved?.api_key || (saved?.use_main_key && settings.api_key)),
          configured: Boolean((saved?.api_key || (saved?.use_main_key && settings.api_key)) && (saved?.model || settings.model)),
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
  app.get('/settings/exploration-model', (_req, res) => res.json(service.status(deps.getSettings())))
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
      const provider = typeof req.body?.provider === 'string' ? getProvider(req.body.provider) : undefined
      if (!provider) throw new Error('请选择有效的网站探索供应商')
      const saved = settings.exploration_providers?.[provider.id]
      if (!saved || (!saved.api_key && !saved.use_main_key)) throw new Error('请先保存该网站探索供应商的 API Key')
      const patch = settingsPatch({ ...saved, ...req.body, provider: provider.id, api_key: saved.api_key, model: req.body?.model || saved.model || 'catalog' }, settings)
      const candidate = { ...settings, ...patch, exploration_model_selection: { provider: '__exploration__', model: req.body?.model || saved.model || 'catalog' } }
      const config = resolveWebwrightModelConfig(candidate)
      const entry: ProviderEntry = { ...provider, id: 'custom', weworker: { protocol: 'anthropic_messages', baseUrl: config.base_url },
        webwright: { protocol: config.protocol, baseUrl: config.base_url, modelClass: config.model_class, structuredOutput: config.structured_output } }
      const catalog = await listProviderModels({ provider: entry, apiKey: config.api_key,
        ...(config.protocol === 'anthropic_messages' ? { anthropicBaseUrl: config.base_url } : { openaiBaseUrl: config.base_url }),
        anthropicFullUrl: config.base_url_is_full, openaiFullUrl: config.base_url_is_full,
        anthropicAuthType: config.auth_type }, deps.fetchImpl)
      const redact = (value: string) => value.split(config.api_key).join('[REDACTED]')
      res.json({ ...catalog, models: catalog.models.map(redact), ...(catalog.warning ? { warning: redact(catalog.warning) } : {}) })
    } catch (error) { res.status(400).json({ detail: error instanceof Error ? error.message : '获取模型列表失败' }) }
  })
}
