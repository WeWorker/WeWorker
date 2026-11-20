import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it.each(['/settings/provider', '/settings/provider/activate'])('uses checked activation and returns failures without writing through %s', async path => {
  let handler: (req: any, res: any) => Promise<void>
  const before = { active_provider: 'builtin' }
  const patch = { model_configurations: { example: {} } }
  const prepareCheckedModelSave = vi.fn(async () => patch)
  const activateCheckedModelSettings = vi.fn(async (..._args: unknown[]) => { throw new Error('example unavailable') })
  const updateSettings = vi.fn()
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf(`app.post('${path}',`)
  const end = source.indexOf('\napp.post(', start + 1)
  const fallback = source.indexOf('\ntype ProviderRequestBody', start)
  const stop = path.endsWith('activate') ? fallback : end
  vm.runInNewContext(ts.transpileModule(source.slice(start, stop), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    app: { post: (_path: string, callback: any) => { handler = callback } },
    Error, getSettings: () => before, updateSettings, prepareCheckedModelSave, activateCheckedModelSettings,
    buildSettingsResponse: (value: unknown) => value,
  })
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  const body = { provider: 'example', activate: true }
  await handler!({ body }, res)
  expect(res.status).toHaveBeenCalledWith(400)
  expect(res.json.mock.calls[0][0]).toEqual({ detail: 'example unavailable', model_checks: [] })
  expect(updateSettings).not.toHaveBeenCalled()
  expect(activateCheckedModelSettings.mock.calls[0][0]).toBe('example')
  if (path === '/settings/provider') {
    expect(prepareCheckedModelSave).toHaveBeenCalledWith(before, 'example', body)
    expect(activateCheckedModelSettings.mock.calls[0][1]).toBe(patch)
  }
})
