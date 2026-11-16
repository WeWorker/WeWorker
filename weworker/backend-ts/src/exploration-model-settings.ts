import { createHash } from 'node:crypto'
import type { Express } from 'express'
import type { Settings } from './config.js'
import type { ProviderEntry } from './llm-egress.js'
import { probeProviderProtocol, type ProtocolProbeResult } from './provider-model-services.js'
import { resolveWebwrightModelConfig } from './webwright-model-config.js'
import { parseConversationModel, type ConversationModel } from './conversation-models.js'

export function explorationConversationSettings(settings: Settings, input?: unknown): Settings {
  if (input === undefined || input === null) return settings
  const selection = parseConversationModel(input)
  if (!['off', 'low', 'medium', 'high'].includes(selection.thinking_effort || 'off')) throw new Error('探索思考选项无效')
  const thinking = selection.thinking_effort as Settings['exploration_thinking_effort']
  if (selection.provider === '__independent__') {
    throw new Error('网站探索已统一使用对话接口，请重新选择模型配置')
  }
  return { ...settings, exploration_model_selection: { provider: selection.provider, model: selection.model }, exploration_thinking_effort: thinking }
}

export function defaultExplorationModel(settings: Settings): ConversationModel {
  const config = resolveWebwrightModelConfig(settings)
  return { provider: settings.exploration_model_selection?.provider || settings.active_model_configuration || settings.active_provider,
    model: config.model, thinking_effort: settings.exploration_thinking_effort || 'off' }
}

function fingerprint(settings: Settings): string {
  try {
    const config = resolveWebwrightModelConfig(settings)
    return createHash('sha256').update(JSON.stringify(config)).digest('hex')
  } catch {
    // Invalid or incomplete configurations can be displayed but never verified.
    return 'invalid'
  }
}

export function createExplorationModelService(fetchImpl: typeof fetch = fetch) {
  let verified = ''
  const pending = new Map<string, Promise<ProtocolProbeResult>>()
  function status(settings: Settings) {
    let effective: ReturnType<typeof resolveWebwrightModelConfig> | undefined
    try { effective = resolveWebwrightModelConfig(settings) } catch { /* Keep incomplete configurations editable. */ }
    return {
      // Scope menu results to the real exploration connection, never main-chat
      // health. Selecting another model or thinking level keeps existing results.
      health_scope: effective ? createHash('sha256').update(JSON.stringify([
        effective.provider_id, effective.protocol, effective.base_url, effective.base_url_is_full,
        effective.api_key, effective.auth_type, effective.structured_output,
      ])).digest('hex') : '',
      selected_provider: settings.exploration_model_selection?.provider
        || settings.active_model_configuration || settings.active_provider,
      effective_model: effective?.model || '',
      model_class: effective?.model_class || '',
      context_limit: effective?.context_limit || settings.context_limit,
      thinking_effort: settings.exploration_thinking_effort || 'off',
      base_url: effective?.base_url || '',
      base_url_is_full: effective?.base_url_is_full === true,
      has_key: Boolean(effective?.api_key),
      status: verified === fingerprint(settings) ? 'connected' : 'pending',
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
    const request = probeProviderProtocol({
      provider, apiKey: config.api_key, model: config.model, target: 'webwright', verifyResponse: true,
      anthropicBaseUrl: config.base_url, openaiBaseUrl: config.base_url,
      anthropicFullUrl: config.base_url_is_full === true, openaiFullUrl: config.base_url_is_full === true,
      anthropicAuthType: config.auth_type,
    }, fetchImpl)
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
      const body = req.body || {}
      const settings = deps.getSettings()
      const patch: Partial<Settings> = {}
      if (body.provider !== undefined || body.model !== undefined) {
        if (typeof body.provider !== 'string' || !body.provider.trim() || typeof body.model !== 'string') throw new Error('请选择模型配置和模型')
        patch.exploration_model_selection = { provider: body.provider, model: body.model.trim() }
      }
      if (body.thinking_effort !== undefined) {
        if (!['off', 'low', 'medium', 'high'].includes(body.thinking_effort)) throw new Error('思考选项无效')
        patch.exploration_thinking_effort = body.thinking_effort
      }
      if (!Object.keys(patch).length) throw new Error('没有需要保存的探索配置')
      resolveWebwrightModelConfig({ ...settings, ...patch })
      res.json(service.status(deps.updateSettings(patch)))
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : '探索模型切换失败' })
    }
  })
  app.post('/settings/exploration-model/check', async (req, res) => {
    try {
      const settings = explorationConversationSettings(deps.getSettings(), req.body?.selection)
      const result = await service.check(settings, req.body?.force === true)
      if (fingerprint(settings) !== fingerprint(explorationConversationSettings(deps.getSettings(), req.body?.selection))) {
        res.status(409).json({ detail: '模型配置已改变，请重新检测' }); return
      }
      res.json({ ...result, ...service.status(settings) })
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : '请先配置主模型' })
    }
  })
  app.post('/settings/exploration-model/probe', async (req, res) => {
    const started = Date.now()
    try {
      const { provider, model } = req.body || {}
      if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) {
        throw new Error('请选择模型配置和模型')
      }
      const candidate = (settings: Settings): Settings => explorationConversationSettings(settings, { provider, model: model.trim() })
      const settings = candidate(deps.getSettings())
      const result = await service.check(settings, true)
      if (fingerprint(settings) !== fingerprint(candidate(deps.getSettings()))) {
        res.status(409).json({ detail: '模型配置已改变，请重新检测' }); return
      }
      // Probing a menu row never persists or activates that model.
      res.json({ ...result, elapsed_ms: Math.max(1, Date.now() - started), checked_at: Date.now() })
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : '探索模型检测失败' })
    }
  })
  app.post('/settings/exploration-model', async (req, res) => {
    res.status(400).json({ detail: '网站探索已统一使用对话接口，请在模型配置中修改' })
  })
}
