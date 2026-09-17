import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadAdapterTools } from './adapter-cli.js'
import { isApiBackgroundExecution } from './direct-execution-metadata.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(moduleDir, '..')
const validSafetyClasses = new Set(['read', 'sensitive_read', 'mutating', 'high_risk'])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadGeneratedSafety(adapterDir) {
  const generatedPath = join(adapterDir, 'wecli.generated.json')
  if (!existsSync(generatedPath)) return new Map()
  const generated = readJson(generatedPath)
  return new Map((generated.registeredCommands || []).map((command) => [
    command.publicName,
    command.safety || 'unknown',
  ]))
}

function loadCatalogMetadata(repoRoot) {
  const catalogPath = join(repoRoot, 'webcli', 'wecli-command-catalog.json')
  const migratedPath = join(repoRoot, 'webcli', 'wecli-migrated-commands.json')
  if (!existsSync(catalogPath) || !existsSync(migratedPath)) return new Map()
  const catalog = readJson(catalogPath)
  const migrated = readJson(migratedPath)
  const commandById = new Map((catalog.commands || []).map((command) => [command.id, command]))
  const byPublicName = new Map()
  for (const [commandId, migration] of Object.entries(migrated)) {
    const command = commandById.get(commandId)
    if (!command || !migration?.publicName) continue
    byPublicName.set(migration.publicName, {
      ...command,
      ...migration,
      parameters: command.parameters,
    })
  }
  return byPublicName
}

function normalizeParameters(tool) {
  if (tool.parameters?.type === 'object') return tool.parameters
  const params = Array.isArray(tool.params) ? tool.params : []
  return {
    type: 'object',
    properties: Object.fromEntries(params.map((parameter) => [parameter.name, {
      type: parameter.type || 'string',
      ...(parameter.description ? { description: parameter.description } : {}),
      ...(Array.isArray(parameter.enum) ? { enum: parameter.enum } : {}),
    }])),
    required: params.filter((parameter) => parameter.required).map((parameter) => parameter.name),
  }
}

function validateParameters(adapterId, toolName, parameters) {
  const errors = []
  if (parameters?.type !== 'object') {
    errors.push(`${adapterId}/${toolName}: parameters.type must be object`)
    return errors
  }
  if (!parameters.properties || typeof parameters.properties !== 'object' || Array.isArray(parameters.properties)) {
    errors.push(`${adapterId}/${toolName}: parameters.properties must be an object`)
    return errors
  }
  if (parameters.required !== undefined && !Array.isArray(parameters.required)) {
    errors.push(`${adapterId}/${toolName}: parameters.required must be an array`)
    return errors
  }
  for (const requiredName of parameters.required || []) {
    if (!Object.hasOwn(parameters.properties, requiredName)) {
      errors.push(`${adapterId}/${toolName}: required parameter "${requiredName}" is not declared`)
    }
  }
  return errors
}

function loadTestSources(repoRoot) {
  const testDir = join(repoRoot, 'extension', 'test')
  if (!existsSync(testDir)) return new Map()
  return new Map(readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => [name, readFileSync(join(testDir, name), 'utf8')]))
}

function findTestFiles(testSources, tokens) {
  const usableTokens = tokens.filter((token) => typeof token === 'string' && token.length > 0)
  return [...testSources.entries()]
    .filter(([, source]) => usableTokens.some((token) => source.includes(token)))
    .map(([name]) => name)
    .sort()
}

