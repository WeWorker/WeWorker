import { createHash } from 'node:crypto'
import type { Express } from 'express'
import type { Settings } from './config.js'
import { normalizeLlmUrlInput, type ProviderEntry } from './llm-egress.js'
import { probeProviderProtocol, type ProtocolProbeResult } from './provider-model-services.js'
import { resolveWebwrightModelConfig, suggestExplorationBaseUrl } from './webwright-model-config.js'

function fingerprint(settings: Settings): string {
  try {
    const config = resolveWebwrightModelConfig(settings)
    return createHash('sha256').update(JSON.stringify([
      settings.active_model_configuration || '', config,
      settings.exploration_base_url, settings.exploration_base_url_is_full, settings.exploration_api_key,
      settings.exploration_model, settings.exploration_use_main_key,
    ])).digest('hex')
  } catch {
    // Invalid or incomplete configurations can be displayed but never verified.
    return 'invalid'
  }
}

export function explorationSettingsPatch(body: Record<string, unknown>): Partial<Settings> {
  if (typeof body.base_url !== 'string' || !body.base_url.trim()) throw new Error('请填写网站探索服务地址')
  if (body.base_url_is_full !== undefined && typeof body.base_url_is_full !== 'boolean') throw new Error('使用完整 URL 必须为布尔值')
  if (typeof body.use_main_key !== 'boolean') throw new Error('请选择是否使用现有 API Key')
  if (typeof body.model !== 'string') throw new Error('模型名称必须为文本')
  if (body.api_key !== undefined && typeof body.api_key !== 'string') throw new Error('API Key 必须为文本')
  return {
    exploration_base_url: normalizeLlmUrlInput(body.base_url.trim(), body.base_url_is_full === true),
    exploration_base_url_is_full: body.base_url_is_full === true,
    exploration_use_main_key: body.use_main_key,
    exploration_model: body.model.trim(),
    ...(body.use_main_key ? { exploration_api_key: '' } : body.api_key ? { exploration_api_key: (body.api_key as string).trim() } : {}),
  }
}

export function createExplorationModelService(fetchImpl: typeof fetch = fetch) {
  let verified = ''
  const pending = new Map<string, Promise<ProtocolProbeResult>>()
  function status(settings: Settings) {
    let suggestion: ReturnType<typeof suggestExplorationBaseUrl> = { url: '', generated: false }
    try { suggestion = suggestExplorationBaseUrl(settings) } catch { /* Invalid main addresses cannot provide a suggestion. */ }
    return {
      base_url: settings.exploration_base_url || '',
      base_url_is_full: settings.exploration_base_url_is_full === true,
      candidate_url: suggestion.url,
      candidate_url_is_full: suggestion.fullUrl === true,
      suggested: suggestion.generated,
      configured_model: settings.exploration_model || '',
      main_model: settings.model,
      use_main_key: settings.exploration_use_main_key !== false,
      has_key: Boolean(settings.exploration_api_key),
      status: verified === fingerprint(settings) ? (settings.exploration_base_url ? 'independent' : 'connected') : 'pending',
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
      anthropicAuthType: 'api_key',
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
  app.post('/settings/exploration-model/check', async (req, res) => {
    const settings = deps.getSettings()
    try {
      const result = await service.check(settings, req.body?.force === true)
      if (fingerprint(settings) !== fingerprint(deps.getSettings())) {
        res.status(409).json({ detail: '模型配置已改变，请重新检测' }); return
      }
      res.json({ ...result, ...service.status(settings) })
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : '请先配置主模型' })
    }
  })
  app.post('/settings/exploration-model', async (req, res) => {
    try {
      const settings = deps.getSettings()
      const patch = explorationSettingsPatch(req.body || {})
      const candidate = { ...settings, ...patch }
      const result = await service.check(candidate, true)
      if (fingerprint(settings) !== fingerprint(deps.getSettings())) {
        res.status(409).json({ detail: '模型配置已改变，请重新验证' }); return
      }
      if (!result.ok) { res.json(result); return }
      res.json({ ...result, ...service.status(deps.updateSettings(patch)) })
    } catch (error) {
      res.status(400).json({ detail: error instanceof Error ? error.message : '网站探索模型配置失败' })
    }
  })
}
