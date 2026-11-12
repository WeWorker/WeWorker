import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const BASE32 = 'abcdefghjkmnpqrstuvwxyz23456789'
const FIXED_TIME = new Date('1980-01-01T00:00:00Z')
const MAX_FILES = 512
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024

export function createHubId(scope, exists = () => false) {
  const prefix = scope === 'site' ? 's-' : scope === 'command' ? 'c-' : null
  if (!prefix) throw new Error(`Unsupported Hub ID scope: ${scope}`)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(8)
    let suffix = ''
    for (let i = 0; i < 8; i += 1) suffix += BASE32[bytes[i] % BASE32.length]
    const id = `${prefix}${suffix}`
    if (!exists(id)) return id
  }
  throw new Error('Unable to allocate a unique Hub ID')
}

export function sha256(input) {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`
}

export function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '')
  if (!raw || raw.includes('/') || raw.includes('\\') || /\s/.test(raw)) {
    throw new Error('Invalid primary domain')
  }
  return raw
}

export function normalizeCommandName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid command name')
  return name
}

function safePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || path.posix.isAbsolute(name)) return false
  const normalized = path.posix.normalize(name)
  return normalized === name && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../')
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  return strToU8(String(value))
}

export function createAdapt(files) {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right))
  if (!entries.some(([name]) => name === 'manifest.json')) throw new Error('manifest.json is required')
  if (entries.length > MAX_FILES) throw new Error('Too many files in adapt package')
  let total = 0
  const archive = {}
  for (const [name, value] of entries) {
    if (!safePath(name)) throw new Error(`Unsafe package path: ${name}`)
    const bytes = asBytes(value)
    total += bytes.length
    if (total > MAX_EXPANDED_BYTES) throw new Error('Adapt package is too large')
    archive[name] = [bytes, { mtime: FIXED_TIME }]
  }
  return Buffer.from(zipSync(archive, { level: 9 }))
}

export function readAdapt(input) {
  let unpacked
  try {
    unpacked = unzipSync(new Uint8Array(input))
  } catch {
    throw new Error('Invalid .adapt archive')
  }
  const names = Object.keys(unpacked).sort()
  if (names.length > MAX_FILES) throw new Error('Too many files in adapt package')
  let total = 0
  const files = new Map()
  for (const name of names) {
    if (!safePath(name)) throw new Error(`Unsafe package path: ${name}`)
    const bytes = unpacked[name]
    total += bytes.length
    if (total > MAX_EXPANDED_BYTES) throw new Error('Adapt package is too large')
    if (files.has(name)) throw new Error(`Duplicate package path: ${name}`)
    files.set(name, bytes)
  }
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw new Error('manifest.json is required')
  let manifest
  try { manifest = JSON.parse(strFromU8(manifestBytes)) } catch { throw new Error('manifest.json is invalid JSON') }
  validateManifest(manifest, files)
  return { manifest, files, sha256: sha256(input), expandedBytes: total }
}

function validateHubId(id, prefix) {
  if (!new RegExp(`^${prefix}-[${BASE32}]{8}$`).test(String(id || ''))) throw new Error(`Invalid ${prefix} Hub ID`)
}

export function validateManifest(manifest, files = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be an object')
  if ('schema_version' in manifest) throw new Error('Hub manifest must not contain schema_version')
  if ('adapter_type' in manifest || 'entry' in manifest) throw new Error('Hub manifest must not contain root execution fields')
  if (!['site', 'command', 'base'].includes(manifest.scope)) throw new Error('Invalid manifest scope')

  if (manifest.scope === 'site' || manifest.scope === 'base') {
    validateHubId(manifest.hub_id, 's')
    normalizeDomain(manifest.domain)
    if (!manifest.runtimes || typeof manifest.runtimes !== 'object') throw new Error('runtimes is required')
    const names = new Set()
    for (const tool of manifest.tools || []) {
      validateHubId(tool.hub_id, 'c')
      const commandName = normalizeCommandName(tool.command_name)
      if (names.has(commandName)) throw new Error(`Duplicate command name: ${commandName}`)
      names.add(commandName)
      if (!['extension', 'toolkit'].includes(tool.runtime)) throw new Error('Invalid command runtime')
      if (!safePath(tool.module)) throw new Error(`Unsafe command module: ${tool.module}`)
      if (files && !files.has(tool.module)) throw new Error(`Missing command module: ${tool.module}`)
      if (files && sha256(files.get(tool.module)) !== tool.artifact_hash) throw new Error(`Command hash mismatch: ${tool.command_name}`)
    }
  } else {
    validateHubId(manifest.site?.hub_id, 's')
    normalizeDomain(manifest.site?.domain)
    const tool = manifest.command
    validateHubId(tool?.hub_id, 'c')
    normalizeCommandName(tool?.command_name)
    if (!safePath(tool?.module)) throw new Error('Unsafe command module')
    if (files) {
      const allowed = new Set(['manifest.json', tool.module])
      for (const name of files.keys()) if (!allowed.has(name)) throw new Error(`Unexpected command package file: ${name}`)
      if (!files.has(tool.module)) throw new Error(`Missing command module: ${tool.module}`)
      if (sha256(files.get(tool.module)) !== tool.artifact_hash) throw new Error('Command hash mismatch')
    }
  }
  if (files) {
    for (const name of files.keys()) if (name.endsWith('toolkit_runtime.py')) throw new Error('Hub packages must not contain toolkit_runtime.py')
  }
  return manifest
}

// ── v2：Adapter 维度包（规范 docs/adapter_package_spec.md，schema_version=2）──
// v1（scope site/command/base）冻结只读；v2 包 = adapter 目录 zip，manifest 为 v2。

const V2_RUNTIMES = ['extension', 'wewright']
const V2_FORBIDDEN_FILES = new Set([
  'toolkit_runtime.py', 'toolkit.py', 'requirements.txt',
  'SKILL.md', 'SKILL.generated.md', 'index.js',
  'WEBCLI_KNOWLEDGE.json', 'WEBCLI_KNOWLEDGE.md', 'wecli.generated.json',
])

function validAdapterName(name) {
  return typeof name === 'string' && name.length > 0
    && !/[/\:*?"<>|\s]/.test(name) && !name.startsWith('.') && !name.endsWith('.') && name !== '..'
}

export function validateAdapterManifestV2(manifest, files = null) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be an object')
  if (manifest.schema_version !== 2) throw new Error('Adapter package requires schema_version 2')
  const name = manifest.name
  if (!validAdapterName(name)) throw new Error('Invalid adapter name')
  for (const field of ['adapter_type', 'entry', 'scope', 'hub_id', 'support_files', 'tool_execution', 'detail_description', 'author']) {
    if (field in manifest) throw new Error(`Forbidden legacy field: ${field}`)
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) throw new Error('version is required')
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) throw new Error('description is required')
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) throw new Error('commands must be a non-empty array')

  const ids = new Set()
  const runtimes = new Set()
  for (const command of manifest.commands) {
    const id = String(command?.id || '')
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid command id: ${id}`)
    if (ids.has(id)) throw new Error(`Duplicate command id: ${id}`)
    ids.add(id)
    if (!V2_RUNTIMES.includes(command.runtime)) throw new Error(`Command "${id}" runtime must be extension|wewright`)
    runtimes.add(command.runtime)
    const ext = command.runtime === 'extension' ? 'js' : 'py'
    const expected = `${command.runtime}/commands/${id}.${ext}`
    if (command.module !== expected) throw new Error(`Command "${id}" module must be "${expected}"`)
    if (!command.description || typeof command.description !== 'string') throw new Error(`Command "${id}" description is required`)
    if (!command.schema || typeof command.schema !== 'object' || Array.isArray(command.schema)) throw new Error(`Command "${id}" schema is required`)
    if (files && !files.has(command.module)) throw new Error(`Missing command module: ${command.module}`)
  }

  const match = manifest.match
  if (runtimes.has('extension')) {
    if (!Array.isArray(match) || match.length === 0) throw new Error('match is required when extension commands exist')
  } else if (match != null && Array.isArray(match) && match.length > 0) {
    throw new Error('match is forbidden for pure wewright adapters')
  }

  if (files) {
    const roots = new Set(['manifest.json', ...runtimes])
    for (const name of files.keys()) {
      if (name.split('/').some((part) => part === '__pycache__')) throw new Error(`Forbidden directory entry: ${name}`)
      const base = name.split('/').pop()
      if (V2_FORBIDDEN_FILES.has(base)) throw new Error(`Forbidden file: ${name}`)
      if (/\.generated\.(js|py|md|txt)$/.test(base)) throw new Error(`Forbidden generated file: ${name}`)
      const [root, sub] = name.split('/')
      if (!roots.has(root)) throw new Error(`Unexpected package root entry: ${root}`)
      if (root !== 'manifest.json' && sub !== 'commands' && sub !== 'internal') {
        throw new Error(`Runtime "${root}" may only contain commands/ and internal/`)
      }
    }
  }
  return manifest
}

function unzipEntries(input) {
  let unpacked
  try { unpacked = unzipSync(new Uint8Array(input)) } catch { throw new Error('Invalid .adapt archive') }
  const names = Object.keys(unpacked).sort()
  if (names.length > MAX_FILES) throw new Error('Too many files in adapt package')
  let total = 0
  const files = new Map()
  for (const name of names) {
    if (!safePath(name)) throw new Error(`Unsafe package path: ${name}`)
    const bytes = unpacked[name]
    total += bytes.length
    if (total > MAX_EXPANDED_BYTES) throw new Error('Adapt package is too large')
    if (files.has(name)) throw new Error(`Duplicate package path: ${name}`)
    files.set(name, bytes)
  }
  return { files, sha256: sha256(input), expandedBytes: total }
}

export function readAdapterPackage(input) {
  const { files, sha256: hash, expandedBytes } = unzipEntries(input)
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw new Error('manifest.json is required')
  let manifest
  try { manifest = JSON.parse(strFromU8(manifestBytes)) } catch { throw new Error('manifest.json is invalid JSON') }
  validateAdapterManifestV2(manifest, files)
  return { manifest, files, sha256: hash, expandedBytes }
}
