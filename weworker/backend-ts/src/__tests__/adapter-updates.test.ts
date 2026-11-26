import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ZipFile } from 'yazl'
import { buffer } from 'node:stream/consumers'
import { validatePackageFiles } from '../../../../webcli/adapter-package-files.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { describeDesktopAdapters, readDesktopAdapterCatalogInputs, toggleDesktopAdapter } from '../../../../webcli/adapter-desktop.js'
import { installAdapter } from '../../../../webcli/adapter-install-store.js'
import { createAdapterUpdateSource } from '../adapter-update-source.js'
import { adapterUpdateErrorMessage, createAdapterUpdates } from '../adapter-updates.js'

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
  const release = async () => ({ version: '1.1.0', official, uploader: official ? '官方' : 'example-user',
    sha256: 'sha256:' + createHash('sha256').update(await bytes).digest('hex') })
  const catalog = vi.fn(async () => [{ name: id, version: '1.1.0', official, release: await release() }])
  return { service, index: vi.fn(async () => new Map([[id, await release()]])), catalog,
    catalogPage: vi.fn(async (page: number) => ({ items: await catalog(), page, hasMore: false })),
    detail: vi.fn(async (name: string) => ({ name, commands: [] })),
    download: vi.fn(async () => bytes) }
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

it('reads Hub detail and commands from the configured remote source', async () => {
  const request = vi.fn<typeof fetch>(async url => {
    const endpoint = String(url)
    if (endpoint === `${service}/api/v1/adapters/${id}`) return Response.json({ name: id, origin: 'user', publishedBy: 'example-publisher', author: 'example-owner', domains: ['example.com'], scenarios: [] })
    if (endpoint === `${service}/api/v1/adapters/${id}/commands`) return Response.json({ items: [{ commandName: 'list' }] })
    throw new Error('Unexpected request')
  })
  const updater = createAdapterUpdates({ source: createAdapterUpdateSource(service, request) })
  await expect(updater.detail(id)).resolves.toMatchObject({ name: id, uploader: 'example-publisher', domains: ['example.com'], commands: [{ commandName: 'list' }] })
  expect(request).toHaveBeenCalledTimes(2)
})

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
  expect(source.download).toHaveBeenCalledWith(id, '1.1.0', expect.any(Function))
  expect(updater.updateTransfer()).toBeNull()
  expect(installed).toHaveBeenCalledWith(expect.objectContaining({ name: id }))
  expect(readDesktopAdapterCatalogInputs().state.selections[id]).toEqual({ source: 'disabled', resumeSource: 'user' })
  expect(toggleDesktopAdapter(id)).toBe(true)
})

it('reports real bytes for an installed Adapter update and clears failed transfers', async () => {
  installAdapter({ files: files('1.0.0'), origin })
  const source = feed()
  const download = vi.fn<ReturnType<typeof createAdapterUpdateSource>['download']>(async (_id, _version, report) => {
    report?.({ received: 760, total: 1000, elapsedMs: 500, bytesPerSecond: 1520 })
    throw new Error('Interrupted download')
  })
  const updater = createAdapterUpdates({ source: { ...source, download } })
  await updater.startCheck()
  const result = updater.apply(id, '1.1.0')
  expect(updater.updateTransfer()).toMatchObject({ name: id, status: 'downloading', receivedBytes: 760, totalBytes: 1000 })
  await expect(result).rejects.toThrow('Interrupted download')
  expect(updater.updateTransfer()).toBeNull()
})

it('accepts permission changes from the official channel and keeps a disabled built-in disabled', async () => {
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
  expect((await expanded.apply(id, '1.1.0')).items[id].currentVersion).toBe('1.1.0')
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.grants).toContain('host:example.org')
  expect(readDesktopAdapterCatalogInputs().state.selections[id]).toEqual({ source: 'disabled', resumeSource: 'user' })
  const untrustedAfterUpdate = createAdapterUpdates({ source: feed(undefined, false) })
  await untrustedAfterUpdate.startCheck()
  expect(untrustedAfterUpdate.snapshot().items[id].status).toBe('unlisted')
})

