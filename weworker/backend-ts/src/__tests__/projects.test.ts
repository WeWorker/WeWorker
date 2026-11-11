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
  ensureProjectsDirectory: () => {
    const directory = path.join(fixtureRoot, 'projects')
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  ensureProjectDirectory: (...segments: string[]) => {
    const directory = path.join(fixtureRoot, 'projects', ...segments)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  expandHomePath: (value: string) => value,
  getConfigDirectory: () => path.join(fixtureRoot, '.weworker'),
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
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'Demo Project'))).toBe(true)

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

  it('creates a missing generated folder when it is inside the projects directory', () => {
    const selectedDirectory = path.join(fixtureRoot, 'projects', 'workspace-fixture')
    const project = store.createProject('Generated Project', selectedDirectory)

    expect(store.getProject(project.id)?.folder_path).toBe(selectedDirectory)
    expect(fs.existsSync(selectedDirectory)).toBe(true)
  })

  it('creates one shared scheduled task project workspace on demand', () => {
    const work = store.createWork('Default workspace')
    expect(work.workspace_directory).toBe(path.join(fixtureRoot, 'projects', 'default'))
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
    expect(task.workspace_directory).toBe(path.join(fixtureRoot, 'projects', 'scheduled-tasks'))
    expect(nextTask.workspace_directory).toBe(task.workspace_directory)
    expect(store.getProject(project.id)?.folder_path).toBe(task.workspace_directory)
    expect(fs.existsSync(task.workspace_directory!)).toBe(true)
  })

  it('keeps legacy scheduled task projects and workspaces at their recorded locations', () => {
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
    fs.mkdirSync(legacyTaskDirectory, { recursive: true })
    fs.writeFileSync(path.join(legacyProjectDirectory, 'project-file.txt'), 'preserved')
    fs.writeFileSync(path.join(legacyTaskDirectory, 'task-file.txt'), 'preserved')

    const database = store._getTestDb()
    database.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(legacyProjectDirectory, project.id)
    database.prepare('UPDATE scheduled_tasks SET workspace_directory = ? WHERE id = ?').run(legacyTaskDirectory, task.id)
    const work = store.createWork('Legacy scheduled run', project.id)
    store.createTaskExecution(task.id, work.id)

    const history = store.ensureScheduledTaskHistoryProject(10)
    expect(history.project?.id).toBe(project.id)
    expect(store.getProject(project.id)?.folder_path).toBe(legacyProjectDirectory)
    expect(store.getScheduledTask(task.id)?.workspace_directory).toBe(legacyTaskDirectory)
    expect(store.ensureScheduledTaskWorkspace(task.id)).toBe(legacyTaskDirectory)
    expect(store.getWork(work.id)?.workspace_directory).toBe(legacyProjectDirectory)
    expect(fs.readFileSync(path.join(legacyProjectDirectory, 'project-file.txt'), 'utf8')).toBe('preserved')
    expect(fs.readFileSync(path.join(legacyTaskDirectory, 'task-file.txt'), 'utf8')).toBe('preserved')
  })

  it('renames the project folder and rejects deletion while it has conversations', () => {
    const project = store.createProject('Before')
    store.createWork('', project.id)

    expect(() => store.renameProject(project.id, 'After')).not.toThrow()
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'After'))).toBe(true)
    expect(() => store.deleteProject(project.id)).toThrow('project must be empty before deletion')
  })

  it('removes the project record and keeps its folder', () => {
    const project = store.createProject('Empty')
    const folder = store.getProject(project.id)!.folder_path
    store.deleteProject(project.id)
    expect(store.listProjects()).toHaveLength(0)
    expect(fs.existsSync(folder)).toBe(true)
  })

  it('keeps project files when the project record is deleted', () => {
    const project = store.createProject('Keep mine')
    const folder = store.getProject(project.id)!.folder_path
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'mine')
    store.deleteProject(project.id)
    expect(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8')).toBe('mine')
    expect(store.listProjects()).toHaveLength(0)
  })

  it('does not clean up the project when a conversation is archived', () => {
    const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    const start = source.indexOf("app.patch('/works/:id/archive'")
    const end = source.indexOf("app.get('/projects'", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const route = source.slice(start, end)
    expect(route).toContain('archiveWork')
    expect(route).not.toContain('cleanupProjectIfNoVisibleWorks')
  })

  it('moves archived conversations to the default workspace and removes an empty project record without deleting the folder', () => {
    const project = store.createProject('Archive me')
    const folder = store.getProject(project.id)!.folder_path
    const work = store.createWork('Archived conversation', project.id)

    const archived = store.archiveWork(work.id, true)!
    expect(archived.project_id).toBeNull()
    expect(archived.workspace_directory).toBe(path.join(fixtureRoot, 'projects', 'default'))
    expect(store.cleanupProjectIfNoVisibleWorks(project.id)).toBe(true)
    expect(store.getProject(project.id)).toBeNull()
    expect(fs.existsSync(folder)).toBe(true)

    const restored = store.archiveWork(work.id, false)!
    expect(restored.project_id).toBeNull()
    expect(restored.workspace_directory).toBe(path.join(fixtureRoot, 'projects', 'default'))
  })

  it('preserves files when an archived conversation empties a workspace', () => {
    const project = store.createProject('Keep files')
    const folder = store.getProject(project.id)!.folder_path
    const filePath = path.join(folder, 'notes.txt')
    fs.writeFileSync(filePath, 'preserved')
    const work = store.createWork('Archived conversation', project.id)

    store.archiveWork(work.id, true)
    expect(store.cleanupProjectIfNoVisibleWorks(project.id)).toBe(true)
    expect(store.getProject(project.id)).toBeNull()
    expect(fs.readFileSync(filePath, 'utf8')).toBe('preserved')
    expect(fs.existsSync(folder)).toBe(true)
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
    store.updateTaskExecution(store.createTaskExecution(task.id, oldest.id).id, { status: 'completed' })
    store.appendMessage(oldest.id, 'user', [{ type: 'text', text: 'Old fixture prompt' }])
    const newest = store.createWork('new execution')
    store.updateTaskExecution(store.createTaskExecution(task.id, newest.id).id, { status: 'completed' })
    store.appendMessage(newest.id, 'user', [{ type: 'text', text: 'New fixture prompt' }])

    const history = store.ensureScheduledTaskHistoryProject(1)
    const project = history.project!
    expect(project.name).toBe('定时任务')
    expect(store.getProject(project.id)?.folder_path).toBe(path.join(fixtureRoot, 'projects', 'scheduled-tasks'))
    expect(fs.existsSync(path.join(fixtureRoot, 'projects', 'scheduled-tasks'))).toBe(true)
    expect(store.getOrCreateScheduledTaskProject().id).toBe(project.id)
    expect(history.project?.id).toBe(project.id)
    expect(history.movedCount).toBe(2)
    expect(history.prunedIds).toEqual([oldest.id])
    expect(store.getWork(oldest.id)).toBeNull()
    expect(store.getWorkWithMessages(newest.id)?.project_id).toBe(project.id)
    expect(store.getWorkWithMessages(newest.id)?.workspace_directory).toBe(newest.workspace_directory)
    expect(store.getWorkWithMessages(newest.id)?.messages).toHaveLength(1)
    expect(store.listTaskExecutions(task.id).map((execution) => execution.work_id)).toEqual([newest.id])
    expect(() => store.renameProject(project.id, 'Other')).toThrow('定时任务项目不能重命名')
    expect(() => store.deleteProject(project.id)).toThrow('定时任务项目不能删除')
  })

  it('retains running and pending conversations while pruning older completed history', () => {
    const task = store.createScheduledTask({ title: 'Fixture schedule', cron_expression: '0 * * * *', prompt_template: 'Fixture prompt', enabled: true, notify_channels: [] })
    const project = store.getProjectByName('定时任务')!
    const running = store.createWork('Running fixture', project.id)
    const runningExecution = store.createTaskExecution(task.id, running.id)
    store.updateTaskExecution(runningExecution.id, { status: 'running' })
    const pending = store.createWork('Pending fixture', project.id)
    const pendingExecution = store.createTaskExecution(task.id, pending.id)
    const finished = store.createWork('Finished fixture', project.id)
    store.updateTaskExecution(store.createTaskExecution(task.id, finished.id).id, { status: 'completed' })

    expect(store.pruneScheduledTaskWorks(project.id, 1)).toEqual([])
    expect(store.getWork(running.id)).not.toBeNull()
    expect(store.getWork(pending.id)).not.toBeNull()
    store.updateTaskExecution(runningExecution.id, { status: 'completed' })
    store.updateTaskExecution(pendingExecution.id, { status: 'completed' })
    expect(store.pruneScheduledTaskWorks(project.id, 1)).toEqual([running.id, pending.id])
    expect(store.getWork(finished.id)).not.toBeNull()
  })

  it('counts history from deleted schedules but excludes dedicated-agent context and other projects', () => {
    const task = store.createScheduledTask({ title: 'Removed fixture', cron_expression: '0 * * * *', prompt_template: 'Fixture prompt', enabled: true, notify_channels: [] })
    const project = store.getProjectByName('定时任务')!
    const orphan = store.createWork('History of a removed schedule', project.id)
    archiveState.ids.add(orphan.id)
    const filePath = path.join(orphan.workspace_directory!, 'fixture-result.txt')
    fs.writeFileSync(filePath, 'preserve task output')
    store.appendMessage(orphan.id, 'user', [{ type: 'text', text: 'Fixture message' }])
    store.createTaskExecution(task.id, orphan.id)
    store.deleteScheduledTask(task.id)
    const durable = store.createWork('Dedicated context', project.id)
    const agentTask = store.createScheduledTask({ title: 'Agent fixture', cron_expression: '0 * * * *', prompt_template: 'Fixture prompt', enabled: true, notify_channels: [], agent_id: 'fixture-agent', context_work_id: durable.id })
    store.updateTaskExecution(store.createTaskExecution(agentTask.id, durable.id).id, { status: 'completed' })
    const newest = store.createWork('Newest schedule history', project.id)
    const unrelated = store.createWork('Other workspace')

    expect(store.pruneScheduledTaskWorks(project.id, 1)).toEqual([orphan.id])
    expect(store.getWorkWithMessages(orphan.id)).toBeNull()
    expect(archiveState.ids.has(orphan.id)).toBe(false)
    expect(store._getTestDb().prepare('SELECT COUNT(*) AS count FROM messages WHERE work_id = ?').get(orphan.id)).toEqual({ count: 0 })
    expect(fs.readFileSync(filePath, 'utf8')).toBe('preserve task output')
    expect(store.getWork(durable.id)).not.toBeNull()
    expect(store.getWork(newest.id)).not.toBeNull()
    expect(store.getWork(unrelated.id)).not.toBeNull()
  })
})

describe('interrupted scheduled task recovery', () => {
  it('marks leftover executions failed and then prunes the reserved project', () => {
    const project = store.ensureScheduledTaskHistoryProject(2, { createIfMissing: true }).project!
    const task = store.createScheduledTask({
      title: 'Fixture schedule', cron_expression: '0 * * * *', prompt_template: 'Fixture prompt',
      enabled: true, notify_channels: [],
    })
    for (let index = 0; index < 3; index += 1) {
      const work = store.createWork(`运行 ${index}`, project.id)
      store.createTaskExecution(task.id, work.id)
    }
    expect(store.listTaskExecutions(task.id).filter(item => item.status === 'pending')).toHaveLength(3)

    const recovered = store.recoverInterruptedScheduledTasks(2)
    expect(recovered.failed).toBe(3)
    // 中断的执行先被收尾，随后按上限清理（至少删掉一条）。
    expect(recovered.pruned).toBeGreaterThan(0)
    expect(store.listTaskExecutions(task.id).every(item => item.status === 'failed')).toBe(true)
  })
})