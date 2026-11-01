import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseAllAdapters, clearAdapterCache } from '../adapter-parser.js'
import { resolveToolsForAdapter } from '../adapter-tool-list.js'
import { getSiteEnabled } from '../config.js'
import { buildLoadedSkillContext } from '../skill-context.js'
import { buildEnabledSkillIndex } from '../context/runtime-context.js'
import { getDesktopAdapterCatalog, refreshDesktopAdapterSkillsIfStale } from '../adapter-catalog-cache.js'
import { describeDesktopAdapters, toggleDesktopAdapter, refreshDesktopAdapterSkills } from '../../../../webcli/adapter-desktop.js'
// @ts-expect-error Shared JavaScript installation implementation, exercised directly with temporary fixtures.
import { installAdapter, selectAdapter, removeInstalledAdapter } from '../../../../webcli/adapter-install-store.js'

// Config is the input; shared runtime tests must also work with variant defaults.
vi.mock('../../../default-site.json', () => ({
  default: [{ id: 'second.example.com', enabled: false }, 'missing.example.com', { id: 'first.example.com', enabled: true }],
}))

let root: string
const files = (version = '1.0.0', id = 'list') => new Map([
  ['manifest.json', JSON.stringify({ schema_version: 2, name: 'demo', version, description: 'Fixture', match: ['example.com'],
    i18n: { zh: { name: '示例' } }, commands: [{ id, runtime: 'extension', module: `extension/commands/${id}.js`,
      description: 'Fixture command', schema: { type: 'object', properties: { count: { type: 'integer' } } } }] })],
  [`extension/commands/${id}.js`, 'fixture source'],
])
function install(version?: string, id?: string) { return installAdapter({ files: files(version, id), origin: { kind: 'local' } }) }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-adapter-'))
  vi.stubEnv('WEWORKER_RESOURCES_PATH', path.join(root, 'resources'))
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public')
  const builtinDir = path.join(root, 'builtin')
  fs.mkdirSync(builtinDir, { recursive: true })
  fs.writeFileSync(path.join(builtinDir, '.profile.json'), JSON.stringify({
    schema_version: 1,
    profile: 'public',
    adapters: [],
    legacy: [],
  }))
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', builtinDir)
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', path.join(root, 'user'))
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', path.join(root, 'user'))
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', path.join(root, 'data'))
  const old = path.join(root, 'resources/extension/adapters/demo')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Old fixture', match: ['example.com'] }))
  fs.writeFileSync(path.join(old, 'index.js'), "window.__webmcpRegister({tools:[{name:'demo.obsolete',description:'Old'}]});")
  clearAdapterCache()
})
afterEach(() => { clearAdapterCache(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

describe('desktop Adapter catalog and Skill continuity', () => {
  it('uses the selected package icon through updates, disable and removal', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" fill="#2563eb"/></svg>'
    const pkg = files()
    const manifest = JSON.parse(pkg.get('manifest.json')!)
    manifest.iconUrl = 'https://example.com/untrusted.png'
    pkg.set('manifest.json', JSON.stringify(manifest))
    pkg.set('icon.svg', svg)
    installAdapter({ files: pkg, origin: { kind: 'local' } })
    const expected = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    expect(parseAllAdapters().get('demo')?.iconUrl).toBe(expected)
    toggleDesktopAdapter('demo')
    expect(parseAllAdapters().get('demo')?.iconUrl).toBe(expected)
    toggleDesktopAdapter('demo')
    const updated = files('1.1.0')
    updated.set('icon.svg', svg.replace('#2563eb', '#0f766e'))
    installAdapter({ files: updated, origin: { kind: 'local' } })
    expect(parseAllAdapters().get('demo')?.iconUrl).not.toBe(expected)
    installAdapter({ files: files('1.2.0'), origin: { kind: 'local' } })
    expect(parseAllAdapters().get('demo')?.iconUrl).toBeUndefined()
    removeInstalledAdapter('demo')
    expect(parseAllAdapters().get('demo')?.iconUrl).toBeUndefined()
  })

  it('applies default-site priority after merging managed and legacy adapters', () => {
    // Managed inventory sorts these alphabetically; presentation must follow the JSON.
    for (const name of ['first.example.com', 'second.example.com', 'extra.example.com']) {
      const pkg = files()
      const manifest = JSON.parse(pkg.get('manifest.json')!)
      manifest.name = name
      manifest.match = [name.replaceAll('.', '-') + '.example.com']
      pkg.set('manifest.json', JSON.stringify(manifest))
      installAdapter({ files: pkg, origin: { kind: 'local' } })
    }
    const adapters = parseAllAdapters()
    expect([...adapters.keys()]).toEqual([
      'second.example.com', 'first.example.com', 'demo', 'extra.example.com',
    ])
    // Configured but absent sites are skipped; disabled metadata stays available to management.
    expect(adapters.has('missing.example.com')).toBe(false)
    toggleDesktopAdapter('second.example.com')
    const updated = parseAllAdapters()
    expect([...updated.keys()]).toEqual([...adapters.keys()])
    expect(updated.get('second.example.com')?.managed?.enabled).toBe(false)
  })

  it('retains compatible names as metadata on a single canonical tool', () => {
    const pkg = files('1.0.0', 'list-items')
    const manifest = JSON.parse(pkg.get('manifest.json')!)
    manifest.commands[0].aliases = ['list_items']
    pkg.set('manifest.json', JSON.stringify(manifest))
    installAdapter({ files: pkg, origin: { kind: 'local' } })
    const adapter = parseAllAdapters().get('demo')!
    expect(resolveToolsForAdapter(adapter, null)).toHaveLength(1)
    expect(adapter.tools[0]).toMatchObject({ name: 'demo.list-items', aliases: ['demo.list_items'] })
  })

  it('derives background capability only from the selected package command', () => {
    const pkg = files()
    const manifest = JSON.parse(pkg.get('manifest.json')!)
    manifest.commands[0].execution = { type: 'api', runtime: 'background' }
    pkg.set('manifest.json', JSON.stringify(manifest))
    installAdapter({ files: pkg, origin: { kind: 'local' } })
    const adapter = parseAllAdapters().get('demo')!
    expect(resolveToolsForAdapter(adapter, null)[0]).toMatchObject({
      name: 'demo.list', directCapable: true, executionMode: 'direct', execution: { type: 'api', runtime: 'background' },
    })
    selectAdapter('demo', 'disabled')
    expect(resolveToolsForAdapter(parseAllAdapters().get('demo')!, null)).toEqual([])
  })

  it('replaces a cached legacy description and follows updates without a cache reset', () => {
    expect(parseAllAdapters().get('demo')?.name).toBe('Old fixture')
    const first = install()
    const adapter = parseAllAdapters().get('demo')!
    expect(adapter.name).toBe('示例')
    expect(adapter.managed?.digest).toBe(first.digest)
    expect(resolveToolsForAdapter(adapter, path.join(root, 'resources/extension/adapters')).map(tool => tool.name)).toEqual(['demo.list'])
    const second = install('1.1.0', 'updated')
    expect(parseAllAdapters().get('demo')?.managed?.digest).toBe(second.digest)
    expect(parseAllAdapters().get('demo')?.tools.map(tool => tool.name)).toEqual(['demo.updated'])
  })

  it('keeps disabled entries visible to management without restoring legacy tools', () => {
    install()
    expect(toggleDesktopAdapter('demo')).toBe(false)
    const disabled = parseAllAdapters().get('demo')!
    expect(disabled.tools).toEqual([])
    expect(disabled.managed).toMatchObject({ enabled: false, canEnable: true, source: 'user' })
    expect(getSiteEnabled('demo', true, disabled.managed?.enabled)).toBe(false)
    expect(toggleDesktopAdapter('demo')).toBe(true)
    const enabled = parseAllAdapters().get('demo')!
    expect(getSiteEnabled('demo', false, enabled.managed?.enabled)).toBe(true)
    expect(enabled.tools.map(tool => tool.name)).toEqual(['demo.list'])
  })

  it('quarantines damaged or removed packages while retaining management diagnostics', () => {
    const installed = install()
    fs.writeFileSync(path.join(installed.executionRoot, 'extension/commands/list.js'), 'changed')
    const damaged = parseAllAdapters().get('demo')!
    expect(damaged.tools).toEqual([])
    expect(damaged.managed?.diagnostics).toContain('ADAPTER_CONTENT_CHANGED')
    expect(() => toggleDesktopAdapter('demo')).toThrow(/cannot be enabled/)
    removeInstalledAdapter('demo')
    expect(parseAllAdapters().get('demo')?.tools).toEqual([])
    expect(describeDesktopAdapters().managedNames.has('demo')).toBe(true)
    expect(parseAllAdapters().get('demo')?.managed).toMatchObject({ enabled: false, canEnable: false })
    expect(() => toggleDesktopAdapter('demo')).toThrow(/cannot be enabled/)
  })

  it('invalidates replayed Skill context immediately after package update, even before disk refresh', () => {
    install()
    const target = path.join(root, 'skills')
    refreshDesktopAdapterSkills(target)
    const directory = path.join(target, 'webcli-demo')
    const source = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')
    const messages = [{ content: [{ type: 'skill_context', name: 'webcli-demo', directory,
      digest: createHash('sha256').update(source).digest('hex'), text: 'old fixture instructions', tool_use_id: 'fixture-call' }] }]
    expect(buildLoadedSkillContext(messages, [target])).toContain('old fixture instructions')
    expect(buildEnabledSkillIndex(target)).toContain('webcli-demo')
    install('1.1.0', 'updated')
    expect(buildLoadedSkillContext(messages, [target])).toBe('')
    expect(buildEnabledSkillIndex(target)).toBe('')
    refreshDesktopAdapterSkills(target)
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toContain('demo.updated')
    selectAdapter('demo', 'disabled')
    refreshDesktopAdapterSkills(target)
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).not.toContain('webcli call')
    expect(buildEnabledSkillIndex(target)).toBe('')
  })

  it('preserves unowned same-name files without treating them as current managed guidance', () => {
    install()
    const target = path.join(root, 'skills'), directory = path.join(target, 'webcli-demo')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'SKILL.md'), '# User-owned fixture')
    expect(refreshDesktopAdapterSkills(target).preserved).toEqual(['demo'])
    expect(buildEnabledSkillIndex(target)).toBe('')
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toBe('# User-owned fixture')
  })

  it('rejects a broken state rather than returning cached legacy capability descriptions', () => {
    parseAllAdapters(); install()
    fs.writeFileSync(path.join(root, 'data/adapter-state/public/registry.json'), '{invalid')
    expect(() => parseAllAdapters()).toThrow(/inspection/)
  })

  it('shares one catalog snapshot until registry state or package files change', () => {
    const first = install()
    const snapshot = getDesktopAdapterCatalog()
    expect(getDesktopAdapterCatalog()).toBe(snapshot)
    expect(snapshot.effective.map(entry => entry.digest)).toEqual([first.digest])
    // An in-place edit of an installed snapshot is still reported without a registry change.
    parseAllAdapters()
    fs.writeFileSync(path.join(first.executionRoot, 'extension/commands/list.js'), 'changed content')
    expect(getDesktopAdapterCatalog()).not.toBe(snapshot)
    expect(parseAllAdapters().get('demo')?.managed?.diagnostics).toContain('ADAPTER_CONTENT_CHANGED')
    const second = install('1.1.0', 'updated')
    expect(getDesktopAdapterCatalog().effective.map(entry => entry.digest)).toEqual([second.digest])
    const current = getDesktopAdapterCatalog()
    clearAdapterCache()
    expect(getDesktopAdapterCatalog()).not.toBe(current)
  })

  it('does not rewrite unchanged managed Skill files', () => {
    install()
    const target = path.join(root, 'skills')
    const file = path.join(target, 'webcli-demo', 'SKILL.md')
    refreshDesktopAdapterSkills(target)
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(file, past, past)
    const before = fs.statSync(file).mtimeMs
    expect(refreshDesktopAdapterSkills(target, { catalog: getDesktopAdapterCatalog() }).installed).toBe(1)
    expect(fs.statSync(file).mtimeMs).toBe(before)
    install('1.1.0', 'updated')
    refreshDesktopAdapterSkills(target, { catalog: getDesktopAdapterCatalog() })
    expect(fs.statSync(file).mtimeMs).not.toBe(before)
    expect(fs.readFileSync(file, 'utf8')).toContain('demo.updated')
  })

  it('skips the per-turn Skill refresh until the catalog or managed folders change', () => {
    install()
    const target = path.join(root, 'skills')
    const directory = path.join(target, 'webcli-demo')
    expect(refreshDesktopAdapterSkillsIfStale(target).skipped).toBe(false)
    expect(refreshDesktopAdapterSkillsIfStale(target).skipped).toBe(true)
    // A removed managed Skill is restored on the next turn.
    fs.rmSync(directory, { recursive: true, force: true })
    expect(refreshDesktopAdapterSkillsIfStale(target).skipped).toBe(false)
    expect(fs.existsSync(path.join(directory, 'SKILL.md'))).toBe(true)
    install('1.1.0', 'updated')
    expect(refreshDesktopAdapterSkillsIfStale(target).skipped).toBe(false)
    expect(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')).toContain('demo.updated')
    expect(refreshDesktopAdapterSkillsIfStale(target).skipped).toBe(true)
  })
})
