import { describe, expect, it } from 'vitest'
import type { Settings } from '../config.js'
import { explorationResetPatch, isAuthorizedModelConfigRequest, resolveWebwrightModelConfig } from '../webwright-model-config.js'
import { resolveConversationModelSettings } from '../conversation-models.js'
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

describe('shared conversation interface', () => {
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
  it.each(['anthropic_messages', 'openai_chat_completions', 'openai_responses'] as const)('uses the conversation configuration for %s and ignores legacy overrides', protocol => {
    const saved = configured(protocol)
    const original = structuredClone(saved)
    const main = resolveConversationModelSettings(saved, { provider: 'example-config', model: 'example-model' })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ protocol, base_url: main.base_url, base_url_is_full: true,
      model: main.model, api_key: main.api_key, auth_type: main.active_auth_type, context_limit: 128000 })
    expect(defaultExplorationModel(saved).provider).toBe('example-config')
    expect(saved).toEqual(original)
  })
  it('keeps a session model override separate from the default configuration', () => {
    const saved = configured('anthropic_messages')
    const candidate = explorationConversationSettings(saved, { provider: 'example-config', model: 'session-model', thinking_effort: 'high' })
    expect(resolveWebwrightModelConfig(candidate)).toMatchObject({ model: 'session-model', api_key: 'placeholder-main-key', thinking_effort: 'high' })
    expect(saved.model).toBe('example-model')
    expect(saved.exploration_model_selection).toBeUndefined()
  })
  it('probes the shared Anthropic URL with the selected bearer authentication', async () => {
    const saved = configured('anthropic_messages')
    const requests: Array<{ url: string; init: RequestInit }> = []
    const service = createExplorationModelService((async (url, init) => {
      requests.push({ url: String(url), init: init! })
      return Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] })
    }) as typeof fetch)
    expect((await service.check(saved)).ok).toBe(true)
    expect(requests[0].url).toBe('https://example.com/custom/infer/?v=1')
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe('Bearer placeholder-main-key')
    expect(new Headers(requests[0].init.headers).has('x-api-key')).toBe(false)
  })
})

describe('managed conversation configuration', () => {
  it.each(['anthropic', 'glm', 'deepseek'])('uses the same preset interface for %s', active_provider => {
    const saved = settings({ active_provider })
    const main = resolveConversationModelSettings(saved, { provider: active_provider, model: saved.model })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ protocol: main.active_weworker_protocol, base_url: main.base_url,
      auth_type: main.active_auth_type, api_key: main.api_key, model: main.model })
  })
  it('preserves exact full URLs including query parameters in legacy main settings', () => {
    const url = 'https://example.com/custom/infer/?v=1&route=a%2Fb'
    const saved = settings({ active_provider: 'custom', base_url_custom: url, base_url_is_full_custom: true })
    expect(resolveWebwrightModelConfig(saved)).toMatchObject({ base_url: url, base_url_is_full: true, protocol: 'anthropic_messages' })
  })
  it.each(['https://example.com', 'https://example.com/', 'https://example.com/v1/', 'https://example.com/anthropic'])('uses %s without guessing another endpoint', base_url_custom => {
    const saved = settings({ active_provider: 'custom', base_url_custom })
    expect(resolveWebwrightModelConfig(saved).base_url).toBe(base_url_custom.replace(/\/$/, ''))
  })
  it('does not let legacy exploration credentials hide an incomplete conversation configuration', () => {
    const saved = settings({ active_provider: 'custom', openai_base_url_custom: 'https://example.org/old', exploration_base_url: 'https://example.org/old' })
    expect(() => resolveWebwrightModelConfig(saved)).toThrow('对话接口地址')
    expect(() => resolveWebwrightModelConfig({ ...saved, api_key: '' })).toThrow('API Key')
  })
  it.each(['file:///example', 'https://user:password@example.com', 'https://example.com/#fragment'])('rejects invalid shared addresses: %s', base_url_custom => {
    expect(() => resolveWebwrightModelConfig(settings({ active_provider: 'custom', base_url_custom }))).toThrow()
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
