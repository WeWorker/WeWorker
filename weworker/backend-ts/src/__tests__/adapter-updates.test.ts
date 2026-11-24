import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipFile } from 'yazl'
import { buffer } from 'node:stream/consumers'
import { validatePackageFiles } from '../../../../webcli/adapter-package-files.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readDesktopAdapterCatalogInputs, toggleDesktopAdapter } from '../../../../webcli/adapter-desktop.js'
import { installAdapter } from '../../../../webcli/adapter-install-store.js'
import { createAdapterUpdateSource } from '../adapter-update-source.js'
import { createAdapterUpdates } from '../adapter-updates.js'

const service = 'https://example.com/adapterhub'
const id = 'demo.example.com'
const origin = { kind: 'hub', service } as const
let root: string

function files(version: string, match = ['example.com'], name = id) {
  return new Map([
    ['manifest.json', JSON.stringify({ schema_version: 2, name, version, match, description: 'Fixture',
      commands: [{ id: 'list', runtime: 'extension', module: 'extension/commands/list.js', description: 'List', schema: { type: 'object' } }] })],
    ['extension/commands/list.js', '// Fixture source'],
  ])
}

// The production updater reads real .adapt ZIP bytes and commits into an isolated store.
function feed(pkg = files('1.1.0'), official = true) {
  const zip = new ZipFile()
  for (const [name, text] of pkg) zip.addBuffer(Buffer.from(text), name)
  const bytes = buffer(zip.outputStream)
  zip.end()
  return { service, index: vi.fn(async () => {
    const sha256 = 'sha256:' + createHash('sha256').update(await bytes).digest('hex')
    return new Map([[id, { version: '1.1.0', official, sha256 }]])
  }), download: vi.fn(async () => bytes) }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-updates-'))
  const builtin = path.join(root, 'builtin')
  fs.mkdirSync(builtin)
  fs.writeFileSync(path.join(builtin, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: [] }))
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public')
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', builtin)
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', path.join(root, 'user'))
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', path.join(root, 'user'))
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', path.join(root, 'data'))
})
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

it('coalesces checks and updates a disabled Hub Adapter without enabling it', async () => {
  installAdapter({ files: files('1.0.0'), origin })
  expect(toggleDesktopAdapter(id)).toBe(false)
  const source = feed()
  const installed = vi.fn()
  const updater = createAdapterUpdates({ source, onInstalled: installed })
  expect(updater.snapshot().status).toBe('idle')
  const check = updater.startCheck()
  expect(updater.snapshot().status).toBe('checking')
  expect(updater.startCheck()).toBe(check)
  await check
  expect(source.index).toHaveBeenCalledTimes(1)
  expect(updater.snapshot().items[id]).toEqual({ currentVersion: '1.0.0', latestVersion: '1.1.0', status: 'available' })
  expect((await updater.apply(id, '1.1.0')).items[id].status).toBe('current')
  expect(source.download).toHaveBeenCalledWith(id, '1.1.0')
  expect(installed).toHaveBeenCalledWith(expect.objectContaining({ name: id }))
  expect(readDesktopAdapterCatalogInputs().state.selections[id]).toEqual({ source: 'disabled', resumeSource: 'user' })
  expect(toggleDesktopAdapter(id)).toBe(true)
})

it('only updates a disabled built-in from the official channel and preserves its permission boundary', async () => {
  const pkg = files('1.0.0')
  const { digest } = validatePackageFiles(pkg)
  const builtin = path.join(root, 'builtin')
  for (const [relative, content] of pkg) {
    const target = path.join(builtin, id, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  fs.writeFileSync(path.join(builtin, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [{ name: id, version: '1.0.0', digest }], legacy: [] }))
  expect(toggleDesktopAdapter(id)).toBe(false)
  const untrusted = createAdapterUpdates({ source: feed(undefined, false) })
  await untrusted.startCheck()
  expect(untrusted.snapshot().items[id].status).toBe('unlisted')
  const expanded = createAdapterUpdates({ source: feed(files('1.1.0', ['example.com', 'example.org'])) })
  await expanded.startCheck()
  await expect(expanded.apply(id, '1.1.0')).rejects.toMatchObject({ code: 'ADAPTER_PERMISSION_CHANGE' })
  const updater = createAdapterUpdates({ source: feed() })
  await updater.startCheck()
  expect((await updater.apply(id, '1.1.0')).items[id].currentVersion).toBe('1.1.0')
  expect(readDesktopAdapterCatalogInputs().state.selections[id]).toEqual({ source: 'disabled', resumeSource: 'user' })
  const untrustedAfterUpdate = createAdapterUpdates({ source: feed(undefined, false) })
  await untrustedAfterUpdate.startCheck()
  expect(untrustedAfterUpdate.snapshot().items[id].status).toBe('unlisted')
})

it('does not replace local sources or downgrade a newer installed version', async () => {
  const updater = createAdapterUpdates({ source: feed() })
  installAdapter({ files: files('1.0.0'), origin: { kind: 'generated' } })
  await updater.startCheck()
  expect(updater.snapshot().items[id].status).toBe('unsupported')
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow()
  installAdapter({ files: files('2.0.0'), origin, allowSourceChange: true })
  expect(updater.snapshot().items[id].status).toBe('local-newer')
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow()
})

it.each([
  ['different name', () => feed(files('1.1.0', undefined, 'other.example.com'))],
  ['different version', () => feed(files('1.2.0'))],
  ['permission expansion', () => feed(files('1.1.0', ['example.com', 'example.org']))],
  ['wrong checksum', () => { const source = feed(); source.download.mockResolvedValue(Buffer.from('wrong')); return source }],
] as const)('keeps the original Adapter when a package has %s', async (_label, makeSource) => {
  const original = installAdapter({ files: files('1.0.0'), origin })
  const updater = createAdapterUpdates({ source: makeSource() })
  await updater.startCheck()
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow()
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.digest).toBe(original.digest)
})

it('rejects an update if the local selection changes during download', async () => {
  const original = installAdapter({ files: files('1.0.0'), origin })
  const source = feed()
  const download = source.download.getMockImplementation()!
  source.download.mockImplementation(async () => { toggleDesktopAdapter(id); return download() })
  const updater = createAdapterUpdates({ source })
  await updater.startCheck()
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow('状态已变化')
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.digest).toBe(original.digest)
})

it('reports a failed check and retries without a stale available release', async () => {
  installAdapter({ files: files('1.0.0'), origin })
  const source = feed()
  const updater = createAdapterUpdates({ source })
  await updater.startCheck()
  source.index.mockRejectedValueOnce(new Error('network'))
  await updater.startCheck()
  expect(updater.snapshot()).toMatchObject({ status: 'error', items: {} })
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow('先检测')
  await updater.startCheck()
  expect(updater.snapshot().items[id].status).toBe('available')
})

it('reuses a matching ETag and refuses the website HTML fallback', async () => {
  const request = vi.fn<typeof fetch>()
  request.mockResolvedValueOnce(Response.json({ channel: 'desktop', items: [] }, { headers: { etag: '"index"' } }))
  request.mockResolvedValueOnce(new Response(null, { status: 304 }))
  request.mockResolvedValueOnce(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }))
  const source = createAdapterUpdateSource(service, request)
  expect(await source.index()).toEqual(new Map())
  expect(await source.index()).toEqual(new Map())
  expect(request).toHaveBeenLastCalledWith(service + '/api/v1/adapters/index?channel=desktop', expect.objectContaining({
    headers: { 'If-None-Match': '"index"' }, redirect: 'error',
  }))
  await expect(source.index()).rejects.toThrow('release index')
})
