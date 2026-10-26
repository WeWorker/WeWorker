import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePackageFiles } from '../../../../webcli/adapter-package-files.js'
import { installAdapter } from '../../../../webcli/adapter-install-store.js'
import { refreshDesktopAdapterSkills } from '../../../../webcli/adapter-desktop.js'
import { createWebsiteExplorationAdapterRouter } from '../website-exploration-adapters.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weworker-v2-adapter-'))
  roots.push(root)
  const builtin = join(root, 'builtin')
  mkdirSync(builtin)
  writeFileSync(join(builtin, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [] }))
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', builtin)
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', join(root, 'user'))
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', join(root, 'user'))
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public')
  const manifest = {
    schema_version: 2, name: 'demo.example.com', version: '1.0.0', description: 'Example Adapter',
    runtime_allowed_hosts: ['example.com'],
    commands: [{ id: 'read-page', runtime: 'wewright', module: 'wewright/commands/read-page.py',
      description: 'Read example page', schema: { type: 'object', properties: {} }, safety: 'read' }],
  }
  const files = new Map<string, Buffer>([
    ['manifest.json', Buffer.from(JSON.stringify(manifest) + '\n')],
    ['wewright/commands/read-page.py', Buffer.from('print("fixture")\n')],
  ])
  const pkg = validatePackageFiles(files)
  const payload = { name: pkg.name, digest: pkg.digest,
    files: Object.fromEntries([...files].map(([name, content]) => [name, content.toString('base64')])) }
  return { root, payload, files }
}

async function harness(payload: object, override?: typeof fetch) {
  const fetchAgent = override || vi.fn(async (url: string) => url.endsWith('/api/health')
    ? Response.json({ ok: true, instance_id: 'owned' })
    : Response.json(payload)) as unknown as typeof fetch
  const app = express()
  app.use(express.json())
  app.use('/api/website-exploration', createWebsiteExplorationAdapterRouter({ instanceId: 'owned', fetchAgent }))
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
  servers.push(server)
  const address = server.address() as { port: number }
  const request = (path: string, options: RequestInit = {}) => fetch(
    'http://127.0.0.1:' + address.port + '/api/website-exploration' + path, options)
  return { request, fetchAgent }
}

