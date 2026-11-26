import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import { activateCheckedModelSettings, prepareCheckedModelSave } from '../model-settings-activation.js'

function fixture() {
  let state = { active_provider: 'deepseek', model: 'example-old', api_key: 'placeholder-old',
    base_url: 'https://example.org/old', added_providers: [],
    model_configurations: { 'model-example': { provider_id: 'custom', name: 'Example', api_key: 'placeholder-key',
      model: 'example-model', context_limit: 128000, base_url: 'https://example.com/v1',
      weworker_protocol: 'openai_chat_completions', auth_type: 'auth_token',
      openai_base_url: 'https://example.org/v1', openai_model: 'example-exploration',
      openai_api_key: 'placeholder-exploration' } },
  } as unknown as Settings
  const probeMain = vi.fn(async () => ({ ok: true, target: 'weworker', protocol: 'openai_chat_completions' }))
  const probeExploration = vi.fn(async () => ({ ok: true, target: 'webwright', protocol: 'openai_chat_completions' }))
  const updateSettings = vi.fn(patch => (state = { ...state, ...patch }))
  return { getSettings: () => state, updateSettings, probeMain, probeExploration } as any
}

describe('checked settings activation', () => {
  it('advances the global selection revision even when reactivating the same model', async () => {
    const f = fixture()
    await activateCheckedModelSettings('model-example', {}, f)
    const first = f.getSettings().model_selection_revision
    expect(first).toBeTruthy()
    await activateCheckedModelSettings('model-example', {}, f)
    expect(f.getSettings().model_selection_revision).not.toBe(first)
  })

  it('commits after local validation without network probes', async () => {
    const f = fixture()
    await activateCheckedModelSettings('model-example', {}, f)
    expect(f.probeMain).not.toHaveBeenCalled()
    expect(f.probeExploration).not.toHaveBeenCalled()
    expect(f.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('prepares legacy preset edits without mutating or writing the existing settings', async () => {
    const f = fixture()
    const before = f.getSettings()
    before.api_key_deepseek = 'placeholder-legacy'
    before.model_deepseek = 'example-legacy'
    const snapshot = structuredClone(before)
    const patch = await prepareCheckedModelSave(before, 'deepseek', {
      model: 'example-edited', api_key: 'placeholder-edited', context_limit: '128K', activate: true,
    })
    expect(patch.model_configurations?.deepseek).toMatchObject({ provider_id: 'deepseek',
      model: 'example-edited', api_key: 'placeholder-edited', context_limit: 128000 })
    expect(before).toEqual(snapshot)
    expect(f.updateSettings).not.toHaveBeenCalled()
    await activateCheckedModelSettings('deepseek', patch, f)
    expect(f.getSettings()).toMatchObject({ active_provider: 'deepseek', active_model_configuration: 'deepseek', model: 'example-edited' })
  })

  it('preserves independent records and rejects invalid draft fields without persisting', async () => {
    const f = fixture()
    const before = f.getSettings()
    await expect(prepareCheckedModelSave(before, 'model-example', { context_limit: 'invalid' })).rejects.toThrow()
    expect(f.updateSettings).not.toHaveBeenCalled()
    expect(Object.keys(before.model_configurations)).toEqual(['model-example'])
  })

  it('accepts a bare token count and rejects settings above 960K', async () => {
    const f = fixture()
    const before = f.getSettings()
    const patch = await prepareCheckedModelSave(before, 'model-example', { context_limit: '80000' })
    expect(patch.model_configurations?.['model-example'].context_limit).toBe(80_000)
    await expect(prepareCheckedModelSave(before, 'model-example', { context_limit: '1M' })).rejects.toThrow('960000')
    await expect(prepareCheckedModelSave(before, 'builtin', { context_limit: 960_001 })).rejects.toThrow('960000')
    before.model_configurations['model-example'].context_limit = 1_500_000
    await activateCheckedModelSettings('model-example', {}, f)
    expect(f.getSettings().context_limit).toBe(960_000)
  })

  it('commits edited settings while rejecting a stale snapshot', async () => {
    const f = fixture()
    const before = f.getSettings()
    const patch = { model_configurations: { ...before.model_configurations,
      'model-example': { ...before.model_configurations['model-example'], model: 'example-edited' } } }
    await activateCheckedModelSettings('model-example', patch, f)
    expect(f.getSettings()).toMatchObject({ active_model_configuration: 'model-example', model: 'example-edited' })
    await expect(activateCheckedModelSettings('model-example', {}, f, before)).rejects.toThrow('设置已变更')
    expect(f.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('rejects unavailable references without any request or write', async () => {
    const f = fixture()
    await expect(activateCheckedModelSettings('missing', {}, f)).rejects.toThrow()
    expect(f.probeMain).not.toHaveBeenCalled()
    expect(f.updateSettings).not.toHaveBeenCalled()
  })
})