export async function loadShippedApiInventory({ repoRoot = defaultRepoRoot } = {}) {
  const profilePath = join(repoRoot, 'weworker', 'build-profile.json')
  const adaptersRoot = join(repoRoot, 'extension', 'adapters')
  const extensionIndex = new Set(readJson(join(adaptersRoot, 'index.json')))
  const profile = readJson(profilePath)
  const adapterIds = Array.isArray(profile.adapters) ? profile.adapters : []
  const errors = []
  const adapters = []
  const catalogByPublicName = loadCatalogMetadata(repoRoot)
  const testSources = loadTestSources(repoRoot)
  const seenAdapterIds = new Set()
  const seenToolNames = new Set()

  for (const adapterId of adapterIds) {
    if (seenAdapterIds.has(adapterId)) {
      errors.push(`duplicate build-profile Adapter: ${adapterId}`)
      continue
    }
    seenAdapterIds.add(adapterId)

    const adapterDir = join(adaptersRoot, adapterId)
    const manifestPath = join(adapterDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      errors.push(`${adapterId}: manifest.json is missing`)
      continue
    }
    if (!extensionIndex.has(adapterId)) {
      errors.push(`${adapterId}: missing from extension/adapters/index.json`)
    }

    const manifest = readJson(manifestPath)
    if (manifest.id !== adapterId) {
      errors.push(`${adapterId}: manifest id is "${manifest.id || ''}"`)
    }
    const registeredTools = await loadAdapterTools(adapterId, { adapterDir })
    const toolByName = new Map(registeredTools.map((tool) => [tool.name, tool]))
    const safetyByName = loadGeneratedSafety(adapterDir)
    const declaredApiByName = new Map(Object.entries(manifest.tool_execution || {})
      .filter(([, execution]) => isApiBackgroundExecution(execution)))
    const registeredApiByName = new Map(registeredTools
      .filter((tool) => isApiBackgroundExecution(tool.execution)
        || tool.directCapable === true
        || tool.executionMode === 'direct')
      .map((tool) => [tool.name, tool]))
    const apiToolNames = [...new Set([
      ...declaredApiByName.keys(),
      ...registeredApiByName.keys(),
    ])].sort((left, right) => left.localeCompare(right))
    const tools = []

    for (const toolName of apiToolNames) {
      const execution = declaredApiByName.get(toolName)
        || registeredApiByName.get(toolName)?.execution
        || { type: 'api', runtime: 'background' }
      const tool = toolByName.get(toolName)
      const catalogTool = catalogByPublicName.get(toolName)
      if (!tool) {
        errors.push(`${adapterId}/${toolName}: API tool is missing from WebCLI static discovery`)
      } else if (!declaredApiByName.has(toolName)) {
        errors.push(`${adapterId}/${toolName}: direct API tool is missing manifest tool_execution`)
      }
      if (seenToolNames.has(toolName)) {
        errors.push(`duplicate API tool registration: ${toolName}`)
      }
      seenToolNames.add(toolName)
      const parameters = tool
        ? normalizeParameters(tool)
        : (catalogTool?.parameters || { type: 'object', properties: {}, required: [] })
      errors.push(...validateParameters(adapterId, toolName, parameters))
      const safety = tool?.safety || safetyByName.get(toolName) || catalogTool?.safety || 'unknown'
      if (!validSafetyClasses.has(safety)) {
        errors.push(`${adapterId}/${toolName}: missing or invalid safety metadata`)
      }
      tools.push({
        name: toolName,
        catalogId: catalogTool?.id || null,
        webcliDiscoverable: Boolean(tool),
        handlerName: tool?.handlerName || catalogTool?.handlerName || toolName,
        routeDomain: tool?.routeDomain || catalogTool?.routeDomain || manifest.match?.[0] || adapterId,
        parameters,
        safety,
        requiresConfirmation: tool?.requiresConfirmation === true,
        execution,
        testFiles: findTestFiles(testSources, [toolName, catalogTool?.id]),
      })
    }

    if (tools.length > 0) {
      adapters.push({
        id: adapterId,
        name: manifest.name || adapterId,
        tools,
        testFiles: findTestFiles(testSources, [adapterId]),
      })
    }
  }

  const safety = {}
  const allTools = adapters.flatMap((adapter) => adapter.tools)
  for (const tool of allTools) {
    safety[tool.safety] = (safety[tool.safety] || 0) + 1
  }

  return {
    schemaVersion: 1,
    scope: 'shipped-extension-api-background-tools',
    adapterCount: adapters.length,
    toolCount: adapters.reduce((count, adapter) => count + adapter.tools.length, 0),
    webcliDiscoverableToolCount: adapters.flatMap((adapter) => adapter.tools).filter((tool) => tool.webcliDiscoverable).length,
    webcliDiscoveryGapCount: adapters.flatMap((adapter) => adapter.tools).filter((tool) => !tool.webcliDiscoverable).length,
    executionMetadataGapCount: errors.filter((error) => error.endsWith('direct API tool is missing manifest tool_execution')).length,
    referencedByTestCount: allTools.filter((tool) => tool.testFiles.length > 0).length,
    noTestReferenceCount: allTools.filter((tool) => tool.testFiles.length === 0).length,
    safety,
    errors,
    adapters,
  }
}

export function assertValidShippedApiInventory(inventory) {
  if (inventory.errors.length > 0) {
    throw new Error(`API Adapter inventory is invalid:\n${inventory.errors.map((error) => `- ${error}`).join('\n')}`)
  }
  return inventory
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const inventory = await loadShippedApiInventory()
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
  if (inventory.errors.length > 0) process.exitCode = 1
}
