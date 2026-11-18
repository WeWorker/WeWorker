import { describe, expect, it } from 'vitest'
import type { Express } from 'express'
import type { Settings } from '../config.js'
import { createExplorationModelService, defaultExplorationModel, registerExplorationModelRoutes } from '../exploration-model-settings.js'
import { resolveOpenAiEndpoint } from '../llm-egress.js'
import { getProvider } from '../provider-registry.js'
import { resolveWebwrightModelConfig } from '../webwright-model-config.js'

function settings(): Settings {
  return {
    active_provider: 'builtin', model: 'ark-code-latest', context_limit: 200000,
    model_configurations: {
      'configured-custom': { provider_id: 'custom', name: 'Example exploration', api_key: 'placeholder-chat-key',
        model: 'chat-model', base_url: 'https://example.com/chat', auth_type: 'api_key', context_limit: 128000,
        openai_base_url: 'https://example.org/explore/v1', openai_api_key: 'placeholder-explore-key', openai_model: 'explore-model',
        openai_models_url: 'https://example.org/catalog', openai_models_url_is_full: true },
      'chat-only': { provider_id: 'custom', name: 'Chat only', api_key: 'placeholder-chat-only-key', model: 'chat-model',
        base_url: 'https://example.com/chat', auth_type: 'api_key', context_limit: 200000, openai_base_url: '' },
    },
    exploration_active_provider: 'custom',
    exploration_providers: { custom: { api_key: 'placeholder-stale-key', model: 'stale-model',
      base_url: 'https://example.com/stale', protocol: 'anthropic_messages', auth_type: 'api_key' },
      'configured-custom': { api_key: 'placeholder-stale-key', model: 'stale-model',
        base_url: 'https://example.com/stale', protocol: 'anthropic_messages', auth_type: 'api_key' } },
  } as unknown as Settings
}

