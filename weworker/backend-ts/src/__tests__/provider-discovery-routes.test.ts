import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { importDiscoveredProviders, publicDiscoveredProviders } from '../provider-discovery.js'
import { publicModelConfigurations, savedModelConfigurationKey } from '../model-configurations.js'
import type { Settings } from '../config.js'

const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
function fixture() {
  let state = { active_provider: 'anthropic', api_key: 'fixture-current-key', model_configurations: {} } as Settings
  const discoverLocalProviders = vi.fn(async () => ({ providers: [{ sourceId: 'fixture-source', product: 'Claude Code',
    configuration: { name: 'Claude Code', provider_id: 'custom', model: 'fixture-model',
      api_key: 'fixture-imported-key', base_url: 'https://example.com', auth_type: 'api_key',
      external_source_id: 'fixture-source' } }, { sourceId: 'fixture-second', product: 'Codex',
    configuration: { name: 'Codex', provider_id: 'custom', model: 'fixture-second-model',
      api_key: 'fixture-second-key', base_url: 'https://example.org', auth_type: 'auth_token',
      external_source_id: 'fixture-second' } }], issues: [] }))
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
  const updateSettings = vi.fn(patch => { state = { ...state, ...patch }; return state })
  const context = vm.createContext({
    discoverLocalProviders, importDiscoveredProviders, publicDiscoveredProviders, savedModelConfigurationKey, getSettings: () => state, updateSettings,
    buildSettingsResponse: (settings: Settings) => ({ providers: publicModelConfigurations(settings) }),
    app: { post: (url: string, handler: any) => routes.set(url, handler) },
  })
  const from = source.indexOf('async function detectLocalProviders(')
  const to = source.indexOf("app.post('/settings/provider/add'", from)
  vm.runInContext(ts.transpileModule(source.slice(from, to), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const switchFrom = source.indexOf("app.post('/settings/extensions/model-discovery'")
  const switchTo = source.indexOf("app.post('/settings/permissions'", switchFrom)
  vm.runInContext(ts.transpileModule(source.slice(switchFrom, switchTo), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis(), setHeader: vi.fn() })
  return { context, discoverLocalProviders, updateSettings, routes, response, state: () => state }
}

describe('provider discovery API and startup', () => {
  it('reveals the saved configuration key rather than rescanning a changed source', async () => {
    const f = fixture()
    f.state().model_configurations = { 'model-fixture': {
      provider_id: 'custom', api_key: 'fixture-saved-edited-key', openai_api_key: 'fixture-exploration-key',
    } as any }
    const route = f.routes.get('/settings/provider/reveal-key')!
    const res = f.response()
    await route({ body: { provider: 'model-fixture' } }, res)
    expect(res.json).toHaveBeenCalledWith({ api_key: 'fixture-saved-edited-key' })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    const exploration = f.response()
    await route({ body: { provider: 'model-fixture', target: 'webwright' } }, exploration)
    expect(exploration.json).toHaveBeenCalledWith({ api_key: 'fixture-exploration-key' })
    expect(f.discoverLocalProviders).not.toHaveBeenCalled()
    expect(f.updateSettings).not.toHaveBeenCalled()
  })

  it('rejects built-in keys, ambiguous requests, invalid targets and missing configurations', async () => {
    const f = fixture()
    const route = f.routes.get('/settings/provider/reveal-key')!
    for (const body of [{ provider: 'builtin' }, { provider: 'missing' },
      { provider: 'anthropic', target: 'other' }, { provider: 'anthropic', source_id: 'fixture-source' }]) {
      const res = f.response()
      await route({ body }, res)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json.mock.calls[0][0]).not.toHaveProperty('api_key')
    }
    const empty = f.response()
    await route({ body: { provider: 'anthropic' } }, empty)
    expect(empty.status).toHaveBeenCalledWith(404)
    f.state().api_key_anthropic = 'fixture-legacy-key'
    const legacy = f.response()
    await route({ body: { provider: 'anthropic' } }, legacy)
    expect(legacy.json).toHaveBeenCalledWith({ api_key: 'fixture-legacy-key' })
    expect(f.discoverLocalProviders).not.toHaveBeenCalled()
  })

  it('scans without writing settings or returning credentials', async () => {
    const f = fixture()
    const res = f.response()
    await f.routes.get('/settings/provider/detect')!({}, res)
    expect(f.updateSettings).not.toHaveBeenCalled()
    const data = res.json.mock.calls[0][0]
    expect(data.candidates).toHaveLength(2)
    expect(data.candidates[0]).toMatchObject({ source_id: 'fixture-source', imported: false })
    expect(JSON.stringify(data)).not.toContain('fixture-imported-key')
    expect(JSON.stringify(data)).not.toContain('fixture-second-key')
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('imports only the selected source and handles concurrent duplicate requests once', async () => {
    const f = fixture()
    const responses = [f.response(), f.response()]
    await Promise.all(responses.map(res => f.routes.get('/settings/provider/import')!({ body: { source_id: 'fixture-source', api_key: 'fixture-untrusted-key' } }, res)))
    expect(f.updateSettings).toHaveBeenCalledOnce()
    expect(Object.keys(f.state().model_configurations!)).toHaveLength(1)
    expect(responses[0].json.mock.calls[0][0].imported_provider).toBe('model-discovered-fixture-source')
    expect(responses[1].json.mock.calls[0][0].imported_provider).toBe('model-discovered-fixture-source')
    expect(Object.values(f.state().model_configurations!)[0].api_key).toBe('fixture-imported-key')
    expect(f.state().active_provider).toBe('anthropic')
    expect(JSON.stringify(responses.map(res => res.json.mock.calls))).not.toContain('fixture-imported-key')
    expect(responses[0].setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    const scan = f.response()
    await f.routes.get('/settings/provider/detect')!({}, scan)
    expect(scan.json.mock.calls[0][0].candidates[0].imported).toBe(true)
    expect(scan.json.mock.calls[0][0].candidates[1].imported).toBe(false)
  })

  it('rejects missing or stale source IDs without importing any configuration', async () => {
    const f = fixture()
    const invalid = f.response()
    await f.routes.get('/settings/provider/import')!({ body: {} }, invalid)
    expect(invalid.status).toHaveBeenCalledWith(400)
    expect(f.discoverLocalProviders).not.toHaveBeenCalled()
    const stale = f.response()
    await f.routes.get('/settings/provider/import')!({ body: { source_id: 'fixture-gone' } }, stale)
    expect(stale.status).toHaveBeenCalledWith(404)
    expect(f.updateSettings).not.toHaveBeenCalled()
  })

  it('persists only boolean startup discovery settings', async () => {
    const f = fixture()
    const route = f.routes.get('/settings/extensions/model-discovery')!
    const invalid = f.response()
    await route({ body: { model_discovery_enabled: 'false' } }, invalid)
    expect(invalid.status).toHaveBeenCalledWith(400)
    expect(f.updateSettings).not.toHaveBeenCalled()
    for (const enabled of [false, true]) {
      await route({ body: { model_discovery_enabled: enabled } }, f.response())
      expect(f.state().model_discovery_enabled).toBe(enabled)
    }
  })

  it('does not return filesystem errors or credential values', async () => {
    const f = fixture()
    f.discoverLocalProviders.mockRejectedValueOnce(new Error('fixture-sensitive-path-and-key'))
    const res = f.response()
    await f.routes.get('/settings/provider/detect')!({}, res)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ detail: '自动识别暂时失败，请稍后重试' })
    expect(f.updateSettings).not.toHaveBeenCalled()
  })

  it.each([undefined, true, false])('honors the startup discovery switch (%s) and tolerates scanning failures', async enabled => {
    const order: string[] = []
    const context = vm.createContext({
      initSettings: async () => order.push('init'),
      detectLocalProviders: async () => { order.push('detect'); throw new Error('fixture failure') },
      store: { ensureScheduledTaskHistoryProject: () => ({ project: null }) }, getSettings: () => ({ model_discovery_enabled: enabled }),
      startConfiguredChannels: async () => order.push('channels'),
      app: { listen: (_port: unknown, _host: unknown, callback: () => void) => { order.push('listen'); callback() } },
      PORT: 0, log: { info: vi.fn() }, scheduler: { start: () => order.push('scheduler') },
    })
    const from = source.indexOf('async function bootstrap():')
    const to = source.indexOf('\nbootstrap().catch', from)
    vm.runInContext(ts.transpileModule(source.slice(from, to), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText, context)
    await context.bootstrap()
    expect(order).toEqual(enabled === false ? ['init', 'channels', 'listen', 'scheduler'] : ['init', 'detect', 'channels', 'listen', 'scheduler'])
  })
})
