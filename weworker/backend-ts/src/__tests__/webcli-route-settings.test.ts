import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

it('defaults WebCLI routing on and persists an explicit opt-out without changing the older router flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-route-settings-'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.resetModules()
  const config = await import('../config.js')
  expect(config.getSettings().webcli_route_enabled).toBe(true)
  const olderFlag = config.getSettings().api_query_llm_route
  config.updateSettings({ webcli_route_enabled: true })
  config.resetSettingsStateForTests()
  expect(config.getSettings().webcli_route_enabled).toBe(true)
  expect(config.getSettings().api_query_llm_route).toBe(olderFlag)
  config.updateSettings({ webcli_route_enabled: false })
  config.resetSettingsStateForTests()
  expect(config.getSettings().webcli_route_enabled).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(root, '.weworker/settings.json'), 'utf8')).webcli_route_enabled).toBe(false)
})

it('defaults routing on for absent or malformed saved values but preserves an explicit opt-out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-route-settings-'))
  fs.mkdirSync(path.join(root, '.weworker'))
  fs.writeFileSync(path.join(root, '.weworker/settings.json'), JSON.stringify({ webcli_route_enabled: 'false' }))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.resetModules()
  const config = await import('../config.js')
  expect(config.getSettings().webcli_route_enabled).toBe(true)
  config.updateSettings({ webcli_route_enabled: false })
  config.resetSettingsStateForTests()
  expect(config.getSettings().webcli_route_enabled).toBe(false)
})

it('settings API rejects non-booleans and persists only the requested extension option', () => {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.post('/settings/extensions/webcli-route'")
  const end = source.indexOf("app.post('/settings/permissions'", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  let settings = { webcli_route_enabled: false, api_query_llm_route: true }
  let handler: (req: { body: unknown }, res: any) => void = () => { throw new Error('route not registered') }
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    app: { post: (_path: string, callback: typeof handler) => { handler = callback } },
    updateSettings: (patch: Partial<typeof settings>) => (settings = { ...settings, ...patch }),
    buildSettingsResponse: (value: typeof settings) => value,
  })
  for (const body of [null, {}, { webcli_route_enabled: 'true' }, { webcli_route_enabled: 1 }]) {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    handler({ body }, response)
    expect(response.status).toHaveBeenCalledWith(400)
    expect(settings.webcli_route_enabled).toBe(false)
  }
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  handler({ body: { webcli_route_enabled: true, api_query_llm_route: false } }, response)
  expect(response.json).toHaveBeenCalledWith({ webcli_route_enabled: true, api_query_llm_route: true })
  handler({ body: { webcli_route_enabled: false } }, response)
  expect(settings.webcli_route_enabled).toBe(false)
})
