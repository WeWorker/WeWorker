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

  it('reports both existing checks before saving once, without additional probes', async () => {
    const f = fixture()
    const checks: unknown[] = []
    f.onCheck = (check: unknown) => {
      expect(f.updateSettings).not.toHaveBeenCalled()
      checks.push(check)
    }
    await activateCheckedModelSettings('model-example', {}, f)
    expect(checks).toMatchObject([
      { target: 'weworker', status: 'success' },
      { target: 'webwright', status: 'success' },
    ])
    expect(f.probeMain).toHaveBeenCalledTimes(1)
    expect(f.probeExploration).toHaveBeenCalledTimes(1)
    expect(f.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('reports a failed check without claiming the untested interface passed or committing', async () => {
    const f = fixture()
    f.onCheck = vi.fn()
    f.probeMain.mockResolvedValue({ ok: false, detail: 'example rejected' })
    await expect(activateCheckedModelSettings('model-example', {}, f)).rejects.toThrow('example rejected')
    expect(f.onCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: 'weworker', status: 'failure', message: 'example rejected' }))
    expect(f.probeExploration).not.toHaveBeenCalled()
    expect(f.updateSettings).not.toHaveBeenCalled()
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

  it('probes the draft and independent exploration credentials before committing once', async () => {
    const f = fixture()
    const before = f.getSettings()
    const patch = { model_configurations: { ...before.model_configurations,
      'model-example': { ...before.model_configurations['model-example'], model: 'example-edited', api_key: 'placeholder-edited' } } }
    f.probeMain.mockImplementation(async (input: any) => {
      expect(input).toMatchObject({ model: 'example-edited', apiKey: 'placeholder-edited', weworkerBaseUrl: 'https://example.com/v1' })
      expect(f.updateSettings).not.toHaveBeenCalled()
      return { ok: true }
    })
    await activateCheckedModelSettings('model-example', patch, f)
    expect(f.probeExploration.mock.calls[0][0]).toMatchObject({ model: 'example-exploration', apiKey: 'placeholder-exploration', openaiBaseUrl: 'https://example.org/v1' })
    expect(f.updateSettings).toHaveBeenCalledTimes(1)
    expect(f.getSettings()).toMatchObject({ active_model_configuration: 'model-example', model: 'example-edited' })
    expect(before.model).toBe('example-old')
  })

  it.each(['probeMain', 'probeExploration'])('keeps all settings intact when %s fails', async probe => {
    const f = fixture()
    const initial = structuredClone(f.getSettings())
    f[probe].mockResolvedValue({ ok: false, error: 'auth_failed', detail: 'example rejection' })
    await expect(activateCheckedModelSettings('model-example', {}, f)).rejects.toThrow('不可用')
    expect(f.updateSettings).not.toHaveBeenCalled()
    expect(f.getSettings()).toEqual(initial)
  })

  it('does not overwrite a concurrent settings change after checking a stale snapshot', async () => {
    const f = fixture()
    f.probeMain.mockImplementation(async () => {
      f.updateSettings({ model: 'example-concurrent' })
      return { ok: true }
    })
    await expect(activateCheckedModelSettings('model-example', {}, f)).rejects.toThrow('设置已变更')
    expect(f.getSettings().active_provider).toBe('deepseek')
    expect(f.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('rejects unavailable references without any request or write', async () => {
    const f = fixture()
    await expect(activateCheckedModelSettings('missing', {}, f)).rejects.toThrow()
    expect(f.probeMain).not.toHaveBeenCalled()
    expect(f.updateSettings).not.toHaveBeenCalled()
  })
})
