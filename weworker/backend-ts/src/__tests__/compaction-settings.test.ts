import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

it('defaults compaction to 80 percent and persists the saved ratio across reloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-compaction-settings-'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  const config = await import('../config.js')
  expect(config.getSettings().compaction_ratio).toBe(80)
  expect(config.getSettings().compaction_max_attempts).toBe(3)
  config.updateSettings({ compaction_max_attempts: 5 })
  config.updateSettings({ compaction_ratio: 60 })
  config.resetSettingsStateForTests()
  expect(config.getSettings().compaction_ratio).toBe(60)
  expect(config.getSettings().compaction_max_attempts).toBe(5)
  for (const value of [0, 11, 2.5, NaN]) {
    config.updateSettings({ compaction_max_attempts: value })
    expect(config.getSettings().compaction_max_attempts).toBe(3)
  }
  config.updateSettings({ compaction_ratio: NaN })
  expect(config.getSettings().compaction_ratio).toBe(80)
})

it('validates the API ratio and saves only that setting', () => {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.post('/settings/compaction'")
  expect(start).toBeGreaterThan(0)
  const end = source.indexOf('\napp.', start + 1)
  let handler: any
  const updateSettings = vi.fn(value => value)
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { app: { post: (_: string, fn: any) => { handler = fn } }, updateSettings, buildSettingsResponse: (s: unknown) => s })
  for (const ratio of [undefined, null, '80', 0, 100, 80.5, true]) {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    handler({ body: { compaction_ratio: ratio } }, res)
    expect(res.status).toHaveBeenCalledWith(400)
  }
  expect(updateSettings).not.toHaveBeenCalled()
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  handler({ body: { compaction_ratio: 70, context_limit: 1 } }, res)
  expect(updateSettings).toHaveBeenCalledWith({ compaction_ratio: 70 })
  updateSettings.mockClear()
  for (const attempts of [null, '3', 0, 11, 1.5, true]) {
    const invalid = { status: vi.fn().mockReturnThis(), json: vi.fn() }
    handler({ body: { compaction_max_attempts: attempts } }, invalid)
    expect(invalid.status).toHaveBeenCalledWith(400)
  }
  expect(updateSettings).not.toHaveBeenCalled()
  handler({ body: { compaction_max_attempts: 4 } }, res)
  expect(updateSettings).toHaveBeenLastCalledWith({ compaction_max_attempts: 4 })
  handler({ body: { compaction_ratio: 80, compaction_max_attempts: 2 } }, res)
  expect(updateSettings).toHaveBeenLastCalledWith({ compaction_ratio: 80, compaction_max_attempts: 2 })
})
