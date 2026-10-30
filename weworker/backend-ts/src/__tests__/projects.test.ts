import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const archiveState = vi.hoisted(() => ({ ids: new Set<string>() }))

vi.mock('../conversation-archive.js', () => ({
  listArchivedWorkIds: () => [...archiveState.ids],
  setWorkArchived: (id: string, archived: boolean) => {
    if (archived) archiveState.ids.add(id)
    else archiveState.ids.delete(id)
  },
  removeArchivedWork: (id: string) => archiveState.ids.delete(id),
}))

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-projects-'))

vi.mock('../config.js', () => ({
  ensureUserDirectory: () => fixtureRoot,
  ensureProjectDirectory: (...segments: string[]) => {
    const directory = path.join(fixtureRoot, ...segments)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  getUserDirectory: () => fixtureRoot,
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
    archiveState.ids.clear()
    for (const entry of fs.readdirSync(fixtureRoot)) {
      fs.rmSync(path.join(fixtureRoot, entry), { recursive: true, force: true })
    }
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

  it('binds a project to a user-selected existing directory', () => {
    const selectedDirectory = path.join(fixtureRoot, 'selected')
    fs.mkdirSync(selectedDirectory)
    const project = store.createProject('External Project', selectedDirectory)
    const work = store.createWork('', project.id)

    expect(store.getProject(project.id)?.folder_path).toBe(selectedDirectory)
    expect(work.workspace_directory).toBe(selectedDirectory)
    expect(fs.readdirSync(selectedDirectory)).toEqual([])
  })

  it('creates one shared scheduled task project workspace on demand', () => {
    const work = store.createWork('Default workspace')
    expect(work.workspace_directory).toBe(path.join(fixtureRoot, 'default'))
    expect(fs.existsSync(work.workspace_directory)).toBe(true)

    const task = store.createScheduledTask({
      title: 'Fixture task',
      cron_expression: '0 9 * * *',
      prompt_template: 'Fixture prompt',
      enabled: true,
      notify_channels: [],
    })
    const nextTask = store.createScheduledTask({
      title: 'Fixture task two',
      cron_expression: '0 10 * * *',
      prompt_template: 'Fixture prompt two',
      enabled: true,
      notify_channels: [],
    })
    const project = store.getProjectByName('定时任务')!
    expect(task.workspace_directory).toBe(path.join(fixtureRoot, 'scheduled-tasks'))
    expect(nextTask.workspace_directory).toBe(task.workspace_directory)
    expect(store.getProject(project.id)?.folder_path).toBe(task.workspace_directory)
    expect(fs.existsSync(task.workspace_directory!)).toBe(true)
  })

  it('moves legacy scheduled task workspaces under the shared project directory', () => {
    const task = store.createScheduledTask({
      title: 'Legacy fixture task',
      cron_expression: '0 9 * * *',
      prompt_template: 'Fixture prompt',
      enabled: true,
      notify_channels: [],
    })
    const project = store.getProjectByName('定时任务')!
    const legacyProjectDirectory = path.join(fixtureRoot, '定时任务')
    const legacyTaskDirectory = path.join(fixtureRoot, 'scheduled-tasks', task.id)
    fs.mkdirSync(legacyProjectDirectory)
    fs.mkdirSync(legacyTaskDirectory)
    fs.writeFileSync(path.join(legacyProjectDirectory, 'project-file.txt'), 'preserved')
    fs.writeFileSync(path.join(legacyTaskDirectory, 'task-file.txt'), 'preserved')

    const database = store._getTestDb()
    database.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(legacyProjectDirectory, project.id)
    database.prepare('UPDATE scheduled_tasks SET workspace_directory = ? WHERE id = ?').run(legacyTaskDirectory, task.id)
    const work = store.createWork('Legacy scheduled run', project.id)
    store.createTaskExecution(task.id, work.id)

    const history = store.ensureScheduledTaskHistoryProject(10)
    const sharedDirectory = path.join(fixtureRoot, 'scheduled-tasks')

    expect(history.project?.id).toBe(project.id)
    expect(store.getProject(project.id)?.folder_path).toBe(sharedDirectory)
    expect(store.getScheduledTask(task.id)?.workspace_directory).toBe(sharedDirectory)
    expect(store.getWork(work.id)?.workspace_directory).toBe(sharedDirectory)
    expect(fs.readFileSync(path.join(sharedDirectory, 'legacy-project', 'project-file.txt'), 'utf8')).toBe('preserved')
    expect(fs.readFileSync(path.join(legacyTaskDirectory, 'task-file.txt'), 'utf8')).toBe('preserved')
  })

  it('renames the project folder and rejects deletion while it has conversations', () => {
    const project = store.createProject('Before')
    store.createWork('', project.id)

    expect(() => store.renameProject(project.id, 'After')).not.toThrow()
    expect(fs.existsSync(path.join(fixtureRoot, 'After'))).toBe(true)
    expect(() => store.deleteProject(project.id)).toThrow('project must be empty before deletion')
  })

  it('deletes only an empty project folder', () => {
    const project = store.createProject('Empty')
    store.deleteProject(project.id)
    expect(fs.existsSync(path.join(fixtureRoot, 'Empty'))).toBe(false)
    expect(store.listProjects()).toHaveLength(0)
  })

  it('moves archived conversations to the default workspace and removes a workspace with no visible conversations', () => {
    const project = store.createProject('Archive me')
    const work = store.createWork('Archived conversation', project.id)

    const archived = store.archiveWork(work.id, true)!
    expect(archived.project_id).toBeNull()
    expect(archived.workspace_directory).toBe(path.join(fixtureRoot, 'default'))
    expect(store.cleanupProjectIfNoVisibleWorks(project.id)).toBe(true)
    expect(store.getProject(project.id)).toBeNull()
    expect(fs.existsSync(path.join(fixtureRoot, 'Archive me'))).toBe(false)

    const restored = store.archiveWork(work.id, false)!
    expect(restored.project_id).toBeNull()
    expect(restored.workspace_directory).toBe(path.join(fixtureRoot, 'default'))
  })

  it('preserves files when an archived conversation empties a workspace', () => {
    const project = store.createProject('Keep files')
    const filePath = path.join(fixtureRoot, 'Keep files', 'notes.txt')
    fs.writeFileSync(filePath, 'preserved')
    const work = store.createWork('Archived conversation', project.id)

    store.archiveWork(work.id, true)
    expect(store.cleanupProjectIfNoVisibleWorks(project.id)).toBe(true)
    expect(store.getProject(project.id)).toBeNull()
    expect(fs.readFileSync(filePath, 'utf8')).toBe('preserved')
  })

  it('keeps a workspace while it still contains a visible conversation and cleans it after deletion', () => {
    const project = store.createProject('Delete me when empty')
    const work = store.createWork('Remaining conversation', project.id)

    expect(store.cleanupProjectIfNoVisibleWorks(project.id)).toBe(false)
    expect(store.getProject(project.id)).not.toBeNull()
    store.deleteWork(work.id)
    expect(store.cleanupProjectIfNoVisibleWorks(project.id)).toBe(true)
    expect(store.getProject(project.id)).toBeNull()
  })

  it('groups regular scheduled-task conversations and prunes the oldest with its execution record', () => {
    expect(() => store.createProject('定时任务')).toThrow('定时任务项目由定时任务自动创建')
    const task = store.createScheduledTask({
      title: 'Example schedule', cron_expression: '0 * * * *', prompt_template: 'Fixture prompt', enabled: true, notify_channels: [],
    })
    const oldest = store.createWork('old execution')
    store.createTaskExecution(task.id, oldest.id)
    store.appendMessage(oldest.id, 'user', [{ type: 'text', text: 'Old fixture prompt' }])
    const newest = store.createWork('new execution')
    store.createTaskExecution(task.id, newest.id)
    store.appendMessage(newest.id, 'user', [{ type: 'text', text: 'New fixture prompt' }])

    const history = store.ensureScheduledTaskHistoryProject(1)
    const project = history.project!
    expect(project.name).toBe('定时任务')
    expect(store.getProject(project.id)?.folder_path).toBe(path.join(fixtureRoot, 'scheduled-tasks'))
    expect(fs.existsSync(path.join(fixtureRoot, 'scheduled-tasks'))).toBe(true)
    expect(store.getOrCreateScheduledTaskProject().id).toBe(project.id)
    expect(history.project?.id).toBe(project.id)
    expect(history.movedCount).toBe(2)
    expect(history.prunedIds).toEqual([oldest.id])
    expect(store.getWork(oldest.id)).toBeNull()
    expect(store.getWorkWithMessages(newest.id)?.project_id).toBe(project.id)
    expect(store.getWorkWithMessages(newest.id)?.workspace_directory).toBe(path.join(fixtureRoot, 'scheduled-tasks'))
    expect(store.getWorkWithMessages(newest.id)?.messages).toHaveLength(1)
    expect(store.listTaskExecutions(task.id).map((execution) => execution.work_id)).toEqual([newest.id])
    expect(() => store.renameProject(project.id, 'Other')).toThrow('定时任务项目不能重命名')
    expect(() => store.deleteProject(project.id)).toThrow('定时任务项目不能删除')
  })
})
