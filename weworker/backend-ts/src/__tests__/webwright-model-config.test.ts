import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import { explorationResetPatch, isAuthorizedModelConfigRequest, resolveWebwrightModelConfig } from '../webwright-model-config.js'
import { defaultConversationModel, resolveConversationModelSettings } from '../conversation-models.js'
import { resolveOpenAiEndpoint } from '../llm-egress.js'
import { getProvider } from '../provider-registry.js'
import { explorationConversationSettings, defaultExplorationModel, createExplorationModelService } from '../exploration-model-settings.js'

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    active_provider: 'glm',
    api_key: 'secret',
    model: 'glm-5.2',
    base_url_custom: '',
    openai_base_url_custom: '',
    ...overrides,
  } as Settings
}

describe('model settings Adapter workshop interface', () => {
  it('uses the latest global exploration model for old records and honors only current local overrides', () => {
    const state = settings({ active_provider: 'custom', active_model_configuration: 'example', model: 'global-chat',
      model_selection_revision: 'revision-new', model_configurations: {
        example: { provider_id: 'custom', api_key: 'placeholder-key', model: 'global-chat', base_url: 'https://example.com/v1',
          openai_base_url: 'https://example.org/v1', openai_model: 'global-exploration', auth_type: 'auth_token', context_limit: 128000 },
      } })
    const stale = { provider: 'missing-old', model: 'old-model', selection_revision: 'revision-old' }
    expect(resolveWebwrightModelConfig(explorationConversationSettings(state, stale)).model).toBe('global-exploration')
    expect(resolveWebwrightModelConfig({ ...state, exploration_model_selection: stale }).model).toBe('global-exploration')
    const local = { provider: '__exploration__:example', model: 'local-next', selection_revision: 'revision-new' }
    expect(resolveWebwrightModelConfig(explorationConversationSettings(state, local)).model).toBe('local-next')
    expect(state.model).toBe('global-chat')
  })

  function configured(protocol: 'anthropic_messages' | 'openai_chat_completions' | 'openai_responses') {
    return settings({ active_provider: 'custom', active_model_configuration: 'example-config', model: 'example-model',
      model_configurations: { 'example-config': { provider_id: 'custom', model: 'example-model', api_key: 'placeholder-main-key',
        base_url: 'https://example.com/custom/infer/?v=1', base_url_is_full: true,
        weworker_protocol: protocol, auth_type: 'auth_token', context_limit: 128000,
        openai_base_url: 'https://example.org/old/v1', openai_api_key: 'placeholder-old-key', openai_model: 'old-model' } },
      exploration_base_url: 'https://example.org/independent', exploration_api_key: 'placeholder-independent-key',
      exploration_model: 'old-independent-model', exploration_use_main_key: false,
    })
  }
  it('uses distinct Workshop settings for custom Anthropic', () => {
    const saved = configured('anthropic_messages')
    const original = structuredClone(saved)
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ protocol: 'openai_chat_completions',
      base_url: 'https://example.org/old/v1', base_url_is_full: false,
      model: 'old-model', api_key: 'placeholder-old-key', auth_type: 'auth_token', context_limit: 128000 })
    expect(defaultExplorationModel(saved).provider).toBe('example-config')
    expect(saved).toEqual(original)
  })
  it.each([
    ['openai_chat_completions', 'https://example.com/custom/infer/?v=1', true, 'https://example.com/custom/infer/?v=1'],
    ['openai_responses', 'https://example.com/v1', false, 'https://example.com/v1'],
    ['openai_responses', 'https://example.com/v1/responses', true, 'https://example.com/v1/chat/completions'],
  ] as const)('shares the saved %s connection at %s despite stale Workshop fields and selection', (protocol, url, full, expected) => {
    const saved = configured(protocol)
    Object.assign(saved.model_configurations!['example-config'], { base_url: url, base_url_is_full: full })
    saved.exploration_model_selection = { provider: '__exploration__:example-config', model: 'stale-workshop-model' }
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ protocol: 'openai_chat_completions',
      base_url: expected, base_url_is_full: full, model: 'example-model', api_key: 'placeholder-main-key' })
    expect(defaultExplorationModel(saved).model).toBe('example-model')
    expect(resolveConversationModelSettings(saved, defaultConversationModel(saved))).toMatchObject({ active_weworker_protocol: protocol, base_url: url })
  })
  it('honors a pinned generation model and thinking effort after a shared default changes', () => {
    const saved = configured('openai_chat_completions')
    saved.model_selection_revision = 'fixture-new-revision'
    saved.model_configurations!['example-config'].model = 'fixture-new-default'
    const pin = { provider: '__exploration__:example-config', model: 'fixture-prepared-model',
      thinking_effort: 'high' as const, selection_revision: 'fixture-old-revision' }
    expect(resolveWebwrightModelConfig(saved).model).toBe('fixture-new-default')
    expect(resolveWebwrightModelConfig(saved, pin)).toMatchObject({ model: pin.model,
      thinking_effort: 'high', context_limit: 128000, api_key: 'placeholder-main-key' })
  })
  it('does not use an arbitrary full Responses URL or a stale Workshop override', () => {
    expect(() => resolveWebwrightModelConfig(configured('openai_responses'))).toThrow(/OpenAI/)
  })
  it('shares the main connection for legacy custom OpenAI settings', () => {
    const saved = settings({ active_provider: 'custom', api_key_custom: 'placeholder-main-key',
      base_url_custom: 'https://example.com/shared/v1', model_custom: 'fixture-main', weworker_protocol_custom: 'openai_chat_completions',
      openai_api_key_custom: 'placeholder-stale-key', openai_base_url_custom: 'https://example.org/stale/v1', openai_model_custom: 'fixture-stale' })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ base_url: saved.base_url_custom, model: saved.model_custom, api_key: saved.api_key_custom })
  })
  it('keeps a session model override separate from the default configuration', () => {
    const saved = configured('anthropic_messages')
    const candidate = explorationConversationSettings(saved, { provider: 'example-config', model: 'session-model', thinking_effort: 'high' })
    expect(resolveWebwrightModelConfig(candidate)).toMatchObject({ model: 'session-model', api_key: 'placeholder-old-key', thinking_effort: 'high' })
    expect(saved.model).toBe('example-model')
    expect(saved.exploration_model_selection).toBeUndefined()
  })
  it('probes the configured OpenAI exploration URL with bearer authentication', async () => {
    const saved = configured('anthropic_messages')
    const requests: Array<{ url: string; init: RequestInit }> = []
    const service = createExplorationModelService((async (url, init) => {
      requests.push({ url: String(url), init: init! })
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
    }) as typeof fetch)
    expect((await service.check(saved)).ok).toBe(true)
    expect(requests[0].url).toBe('https://example.org/old/v1/chat/completions')
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe('Bearer placeholder-old-key')
    expect(new Headers(requests[0].init.headers).has('x-api-key')).toBe(false)
  })
})

