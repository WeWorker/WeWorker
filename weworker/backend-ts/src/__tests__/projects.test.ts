import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-projects-'))

vi.mock('../config.js', () => ({
  ensureUserDirectory: () => fixtureRoot,
}))

const store = await import('../works-store.js')

describe('project persistence', () => {
  it('shares desktop and channel messages through the same work and keeps resets in the project', () => {
    store._initTestDb()
    const project = store.createProject('Agent Project')
    const work = store.createWork('Example Agent', project.id)
    store.bindChannelWork('agent:fixture', 'fixture-user', work.id)
    const channel = store.getOrCreateChannelWork('agent:fixture', 'fixture-user', '', project.id)
    expect(channel.created).toBe(false)
    expect(channel.work.id).toBe(work.id)
    store.appendMessage(channel.work.id, 'user', [{ type: 'text', text: 'Fixture question' }])
    expect(store.getWorkWithMessages(work.id)?.messages[0].content).toEqual([{ type: 'text', text: 'Fixture question' }])
    const reset = store.resetChannelWork('agent:fixture', 'fixture-user', '', project.id)
    expect(reset.id).not.toBe(work.id)
    expect(reset.project_id).toBe(project.id)
    expect(store.listWorks()).toHaveLength(2)
  })

  beforeEach(() => {
    store._initTestDb()
  })

  afterEach(() => {
    for (const entry of fs.readdirSync(fixtureRoot)) {
      fs.rmSync(path.join(fixtureRoot, entry), { recursive: true, force: true })
    }
  })

  it('creates a project folder and associates new conversations with it', () => {
    const project = store.createProject('Demo Project')
    expect(fs.existsSync(path.join(fixtureRoot, 'Demo Project'))).toBe(true)

    const work = store.createWork('', project.id)
    expect(work.project_id).toBe(project.id)
    expect(store.listWorks()[0]?.project_id).toBe(project.id)
  })

  it('keeps a bound project folder when its display name changes', () => {
    const project = store.createProject('Before')
    store.createWork('', project.id)

    expect(() => store.renameProject(project.id, 'After')).not.toThrow()
    expect(fs.existsSync(path.join(fixtureRoot, 'Before'))).toBe(true)
    expect(fs.existsSync(path.join(fixtureRoot, 'After'))).toBe(false)
    expect(() => store.deleteProject(project.id)).toThrow('project must be empty before deletion')
  })

  it('deletes only an empty project folder', () => {
    const project = store.createProject('Empty')
    store.deleteProject(project.id)
    expect(fs.existsSync(path.join(fixtureRoot, 'Empty'))).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })
})
