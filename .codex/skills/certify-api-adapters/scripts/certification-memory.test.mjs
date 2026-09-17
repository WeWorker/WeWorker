import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildPlan,
  collectFingerprints,
  hashFiles,
  listProfileIds,
  memoryFile,
  profileTemplate,
  recordMemory,
  validateProfile,
} from './certification-memory.mjs'

test('source fingerprints are stable across Git line-ending settings', () => {
  const lfRoot = mkdtempSync(join(tmpdir(), 'adapter-certification-lf-'))
  const crlfRoot = mkdtempSync(join(tmpdir(), 'adapter-certification-crlf-'))
  try {
    writeFileSync(join(lfRoot, 'source.js'), 'const one = 1\nconst two = 2\n')
    writeFileSync(join(crlfRoot, 'source.js'), 'const one = 1\r\nconst two = 2\r\n')
    assert.equal(hashFiles(lfRoot, ['source.js']), hashFiles(crlfRoot, ['source.js']))
  } finally {
    rmSync(lfRoot, { recursive: true, force: true })
    rmSync(crlfRoot, { recursive: true, force: true })
  }
})

test('project fingerprint covers the complete shipped API scope', async () => {
  const snapshot = await collectFingerprints()
  assert.equal(snapshot.inventory.adapterCount, snapshot.adapters.length)
  assert.equal(snapshot.inventory.toolCount, snapshot.adapters.reduce((sum, adapter) => sum + adapter.toolCount, 0))
  if (snapshot.adapters.length > 1) {
    assert.equal(new Set(snapshot.adapters.map((adapter) => adapter.fingerprint)).size > 1, true)
  }
})

test('profile validation rejects credentials and keeps developer bindings local', () => {
  const profile = profileTemplate('developer-a', '2026-09-14T00:00:00.000Z')
  profile.adapters['api.example.com'] = {
    updatedAt: '2026-09-14T00:00:00.000Z',
    capabilities: { projects: [{ alias: 'uat-project', id: '1000' }] },
  }
  assert.equal(validateProfile(profile), profile)
  profile.adapters['api.example.com'].token = 'must-not-be-stored'
  assert.throws(() => validateProfile(profile), /forbidden secret field/)
})

test('profile filenames remain explicit local aliases', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'adapter-certification-profiles-'))
  try {
    const profilesRoot = join(stateRoot, 'profiles')
    mkdirSync(profilesRoot, { recursive: true })
    writeFileSync(join(profilesRoot, 'developer-b.json'), '{}')
    writeFileSync(join(profilesRoot, 'developer-a.json'), '{}')
    writeFileSync(join(profilesRoot, 'not-a-profile.txt'), '{}')
    assert.deepEqual(listProfileIds(stateRoot), ['developer-a', 'developer-b'])
  } finally {
    rmSync(stateRoot, { recursive: true, force: true })
  }
})

test('planner reuses fresh evidence and targets only the changed developer profile', () => {
  const snapshot = {
    globalFingerprint: 'global-a',
    adapters: [
      { id: 'api.example.com', fingerprint: 'adapter-a', toolCount: 4 },
      { id: 'reports.example.com', fingerprint: 'adapter-b', toolCount: 24 },
    ],
  }
  const memory = {
    recordedAt: '2026-09-14T08:00:00.000Z',
    fingerprints: snapshot,
  }
  const profile = profileTemplate('developer-a', '2026-09-14T08:00:00.000Z')
  profile.adapters['api.example.com'] = { updatedAt: '2026-09-14T09:00:00.000Z' }
  const plan = buildPlan({
    snapshot,
    memory,
    profile,
    now: new Date('2026-09-14T10:00:00.000Z'),
  })
  assert.deepEqual(plan.summary, { conditional: 1, reuse: 1 })
  assert.deepEqual(plan.adapters, [
    { id: 'api.example.com', mode: 'conditional', reason: 'developer_profile_changed' },
    { id: 'reports.example.com', mode: 'reuse', reason: 'fingerprint_and_live_evidence_fresh' },
  ])
})

