#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(scriptDir, '../../../..')
const defaultStateRoot = join(homedir(), '.weworker', 'api-adapter-certification')
const defaultSharedBaseline = resolve(scriptDir, '../references/shared-baseline.json')
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const FORBIDDEN_KEY = /^(?:authorization|cookie|credentials?|password|secret|sessionid|token|api[-_]?key|access[-_]?key|private[-_]?key)$/i
const GLOBAL_FILES = [
  '.codex/skills/certify-api-adapters/SKILL.md',
  '.codex/skills/certify-api-adapters/references/adapter-playbooks.json',
  '.codex/skills/certify-api-adapters/references/runbook.md',
  '.codex/skills/certify-api-adapters/scripts/certification-memory.mjs',
  '.codex/skills/certify-api-adapters/scripts/render-report.mjs',
  'weworker/build-profile.json',
  'weworker/package.json',
  'weworker/scripts/prepare-build.cjs',
  'webcli/adapter-cli.js',
  'webcli/api-adapter-certification.js',
  'webcli/api-adapter-certification-matrix.js',
  'webcli/direct-execution-metadata.js',
  'webcli/bridge.js',
  'webcli/wecli-command-catalog.json',
  'webcli/wecli-migrated-commands.json',
  'webcli/scripts/run-api-adapter-live-reads.js',
  'extension/adapters/index.json',
  'extension/adapters/registry.json',
  'extension/background/service-worker.js',
  'extension/offscreen/direct-frame.js',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function option(args, name, fallback = null) {
  const prefix = `--${name}=`
  const value = args.find((arg) => arg.startsWith(prefix))
  return value ? value.slice(prefix.length) : fallback
}

function requireProfileId(value) {
  if (!PROFILE_ID.test(value || '')) {
    throw new Error('profile ID must match [a-z0-9][a-z0-9_-]{0,63}')
  }
  return value
}

function profileFile(stateRoot, profileId) {
  return join(stateRoot, 'profiles', `${requireProfileId(profileId)}.json`)
}

function memoryFile(stateRoot, profileId) {
  return join(stateRoot, 'memory', `${requireProfileId(profileId)}.json`)
}

export function listProfileIds(stateRoot = defaultStateRoot) {
  const profilesRoot = join(stateRoot, 'profiles')
  return existsSync(profilesRoot)
    ? readdirSync(profilesRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((name) => PROFILE_ID.test(name))
      .sort()
    : []
}

function assertNoSecrets(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`forbidden secret field at ${location}.${key}`)
    assertNoSecrets(entry, `${location}.${key}`)
  }
}

export function validateProfile(profile, expectedProfileId = null) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('profile must be an object')
  if (profile.schemaVersion !== 1) throw new Error('profile.schemaVersion must be 1')
  requireProfileId(profile.profileId)
  if (expectedProfileId && profile.profileId !== expectedProfileId) throw new Error('profile ID does not match file name')
  if (!Number.isFinite(Date.parse(profile.updatedAt))) throw new Error('profile.updatedAt must be an ISO timestamp')
  if (!profile.policy || typeof profile.policy !== 'object') throw new Error('profile.policy is required')
  for (const key of ['allowAuthenticatedReads', 'allowDryRuns', 'allowConfirmedMutations']) {
    if (typeof profile.policy[key] !== 'boolean') throw new Error(`profile.policy.${key} must be boolean`)
  }
  if (!profile.adapters || typeof profile.adapters !== 'object' || Array.isArray(profile.adapters)) {
    throw new Error('profile.adapters must be an object')
  }
  for (const [adapterId, adapter] of Object.entries(profile.adapters)) {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) throw new Error(`profile.adapters.${adapterId} must be an object`)
    if (!Number.isFinite(Date.parse(adapter.updatedAt))) throw new Error(`profile.adapters.${adapterId}.updatedAt must be an ISO timestamp`)
  }
  assertNoSecrets(profile)
  return profile
}

export function profileTemplate(profileId, timestamp = new Date().toISOString()) {
  return {
    schemaVersion: 1,
    profileId: requireProfileId(profileId),
    updatedAt: timestamp,
    policy: {
      allowAuthenticatedReads: true,
      allowDryRuns: true,
      allowConfirmedMutations: false,
    },
    adapters: {},
  }
}

