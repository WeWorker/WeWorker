import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

import {
  selectCompatibleCaptureBoundEntry,
  validateGenerationPreviewOutputV2,
} from '../../background/generation-output-validator.js'

let migratedCommands

function loadMigratedCommands(repoRoot = process.cwd()) {
  if (!migratedCommands) {
    migratedCommands = JSON.parse(readFileSync(join(repoRoot, 'webcli', 'wecli-migrated-commands.json'), 'utf8'))
  }
  return migratedCommands
}

function defaultValidateArgs(args = {}, schema = {}) {
  const result = { ...(args || {}) }
  for (const [name, definition] of Object.entries(schema.properties || {})) {
    if (!(name in result) && Object.hasOwn(definition, 'default')) result[name] = definition.default
  }
  return result
}

export function sampleSchemaValue(name, schema = {}) {
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return sampleSchemaValue(name, schema.oneOf[0])
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return sampleSchemaValue(name, schema.anyOf[0])
  if (schema.type === 'integer' || schema.type === 'number') return Math.max(1, schema.minimum || 1)
  if (schema.type === 'boolean') return true
  if (schema.type === 'array') return [sampleSchemaValue(name, schema.items || { type: 'string' })]
  if (schema.type === 'object') return {}
  if (schema.format === 'date') return '2026-01-01'
  if (schema.format === 'date-time') return '2026-01-01T00:00:00Z'
  if (/email/i.test(name)) return 'adapter-test@example.com'
  if (/url/i.test(name)) return 'https://example.com/test'
  if (/ip/i.test(name)) return '192.0.2.1'
  return '__adapter_certification_fixture__'
}

export function minimalToolArgs(parameters = {}, { confirmed = false, dryRun = false } = {}) {
  const properties = parameters.properties || {}
  const args = Object.fromEntries((parameters.required || []).map((name) => [
    name,
    sampleSchemaValue(name, properties[name] || {}),
  ]))
  if (confirmed) args.__confirmed = true
  if (dryRun && Object.hasOwn(properties, 'dry-run')) args['dry-run'] = true
  return args
}

export function findRuntimeTool(tools, name) {
  return tools.find((tool) => tool.name === name || tool.publicName === name)
}

export async function withTimeout(promise, label, timeoutMs = 1500) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} did not settle within ${timeoutMs}ms`), {
        code: 'CERTIFICATION_TIMEOUT',
      })), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

export function runAdapterSourcesInContext(adapterId, context, options = {}) {
  const repoRoot = options.repoRoot || process.cwd()
  const adapterDir = join(repoRoot, 'extension', 'adapters', adapterId)
  const manifest = JSON.parse(readFileSync(join(adapterDir, 'manifest.json'), 'utf8'))
  const host = manifest.match?.[0] || adapterId
  const location = {
    href: manifest.homepage_url || `https://${host}/`,
    origin: `https://${host}`,
    hostname: host,
  }
  const defaultGlobals = {
    Blob,
    FormData,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Uint8Array,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    clearInterval,
    clearTimeout,
    crypto: globalThis.crypto,
    location,
    navigator: { userAgent: 'adapter-certification-test' },
    setInterval,
    setTimeout,
  }
  for (const [name, value] of Object.entries(defaultGlobals)) {
    if (context[name] === undefined) context[name] = value
  }
  if (context.window) {
    context.window.location = { ...location, ...(context.window.location || {}) }
  }

  for (const relativePath of manifest.support_files || []) {
    vm.runInContext(readFileSync(join(adapterDir, relativePath), 'utf8'), context, {
      filename: `${adapterId}/${relativePath}`,
      timeout: options.timeout || 2000,
    })
  }
  vm.runInContext(readFileSync(join(adapterDir, 'index.js'), 'utf8'), context, {
    filename: `${adapterId}/index.js`,
    timeout: options.timeout || 2000,
  })

  return manifest
}

