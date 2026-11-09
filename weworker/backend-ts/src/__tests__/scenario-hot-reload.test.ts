import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyRouterConfigBundle } from '../router-config/types.js'

const mocks = vi.hoisted(() => ({
  adaptersDir: '',
  adapters: new Map<string, unknown>(),
  bundle: null as unknown,
  signature: 'config-1',
  clearSnapshot: vi.fn(),
}))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => mocks.adapters }))
vi.mock('../adapter-tool-list.js', () => ({
  findAdaptersDirectory: () => mocks.adaptersDir,
  resolveToolsForAdapter: (adapter: { tools: unknown[] }) => adapter.tools,
}))
vi.mock('../adapter-catalog-cache.js', () => ({ clearDesktopAdapterCatalogCache: mocks.clearSnapshot }))
vi.mock('../config.js', () => ({ getSiteEnabled: () => true, getSettings: () => ({}) }))
vi.mock('../router-config/loader.js', () => ({ loadRouterConfig: () => ({ bundle: mocks.bundle, signature: mocks.signature }) }))

import { catalogSignature, getCatalog, resetToolCatalogCacheForTests } from '../api-query-router/tool-catalog.js'
import { getRouteEngine, resetRouteEngineForTests } from '../api-query-router/index.js'
import { loadScenarioRoutes, resetScenarioRoutesCacheForTests } from '../api-query-router/scenario-routes.js'

const tool = { name: 'list', safety: 'read', requiresConfirmation: false,
  execution: { type: 'api', runtime: 'background' }, parameters: { properties: {} } }
const scenario = (text: string) => ({ id: 'list', title: 'List', summary: 'List', prompts: [{ text }],
  route: { tool: 'example.com.list', args: {} } })