export function hashFiles(repoRoot, relativePaths) {
  const hash = createHash('sha256')
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const fullPath = join(repoRoot, relativePath)
    hash.update(relativePath.replaceAll('\\', '/'))
    hash.update('\0')
    // Git may materialize the same text blob with LF or CRLF depending on the
    // developer's checkout settings. Certification fingerprints represent
    // source content, so line-ending differences must not invalidate evidence.
    if (existsSync(fullPath)) hash.update(readFileSync(fullPath, 'utf8').replaceAll('\r\n', '\n'))
    else hash.update('<missing>')
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function collectFingerprints(repoRoot = defaultRepoRoot) {
  const certificationUrl = pathToFileURL(join(repoRoot, 'webcli', 'api-adapter-certification.js')).href
  const { loadShippedApiInventory } = await import(certificationUrl)
  const inventory = await loadShippedApiInventory({ repoRoot })
  const adapters = []
  for (const adapter of inventory.adapters) {
    const adapterRoot = join('extension', 'adapters', adapter.id)
    const manifest = readJson(join(repoRoot, adapterRoot, 'manifest.json'))
    const files = [
      join(adapterRoot, 'manifest.json'),
      join(adapterRoot, 'index.js'),
      join(adapterRoot, 'wecli.generated.json'),
      ...(manifest.support_files || []).map((file) => join(adapterRoot, file)),
    ]
    adapters.push({
      id: adapter.id,
      fingerprint: hashFiles(repoRoot, files),
      toolCount: adapter.tools.length,
    })
  }
  return {
    schemaVersion: 1,
    inventory: { adapterCount: inventory.adapterCount, toolCount: inventory.toolCount },
    globalFingerprint: hashFiles(repoRoot, GLOBAL_FILES),
    adapters,
  }
}

function adapterProfileChanged(profileAdapter, recordedAt) {
  if (!profileAdapter) return false
  return Date.parse(profileAdapter.updatedAt) > Date.parse(recordedAt)
}

export function buildPlan({ snapshot, sharedBaseline = null, memory, profile, now = new Date(), liveTtlHours = 24 }) {
  const recordedAt = memory?.recordedAt || null
  const expired = !recordedAt || now.getTime() - Date.parse(recordedAt) > liveTtlHours * 60 * 60 * 1000
  const previousAdapters = new Map((memory?.fingerprints?.adapters || []).map((adapter) => [adapter.id, adapter]))
  const sharedChanged = Boolean(memory && memory.fingerprints?.globalFingerprint !== snapshot.globalFingerprint)
  const adapters = snapshot.adapters.map((adapter) => {
    const previous = previousAdapters.get(adapter.id)
    if (!memory) {
      const sharedAdapter = (sharedBaseline?.fingerprints?.adapters || []).find((entry) => entry.id === adapter.id)
      if (!sharedBaseline) return { id: adapter.id, mode: 'full', reason: 'no_shared_or_profile_evidence' }
      if (sharedBaseline.fingerprints?.globalFingerprint !== snapshot.globalFingerprint) {
        return { id: adapter.id, mode: 'full', reason: 'shared_baseline_runtime_changed' }
      }
      if (!sharedAdapter || sharedAdapter.fingerprint !== adapter.fingerprint) {
        return { id: adapter.id, mode: 'full', reason: 'adapter_changed_since_shared_baseline' }
      }
      return { id: adapter.id, mode: 'live', reason: 'shared_static_fresh_profile_live_missing' }
    }
    if (sharedChanged) return { id: adapter.id, mode: 'full', reason: 'shared_runtime_changed' }
    if (!previous || previous.fingerprint !== adapter.fingerprint) {
      return { id: adapter.id, mode: 'full', reason: 'adapter_source_changed' }
    }
    if (adapterProfileChanged(profile.adapters[adapter.id], recordedAt)) {
      return { id: adapter.id, mode: 'conditional', reason: 'developer_profile_changed' }
    }
    if (expired) return { id: adapter.id, mode: 'live', reason: 'live_evidence_expired' }
    return { id: adapter.id, mode: 'reuse', reason: 'fingerprint_and_live_evidence_fresh' }
  })
  return {
    schemaVersion: 1,
    profileId: profile.profileId,
    liveTtlHours,
    summary: adapters.reduce((summary, adapter) => {
      summary[adapter.mode] = (summary[adapter.mode] || 0) + 1
      return summary
    }, {}),
    adapters,
  }
}

function sanitizedMatrixEvidence(matrix) {
  return {
    evidenceThrough: matrix.evidenceThrough || null,
    adapterCount: matrix.adapterCount,
    toolCount: matrix.toolCount,
    summary: matrix.summary,
    adapters: (matrix.adapters || []).map((adapter) => ({
      id: adapter.id,
      result: adapter.result,
      tools: (adapter.tools || []).map((tool) => ({
        name: tool.name,
        result: tool.result,
        reasonCode: tool.reasonCode,
        liveStatus: tool.liveStatus,
        dryRunStatus: tool.dryRunStatus,
      })),
    })),
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

export async function recordMemory({ repoRoot, stateRoot, profile, matrix, timestamp = new Date().toISOString() }) {
  const snapshot = await collectFingerprints(repoRoot)
  const memory = {
    schemaVersion: 1,
    profileId: profile.profileId,
    recordedAt: timestamp,
    profileUpdatedAt: profile.updatedAt,
    fingerprints: snapshot,
    evidence: sanitizedMatrixEvidence(matrix),
  }
  assertNoSecrets(memory)
  writeJsonAtomic(memoryFile(stateRoot, profile.profileId), memory)
  return memory
}

function loadProfile(stateRoot, profileId) {
  const path = profileFile(stateRoot, profileId)
  if (!existsSync(path)) throw new Error(`profile not found: <local-state>/profiles/${profileId}.json`)
  return validateProfile(readJson(path), profileId)
}

async function main() {
  const args = process.argv.slice(2)
  const command = args.find((arg) => !arg.startsWith('--'))
  const repoRoot = resolve(option(args, 'repo-root', defaultRepoRoot))
  const stateRoot = resolve(option(args, 'state-root', defaultStateRoot))
  const profileId = option(args, 'profile')

  if (command === 'fingerprint') {
    process.stdout.write(`${JSON.stringify(await collectFingerprints(repoRoot), null, 2)}\n`)
    return
  }
  if (command === 'profile-template') {
    process.stdout.write(`${JSON.stringify(profileTemplate(profileId), null, 2)}\n`)
    return
  }
  if (command === 'list-profiles') {
    process.stdout.write(`${JSON.stringify({ profiles: listProfileIds(stateRoot) })}\n`)
    return
  }
  if (command === 'init-profile') {
    const path = profileFile(stateRoot, profileId)
    if (existsSync(path)) throw new Error('profile already exists; update it explicitly instead of replacing it')
    const profile = profileTemplate(profileId)
    writeJsonAtomic(path, profile)
    process.stdout.write(`${JSON.stringify({ created: true, profileId: profile.profileId })}\n`)
    return
  }
  if (command === 'validate-profile') {
    const profile = loadProfile(stateRoot, profileId)
    process.stdout.write(`${JSON.stringify({ valid: true, profileId: profile.profileId, adapterEntries: Object.keys(profile.adapters).length })}\n`)
    return
  }
  if (command === 'plan') {
    const profile = loadProfile(stateRoot, profileId)
    const snapshot = await collectFingerprints(repoRoot)
    const path = memoryFile(stateRoot, profileId)
    const memory = existsSync(path) ? readJson(path) : null
    const sharedBaselinePath = resolve(option(args, 'shared-baseline', defaultSharedBaseline))
    const sharedBaseline = existsSync(sharedBaselinePath) ? readJson(sharedBaselinePath) : null
    const liveTtlHours = Number(option(args, 'live-ttl-hours', '24'))
    process.stdout.write(`${JSON.stringify(buildPlan({ snapshot, sharedBaseline, memory, profile, liveTtlHours }), null, 2)}\n`)
    return
  }
  if (command === 'record') {
    const profile = loadProfile(stateRoot, profileId)
    const matrixPath = option(args, 'matrix')
    if (!matrixPath) throw new Error('--matrix is required')
    const matrix = readJson(resolve(repoRoot, matrixPath))
    const memory = await recordMemory({ repoRoot, stateRoot, profile, matrix })
    process.stdout.write(`${JSON.stringify({ recorded: true, profileId, adapterCount: memory.evidence.adapterCount, toolCount: memory.evidence.toolCount })}\n`)
    return
  }
  throw new Error('command must be fingerprint, list-profiles, profile-template, init-profile, validate-profile, plan, or record')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

export { defaultRepoRoot, defaultSharedBaseline, defaultStateRoot, memoryFile, profileFile }