export function findAdapterTool(adapterId, tools, name, options = {}) {
  const direct = tools.find((tool) => [tool.name, tool.publicName, tool.handlerName].includes(name))
  if (direct) return direct
  const migration = loadMigratedCommands(options.repoRoot)[name]
  if (!migration) return undefined
  const expectedNames = [migration.publicName, migration.handlerName, ...(migration.aliases || [])]
  return tools.find((tool) => expectedNames.some((expected) => (
    expected && [tool.name, tool.publicName, tool.handlerName].includes(expected)
  )))
}

export function indexAdapterTools(adapterId, tools, options = {}) {
  const indexed = {}
  for (const tool of tools) {
    for (const name of [tool.name, tool.publicName, tool.handlerName]) {
      if (name && indexed[name] === undefined) indexed[name] = tool
    }
  }
  for (const commandId of Object.keys(loadMigratedCommands(options.repoRoot))) {
    const tool = findAdapterTool(adapterId, tools, commandId, options)
    if (tool && indexed[commandId] === undefined) indexed[commandId] = tool
  }
  return indexed
}

export function runServiceWorkerInContext(context, options = {}) {
  const repoRoot = options.repoRoot || process.cwd()
  const sourcePath = join(repoRoot, 'extension', 'background', 'service-worker.js')
  const source = readFileSync(sourcePath, 'utf8').replace(
    /import\s*\{[\s\S]*?\}\s*from\s*['"]\.\/generation-output-validator\.js['"];?\s*/,
    '',
  )
  context.selectCompatibleCaptureBoundEntry = selectCompatibleCaptureBoundEntry
  context.validateGenerationPreviewOutputV2 = validateGenerationPreviewOutputV2
  vm.runInContext(source, context, {
    filename: 'service-worker.js',
    timeout: options.timeout || 5000,
  })
}

export async function loadAdapterBundle(adapterId, options = {}) {
  const repoRoot = options.repoRoot || process.cwd()
  const adapterDir = join(repoRoot, 'extension', 'adapters', adapterId)
  const manifest = JSON.parse(readFileSync(join(adapterDir, 'manifest.json'), 'utf8'))
  const registrations = []
  const runtime = {
    validateArgs: defaultValidateArgs,
    createRuntimeError(code, message, details = {}) {
      const error = new Error(message)
      error.code = code
      error.details = details
      return error
    },
    requireConfirmation(args = {}, toolName = 'tool') {
      if (args.__confirmed === true) return true
      const error = new Error(`${toolName} requires explicit user confirmation`)
      error.code = 'CONFIRMATION_REQUIRED'
      throw error
    },
    async requestPrivileged(action) {
      throw new Error(`Unexpected privileged request while loading Adapter: ${action}`)
    },
    async fetchJson(url) {
      throw new Error(`Unexpected fetch while loading Adapter: ${url}`)
    },
    ...(options.runtime || {}),
  }
  const location = {
    href: manifest.homepage_url || `https://${manifest.match?.[0] || adapterId}/`,
    origin: `https://${manifest.match?.[0] || adapterId}`,
    hostname: manifest.match?.[0] || adapterId,
  }
  const document = {
    body: {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    createElement() { return {} },
    ...(options.document || {}),
  }
  const window = {
    location,
    document,
    __webmcpWecliRuntime: runtime,
    __webmcpGeneratedSupport: {},
    __webmcpGeneratedLegacyHandlers: {},
    __webmcpRegister(payload) {
      registrations.push(payload)
    },
    ...(options.window || {}),
  }
  const sandbox = {
    Blob,
    Date,
    Error,
    FormData,
    JSON,
    Map,
    Promise,
    Set,
    String,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Uint8Array,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    clearInterval,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    crypto: globalThis.crypto,
    document,
    fetch: async (url) => { throw new Error(`Unexpected fetch while loading Adapter: ${url}`) },
    location,
    navigator: { userAgent: 'adapter-certification-test' },
    setInterval,
    setTimeout,
    window,
    ...(options.globals || {}),
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)

  runAdapterSourcesInContext(adapterId, context, { repoRoot, timeout: options.timeout })
  await new Promise((resolvePromise) => setImmediate(resolvePromise))

  return {
    adapterId,
    context,
    manifest,
    registrations,
    tools: registrations.flatMap((registration) => registration.tools || []),
  }
}