it('accepts permission changes when updating an installed package from Hub', async () => {
  installAdapter({ files: files('1.0.0'), origin })
  const updater = createAdapterUpdates({ source: feed(files('1.1.0', ['example.com', 'example.org'])) })
  await expect(updater.installFromHub(id, '1.1.0')).resolves.toEqual({ name: id, version: '1.1.0' })
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.grants).toContain('host:example.org')
  expect(describeDesktopAdapters().adapters.find(adapter => adapter.id === id)?.uploader).toBe('官方')
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
  ['wrong checksum', () => { const source = feed(); source.download.mockResolvedValue(Buffer.from('wrong')); return source }],
] as const)('keeps the original Adapter when a package has %s', async (_label, makeSource) => {
  const original = installAdapter({ files: files('1.0.0'), origin })
  const updater = createAdapterUpdates({ source: makeSource() })
  await updater.startCheck()
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow()
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.digest).toBe(original.digest)
})

it('explains a Hub install domain conflict and permits retry after disabling the conflicting Adapter', async () => {
  const existing = 'existing.example.com'
  installAdapter({ files: files('1.0.0', ['example.com'], existing), origin })
  const updater = createAdapterUpdates({ source: feed() })
  const error = await updater.installFromHub(id, '1.1.0').catch(cause => cause)
  expect(error).toMatchObject({ code: 'ADAPTER_DOMAIN_CONFLICT' })
  expect(adapterUpdateErrorMessage(error)).toContain('站点匹配规则与已启用的 Adapter 冲突')
  expect(readDesktopAdapterCatalogInputs().state.installations[id]).toBeUndefined()
  expect(toggleDesktopAdapter(existing)).toBe(false)
  await expect(updater.installFromHub(id, '1.1.0')).resolves.toEqual({ name: id, version: '1.1.0' })
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
  source.catalog.mockRejectedValueOnce(new Error('network'))
  await updater.startCheck()
  expect(updater.snapshot()).toMatchObject({ status: 'error', items: {} })
  await expect(updater.apply(id, '1.1.0')).rejects.toThrow('先检测')
  await updater.startCheck()
  expect(updater.snapshot().items[id].status).toBe('available')
})

it('lists and installs the selected Hub release, then reports it installed', async () => {
  const source = feed()
  const installed = vi.fn()
  const updater = createAdapterUpdates({ source, onInstalled: installed })
  expect(await updater.listHub()).toMatchObject([{ name: id, version: '1.1.0', action: 'install' }])
  await expect(updater.installFromHub(id, '1.0.0')).rejects.toThrow('不可安装')
  expect(source.download).not.toHaveBeenCalled()
  expect(await updater.installFromHub(id, '1.1.0')).toEqual({ name: id, version: '1.1.0' })
  expect(await updater.listHub()).toMatchObject([{ name: id, installedVersion: '1.1.0', action: null }])
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.origin).toEqual(origin)
  expect(installed).toHaveBeenCalledOnce()
})

it('runs three Hub downloads, reports progress, and drains the queue in order after failure', async () => {
  const names = Array.from({ length: 5 }, (_, i) => `queued-${i}.example.com`)
  const fixtures = new Map(await Promise.all(names.map(async name => {
    const bytes = await feed(files('1.1.0', [name], name)).download()
    const release = { version: '1.1.0', official: true, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }
    return [name, { bytes, release }] as const
  })))
  const gates = new Map<string, () => void>()
  const source = {
    ...createAdapterUpdateSource(service),
    catalog: async () => [...fixtures].map(([name, { release }]) => ({ name, ...release, release })),
    download: vi.fn<ReturnType<typeof createAdapterUpdateSource>['download']>(async (name, _version, report) => {
      report?.({ received: 512, total: 1024, elapsedMs: 500, bytesPerSecond: 1024 })
      await new Promise<void>(resolve => gates.set(name, resolve))
      if (name === names[0]) throw new Error('fixture transfer failed')
      return fixtures.get(name)!.bytes
    }),
  }
  const updater = createAdapterUpdates({ source })
  const jobs = names.map(name => updater.installFromHub(name, '1.1.0'))
  const results = Promise.allSettled(jobs)
  await expect(updater.installFromHub(names[3], '1.1.0')).rejects.toThrow('已在下载队列')
  await vi.waitFor(() => expect([...gates.keys()]).toEqual(names.slice(0, 3)))
  expect(updater.hubTransfers()).toMatchObject([
    ...names.slice(0, 3).map(name => ({ name, status: 'downloading', receivedBytes: 512, totalBytes: 1024, bytesPerSecond: 1024, elapsedMs: 500 })),
    ...names.slice(3).map((name, index) => ({ name, status: 'queued', queuePosition: index + 1 })),
  ])
  gates.get(names[0])!()
  await vi.waitFor(() => expect([...gates.keys()]).toEqual(names.slice(0, 4)))
  gates.get(names[1])!()
  await vi.waitFor(() => expect([...gates.keys()]).toEqual(names))
  for (const name of names.slice(2)) gates.get(name)!()
  const settled = await results
  expect(settled.slice(1).flatMap(result => result.status === 'rejected' ? [String(result.reason)] : [])).toEqual([])
  expect(settled[0].status).toBe('rejected')
  expect(updater.hubTransfers()).toEqual([])
})