describe('managed conversation configuration', () => {
  it.each(['glm', 'deepseek'])('uses the OpenAI preset exploration interface for %s', active_provider => {
    const saved = settings({ active_provider })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ protocol: 'openai_chat_completions',
      base_url: getProvider(active_provider)!.webwright.baseUrl, api_key: saved.api_key, model: saved.model })
  })
  it('excludes presets that do not provide an OpenAI exploration interface', () => {
    const saved = settings({ active_provider: 'anthropic' })
    expect(() => resolveWebwrightModelConfig(saved)).toThrow(/OpenAI/)
    expect(createExplorationModelService().status(saved).providers.find(item => item.id === 'anthropic')).toBeUndefined()
  })
  it('checks the built-in exploration endpoint despite a stale independent exploration provider', async () => {
    const saved = settings({ active_provider: 'builtin', api_key: '', model: 'ark-code-latest',
      exploration_active_provider: 'deepseek', exploration_providers: { deepseek: {
        api_key: 'fixture-stale-explore-key', model: 'stale-model', base_url: 'https://api.deepseek.com',
        protocol: 'openai_chat_completions', auth_type: 'api_key',
      } } })
    const candidate = { ...saved, exploration_model_selection: { provider: 'builtin', model: 'ark-code-latest' } }
    const main = resolveConversationModelSettings(candidate, { provider: 'builtin', model: 'ark-code-latest' })
    const config = resolveWebwrightModelConfig(candidate)
    const provider = getProvider('builtin')!
    expect(config).toMatchObject({ provider_id: 'builtin', protocol: provider.webwright.protocol,
      model_class: provider.webwright.modelClass, base_url: provider.webwright.baseUrl,
      structured_output: provider.webwright.structuredOutput, model: 'ark-code-latest', api_key: main.api_key })
    expect(config.api_key).not.toBe('fixture-stale-explore-key')
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
    const service = createExplorationModelService(fetchMock)
    const builtinStatus = service.status(candidate).providers.find(provider => provider.id === 'builtin')
    expect(builtinStatus).toMatchObject({ configured: true, has_key: true, builtin: true, saved_exploration: false })
    expect(await service.check(candidate, true)).toMatchObject({ ok: true, target: 'webwright', model: 'ark-code-latest' })
    expect(fetchMock.mock.calls[0][0]).toBe(resolveOpenAiEndpoint(provider.webwright.baseUrl))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: 'ark-code-latest', response_format: { type: 'json_object' } })
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.get('authorization')?.replace(/^Bearer /, '')).toBe(main.api_key)
  })
  it('preserves exact full URLs including query parameters in legacy exploration settings', () => {
    const url = 'https://example.com/custom/infer/?v=1&route=a%2Fb'
    const saved = settings({ active_provider: 'custom', openai_base_url_custom: url, openai_base_url_is_full_custom: true })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ base_url: url, base_url_is_full: true, protocol: 'openai_chat_completions' })
  })
  it.each(['https://example.com', 'https://example.com/', 'https://example.com/v1/', 'https://example.com/anthropic'])('uses %s without guessing another endpoint', base_url_custom => {
    const saved = settings({ active_provider: 'custom', openai_base_url_custom: base_url_custom })
    expect(resolveWebwrightModelConfig(saved).base_url).toBe(base_url_custom.replace(/\/$/, ''))
  })
  it('does not let chat credentials or retired exploration fields hide a missing OpenAI interface', () => {
    const saved = settings({ active_provider: 'custom', base_url_custom: 'https://example.com/chat', exploration_base_url: 'https://example.org/old' })
    expect(() => resolveWebwrightModelConfig(saved)).toThrow(/OpenAI/)
    expect(() => resolveWebwrightModelConfig({ ...saved, api_key: '' })).toThrow(/API Key/)
  })
  it.each(['file:///example', 'https://user:password@example.com', 'https://example.com/#fragment'])('rejects invalid shared addresses: %s', base_url_custom => {
    expect(() => resolveWebwrightModelConfig(settings({ active_provider: 'custom', openai_base_url_custom: base_url_custom }))).toThrow()
  })
  it('passes an unlisted session model without replacing it with a catalog default', () => {
    expect(resolveWebwrightModelConfig(settings({ model: 'example-unlisted' })).model).toBe('example-unlisted')
  })
  it('resets independent exploration settings when activating a preset provider', () => {
    for (const provider of ['anthropic', 'glm', 'deepseek', 'builtin']) {
      expect(explorationResetPatch(provider)).toEqual({
        exploration_base_url: '',
        exploration_base_url_is_full: false,
        exploration_model: '',
        exploration_api_key: '',
        exploration_use_main_key: true,
      })
    }
    expect(explorationResetPatch('custom')).toEqual({})
  })

  it('accepts only the per-launch bearer token', () => {
    expect(isAuthorizedModelConfigRequest('Bearer launch-token', 'launch-token')).toBe(true)
    expect(isAuthorizedModelConfigRequest('Bearer wrong', 'launch-token')).toBe(false)
    expect(isAuthorizedModelConfigRequest(undefined, 'launch-token')).toBe(false)
    expect(isAuthorizedModelConfigRequest('Bearer launch-token', '')).toBe(false)
  })
})
