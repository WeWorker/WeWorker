import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-projects-'))

vi.mock('../config.js', () => ({
  ensureUserDirectory: () => fixtureRoot,
  ensureProjectsDirectory: () => {
    const directory = path.join(fixtureRoot, 'projects')
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  expandHomePath: (value: string) => value,
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
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'Demo Project'))).toBe(true)

    const work = store.createWork('', project.id)
    expect(work.project_id).toBe(project.id)
    expect(store.listWorks()[0]?.project_id).toBe(project.id)
  })

  it('keeps a bound project folder when its display name changes', () => {
    const project = store.createProject('Before')
    store.createWork('', project.id)

    expect(() => store.renameProject(project.id, 'After')).not.toThrow()
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'Before'))).toBe(true)
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'After'))).toBe(false)
    expect(() => store.deleteProject(project.id)).toThrow('project must be empty before deletion')
  })

  it('deletes only an empty project folder', () => {
    const project = store.createProject('Empty')
    store.deleteProject(project.id)
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'Empty'))).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })

  it('repairs legacy project and message paths and is idempotent', () => {
    const legacyRoot = fixtureRoot
    const legacyProjectsRoot = path.join(fixtureRoot, 'legacy-projects')
    const projectsRoot = path.join(fixtureRoot, 'projects')
    const legacyProject = path.join(fixtureRoot, 'Legacy')
    fs.mkdirSync(legacyProject, { recursive: true })
    const attachment = path.join(legacyProject, 'report.txt')
    fs.writeFileSync(attachment, 'fixture')

    const project = store.createProject('Legacy', legacyProject)
    const work = store.createWork('Legacy work', project.id)
    store.appendMessage(work.id, 'user', [{
      type: 'file_attachment',
      name: 'report.txt',
      path: attachment,
    }])

    const database = store._getTestDb()
    store.migrateLegacyWorkspacePaths(database, legacyRoot, legacyProjectsRoot, projectsRoot)
    store.migrateLegacyWorkspacePaths(database, legacyRoot, legacyProjectsRoot, projectsRoot)

    expect(store.getProject(project.id)?.folder_path).toBe(path.join(projectsRoot, 'Legacy'))
    expect(store.getWorkWithMessages(work.id)?.messages[0].content).toEqual([{
      type: 'file_attachment',
      name: 'report.txt',
      path: path.join(projectsRoot, 'Legacy', 'report.txt'),
    }])
    expect(fs.existsSync(fixtureRoot)).toBe(true)
  })

  it('repairs the temporary projects root without removing the user-files root', () => {
    const userRoot = path.join(fixtureRoot, 'user-files')
    const legacyProjectsRoot = path.join(fixtureRoot, 'projects')
    const projectsRoot = path.join(userRoot, 'projects')
    const legacyProject = path.join(legacyProjectsRoot, 'Legacy')
    fs.mkdirSync(legacyProject, { recursive: true })
    fs.mkdirSync(userRoot, { recursive: true })
    fs.writeFileSync(path.join(legacyProject, 'notes.txt'), 'fixture')
    fs.writeFileSync(path.join(userRoot, 'keep.txt'), 'user data')

    const staleDatabasePath = path.join(userRoot, 'Legacy')
    fs.mkdirSync(staleDatabasePath)
    const project = store.createProject('Legacy temporary root', staleDatabasePath)
    fs.rmSync(staleDatabasePath, { recursive: true })
    const work = store.createWork('Legacy work', project.id)
    store.appendMessage(work.id, 'user', [{ type: 'file_attachment', name: 'notes.txt', path: path.join(staleDatabasePath, 'notes.txt') }])
    store.migrateLegacyWorkspacePaths(store._getTestDb(), userRoot, legacyProjectsRoot, projectsRoot)

    expect(store.getProject(project.id)?.folder_path).toBe(path.join(projectsRoot, 'Legacy'))
    expect(fs.existsSync(path.join(projectsRoot, 'Legacy', 'notes.txt'))).toBe(true)
    expect(store.getWorkWithMessages(work.id)?.messages[0].content).toEqual([{
      type: 'file_attachment',
      name: 'notes.txt',
      path: path.join(projectsRoot, 'Legacy', 'notes.txt'),
    }])
    expect(fs.existsSync(userRoot)).toBe(true)
    expect(fs.readFileSync(path.join(userRoot, 'keep.txt'), 'utf8')).toBe('user data')
  })
})