describe('website exploration v2 installation', () => {
  it('shows first-install permissions and applies only the reviewed digest', async () => {
    const { payload } = fixture()
    const { request } = await harness(payload)
    const review = await (await request('/toolkits/demo/install-review')).json()
    expect(review.baselineDigest).toBeNull()
    expect(review.permissions).toContain('runtime:wewright')
    const stale = await request('/toolkits/demo/install-apply', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: 'stale', acceptChanges: true }) })
    expect(stale.status).toBe(409)
    const installed = await request('/toolkits/demo/install-apply', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: review.reviewId }) })
    expect(installed.status).toBe(200)
    expect((await installed.json()).digest).toBe(payload.digest)
    const catalog = await (await request('/adapter-catalog')).json()
    expect(catalog.adapters.find((item: { name: string }) => item.name === payload.name)?.commands[0].runtime).toBe('wewright')
  })

  it('rejects a mixed package that changes retained Extension bytes', async () => {
    fixture()
    const baseManifest = { schema_version: 2, name: 'demo.example.com', version: '1.0.0',
      description: 'Example Adapter', match: ['example.com'], commands: [
        { id: 'list', runtime: 'extension', module: 'extension/commands/list.js', description: 'List', schema: { type: 'object', properties: {} } },
      ] }
    const base = new Map<string, Buffer>([
      ['manifest.json', Buffer.from(JSON.stringify(baseManifest))],
      ['extension/commands/list.js', Buffer.from('const original = true;')],
    ])
    const updatedManifest = { ...baseManifest, version: '1.0.1', commands: [...baseManifest.commands,
      { id: 'read-page', runtime: 'wewright', module: 'wewright/commands/read-page.py',
        description: 'Read', schema: { type: 'object', properties: {} } }] }
    const updated = new Map<string, Buffer>([
      ['manifest.json', Buffer.from(JSON.stringify(updatedManifest))],
      ['extension/commands/list.js', Buffer.from('const changed = true;')],
      ['wewright/commands/read-page.py', Buffer.from('print("fixture")')],
    ])
    const basePkg = validatePackageFiles(base)
    const updatedPkg = validatePackageFiles(updated)
    const encode = (files: Map<string, Buffer>) => Object.fromEntries([...files].map(([name, content]) => [name, content.toString('base64')]))
    const { request } = await harness({ name: updatedPkg.name, digest: updatedPkg.digest, files: encode(updated),
      base: { name: basePkg.name, profile: 'public', digest: basePkg.digest, files: encode(base) } })
    const review = await request('/toolkits/demo/install-review')
    expect(review.status).toBe(409)
    expect((await review.json()).detail).toContain('existing Adapter file changed')
  })

  it('reviews new Toolkit runtime permission before replacing an Extension Adapter', async () => {
    const { root } = fixture()
    const baseManifest = { schema_version: 2, name: 'demo.example.com', version: '1.0.0',
      description: 'Example Adapter', match: ['example.com'], commands: [
        { id: 'list', runtime: 'extension', module: 'extension/commands/list.js', description: 'List', schema: { type: 'object', properties: {} } },
      ] }
    const extension = Buffer.from('window.__webcliRegisterCommand("list", () => ({ok:true}));')
    const baseFiles = new Map<string, Buffer>([
      ['manifest.json', Buffer.from(JSON.stringify(baseManifest))],
      ['extension/commands/list.js', extension],
    ])
    const base = validatePackageFiles(baseFiles)
    installAdapter({ files: baseFiles, origin: { kind: 'local' }, activate: true })
    const updatedManifest = { ...baseManifest, version: '1.0.1', runtime_allowed_hosts: ['example.com'],
      commands: [...baseManifest.commands, { id: 'read-page', runtime: 'wewright',
        module: 'wewright/commands/read-page.py', description: 'Read', safety: 'read',
        schema: { type: 'object', properties: {} } }] }
    const updatedFiles = new Map<string, Buffer>([
      ['manifest.json', Buffer.from(JSON.stringify(updatedManifest))],
      ['extension/commands/list.js', extension],
      ['wewright/commands/read-page.py', Buffer.from('print("fixture")')],
    ])
    const updated = validatePackageFiles(updatedFiles)
    const encode = (files: Map<string, Buffer>) => Object.fromEntries([...files].map(([name, content]) => [name, content.toString('base64')]))
    const { request } = await harness({ name: updated.name, digest: updated.digest, files: encode(updatedFiles),
      base: { name: base.name, profile: 'public', digest: base.digest, files: encode(baseFiles) } })
    const reviewResponse = await request('/toolkits/demo/install-review')
    expect(reviewResponse.status).toBe(200)
    const review = await reviewResponse.json()
    expect(review.addedPermissions).toContain('runtime:wewright')
    expect(review.sourceChange).toBe(true)
    expect(review.baselineDigest).toBe(base.digest)
    const rejected = await request('/toolkits/demo/install-apply', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: review.reviewId }) })
    expect(rejected.status).toBe(409)
    const applied = await request('/toolkits/demo/install-apply', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: review.reviewId, acceptChanges: true }) })
    expect(applied.status).toBe(200)
    const catalog = await (await request('/adapter-catalog')).json()
    const active = catalog.adapters.find((item: { name: string }) => item.name === updated.name)
    expect(active.commands.map((command: { id: string }) => command.id)).toEqual(['list', 'read-page'])
    expect(active.digest).toBe(updated.digest)
    refreshDesktopAdapterSkills(join(root, 'skills'))
    const skill = readFileSync(join(root, 'skills', 'webcli-demo.example.com', 'SKILL.md'), 'utf8')
    expect(skill).toContain('demo.example.com.list')
    expect(skill).toContain('demo.example.com.read-page')
    expect(skill).toContain('Runtime: Extension')
    expect(skill).toContain('Runtime: Toolkit')
  })
})

