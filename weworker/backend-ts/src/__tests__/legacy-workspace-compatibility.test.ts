import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fixtureHome: string
let configDirectory: string
let userDirectory: string
let store: typeof import('../works-store.js') | undefined

beforeEach(() => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-legacy-workspace-'))
  configDirectory = path.join(fixtureHome, '.weworker')
  userDirectory = path.join(configDirectory, 'user-files')
  fs.mkdirSync(userDirectory, { recursive: true })
  fs.writeFileSync(path.join(configDirectory, 'settings.json'), JSON.stringify({ user_directory: userDirectory }))
  vi.spyOn(os, 'homedir').mockReturnValue(fixtureHome)
  vi.resetModules()
})

afterEach(() => {
  store?._getTestDb().close()
  store = undefined
  vi.restoreAllMocks()
  vi.resetModules()
  fs.rmSync(fixtureHome, { recursive: true, force: true })
})

// Model an installed database from before workspace_directory was introduced.
function seedLegacyDatabase(projectDirectory?: string, workspaceDirectory?: string | null): void {
  const database = new DatabaseSync(path.join(configDirectory, 'works.db'))
  try {
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, folder_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE works (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', project_id TEXT DEFAULT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, work_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `)
    const timestamp = '2026-10-01T00:00:00.000Z'
    if (projectDirectory) {
      fs.mkdirSync(projectDirectory, { recursive: true })
      database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
        'fixture-project', 'Legacy project', projectDirectory, timestamp, timestamp,
      )
    }
    database.prepare('INSERT INTO works VALUES (?, ?, ?, ?, ?)').run(
      'fixture-work', 'Legacy conversation', projectDirectory ? 'fixture-project' : null, timestamp, timestamp,
    )
    if (workspaceDirectory !== undefined) {
      database.exec("ALTER TABLE works ADD COLUMN workspace_directory TEXT DEFAULT ''")
      database.prepare('UPDATE works SET workspace_directory = ?').run(workspaceDirectory)
    }
    database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(
      'fixture-message', 'fixture-work', 'user', JSON.stringify([
        { type: 'text', text: 'Public fixture message' },
        { type: 'file_attachment', name: 'report.txt', path: path.join(projectDirectory || userDirectory, 'report.txt') },
      ]), timestamp,
    )
  } finally {
    database.close()
  }
}

async function openStore() {
  store = await import('../works-store.js')
  store._getTestDb()
  return store
}

async function reopenStore() {
  store!._getTestDb().close()
  store = undefined
  vi.resetModules()
  return openStore()
}

