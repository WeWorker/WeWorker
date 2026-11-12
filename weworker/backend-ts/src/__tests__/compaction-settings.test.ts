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
  config.updateSettings({ compaction_ratio: 60 })
  config.resetSettingsStateForTests()
  expect(config.getSettings().compaction_ratio).toBe(60)
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
})
