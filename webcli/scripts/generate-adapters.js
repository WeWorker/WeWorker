#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mergeManifestToolExecution,
  withCatalogDirectExecution,
} from '../direct-execution-metadata.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const webcliRoot = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(webcliRoot, '..')
const adaptersRoot = path.join(repoRoot, 'extension', 'adapters')

function parseArgs(argv) {
  const options = { profile: 'public', write: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--config') options.config = argv[++i]
    else if (arg === '--dry-run') options.write = false
    else if (arg === '--write') options.write = true
    else if (arg === '--help') options.help = true
  }
  return options
}

function resolveRepoPath(value) {
  return path.resolve(repoRoot, value)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  return readJson(filePath)
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function uniqueBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!key) continue
    map.set(key, { ...(map.get(key) || {}), ...item })
  }
  return [...map.values()]
}

function mergeCatalogs(catalogs) {
  return {
    version: 1,
    generatedFrom: catalogs.map((catalog) => catalog.generatedFrom).filter(Boolean).join('+') || 'config',
    commands: uniqueBy(catalogs.flatMap((catalog) => catalog.commands || []), (command) => command.id),
    adapters: uniqueBy(catalogs.flatMap((catalog) => catalog.adapters || []), (adapter) => adapter.adapterId)
      .map((adapter) => ({
        ...adapter,
        commands: uniqueBy(adapter.commands || [], (command) => command.id || command.publicName || command.command),
      })),
  }
}

function mergeObjects(files) {
  return Object.assign({}, ...files.map((file) => readJsonIfExists(resolveRepoPath(file), {})))
}

function loadGenerationConfig(options) {
  const publicConfigPath = resolveRepoPath('webcli/config/adapter-generation.public.json')
  const base = readJson(options.config ? resolveRepoPath(options.config) : publicConfigPath)
  if (options.profile !== 'internal') return { ...base, profile: options.profile }

  const overlayPath = resolveRepoPath('internal/config/webcli/adapter-generation.overlay.json')
  const overlay = readJsonIfExists(overlayPath, {})
  return {
    ...base,
    ...overlay,
    profile: 'internal',
    catalogFiles: [...(base.catalogFiles || []), ...(overlay.catalogFiles || [])],
    migratedCommandFiles: [...(base.migratedCommandFiles || []), ...(overlay.migratedCommandFiles || [])],
    previousDomains: [...(base.previousDomains || []), ...(overlay.previousDomains || [])],
    adapterDisplayNames: {
      ...(base.adapterDisplayNames || {}),
      ...(overlay.adapterDisplayNames || {}),
    },
    output: {
      ...(base.output || {}),
      ...(overlay.output || {}),
    },
  }
}

function validatePublicBoundary(config, catalog, migrated) {
  if (config.profile !== 'public') return
  const denyPatterns = (config.publicDenyPatterns || []).map((pattern) => new RegExp(pattern, 'i'))
  const payload = JSON.stringify({ config, catalog, migrated })
  const matched = denyPatterns.find((pattern) => pattern.test(payload))
  if (matched) {
    throw new Error(`Public WebCLI generation config contains internal-only content matching ${matched}`)
  }
}

function buildManifest(adapter, config) {
  const sites = adapter.sites || []
  const displayName = config.adapterDisplayNames?.[adapter.adapterId] || sites.join(', ') || adapter.adapterId
  const manifest = {
    id: adapter.adapterId,
    name: displayName,
    description: `Generated adapter manifest for ${displayName}`,
    match: adapter.match || [adapter.adapterId],
    requires_auth: true,
    version: '2026-06-15T00:00:00Z',
    author: 'generated',
    generated_by: 'webcli/scripts/generate-adapters.js',
  }
  if (config.defaultAuthCheckTool) manifest.auth_check_tool = config.defaultAuthCheckTool
  return manifest
}

function buildEmptyAdapterIndex(adapter) {
  const name = `wecli-${adapter.adapterId}-blocked-adapter`
  const match = JSON.stringify(adapter.match || [adapter.adapterId])
  return `// Generated WebCLI adapter shell.\n// Commands in wecli.generated.json remain blocked until their runtime logic is ported and verified.\nwindow.__webmcpRegister({\n  name: ${JSON.stringify(name)},\n  match: ${match},\n  tools: [],\n});\n`
}

function buildBlockedReason(command, overlapsExistingAdapter) {
  const needs = []
  if (command.strategy) needs.push(`strategy=${command.strategy}`)
  if (command.browser) needs.push('browser page dependency')
  if (command.safety === 'mutating' || command.safety === 'high_risk') needs.push(`confirmation required (${command.safety})`)
  if (command.parameters?.properties?.files) needs.push('local file upload mapping required')
  if (command.sourceDomain === '') needs.push('empty source domain mapped by catalog default')
  if (overlapsExistingAdapter) needs.push('must merge without renaming existing tools')

  return `Manual runtime migration required before registration: ${needs.join(', ') || 'source command logic must be ported and verified'}.`
}