test('a new developer reuses matching shared static evidence and runs only live checks', () => {
  const snapshot = {
    globalFingerprint: 'global-a',
    adapters: [{ id: 'api.example.com', fingerprint: 'adapter-a', toolCount: 4 }],
  }
  const plan = buildPlan({
    snapshot,
    sharedBaseline: { fingerprints: snapshot },
    memory: null,
    profile: profileTemplate('developer-b', '2026-09-14T08:00:00.000Z'),
    now: new Date('2026-09-14T09:00:00.000Z'),
  })
  assert.deepEqual(plan.summary, { live: 1 })
  assert.equal(plan.adapters[0].reason, 'shared_static_fresh_profile_live_missing')
})

test('a stale shared baseline cannot skip static certification for a new developer', () => {
  const snapshot = {
    globalFingerprint: 'global-new',
    adapters: [{ id: 'api.example.com', fingerprint: 'adapter-a', toolCount: 4 }],
  }
  const plan = buildPlan({
    snapshot,
    sharedBaseline: {
      fingerprints: { globalFingerprint: 'global-old', adapters: snapshot.adapters },
    },
    memory: null,
    profile: profileTemplate('developer-b', '2026-09-14T08:00:00.000Z'),
    now: new Date('2026-09-14T09:00:00.000Z'),
  })
  assert.deepEqual(plan.summary, { full: 1 })
  assert.equal(plan.adapters[0].reason, 'shared_baseline_runtime_changed')
})

test('checked-in shared baseline matches the current certification source', async () => {
  const snapshot = await collectFingerprints()
  const baseline = JSON.parse(readFileSync(new URL('../references/shared-baseline.json', import.meta.url), 'utf8'))
  const plan = buildPlan({
    snapshot,
    sharedBaseline: baseline,
    memory: null,
    profile: profileTemplate('new-developer', '2026-09-14T08:00:00.000Z'),
    now: new Date('2026-09-14T09:00:00.000Z'),
  })
  const expectedSummary = snapshot.adapters.length > 0 ? { live: snapshot.adapters.length } : {}
  assert.deepEqual(plan.summary, expectedSummary)
})

test('shared routing changes invalidate every Adapter', () => {
  const snapshot = {
    globalFingerprint: 'global-new',
    adapters: [{ id: 'api.example.com', fingerprint: 'adapter-a', toolCount: 4 }],
  }
  const memory = {
    recordedAt: '2026-09-14T08:00:00.000Z',
    fingerprints: { globalFingerprint: 'global-old', adapters: snapshot.adapters },
  }
  const plan = buildPlan({
    snapshot,
    memory,
    profile: profileTemplate('developer-a', '2026-09-14T08:00:00.000Z'),
    now: new Date('2026-09-14T09:00:00.000Z'),
  })
  assert.deepEqual(plan.summary, { full: 1 })
  assert.equal(plan.adapters[0].reason, 'shared_runtime_changed')
})

test('recorded memory contains sanitized classifications but no raw errors', async (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'adapter-certification-memory-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const profile = profileTemplate('developer-a', '2026-09-14T08:00:00.000Z')
  const matrix = {
    evidenceThrough: '2026-09-14T09:00:00.000Z',
    adapterCount: 1,
    toolCount: 1,
    summary: { adapters: { CONDITIONAL: 1 }, tools: { CONDITIONAL: 1 } },
    adapters: [{
      id: 'api.example.com',
      result: 'CONDITIONAL',
      tools: [{
        name: 'api.example.com.get_project',
        result: 'CONDITIONAL',
        reasonCode: 'LIVE_PERMISSION',
        liveStatus: 'PERMISSION',
        dryRunStatus: 'NOT_DECLARED_OR_NOT_RUN',
        errorSignature: 'raw response must not persist',
      }],
    }],
  }
  await recordMemory({
    repoRoot: new URL('../../../..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'),
    stateRoot,
    profile,
    matrix,
    timestamp: '2026-09-14T10:00:00.000Z',
  })
  const raw = readFileSync(memoryFile(stateRoot, 'developer-a'), 'utf8')
  assert.doesNotMatch(raw, /raw response|errorSignature/)
  assert.match(raw, /LIVE_PERMISSION/)
})
