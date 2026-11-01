import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSkillManagementRouter, markWeWorkerCreatedSkill, readManagedSkill } from '../skill-management.js'
import { buildEnabledSkillIndex } from '../context/runtime-context.js'
import { fingerprintSkillFiles } from '../chat-session.js'
import { listCustomSkills, saveCustomSkills } from '../custom-skills.js'
import { syncBundledWebcliSkills } from '../webcli-skills.js'
import { officialSkillBuildTime } from '../skill-build-time.js'
// @ts-expect-error Exercise the same installer used by desktop startup.
import { installSkills } from '../../../../webcli/skill-installer.js'

const fixtureState = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { root: '', home: fs.mkdtempSync(path.join(os.tmpdir(), 'skill-management-home-')) }
})
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, default: { ...actual, homedir: () => fixtureState.home }, homedir: () => fixtureState.home }
})
afterAll(() => fs.rmSync(fixtureState.home, { recursive: true, force: true }))
vi.mock('../runtime-skills-dir.js', () => ({ getRuntimeSkillsDir: () => fixtureState.root }))
let root: string, server: Server, url: string
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fixtureState.home, 'skills-'))
  fixtureState.root = path.join(root, 'skills')
  const app = express()
  app.use(express.json(), createSkillManagementRouter(fixtureState.root, name =>
    officialSkillBuildTime(name, id => id === 'example', Date.UTC(2026, 0, 2))))
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})
const post = (route: string, body: unknown) => fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const list = async () => (await fetch(`${url}/skills`)).json()