let tmp = ''
function configure(text: string) {
  mocks.adapters = new Map([['example.com', {
    id: 'example.com', defaultEnabled: true, tools: [tool], registryScenarios: [scenario(text)],
  }]])
}
function updateManifest(text: string) {
  fs.writeFileSync(path.join(tmp, 'example.com', 'manifest.json'), JSON.stringify({ text }))
  configure(text)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-hot-reload-'))
  fs.mkdirSync(path.join(tmp, 'example.com'))
  mocks.adaptersDir = tmp
  mocks.signature = 'config-1'
  mocks.bundle = emptyRouterConfigBundle()
  mocks.clearSnapshot.mockClear()
  updateManifest('List examples')
  resetToolCatalogCacheForTests()
  resetScenarioRoutesCacheForTests()
  resetRouteEngineForTests()
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('scenario routes reload from live Adapter declarations', () => {
  it('notices an in-place manifest edit and rebuilds same-count scenario matchers', () => {
    const first = getRouteEngine()
    expect(first.matchers.scenario.match('List examples')).toEqual({ tool: 'example.com.list', args: {} })
    const before = catalogSignature()
    updateManifest('List samples')
    expect(catalogSignature()).not.toBe(before)
    const next = getRouteEngine()
    expect(next).not.toBe(first)
    expect(next.matchers.scenario.match('List examples')).toBeNull()
    expect(next.matchers.scenario.match('List samples')).toEqual({ tool: 'example.com.list', args: {} })
    expect(mocks.clearSnapshot).toHaveBeenCalled()
  })

  it('prefers live Adapter declarations over a stale bundled generated route', () => {
    const bundle = emptyRouterConfigBundle()
    bundle.scenarioRoutes.routes = [{ adapter: 'example.com', scenarioId: 'list', tool: 'example.com.list',
      patterns: [{ regex: '^Obsolete$' }], args: {}, slotNames: [], promptTemplates: ['Obsolete'] }]
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'bundled' }]
    mocks.bundle = bundle
    expect(getRouteEngine().matchers.scenario.match('Obsolete')).toBeNull()
    expect(getRouteEngine().matchers.scenario.match('List examples')).not.toBeNull()
  })

  it('does not resurrect a stale packaged route when the live manifest removes all scenarios', () => {
    const bundle = emptyRouterConfigBundle()
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'bundled' }]
    bundle.scenarioRoutes.routes = [{ adapter: 'example.com', scenarioId: 'list', tool: 'example.com.list',
      patterns: [{ regex: '^Packaged$' }], args: {}, slotNames: [], promptTemplates: ['Packaged'] }]
    mocks.bundle = bundle
    const adapter = mocks.adapters.get('example.com') as { registryScenarios: unknown[] }
    adapter.registryScenarios = []
    expect(loadScenarioRoutes()).toEqual([])
  })

  it('keeps a packaged route when a catalogued Adapter has no live declarations', () => {
    const bundle = emptyRouterConfigBundle()
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'bundled' }]
    bundle.scenarioRoutes.routes = [{ adapter: 'example.com', scenarioId: 'list', tool: 'example.com.list',
      patterns: [{ regex: '^Packaged$' }], args: {}, slotNames: [], promptTemplates: ['Packaged'] }]
    mocks.bundle = bundle
    // The tool remains installed, but this package profile omits its manifest
    // scenarios. Rebuilding from live declarations must not discard the artifact.
    const adapter = mocks.adapters.get('example.com') as { registryScenarios: unknown[] }
    adapter.registryScenarios = []
    fs.rmSync(path.join(tmp, 'example.com', 'manifest.json'))
    expect(loadScenarioRoutes()).toHaveLength(1)
    expect(getRouteEngine().matchers.scenario.match('Packaged')).not.toBeNull()
  })

  it('honors disabled and explicitly empty user route layers', () => {
    const bundle = emptyRouterConfigBundle()
    bundle.manifest.layers = { scenarioRoutes: false }
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'default', rejected: 'disabled by manifest.layers.scenarioRoutes' }]
    mocks.bundle = bundle
    expect(loadScenarioRoutes()).toEqual([])
    bundle.manifest.layers = {}
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'user' }]
    mocks.signature = 'config-2'
    expect(loadScenarioRoutes()).toEqual([])
  })

  it('rebuilds matchers when a user override changes without changing route count or timestamp', () => {
    const bundle = emptyRouterConfigBundle()
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'user' }]
    bundle.scenarioRoutes.generatedAt = 'unchanged'
    const override = (text: string) => ({ adapter: 'example.com', scenarioId: 'list',
      tool: 'example.com.list', patterns: [{ regex: `^${text.replace(/\s+/g, '')}$` }],
      args: {}, slotNames: [], promptTemplates: [text] })
    bundle.scenarioRoutes.routes = [override('User first')]
    mocks.bundle = bundle
    mocks.signature = 'override-1'
    const first = getRouteEngine()
    expect(loadScenarioRoutes()).toHaveLength(1)
    expect(first.matchers.scenario.match('User first')).not.toBeNull()
    bundle.scenarioRoutes.routes = [override('User later')]
    mocks.signature = 'override-2'
    const next = getRouteEngine()
    expect(next).not.toBe(first)
    expect(next.matchers.scenario.match('User first')).toBeNull()
    expect(next.matchers.scenario.match('User later')).not.toBeNull()
  })

  it('drops cross-adapter targets and orphaned opt-outs from user overrides', () => {
    const bundle = emptyRouterConfigBundle()
    bundle.sources = [{ layer: 'scenarioRoutes', origin: 'user' }]
    bundle.scenarioRoutes.routes = [
      { adapter: 'example.com', scenarioId: 'foreign', tool: 'other.com.list',
        patterns: [{ regex: '^Foreign$' }], args: {}, slotNames: [], promptTemplates: ['Foreign'] },
      { adapter: 'missing.com', scenarioId: 'optout', optout: true, reason: 'Not routable',
        patterns: [{ regex: '^Missing$' }], slotNames: [], promptTemplates: ['Missing'] },
    ]
    mocks.bundle = bundle
    const other = { ...(mocks.adapters.get('example.com') as Record<string, unknown>), id: 'other.com' }
    mocks.adapters.set('other.com', other)
    expect(loadScenarioRoutes()).toEqual([])
  })

  it('drops a route if its current tool becomes unsafe', () => {
    expect(loadScenarioRoutes()).toHaveLength(1)
    const adapter = mocks.adapters.get('example.com') as { tools: Array<typeof tool> }
    adapter.tools = [{ ...tool, safety: 'write' }]
    updateManifest('List samples')
    ;(mocks.adapters.get('example.com') as { tools: Array<typeof tool> }).tools = adapter.tools
    expect(loadScenarioRoutes()).toEqual([])
    expect(getCatalog().tools[0].safety).toBe('write')
  })
})
