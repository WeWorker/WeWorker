import { describe, expect, it } from 'vitest'
import type { Settings } from '../config.js'
import { getProvider } from '../provider-registry.js'
import { resolveWebwrightModelConfig } from '../webwright-model-config.js'

const settings = (patch: Partial<Settings> = {}) => ({
  active_provider: 'glm', api_key: 'placeholder-main-key', model: 'main-model', context_limit: 200000,
  model_configurations: { 'example-config': { provider_id: 'custom', api_key: 'placeholder-chat-key', model: 'chat-model',
    base_url: 'https://example.com/chat', openai_base_url: 'https://example.org/exploration',
    openai_api_key: 'placeholder-explore-key', openai_model: 'explore-model', context_limit: 128000, auth_type: 'api_key' } },
  ...patch,
} as Settings)

describe('exploration configuration references', () => {
  it.each(['glm', 'deepseek'])('uses the configured %s OpenAI interface', id => {
    const value = settings({ exploration_model_selection: { provider: id, model: 'session-model' },
      ['api_key_' + id]: 'placeholder-preset-key' })
    expect(resolveWebwrightModelConfig(value)).toMatchObject({ provider_id: id, protocol: 'openai_chat_completions',
      base_url: getProvider(id)!.webwright.baseUrl, api_key: 'placeholder-preset-key', model: 'session-model' })
  })

  it.each(['anthropic_messages', 'openai_chat_completions', 'openai_responses'] as const)('ignores old independent %s transport and credentials', protocol => {
    const value = settings({ exploration_active_provider: 'example-config', exploration_providers: { 'example-config': {
      api_key: 'placeholder-stale-key', model: 'old-model', base_url: 'https://example.com/old', protocol, auth_type: 'api_key' } },
      exploration_model_selection: { provider: '__exploration__', model: 'session-model' } })
    expect(resolveWebwrightModelConfig(value)).toMatchObject({ protocol: 'openai_chat_completions',
      model_class: 'openai_chat', api_key: 'placeholder-explore-key', base_url: 'https://example.org/exploration', model: 'session-model' })
  })

  it('inherits only the referenced configuration key when its OpenAI key is blank', () => {
    const value = settings()
    value.model_configurations!['example-config'].openai_api_key = ''
    const selected = { ...value, exploration_model_selection: { provider: '__exploration__:example-config', model: 'session-model' } }
    expect(resolveWebwrightModelConfig(selected).api_key).toBe('placeholder-chat-key')
    expect(resolveWebwrightModelConfig({ ...selected, active_provider: 'custom', api_key: 'placeholder-other-key' }).api_key).toBe('placeholder-chat-key')
  })

  it('pins named configuration credentials while the global conversation default changes', () => {
    const value = settings({ exploration_model_selection: { provider: '__exploration__:example-config', model: 'session-model', thinking_effort: 'high' } })
    expect(resolveWebwrightModelConfig({ ...value, active_provider: 'deepseek', api_key: 'placeholder-other-key', model: 'other-model' }))
      .toEqual(resolveWebwrightModelConfig(value))
    expect(value.model).toBe('main-model')
  })

  it('does not revive an independent-only entry without a configured OpenAI interface', () => {
    const value = settings({ exploration_model_selection: { provider: '__exploration__:custom', model: 'session-model' },
      exploration_providers: { custom: { api_key: 'placeholder-stale-key', model: 'old', base_url: 'https://example.com/old',
        protocol: 'openai_chat_completions', auth_type: 'api_key' } } })
    expect(() => resolveWebwrightModelConfig(value)).toThrow(/Adapter|探索/)
  })
})
