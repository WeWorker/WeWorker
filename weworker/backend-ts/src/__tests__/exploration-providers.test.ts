import { describe, expect, it } from 'vitest'
import type { Settings } from '../config.js'
import { resolveWebwrightModelConfig, explorationResetPatch } from '../webwright-model-config.js'

const settings = (patch: Partial<Settings> = {}) => ({
  active_provider: 'anthropic', api_key: 'fixture-main-key', model: 'main-model',
  base_url_custom: '', openai_base_url_custom: '', exploration_base_url: '',
  exploration_model: '', exploration_api_key: '', exploration_use_main_key: true,
  ...patch,
} as Settings)

describe('independent exploration providers', () => {
  it.each([
    ['anthropic', 'anthropic_messages', 'anthropic', 'https://api.anthropic.com'],
    ['glm', 'openai_chat_completions', 'zhipu', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    ['deepseek', 'openai_chat_completions', 'openai_chat', 'https://api.deepseek.com'],
  ])('uses the advanced %s configuration independently of the conversation', (provider, protocol, modelClass, baseUrl) => {
    const value = settings({ exploration_active_provider: provider, exploration_providers: {
      [provider]: { api_key: 'fixture-explore-key', model: 'explore-model', base_url: '', protocol: 'anthropic_messages', auth_type: 'auth_token' },
    } })
    expect(resolveWebwrightModelConfig(value)).toMatchObject({ provider_id: provider, protocol, model_class: modelClass, base_url: baseUrl, model: 'explore-model', api_key: 'fixture-explore-key' })
    expect(resolveWebwrightModelConfig({ ...value, active_provider: 'custom', model: 'other-main', api_key: 'fixture-changed-key' })).toEqual(resolveWebwrightModelConfig(value))
    expect(explorationResetPatch('glm')).not.toHaveProperty('exploration_providers')
  })

  it.each(['anthropic_messages', 'openai_chat_completions'] as const)('uses the saved custom %s transport and auth', protocol => {
    expect(resolveWebwrightModelConfig(settings({ exploration_active_provider: 'custom', exploration_providers: { custom: {
      api_key: 'fixture-key', model: 'custom-model', base_url: 'https://example.com/gateway', protocol, auth_type: 'auth_token',
    } } }))).toMatchObject({ provider_id: 'custom', protocol, model_class: protocol === 'anthropic_messages' ? 'anthropic' : 'openai_chat', auth_type: 'auth_token', base_url: 'https://example.com/gateway' })
  })

  it('does not silently use the ordinary conversation key when exploration is unconfigured', () => {
    expect(() => resolveWebwrightModelConfig(settings({ exploration_active_provider: 'glm', exploration_providers: {} }))).toThrow(/网站探索/)
  })

  it('uses the active configuration key by reference while preserving a complete exploration URL', () => {
    const value = settings({ active_model_configuration: 'fixture-chat', model_configurations: { 'fixture-chat': {
      provider_id: 'custom', api_key: 'fixture-config-key', model: 'main-model', base_url: 'https://example.com/chat',
      context_limit: 1000000, openai_base_url: '', auth_type: 'api_key',
    } }, exploration_active_provider: 'custom', exploration_providers: { custom: {
      api_key: '', use_main_key: true, model: '', base_url: 'https://example.org/infer/?version=1', base_url_is_full: true,
      protocol: 'openai_chat_completions', auth_type: 'api_key',
    } } })
    expect(resolveWebwrightModelConfig(value)).toMatchObject({ api_key: 'fixture-config-key', base_url: 'https://example.org/infer/?version=1', base_url_is_full: true, model: 'main-model' })
    expect(value.api_key).toBe('fixture-main-key')
  })

  it('resolves a session-specific model through the independent credentials without changing chat settings', () => {
    const value = settings({ exploration_active_provider: 'deepseek', exploration_providers: { deepseek: {
      api_key: 'fixture-explore-key', model: 'saved-explore-model', base_url: '', protocol: 'openai_chat_completions', auth_type: 'api_key',
    } }, exploration_model_selection: { provider: '__exploration__', model: 'session-explore-model', thinking_effort: 'high' } })
    expect(resolveWebwrightModelConfig(value)).toMatchObject({ provider_id: 'deepseek', model: 'session-explore-model', api_key: 'fixture-explore-key', thinking_effort: 'high' })
    expect(value.api_key).toBe('fixture-main-key')
    expect(value.model).toBe('main-model')
  })

  it('pins the selected exploration configuration even when the global default changes', () => {
    const value = settings({ exploration_active_provider: 'deepseek', exploration_providers: {
      glm: { api_key: 'fixture-glm-explore-key', model: 'glm-explore', base_url: '', protocol: 'openai_chat_completions', auth_type: 'api_key' },
      deepseek: { api_key: 'fixture-deepseek-explore-key', model: 'deepseek-explore', base_url: '', protocol: 'openai_chat_completions', auth_type: 'api_key' },
    }, exploration_model_selection: { provider: '__exploration__:glm', model: 'glm-session' } })
    expect(resolveWebwrightModelConfig(value)).toMatchObject({ provider_id: 'glm', api_key: 'fixture-glm-explore-key', model: 'glm-session', protocol: 'openai_chat_completions' })
    expect(resolveWebwrightModelConfig({ ...value, exploration_active_provider: 'custom', active_provider: 'custom', api_key: 'fixture-other-chat-key' }))
      .toEqual(resolveWebwrightModelConfig(value))
    expect(value.exploration_active_provider).toBe('deepseek')
  })
})