describe('Skill management HTTP routes', () => {
  it('creates a physically empty folder, lists it after reload, and refuses activation until authored', async () => {
    const startedAt = Date.now()
    const response = await post('/skills/folders', { name: 'example-skill' })
    expect(response.status).toBe(201)
    expect(fs.readdirSync(path.join(fixtureState.root, 'example-skill'))).toEqual([])
    const firstListing = await list() as Array<{ name: string; source: string; createdAt: number | null; creationOrderKey: string }>
    expect(firstListing).toMatchObject([{ name: 'example-skill', content: '', enabled: false, draft: true, resources: [] }])
    expect(firstListing[0].source).toBe('custom')
    expect(typeof firstListing[0].creationOrderKey).toBe('string')
    const createdAt = firstListing[0].createdAt
    expect(createdAt).toBeGreaterThanOrEqual(startedAt)
    expect(createdAt).toBeLessThanOrEqual(Date.now())
    expect((await post('/skills/example-skill/toggle', { enabled: true })).status).toBe(409)
    expect((await post('/skills/folders', { name: 'example-skill' })).status).toBe(409)
    expect(fs.readdirSync(path.join(fixtureState.root, 'example-skill'))).toEqual([])
    await post('/skills', { name: 'example-skill', previousName: 'example-skill', content: '---\nname: renamed-skill\n---\nAuthored' })
    expect(await list()).toMatchObject([{ name: 'renamed-skill', createdAt, creationOrderKey: firstListing[0].creationOrderKey }])
  })

  it('classifies skills created outside WeWorker as official in the catalog', async () => {
    fs.mkdirSync(path.join(fixtureState.root, 'legacy-blank-draft'), { recursive: true })
    const external = path.join(fixtureState.root, 'webcli-third-party')
    fs.mkdirSync(external, { recursive: true })
    fs.writeFileSync(path.join(external, 'SKILL.md'), '# Adapter managed Skill')
    const entries = await list() as Array<{ name: string; source: string }>
    expect(entries).toContainEqual(expect.objectContaining({ name: 'webcli-third-party', source: 'official' }))
    expect(entries).toContainEqual(expect.objectContaining({ name: 'legacy-blank-draft', source: 'custom' }))

    await post('/skills', { name: 'weworker-created', content: '# Created in WeWorker' })
    const afterCreate = await list() as Array<{ name: string; source: string }>
    expect(afterCreate).toContainEqual(expect.objectContaining({ name: 'weworker-created', source: 'custom' }))
  })

  it('serves a validated root Skill icon and ignores unsafe or invalid icons', async () => {
    const skillDir = path.join(fixtureState.root, 'webcli-example')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Adapter Skill')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>'
    fs.writeFileSync(path.join(skillDir, 'icon.svg'), svg)
    expect(readManagedSkill(fixtureState.root, 'webcli-example').iconUrl).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    fs.writeFileSync(path.join(skillDir, 'icon.svg'), '<svg onload="alert(1)"/>')
    expect(readManagedSkill(fixtureState.root, 'webcli-example').iconUrl).toBeUndefined()
  })

  it('marks a skill uploaded through WeWorker as custom', async () => {
    const uploaded = path.join(fixtureState.root, 'uploaded-skill')
    fs.mkdirSync(uploaded, { recursive: true })
    fs.writeFileSync(path.join(uploaded, 'SKILL.md'), '# Uploaded by the user')
    expect(readManagedSkill(fixtureState.root, 'uploaded-skill').source).toBe('official')
    markWeWorkerCreatedSkill(fixtureState.root, 'uploaded-skill')
    expect(readManagedSkill(fixtureState.root, 'uploaded-skill').source).toBe('custom')
  })

  it('uses the supplied build timestamp for official Skills without changing custom addition time', async () => {
    await post('/skills', { name: 'webcli-example', content: '# Official' })
    await post('/skills/folders', { name: 'custom-example' })
    const buildTime = Date.UTC(2026, 0, 2)
    expect(readManagedSkill(fixtureState.root, 'webcli-example', buildTime).createdAt).toBe(buildTime)
    const custom = readManagedSkill(fixtureState.root, 'custom-example')
    expect(custom.createdAt).toBeGreaterThan(buildTime)
    expect(readManagedSkill(fixtureState.root, 'custom-example').createdAt).toBe(custom.createdAt)
    expect(await list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'webcli-example', createdAt: buildTime }),
      expect.objectContaining({ name: 'custom-example', createdAt: custom.createdAt }),
    ]))
  })

  it('persists a stable fallback on filesystems without directory birth time', async () => {
    await post('/skills/folders', { name: 'fallback' })
    const originalStat = fs.statSync.bind(fs)
    let modifiedAt = BigInt(Date.UTC(2026, 0, 2))
    const stat = vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: { bigint?: boolean }) => {
      const result = originalStat(file, options as { bigint: true })
      return options?.bigint ? { ...result, birthtimeMs: 0n, mtimeMs: modifiedAt } : result
    }) as typeof fs.statSync)
    try {
      const first = readManagedSkill(fixtureState.root, 'fallback')
      modifiedAt += 100000n
      fs.renameSync(path.join(fixtureState.root, 'fallback'), path.join(fixtureState.root, 'renamed'))
      expect(readManagedSkill(fixtureState.root, 'renamed').createdAt).toBe(first.createdAt)
      expect(fs.readdirSync(path.join(fixtureState.root, 'renamed'))).toEqual([])
    } finally {
      stat.mockRestore()
    }
  })

  it.each(['../escape', '..', '.', 'CON', 'LPT1.txt', 'trailing.', ' bad', 'a/b', 'a\\b', 'C:drive', ''])('rejects invalid folder name %s without writing', async name => {
    expect((await post('/skills/folders', { name })).status).toBe(400)
    expect(fs.existsSync(fixtureState.root)).toBe(false)
  })

  it('preserves drafts on resource-only save and keeps the first document disabled until enabled', async () => {
    await post('/skills/folders', { name: 'draft' })
    await post('/skills', { name: 'draft', content: '', resources: [{ relativePath: 'notes.txt', readable: true, content: 'Notes' }] })
    expect(fs.readdirSync(path.join(fixtureState.root, 'draft'))).toEqual(['notes.txt'])
    const saved = await post('/skills', { name: 'draft', content: '# Example' })
    expect(await saved.json()).toMatchObject({ draft: false, enabled: false })
    await post('/skills/draft/toggle', { enabled: true })
    expect(buildEnabledSkillIndex(fixtureState.root)).toContain('draft')
  })

  it('sets enabled idempotently, survives edits and rename, and invalidates session discovery', async () => {
    await post('/skills', { name: 'example', content: '# Example' })
    const before = fingerprintSkillFiles([fixtureState.root])
    expect(await (await post('/skills/example/toggle', { enabled: false })).json()).toMatchObject({ enabled: false })
    expect(await (await post('/skills/example/toggle', { enabled: false })).json()).toMatchObject({ enabled: false })
    expect(fingerprintSkillFiles([fixtureState.root])).not.toBe(before)
    expect(buildEnabledSkillIndex(fixtureState.root)).toBe('')
    await post('/skills', { name: 'example', previousName: 'example', content: '---\nname: renamed\n---\nUpdated' })
    expect(fs.existsSync(path.join(fixtureState.root, 'renamed', 'SKILL.md'))).toBe(false)
    expect(await list()).toMatchObject([{ name: 'renamed', enabled: false, content: expect.stringContaining('Updated') }])
    expect(await (await post('/skills/renamed/toggle', {})).json()).toMatchObject({ enabled: true })
    expect(buildEnabledSkillIndex(fixtureState.root)).toContain('renamed')
  })

  it('rejects invalid toggle requests and missing Skills', async () => {
    expect((await post('/skills/missing/toggle', { enabled: false })).status).toBe(404)
    expect((await post('/skills/missing/toggle', { enabled: 'false' })).status).toBe(400)
  })

  it('preserves site custom Skill state through subsequent content saves', async () => {
    const skill = { id: 'fixture-skill', name: 'example-task', markdown: '# First', resources: [] }
    saveCustomSkills('fixture-site', [skill])
    await post('/skills/webcli-example-task/toggle', { enabled: false })
    saveCustomSkills('fixture-site', [{ ...skill, markdown: '# Updated' }])
    expect(listCustomSkills('fixture-site')[0]).toMatchObject({ enabled: false, directoryName: 'webcli-example-task', markdown: '# Updated\n' })
    expect(buildEnabledSkillIndex(fixtureState.root)).toBe('')
  })

  it('rebuilds reserved bundled Skills at startup while retaining other bundled Skill disablement', async () => {
    const builtin = path.join(root, 'builtin')
    fs.mkdirSync(builtin)
    fs.writeFileSync(path.join(builtin, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [] }))
    vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public')
    vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', builtin)
    vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', path.join(root, 'user'))
    vi.stubEnv('WEBCLI_ADAPTERS_DIR', path.join(root, 'user'))
    vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', path.join(root, 'data'))
    await installSkills({ target: fixtureState.root })
    for (const name of ['webcli', 'complex-task-planner', 'webcli-browser', 'webcli-api-exploration']) {
      expect((await post(`/skills/${name}/toggle`, { enabled: false })).status).toBe(200)
    }
    await installSkills({ target: fixtureState.root })
    for (const name of ['webcli', 'webcli-browser', 'webcli-api-exploration']) {
      expect(fs.existsSync(path.join(fixtureState.root, name, 'SKILL.md'))).toBe(true)
      expect(fs.existsSync(path.join(fixtureState.root, name, 'SKILL.md.disabled'))).toBe(false)
    }
    expect(fs.existsSync(path.join(fixtureState.root, 'complex-task-planner', 'SKILL.md'))).toBe(false)
    expect(fs.readFileSync(path.join(fixtureState.root, 'complex-task-planner', 'SKILL.md.disabled'), 'utf8').length).toBeGreaterThan(0)
  })
})
