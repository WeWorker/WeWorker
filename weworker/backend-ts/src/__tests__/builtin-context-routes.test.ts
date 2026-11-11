import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { isBuiltinProvider, publicBuiltinProviders, resolveBuiltinSettings } from '../builtin-provider.js'
import { parseContextLimit } from '../context-window.js'
import { PROVIDERS } from '../provider-registry.js'
import type { Settings } from '../config.js'

const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
function fixture(active = 'builtin') {
  let state = { active_provider: active, context_limit: 1000000, builtin_context_limits: {} } as Settings
  let handler: (req: unknown, res: unknown) => void
  const updateSettings = vi.fn(patch => {
    state = resolveBuiltinSettings({ ...state, ...patch }, PROVIDERS)
    return state
  })
  const context = vm.createContext({
    app: { post: (_path: string, callback: typeof handler) => { handler = callback } },
    getSettings: () => state, updateSettings, isBuiltinProvider, parseContextLimit,
    getModelConfiguration: () => undefined,
    renameModelConfiguration: () => ({ provider_names: { builtin: 'Fixture model' } }),
    ALLOWED_PROVIDER_IDS: new Set(PROVIDERS.map(provider => provider.id)),
    buildSettingsResponse: (settings: Settings) => ({ context_limit: settings.context_limit,
      providers: publicBuiltinProviders(PROVIDERS, {}, settings.builtin_context_limits) }),
  })
  const from = source.indexOf("app.post('/settings/provider',")
  const to = source.indexOf('\napp.post(', from + 1)
  vm.runInContext(ts.transpileModule(source.slice(from, to), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() })
  return { call: (body: unknown, res: unknown) => handler({ body }, res), response, updateSettings, state: () => state }
}

describe('built-in context settings API', () => {
  it.each(['builtin', 'anthropic'])('saves an override when %s is active and returns consistent metadata', active => {
    const f = fixture(active)
    const res = f.response()
    f.call({ provider: 'builtin', name: 'Fixture model', context_limit: '128K' }, res)
    expect(res.status).not.toHaveBeenCalled()
    expect(f.state().builtin_context_limits).toEqual({ builtin: 128000 })
    expect(res.json.mock.calls[0][0].providers.builtin.context_limit).toBe(128000)
    expect(f.state().context_limit).toBe(active === 'builtin' ? 128000 : 1000000)
  })

  it.each(['', '200', 'invalid', 0, 100000001, null])('rejects invalid context windows (%s) without saving', value => {
    const f = fixture()
    const res = f.response()
    f.call({ provider: 'builtin', context_limit: value }, res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(f.updateSettings).not.toHaveBeenCalled()
  })

  it.each(['api_key', 'base_url', 'model', 'auth_type', 'openai_api_key'])('keeps deployment field %s locked', field => {
    const f = fixture()
    const res = f.response()
    f.call({ provider: 'builtin', context_limit: '128K', [field]: 'fixture-value' }, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(f.updateSettings).not.toHaveBeenCalled()
  })
})