describe('exploration reads the model settings exploration interface', () => {
  it('marks fixed supplier entries for display without treating missing credentials as configured', () => {
    const providers = createExplorationModelService().status(settings()).providers
    for (const id of ['anthropic', 'glm', 'deepseek']) {
      expect(providers.find(item => item.id === id)).toMatchObject({ fixed_provider: true, configured: false, has_key: false })
    }
    expect(providers.find(item => item.id === 'chat-only')).toMatchObject({ fixed_provider: false, configured: false })
  })

  it.each(['configured-custom', '__exploration__:configured-custom', '__exploration__'])('resolves %s from model settings only', provider => {
    const saved = { ...settings(), exploration_active_provider: 'configured-custom',
      exploration_model_selection: { provider, model: 'session-model' } }
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ api_key: 'placeholder-explore-key',
      base_url: 'https://example.org/explore/v1', protocol: 'openai_chat_completions', model: 'session-model' })
  })

  it('defaults to the active model configuration exploration model and ignores retired defaults', () => {
    const saved = { ...settings(), active_provider: 'custom', active_model_configuration: 'configured-custom' }
    expect(defaultExplorationModel(saved)).toMatchObject({ provider: 'configured-custom', model: 'explore-model' })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ model: 'explore-model', api_key: 'placeholder-explore-key' })
    expect(createExplorationModelService().status(saved, 'configured-custom')).toMatchObject({
      configured_model: 'explore-model', configured_base_url: 'https://example.org/explore/v1', protocol: 'openai_chat_completions' })
  })

  it('never falls back to a chat interface when the selected exploration interface is missing', () => {
    const saved = { ...settings(), exploration_model_selection: { provider: 'chat-only', model: 'session-model' } }
    expect(() => resolveWebwrightModelConfig(saved)).toThrow(/探索|Adapter/)
  })

  it('honors a preset configuration exploration key instead of its chat key', () => {
    const saved = settings()
    saved.model_configurations!['preset'] = { ...saved.model_configurations!['configured-custom'], provider_id: 'deepseek' }
    expect(resolveWebwrightModelConfig({ ...saved, exploration_model_selection: { provider: 'preset', model: 'deepseek-chat' } }))
      .toMatchObject({ protocol: 'openai_chat_completions', api_key: 'placeholder-explore-key', base_url: getProvider('deepseek')!.webwright.baseUrl })
  })

  it('lists configured interfaces by their settings name and excludes stale independent and chat-only entries', () => {
    const saved = settings(), before = structuredClone(saved)
    const providers = createExplorationModelService().status(saved).providers.filter(item => item.configured)
    expect(providers.find(item => item.id === 'configured-custom')).toMatchObject({ name: 'Example exploration',
      model: 'explore-model', base_url: 'https://example.org/explore/v1', selection_provider: '__exploration__:configured-custom' })
    expect(providers.some(item => ['custom', 'chat-only'].includes(item.id))).toBe(false)
    expect(JSON.stringify(providers)).not.toContain('placeholder-')
    expect(saved).toEqual(before)
  })

  it('uses the selected interface key, protocol, model and context despite stale independent settings', () => {
    const saved = settings()
    const selection = { provider: '__exploration__:configured-custom', model: 'explore-session', thinking_effort: 'high' as const }
    expect(resolveWebwrightModelConfig({ ...saved, exploration_model_selection: selection })).toMatchObject({
      base_url: 'https://example.org/explore/v1', api_key: 'placeholder-explore-key', protocol: 'openai_chat_completions',
      model: 'explore-session', context_limit: 128000, thinking_effort: 'high',
    })
    saved.model_configurations!['configured-custom'].openai_api_key = 'placeholder-updated-key'
    expect(resolveWebwrightModelConfig({ ...saved, exploration_model_selection: selection }).api_key).toBe('placeholder-updated-key')
    saved.model_configurations!['configured-custom'].openai_base_url = ''
    expect(() => resolveWebwrightModelConfig({ ...saved, exploration_model_selection: selection })).toThrow(/探索/)
  })

  it('supports the legacy custom settings fields without reading the independent custom entry', () => {
    const saved = { ...settings(), api_key_custom: 'placeholder-custom-chat', model_custom: 'custom-chat',
      openai_api_key_custom: 'placeholder-custom-explore', openai_model_custom: 'custom-explore',
      openai_base_url_custom: 'https://example.org/exact/completions?version=1', openai_base_url_is_full_custom: true }
    expect(createExplorationModelService().status(saved).providers.find(item => item.id === 'custom')).toMatchObject({
      configured: true, model: 'custom-explore' })
    expect(resolveWebwrightModelConfig({ ...saved, exploration_model_selection: { provider: '__exploration__:custom', model: 'custom-explore' } }))
      .toMatchObject({ base_url: saved.openai_base_url_custom, base_url_is_full: true, api_key: 'placeholder-custom-explore' })
  })

  it('detects and runs the built-in model through its OpenAI exploration endpoint', async () => {
    const saved = { ...settings(), api_key: '', active_provider: 'builtin', active_model_configuration: '', model: 'ark-code-latest' }
    const selection = { provider: 'builtin', model: 'ark-code-latest' }
    const candidate = { ...saved, exploration_model_selection: selection }
    const config = resolveWebwrightModelConfig(candidate)
    const provider = getProvider('builtin')!
    expect(config).toMatchObject({ protocol: 'openai_chat_completions', model_class: 'zhipu',
      base_url: provider.webwright.baseUrl, model: provider.defaultModel, structured_output: 'openai_json_object' })
    const requests: Array<{ url: string; headers: Headers; body: any }> = []
    const fetchImpl: typeof fetch = async (url, options) => {
      requests.push({ url: String(url), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body)) })
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
    }
    expect((await createExplorationModelService(fetchImpl).check(candidate, true)).ok).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(resolveOpenAiEndpoint(provider.webwright.baseUrl))
    expect(requests[0].headers.has('x-api-key')).toBe(false)
    expect(requests[0].headers.get('authorization')).toMatch(/^Bearer /)
    expect(requests[0].body).toMatchObject({ model: provider.defaultModel, response_format: { type: 'json_object' } })
  })

  it('probes and lists models with the settings exploration credentials and its explicit catalog URL', async () => {
    const saved = settings(), before = structuredClone(saved), requests: Array<{ url: string; key: string | null }> = []
    const fetchImpl: typeof fetch = async (url, options) => {
      requests.push({ url: String(url), key: new Headers(options?.headers).get('authorization') })
      return String(url).endsWith('/catalog') ? Response.json({ data: [{ id: 'explore-next' }] })
        : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
    }
    const selection = { provider: '__exploration__:configured-custom', model: 'explore-model' }
    expect((await createExplorationModelService(fetchImpl).check({ ...saved, exploration_model_selection: selection })).ok).toBe(true)
    const handlers = new Map<string, Function>()
    registerExplorationModelRoutes({ get() {}, post: (route: string, handler: Function) => handlers.set(route, handler) } as unknown as Express,
      { getSettings: () => saved, updateSettings: () => { throw new Error('must not write settings') }, fetchImpl })
    let data: any
    const response = { json(value: unknown) { data = value; return this }, status() { return this } }
    await handlers.get('/settings/exploration-model/models')!({ body: selection }, response)
    expect(data.models).toContain('explore-next')
    expect(requests).toEqual([
      { url: 'https://example.org/explore/v1/chat/completions', key: 'Bearer placeholder-explore-key' },
      { url: 'https://example.org/catalog', key: 'Bearer placeholder-explore-key' },
    ])
    expect(saved).toEqual(before)
  })
})