it('blocks replacing local packages or installing a mismatched Hub archive', async () => {
  const source = feed(files('1.1.0', undefined, 'other.example.com'))
  const updater = createAdapterUpdates({ source })
  await expect(updater.installFromHub(id, '1.1.0')).rejects.toThrow('名称或版本')
  expect(readDesktopAdapterCatalogInputs().state.installations[id]).toBeUndefined()
  const original = installAdapter({ files: files('1.0.0'), origin: { kind: 'generated' } })
  expect(await updater.listHub()).toMatchObject([{ name: id, installedVersion: '1.0.0', action: null }])
  await expect(updater.installFromHub(id, '1.1.0')).rejects.toThrow('不可安装')
  expect(readDesktopAdapterCatalogInputs().state.installations[id]?.digest).toBe(original.digest)
})

it('reads the WebCLI catalog across pages and keeps placeholders read-only', async () => {
  const digest = 'sha256:' + 'a'.repeat(64)
  const item = { name: id, display: 'Demo', version: '1.1.0', origin: 'official', publisherRole: 'admin',
    installable: true, artifact: { sha256: digest } }
  const request = vi.fn<typeof fetch>()
  request.mockResolvedValueOnce(Response.json({ page: 1, pageSize: 1, total: 2, items: [item] }))
  request.mockResolvedValueOnce(Response.json({ page: 2, pageSize: 1, total: 2, items: [
    { ...item, name: 'placeholder.example.com', installable: false },
  ] }))
  const source = createAdapterUpdateSource(service, request)
  expect(await source.catalog()).toMatchObject([
    { name: id, displayName: 'Demo', release: { sha256: digest, official: true } },
    { name: 'placeholder.example.com' },
  ])
  expect(request.mock.calls[1][0]).toBe(service + '/api/v1/adapters?page_size=100&page=2&sort=name')
  expect(request).toHaveBeenCalledTimes(2)
})

it('falls back to a trusted catalog and applies a newer version from it', async () => {
  installAdapter({ files: files('1.0.0'), origin })
  const source = feed()
  source.index.mockRejectedValueOnce(new Error('old Hub'))
  const updater = createAdapterUpdates({ source })
  await updater.startCheck()
  expect(updater.snapshot().items[id]).toMatchObject({ latestVersion: '1.1.0', status: 'available' })
  expect((await updater.apply(id, '1.1.0')).items[id].status).toBe('current')
})

it('tries HTTPS and falls back to the configured HTTP Hub for catalog and release downloads', async () => {
  const endpoint = 'http://example.com/hub'
  installAdapter({ files: files('1.0.0'), origin: { kind: 'hub', service: endpoint } })
  const archive = await feed().download()
  const digestForArchive = 'sha256:' + createHash('sha256').update(archive).digest('hex')
  const releaseEntry = { name: id, version: '1.1.0', origin: 'official', publisherRole: 'admin', installable: true, artifact: { sha256: digestForArchive } }
  const request = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('TLS unavailable'))
    .mockResolvedValueOnce(Response.json({ page: 1, pageSize: 100, total: 1,
      items: [releaseEntry],
    }))
    .mockResolvedValueOnce(Response.json({ page: 1, pageSize: 100, total: 1,
      items: [releaseEntry],
    }))
    .mockResolvedValueOnce(new Response(new Uint8Array(archive)))
  const updater = createAdapterUpdates({ source: createAdapterUpdateSource(endpoint, request) })
  expect(await updater.listHub()).toMatchObject([{ name: id, action: 'update', version: '1.1.0' }])
  await expect(updater.installFromHub(id, '1.1.0')).resolves.toMatchObject({ name: id, version: '1.1.0' })
  expect(request.mock.calls.map(call => String(call[0]))).toEqual([
    'https://example.com/hub/api/v1/adapters?page_size=100&page=1&sort=name',
    'http://example.com/hub/api/v1/adapters?page_size=100&page=1&sort=name',
    'http://example.com/hub/api/v1/adapters?page_size=100&page=1&sort=name',
    `http://example.com/hub/api/v1/adapters/${id}/download?version=1.1.0`,
  ])
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