describe('website exploration Tool deletion', () => {
  it('removes one generated command while retaining another', async () => {
    const { root, files } = fixture()
    const manifest = JSON.parse(files.get('manifest.json')!.toString())
    manifest.commands.push({ ...manifest.commands[0], id: 'read-other', module: 'wewright/commands/read-other.py' })
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
    files.set('wewright/commands/read-other.py', Buffer.from('print("other")'))
    installAdapter({ files, origin: { kind: 'generated' }, activate: true })
    const { request } = await harness({})
    const before = await (await request('/adapter-catalog')).json()
    const adapter = before.adapters.find((item: { name: string }) => item.name === manifest.name)
    expect(adapter.canDeleteGeneratedCommands).toBe(true)
    const deleted = await request(`/adapters/${manifest.name}/commands/read-page`, { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDigest: adapter.digest }) })
    expect(deleted.status).toBe(200)
    expect((await deleted.json()).uninstalled).toBe(false)
    const after = await (await request('/adapter-catalog')).json()
    expect(after.adapters.find((item: { name: string }) => item.name === manifest.name).commands.map((item: { id: string }) => item.id)).toEqual(['read-other'])
    refreshDesktopAdapterSkills(join(root, 'skills'))
    const skill = readFileSync(join(root, 'skills', 'webcli-demo.example.com', 'SKILL.md'), 'utf8')
    expect(skill).toContain('demo.example.com.read-other')
    expect(skill).not.toContain('demo.example.com.read-page')
  })

  it('uninstalls the generated Adapter when its only command is deleted', async () => {
    const { root, files } = fixture()
    installAdapter({ files, origin: { kind: 'generated' }, activate: true })
    const { request } = await harness({})
    const before = await (await request('/adapter-catalog')).json()
    const deleted = await request('/adapters/demo.example.com/commands/read-page', { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDigest: before.adapters[0].digest }) })
    expect(deleted.status).toBe(200)
    expect((await deleted.json()).uninstalled).toBe(true)
    expect((await (await request('/adapter-catalog')).json()).adapters).toEqual([])
    refreshDesktopAdapterSkills(join(root, 'skills'))
    expect(existsSync(join(root, 'skills', 'webcli-demo.example.com'))).toBe(false)
  })

  it('does not remove commands from a non-generated installation', async () => {
    const { files } = fixture()
    installAdapter({ files, origin: { kind: 'local' }, activate: true })
    const { request } = await harness({})
    const before = await (await request('/adapter-catalog')).json()
    expect(before.adapters[0].canDeleteGeneratedCommands).toBe(false)
    const deleted = await request('/adapters/demo.example.com/commands/read-page', { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDigest: before.adapters[0].digest }) })
    expect(deleted.status).toBe(409)
    expect((await (await request('/adapter-catalog')).json()).adapters[0].digest).toBe(before.adapters[0].digest)
  })

  it('removes both the draft and the installed command after one confirmation', async () => {
    const { files } = fixture()
    installAdapter({ files, origin: { kind: 'generated' }, activate: true })
    let visible = true
    let committed = false
    const fetchAgent = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/api/health')) return Response.json({ ok: true, instance_id: 'owned' })
      if (url.endsWith('/api/toolkits/demo')) return Response.json({ name: 'demo.example.com' })
      if (url.endsWith('/api/toolkits/demo/tools/read_page')) return Response.json({ tool_id: 'read_page' })
      if (url.endsWith('/delete-prepare')) { visible = false; return Response.json({ transaction_id: 'a'.repeat(32) }) }
      if (url.endsWith('/delete-finish')) {
        const restore = JSON.parse(String(options?.body)).restore
        visible = restore
        committed = !restore
        return Response.json({ ok: true })
      }
      throw new Error('Unexpected agent call: ' + url)
    }) as unknown as typeof fetch
    const { request } = await harness({}, fetchAgent)
    const before = await (await request('/adapter-catalog')).json()
    const deleted = await request('/toolkits/demo/tools/read_page', { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDigest: before.adapters[0].digest }) })
    expect(deleted.status).toBe(200)
    expect(visible).toBe(false)
    expect(committed).toBe(true)
    expect((await (await request('/adapter-catalog')).json()).adapters).toEqual([])
  })

  it('restores a staged Tool if the installed Adapter changes before removal', async () => {
    const { files } = fixture()
    installAdapter({ files, origin: { kind: 'generated' }, activate: true })
    const calls: string[] = []
    const fetchAgent = vi.fn(async (url: string, options?: RequestInit) => {
      calls.push(url)
      if (url.endsWith('/api/health')) return Response.json({ ok: true, instance_id: 'owned' })
      if (url.endsWith('/api/toolkits/demo')) return Response.json({ name: 'demo.example.com' })
      if (url.endsWith('/api/toolkits/demo/tools/read_page')) return Response.json({ tool_id: 'read_page' })
      if (url.endsWith('/delete-prepare')) {
        installAdapter({ files, origin: { kind: 'generated' }, activate: true })
        return Response.json({ transaction_id: 'a'.repeat(32) })
      }
      if (url.endsWith('/delete-finish')) {
        expect(JSON.parse(String(options?.body)).restore).toBe(true)
        return Response.json({ ok: true })
      }
      throw new Error('Unexpected agent call: ' + url)
    }) as unknown as typeof fetch
    const { request } = await harness({}, fetchAgent)
    const before = await (await request('/adapter-catalog')).json()
    const deleted = await request('/toolkits/demo/tools/read_page', { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedDigest: before.adapters[0].digest }) })
    expect(deleted.status).toBe(409)
    expect(calls.some(url => url.endsWith('/delete-finish'))).toBe(true)
    expect((await (await request('/adapter-catalog')).json()).adapters[0].commands[0].id).toBe('read-page')
  })
})
