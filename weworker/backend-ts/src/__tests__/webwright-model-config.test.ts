import { describe, expect, it } from 'vitest'
import type { Settings } from '../config.js'
import { explorationResetPatch, isAuthorizedModelConfigRequest, resolveWebwrightModelConfig, suggestExplorationBaseUrl } from '../webwright-model-config.js'

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

describe('Webwright managed model config', () => {
  it('passes through exact custom OpenAI URLs and each configuration URL mode', () => {
    const endpoint = 'https://example.com/custom/inference/?v=1&route=a%2Fb'
    const legacy = settings({ active_provider: 'custom', openai_base_url_custom: endpoint, openai_base_url_is_full_custom: true })
    expect(resolveWebwrightModelConfig(legacy)).toMatchObject({ base_url: endpoint, base_url_is_full: true })
    expect(suggestExplorationBaseUrl(legacy)).toEqual({ url: endpoint, generated: false, fullUrl: true })
    const configured = { ...legacy, active_model_configuration: 'model-fixture', model_configurations: {
      'model-fixture': { provider_id: 'custom', model: 'fixture-model', api_key: 'fixture-key', context_limit: 1000000,
        base_url: 'https://example.com/anthropic', base_url_is_full: false,
        openai_base_url: endpoint, openai_base_url_is_full: true, auth_type: 'api_key' as const },
    } }
    expect(resolveWebwrightModelConfig(configured)).toMatchObject({ base_url: endpoint, base_url_is_full: true })
    configured.model_configurations['model-fixture'].openai_base_url_is_full = false
    configured.model_configurations['model-fixture'].openai_base_url = 'https://example.com/v1'
    expect(resolveWebwrightModelConfig(configured)).not.toHaveProperty('base_url_is_full')
  })

  it('does not infer an exploration endpoint from a complete Anthropic URL', () => {
    const value = settings({ active_provider: 'custom',
      base_url_custom: 'https://example.com/inference/?version=1', base_url_is_full_custom: true })
    expect(suggestExplorationBaseUrl(value)).toEqual({ url: '', generated: false })
    expect(() => resolveWebwrightModelConfig(value)).toThrow('请填写网站探索服务地址')
  })

  it('keeps independent exploration URL mode separate from both main URL modes', () => {
    const main = settings({ active_provider: 'custom',
      base_url_custom: 'https://example.com/inference/?version=1', base_url_is_full_custom: true,
      openai_base_url_custom: 'https://example.com/chat/?version=1', openai_base_url_is_full_custom: true })
    const base = { ...main, exploration_base_url: 'https://example.org/v1' }
    expect(resolveWebwrightModelConfig(base)).toMatchObject({ base_url: 'https://example.org/v1' })
    expect(resolveWebwrightModelConfig(base)).not.toHaveProperty('base_url_is_full')
    const full = { ...main, exploration_base_url: 'https://example.org/chat/?v=1', exploration_base_url_is_full: true }
    expect(resolveWebwrightModelConfig(full)).toMatchObject({ base_url: full.exploration_base_url, base_url_is_full: true })
    expect(suggestExplorationBaseUrl(full)).toEqual({ url: full.exploration_base_url, generated: false, fullUrl: true })
  })

  it.each([
    ['https://example.com', 'https://example.com/v1'],
    ['https://example.com/', 'https://example.com/v1'],
    ['https://example.com/v1/', 'https://example.com/v1'],
    ['https://example.com/anthropic', 'https://example.com/anthropic/v1'],
  ])('suggests an editable address without changing the runtime: %s', (base_url_custom, expected) => {
    const value = settings({ active_provider: 'custom', base_url_custom, api_key: '', model: '' })
    expect(suggestExplorationBaseUrl(value)).toEqual({ url: expected, generated: true })
    expect(value.exploration_base_url).toBeUndefined()
    expect(resolveWebwrightModelConfig({ ...value, api_key: 'fixture-key', model: 'fixture-model' }).base_url).toBe(base_url_custom.replace(/\/$/, ''))
  })

  it('prioritizes saved addresses, legacy addresses and exact built-in mappings', () => {
    const value = settings({ active_provider: 'custom', base_url_custom: 'https://api.deepseek.com/anthropic' })
    expect(suggestExplorationBaseUrl(value)).toEqual({ url: 'https://api.deepseek.com', generated: false })
    expect(suggestExplorationBaseUrl({ ...value, openai_base_url_custom: 'https://example.org/legacy' }).url).toBe('https://example.org/legacy')
    const saved = { ...value, exploration_base_url: 'https://example.org/saved', openai_base_url_custom: 'https://example.org/legacy' }
    expect(suggestExplorationBaseUrl({ ...saved, base_url_custom: 'https://example.com/changed' }).url).toBe('https://example.org/saved')
    expect(suggestExplorationBaseUrl({ ...saved, active_provider: 'anthropic' }).url).toBe('https://example.org/saved')
  })

  it('retains the native protocol when saving an unmodified built-in address', () => {
    const value = settings({ active_provider: 'anthropic' })
    const suggestion = suggestExplorationBaseUrl(value)
    expect(suggestion.generated).toBe(false)
    expect(resolveWebwrightModelConfig({ ...value, exploration_base_url: suggestion.url })).toMatchObject({ protocol: 'anthropic_messages', model_class: 'anthropic', structured_output: 'anthropic_json_schema' })
  })

  it('uses the provider-native Chat Completions base URL', () => {
    expect(resolveWebwrightModelConfig(settings())).toEqual({
      provider_id: 'glm',
      protocol: 'openai_chat_completions',
      model_class: 'zhipu',
      base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: 'glm-5.2',
      api_key: 'secret',
      structured_output: 'openai_json_object',
    })
  })

  it('requires the custom Chat Completions base URL', () => {
    expect(() => resolveWebwrightModelConfig(settings({ active_provider: 'custom' }))).toThrow(/Chat Completions/)
    expect(resolveWebwrightModelConfig(settings({
      active_provider: 'custom',
      model: 'custom-model',
      openai_base_url_custom: 'https://gateway.example/openai/v1',
    })).base_url).toBe('https://gateway.example/openai/v1')
    expect(resolveWebwrightModelConfig(settings({
      active_provider: 'custom',
      model: 'custom-model',
      openai_base_url_custom: 'https://gateway.example/openai/v1',
    })).model_class).toBe('openai_chat')
  })

  it('passes through an unlisted configured model without catalog validation', () => {
    expect(resolveWebwrightModelConfig(settings({
      active_provider: 'deepseek',
      model: 'deepseek-chat',
    })).model).toBe('deepseek-chat')
  })

  it('tries the exact same custom base URL without guessing paths', () => {
    const config = resolveWebwrightModelConfig(settings({ active_provider: 'custom', base_url_custom: 'https://example.com/gateway/' }))
    expect(config.base_url).toBe('https://example.com/gateway')
    expect(config.protocol).toBe('openai_chat_completions')
  })

  it('maps only a complete known provider address and preserves legacy overrides', () => {
    const main = { active_provider: 'custom', base_url_custom: 'https://api.deepseek.com/anthropic/' }
    expect(resolveWebwrightModelConfig(settings(main)).base_url).toBe('https://api.deepseek.com')
    expect(resolveWebwrightModelConfig(settings({ ...main, openai_base_url_custom: 'https://example.org/v1' })).base_url).toBe('https://example.org/v1')
    expect(resolveWebwrightModelConfig(settings({ ...main, base_url_custom: 'https://api.deepseek.com/unlisted' })).base_url).toBe('https://api.deepseek.com/unlisted')
  })

  it('uses an independent service without changing the main model, including after a provider switch', () => {
    for (const active_provider of ['custom', 'anthropic']) {
      const value = settings({ active_provider, exploration_base_url: 'https://example.org/v1', exploration_api_key: 'fixture-independent-key', exploration_model: 'explore-model', exploration_use_main_key: false })
      expect(resolveWebwrightModelConfig(value)).toMatchObject({ provider_id: 'custom', api_key: 'fixture-independent-key', model: 'explore-model', protocol: 'openai_chat_completions' })
      expect(value.model).toBe('glm-5.2')
      expect(resolveWebwrightModelConfig({ ...value, exploration_use_main_key: true, exploration_model: '' })).toMatchObject({ api_key: 'secret', model: 'glm-5.2' })
    }
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

  it('falls back to the preset webwright config after switching to a preset provider', () => {
    const stale = settings({
      exploration_base_url: 'https://exploration.example.org/v1',
      exploration_base_url_is_full: true,
      exploration_api_key: 'fixture-independent-key',
      exploration_model: 'explore-model',
      exploration_use_main_key: false,
    })
    const switched = { ...stale, active_provider: 'glm' as const, ...explorationResetPatch('glm') }
    expect(resolveWebwrightModelConfig(switched)).toEqual({
      provider_id: 'glm',
      protocol: 'openai_chat_completions',
      model_class: 'zhipu',
      base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: 'glm-5.2',
      api_key: 'secret',
      structured_output: 'openai_json_object',
    })
  })

  it('accepts only the per-launch bearer token', () => {
    expect(isAuthorizedModelConfigRequest('Bearer launch-token', 'launch-token')).toBe(true)
    expect(isAuthorizedModelConfigRequest('Bearer wrong', 'launch-token')).toBe(false)
    expect(isAuthorizedModelConfigRequest(undefined, 'launch-token')).toBe(false)
    expect(isAuthorizedModelConfigRequest('Bearer launch-token', '')).toBe(false)
  })
})