describe('legacy workspace compatibility on upgrade', () => {
  it.each([undefined, '', null])('uses the user-files root for a legacy conversation with workspace %s', async (workspace) => {
    seedLegacyDatabase(undefined, workspace)
    const current = await openStore()
    expect(current.getWork('fixture-work')?.workspace_directory).toBe(userDirectory)
    expect(current.getWorkspaceDirectoryForWork('fixture-work')).toBe(userDirectory)
    const next = current.createWork('New conversation')
    expect(next.workspace_directory).toBe(path.join(userDirectory, 'projects', 'default'))
    expect((await reopenStore()).getWork('fixture-work')?.workspace_directory).toBe(userDirectory)
  })

  it.each(['user root', 'named folder', 'external folder'])('preserves an existing project in the %s while new projects use projects/', async (location) => {
    const directory = location === 'user root' ? userDirectory
      : location === 'named folder' ? path.join(userDirectory, 'Legacy project')
        : path.join(fixtureHome, 'external-project')
    seedLegacyDatabase(directory)
    fs.writeFileSync(path.join(directory, 'report.txt'), 'public fixture report')
    const current = await openStore()
    expect(current.getProject('fixture-project')?.folder_path).toBe(directory)
    expect(current.getWork('fixture-work')?.workspace_directory).toBe(directory)
    expect(current.createWork('Continue old project', 'fixture-project').workspace_directory).toBe(directory)
    const project = current.createProject('New project')
    expect(current.getProject(project.id)?.folder_path).toBe(path.join(userDirectory, 'projects', 'New project'))
    expect(current.getWorkWithMessages('fixture-work')?.messages[0].content).toEqual([
      { type: 'text', text: 'Public fixture message' },
      { type: 'file_attachment', name: 'report.txt', path: path.join(directory, 'report.txt') },
    ])
    expect(fs.readFileSync(path.join(directory, 'report.txt'), 'utf8')).toBe('public fixture report')
    expect((await reopenStore()).getProject('fixture-project')?.folder_path).toBe(directory)
  })

  it('prefers an explicit conversation workspace over its project directory', async () => {
    const projectDirectory = path.join(userDirectory, 'Legacy project')
    const workspace = path.join(projectDirectory, 'conversation')
    seedLegacyDatabase(projectDirectory, workspace)
    fs.mkdirSync(workspace)
    const current = await openStore()
    expect(current.getWork('fixture-work')?.workspace_directory).toBe(workspace)
    expect((await reopenStore()).getWork('fixture-work')?.workspace_directory).toBe(workspace)
  })

  it('falls back to user-files when a legacy conversation references a missing project', async () => {
    seedLegacyDatabase()
    const current = await openStore()
    current._getTestDb().prepare('UPDATE works SET project_id = ? WHERE id = ?').run('missing-project', 'fixture-work')
    expect(current.getWorkspaceDirectoryForWork('fixture-work')).toBe(userDirectory)
  })

  it('falls back to user-files when the legacy project has no directory value', async () => {
    seedLegacyDatabase(userDirectory)
    const current = await openStore()
    current._getTestDb().prepare("UPDATE projects SET folder_path = '' WHERE id = ?").run('fixture-project')
    expect(current.getWorkspaceDirectoryForWork('fixture-work')).toBe(userDirectory)
  })

  it('does not move existing default, scheduled-tasks, agents or ordinary user files', async () => {
    seedLegacyDatabase()
    const directories = ['default', 'scheduled-tasks', 'agents']
    for (const name of directories) {
      fs.mkdirSync(path.join(userDirectory, name))
      fs.writeFileSync(path.join(userDirectory, name, 'fixture.txt'), name)
    }
    fs.writeFileSync(path.join(userDirectory, 'report.txt'), 'public fixture')
    await openStore()
    await reopenStore()
    for (const name of directories) {
      expect(fs.readFileSync(path.join(userDirectory, name, 'fixture.txt'), 'utf8')).toBe(name)
      expect(fs.existsSync(path.join(userDirectory, 'projects', name, 'fixture.txt'))).toBe(false)
    }
    expect(fs.readFileSync(path.join(userDirectory, 'report.txt'), 'utf8')).toBe('public fixture')
  })

  it('keeps configured user_directory and its saved settings unchanged', async () => {
    const directory = path.join(configDirectory, 'projects')
    fs.mkdirSync(directory)
    const settingsFile = path.join(configDirectory, 'settings.json')
    const raw = JSON.stringify({ user_directory: directory })
    fs.writeFileSync(settingsFile, raw)
    const config = await import('../config.js')
    expect(config.getUserDirectory()).toBe(directory)
    expect(config.ensureProjectsDirectory()).toBe(path.join(directory, 'projects'))
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(raw)
  })

  it('keeps a recorded workspace pointing to its original location even if the folder is missing', async () => {
    const missingDirectory = path.join(userDirectory, 'missing-project')
    seedLegacyDatabase(undefined, missingDirectory)
    const current = await openStore()
    expect(current.getWorkspaceDirectoryForWork('fixture-work')).toBe(missingDirectory)
    expect(fs.existsSync(missingDirectory)).toBe(false)
  })

  it.each(['recorded', 'empty', 'project fallback'])('preserves %s scheduled task workspaces through startup and history grouping', async (kind) => {
    seedLegacyDatabase()
    let current = await openStore()
    const task = current.createScheduledTask({
      title: 'Legacy schedule', cron_expression: '0 9 * * *',
      prompt_template: 'Public fixture prompt', enabled: true, notify_channels: [],
    })
    const project = current.getProjectByName('定时任务')!
    const projectDirectory = path.join(userDirectory, '定时任务')
    const taskDirectory = path.join(userDirectory, 'scheduled-tasks', task.id)
    fs.mkdirSync(projectDirectory)
    fs.mkdirSync(taskDirectory, { recursive: true })
    fs.writeFileSync(path.join(taskDirectory, 'fixture.txt'), 'public schedule fixture')
    const previousProjectDirectory = path.join(userDirectory, 'Previous project')
    fs.mkdirSync(previousProjectDirectory)
    const previousProject = current.createProject('Previous project', previousProjectDirectory)
    const work = current.createWork('Legacy execution', kind === 'project fallback' ? previousProject.id : null, kind === 'recorded' ? taskDirectory : userDirectory)
    current.createTaskExecution(task.id, work.id)
    const database = current._getTestDb()
    database.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(projectDirectory, project.id)
    database.prepare('UPDATE scheduled_tasks SET workspace_directory = ? WHERE id = ?').run(kind === 'recorded' ? taskDirectory : '', task.id)
    if (kind !== 'recorded') database.prepare("UPDATE works SET workspace_directory = '' WHERE id = ?").run(work.id)

    current = await reopenStore()
    current.ensureScheduledTaskHistoryProject(10)
    expect(current.getProject(project.id)?.folder_path).toBe(projectDirectory)
    expect(current.ensureScheduledTaskWorkspace(task.id)).toBe(kind === 'recorded' ? taskDirectory : userDirectory)
    expect(current.getWork(work.id)?.project_id).toBe(project.id)
    expect(current.getWork(work.id)?.workspace_directory).toBe(kind === 'project fallback' ? previousProjectDirectory : kind === 'recorded' ? taskDirectory : userDirectory)
    expect(current.ensureScheduledTaskHistoryProject(10).movedCount).toBe(0)
    expect(fs.readFileSync(path.join(taskDirectory, 'fixture.txt'), 'utf8')).toBe('public schedule fixture')
    expect(fs.existsSync(path.join(projectDirectory, 'legacy-project'))).toBe(false)
  })
})