function buildSupport(adapter, overlapsExistingAdapter, migrated, explicitToolExecution = {}) {
  const commands = (adapter.commands || []).map((command) => {
    const migration = migrated[command.id]
    const publicName = migration?.publicName || command.publicName || command.id
    const execution = explicitToolExecution?.[publicName]
    return withCatalogDirectExecution({
      id: command.id,
      site: command.site,
      command: command.command,
      publicName,
      handlerName: migration?.handlerName || command.handlerName || `wecli.${command.id}`,
      adapterId: command.adapterId || adapter.adapterId,
      routeDomain: command.domain || command.routeDomain || adapter.adapterId,
      tabDomain: command.domain || command.tabDomain || adapter.adapterId,
      description: command.description,
      parameters: command.parameters,
      safety: command.safety,
      aliases: command.aliases || [],
      source: command.source,
      strategy: command.strategy || '',
      browser: Boolean(command.browser),
      navigateBefore: command.navigateBefore,
      status: migration ? 'registered' : 'blocked',
      ...(execution ? { execution } : {}),
      ...(migration
        ? { migrationNotes: migration.notes || '' }
        : { blockedReason: buildBlockedReason(command, overlapsExistingAdapter) }),
    })
  })

  return {
    version: 1,
    adapterId: adapter.adapterId,
    match: adapter.match || [adapter.adapterId],
    sites: adapter.sites || [],
    commandCount: commands.length,
    registeredCommands: commands.filter((command) => command.status === 'registered'),
    blockedCommands: commands.filter((command) => command.status === 'blocked'),
  }
}

function countBy(items, keyFn) {
  return Object.fromEntries(
    [...items.reduce((map, item) => {
      const key = keyFn(item) || 'unknown'
      map.set(key, (map.get(key) || 0) + 1)
      return map
    }, new Map())].sort(([a], [b]) => a.localeCompare(b)),
  )
}

function generate(options) {
  const config = loadGenerationConfig(options)
  const catalogFiles = config.catalogFiles || []
  const catalogs = catalogFiles.map((file) => readJsonIfExists(resolveRepoPath(file), { commands: [], adapters: [] }))
  const catalog = mergeCatalogs(catalogs)
  const migratedCommands = mergeObjects(config.migratedCommandFiles || [])
  validatePublicBoundary(config, catalog, migratedCommands)

  const outputName = config.output?.generatedSupportFile || 'wecli.generated.json'
  const previousDomains = new Set(config.previousDomains || [])
  const generated = []
  const blockedCommands = []

  for (const adapter of catalog.adapters || []) {
    const adapterId = adapter.adapterId
    if (!adapterId) continue

    const adapterDir = path.join(adaptersRoot, adapterId)
    const manifestPath = path.join(adapterDir, 'manifest.json')
    const manifestCreated = !fs.existsSync(manifestPath)
    const manifest = manifestCreated ? buildManifest(adapter, config) : readJson(manifestPath)
    const support = buildSupport(
      adapter,
      previousDomains.has(adapterId),
      migratedCommands,
      manifest.tool_execution,
    )

    if (options.write) {
      fs.mkdirSync(adapterDir, { recursive: true })
      const indexPath = path.join(adapterDir, 'index.js')
      if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, buildEmptyAdapterIndex(adapter), 'utf8')
      writeJson(path.join(adapterDir, outputName), support)
      writeJson(manifestPath, mergeManifestToolExecution(manifest, support.registeredCommands))
    }

    blockedCommands.push(...support.blockedCommands.map((command) => ({
      id: command.id,
      adapterId: command.adapterId,
      safety: command.safety,
      blockedReason: command.blockedReason,
    })))
    generated.push({
      adapterId,
      commandCount: adapter.commands?.length || 0,
      registeredCount: support.registeredCommands.length,
      blockedCount: support.blockedCommands.length,
      manifestCreated,
    })
  }

  const report = {
    version: 1,
    profile: config.profile,
    catalogFiles,
    generatedAt: new Date(0).toISOString(),
    commandCount: catalog.commands.length,
    adapterCount: generated.length,
    registeredCount: generated.reduce((sum, item) => sum + item.registeredCount, 0),
    blockedCount: generated.reduce((sum, item) => sum + item.blockedCount, 0),
    safetyLevels: countBy(catalog.commands, (command) => command.safety),
    domains: (catalog.adapters || []).map((adapter) => adapter.adapterId).sort(),
    blockedCommands: blockedCommands.sort((a, b) => a.id.localeCompare(b.id)),
    adapters: generated.sort((a, b) => a.adapterId.localeCompare(b.adapterId)),
  }

  if (options.write) {
    writeJson(resolveRepoPath(config.output?.migrationReport || 'webcli/generated/wecli-adapter-migration-report.json'), report)
  }

  return report
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log('Usage: node scripts/generate-adapters.js [--profile public|internal] [--config path] [--dry-run|--write]')
} else {
  const report = generate(options)
  console.log(`Generated WebCLI adapter support for ${report.adapterCount} adapters (${report.profile})`)
  console.log(`Blocked commands requiring manual runtime migration: ${report.blockedCount}`)
}
