import { expect, it } from 'vitest'
import { getProvider } from '../provider-registry.js'
import { updatePresetConfiguration, getModelConfiguration, activateModelConfiguration } from '../model-configurations.js'
import { extractSecrets, clearSecretsOnDisk, applySecrets } from '../settings-secrets.js'
import type { Settings } from '../config.js'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { vi } from 'vitest'
import { PROVIDERS } from '../provider-registry.js'
import { updateModelConfiguration, publicModelConfigurations } from '../model-configurations.js'

it.each(['openai', 'qwen'])('saves and activates %s through encrypted model configurations', id => {
  const initial = { model_configurations: {}, active_provider: 'builtin' } as Settings
  const state = { ...initial, ...updatePresetConfiguration(initial, id, { api_key: 'placeholder-provider-key', model: 'example-model', context_limit: '128K' }) }
  const config = getModelConfiguration(state, id)!
  expect(config.weworker_protocol).toBe('openai_chat_completions')
  expect(config.base_url).toBe(getProvider(id)!.weworker.baseUrl)
  const active = activateModelConfiguration(state, id)
  expect(active).toMatchObject({ active_provider: id, model: 'example-model', active_weworker_protocol: 'openai_chat_completions', api_key: 'placeholder-provider-key' })
  const disk = clearSecretsOnDisk(state)
  expect(disk.model_configurations![id].api_key).toBe('')
  expect(applySecrets(disk, extractSecrets(state)).model_configurations![id].api_key).toBe('placeholder-provider-key')
  expect(initial.model_configurations).toEqual({})
})

it.each(['openai', 'qwen'])('accepts first and subsequent saves of %s through the settings route', async id => {
  let state = { model_configurations: {}, active_provider: 'builtin' } as Settings
  const handlers = new Map<string, (req: any, res: any) => Promise<void>>()
  const updateSettings = vi.fn(patch => (state = { ...state, ...patch }))
  const context = vm.createContext({
    app: { post: (path: string, handler: any) => handlers.set(path, handler) },
    getSettings: () => state, updateSettings, getModelConfiguration, updateModelConfiguration,
    updatePresetConfiguration, ALLOWED_PROVIDER_IDS: new Set(PROVIDERS.map(p => p.id)),
    buildSettingsResponse: (s: Settings) => ({ providers: publicModelConfigurations(s) }),
    automaticWorkshopUpdate: async () => ({}),
  })
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.post('/settings/provider',")
  const end = source.indexOf('\napp.post(', start + 1)
  vm.runInContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  for (const model of ['example-first', 'example-second']) {
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    await handlers.get('/settings/provider')!({ body: { provider: id, api_key: 'placeholder-key', model } }, res)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json.mock.calls[0][0].providers[id]).toMatchObject({ model, has_key: true, provider_id: id })
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('placeholder-key')
  }
  expect(updateSettings).toHaveBeenCalledTimes(2)
  expect(state.active_provider).toBe('builtin')
})
