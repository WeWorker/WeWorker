import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { LoadedSkillContext } from './skill-context.js'
import { ensureProjectDirectory, ensureUserDirectory, getUserDirectory } from './config.js'
import { listArchivedWorkIds, removeArchivedWork, setWorkArchived } from './conversation-archive.js'

const DB_DIR = path.join(os.homedir(), '.weworker')
const DB_FILE = path.join(DB_DIR, 'works.db')
const SCHEDULED_TASK_PROJECT_NAME = '定时任务'

export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | null

export interface Work {
  id: string
  title: string
  label: LabelColor
  project_id: string | null
  workspace_directory: string
  /** 该任务使用的风格 id（列名沿用历史命名，改列名需要数据迁移）。 */
  zcf_role: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  name: string
  folder_path: string
  created_at: string
  updated_at: string
}

export type ProjectSummary = Omit<Project, 'folder_path'>

export interface Message {
  id: string
  work_id: string
  role: string
  content: ContentBlock[]
  created_at: string
}

export type ContentBlock =
  | LoadedSkillContext
  | { type: 'text'; text: string }
  | { type: 'file_attachment'; name: string; path: string; size?: number; modified_at?: string; mime?: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'tool_use'; id: string; name: string; args: unknown; result?: string; status?: string; image?: string; thinkMs?: number; execMs?: number }
  | { type: 'timing'; totalMs: number; llmMs: number; execMs: number; steps: number; routeTool?: string; routeSource?: string; routeArgs?: string }
  | { type: 'error'; text: string }

export interface WorkWithMessages extends Work {
  messages: Message[]
}

export interface AgentNotificationTarget {
  /** WeCom chat id for a group or user id for a direct message. */
  id: string
  chat_type: 1 | 2
  /** The member whose message let this Agent observe the target. */
  observed_user_id: string
  observed_at: string
}

export interface ScheduledTask {
  id: string
  title: string
  cron_expression: string
  prompt_template: string
  enabled: boolean
  notify_channels: string[]
  /** Present only for a task created through a dedicated Agent. */
  agent_id?: string
  /** The Agent owner who authorized task creation and notification targets. */
  owner_user_id?: string
  /** Explicitly authorized WeCom targets. Never fall back to the last chat. */
  notification_targets?: AgentNotificationTarget[]
  /** A durable Agent-only conversation used as task context across executions. */
  context_work_id?: string
  workspace_directory?: string
  created_at: string
  updated_at: string
}

export interface TaskExecution {
  id: string
  task_id: string
  work_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error_message?: string
  started_at?: string
  completed_at?: string
}

export interface ScheduledTaskWithLastExecution extends ScheduledTask {
  last_execution_status?: string
}

let _db: DatabaseSync | null = null

function db(): DatabaseSync {
  if (_db) return _db
  fs.mkdirSync(DB_DIR, { recursive: true })
  _db = new DatabaseSync(DB_FILE)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      label TEXT DEFAULT NULL,
      project_id TEXT DEFAULT NULL,
      workspace_directory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      folder_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS channel_sessions (
      channel_type TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      PRIMARY KEY (channel_type, external_user_id)
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      notify_channels TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT DEFAULT NULL,
      owner_user_id TEXT DEFAULT NULL,
      notification_targets TEXT NOT NULL DEFAULT '[]',
      context_work_id TEXT DEFAULT NULL,
      workspace_directory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS channel_notify_targets (
      channel_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      extra TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel_type, user_id)
    );
  `)
  // Migration: add label column for existing databases
  try {
    _db.exec('ALTER TABLE works ADD COLUMN label TEXT DEFAULT NULL')
  } catch {
    // Column already exists — ignore
  }
  try {
    _db.exec('ALTER TABLE works ADD COLUMN zcf_role TEXT DEFAULT NULL')
  } catch {
    // Column already exists — ignore
  }
  // 历史列 `zcf_mode`（已移除的工作流模式）保留在 schema 里：删除列属于数据库
  // schema 变更，本次不迁移、不删用户数据；读写侧已不再使用该列。
  try {
    _db.exec('ALTER TABLE works ADD COLUMN zcf_mode TEXT DEFAULT NULL')
  } catch {
    // Column already exists — ignore
  }
  try {
    _db.exec('ALTER TABLE works ADD COLUMN project_id TEXT DEFAULT NULL REFERENCES projects(id) ON DELETE SET NULL')
  } catch {
    // Column already exists — ignore
  }
  for (const statement of [
    "ALTER TABLE works ADD COLUMN workspace_directory TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE scheduled_tasks ADD COLUMN workspace_directory TEXT NOT NULL DEFAULT ''",
  ]) {
    try { _db.exec(statement) } catch { /* column already exists */ }
  }
  const currentRoot = path.resolve(getUserDirectory())
  const legacyRoot = path.resolve(DB_DIR, 'user-files')
  if (currentRoot !== legacyRoot) {
    const projects = _db.prepare('SELECT id, folder_path FROM projects').all() as Array<{ id: string; folder_path: string }>
    for (const project of projects) {
      if (path.resolve(project.folder_path).startsWith(`${legacyRoot}${path.sep}`)) {
        _db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?')
          .run(path.join(currentRoot, path.relative(legacyRoot, project.folder_path)), project.id)
      }
    }
    const works = _db.prepare('SELECT id, workspace_directory FROM works').all() as Array<{ id: string; workspace_directory: string }>
    for (const work of works) {
      if (work.workspace_directory && path.resolve(work.workspace_directory).startsWith(`${legacyRoot}${path.sep}`)) {
        _db.prepare('UPDATE works SET workspace_directory = ? WHERE id = ?')
          .run(path.join(currentRoot, path.relative(legacyRoot, work.workspace_directory)), work.id)
      }
    }
  }
  for (const statement of [
    "ALTER TABLE scheduled_tasks ADD COLUMN agent_id TEXT DEFAULT NULL",
    "ALTER TABLE scheduled_tasks ADD COLUMN owner_user_id TEXT DEFAULT NULL",
    "ALTER TABLE scheduled_tasks ADD COLUMN notification_targets TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE scheduled_tasks ADD COLUMN context_work_id TEXT DEFAULT NULL",
  ]) {
    try { _db.exec(statement) } catch { /* column already exists */ }
  }
  return _db
}

function toProjectSummary(project: Project): ProjectSummary {
  const { folder_path: _folderPath, ...summary } = project
  return summary
}

function normalizeProjectName(value: string): string {
  const name = String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!name || name === '.' || name === '..') throw new Error('project name is required')
  return name.slice(0, 120)
}

function projectFolderPath(name: string): string {
  return path.join(ensureUserDirectory(), name)
}

function assertProjectFolderInsideUserDirectory(folderPath: string): void {
  const root = path.resolve(ensureUserDirectory())
  const target = path.resolve(folderPath)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('project folder must be inside the user directory')
  }
}

export function listProjects(): ProjectSummary[] {
  const projects = db().prepare('SELECT id, name, folder_path, created_at, updated_at FROM projects ORDER BY updated_at DESC').all() as unknown as Project[]
  return projects.map(toProjectSummary)
}

export function getProjectByName(name: string): ProjectSummary | null {
  const row = db().prepare('SELECT id, name, folder_path, created_at, updated_at FROM projects WHERE name = ?').get(name) as Project | undefined
  return row ? toProjectSummary(row) : null
}

export function getOrCreateScheduledTaskProject(): ProjectSummary {
  const folderPath = ensureProjectDirectory('scheduled-tasks')
  const existing = db().prepare('SELECT id, name, folder_path, created_at, updated_at FROM projects WHERE name = ?').get(SCHEDULED_TASK_PROJECT_NAME) as Project | undefined
  if (!existing) return createProjectRecord(SCHEDULED_TASK_PROJECT_NAME, folderPath)

  const previousFolder = path.resolve(existing.folder_path)
  const nextFolder = path.resolve(folderPath)
  if (previousFolder !== nextFolder) {
    const userRoot = path.resolve(ensureUserDirectory())
    if (path.dirname(previousFolder) === userRoot && fs.existsSync(previousFolder)) {
      let legacyFolder = path.join(nextFolder, 'legacy-project')
      let suffix = 1
      while (fs.existsSync(legacyFolder)) {
        legacyFolder = path.join(nextFolder, `legacy-project-${suffix}`)
        suffix += 1
      }
      fs.renameSync(previousFolder, legacyFolder)
    }
    db().prepare('UPDATE projects SET folder_path = ?, updated_at = ? WHERE id = ?').run(nextFolder, new Date().toISOString(), existing.id)
  }

  db().prepare('UPDATE scheduled_tasks SET workspace_directory = ? WHERE workspace_directory != ?').run(nextFolder, nextFolder)
  return toProjectSummary(getProject(existing.id)!)
}

export function moveScheduledTaskWorksToProject(projectId: string): number {
  const project = getProject(projectId)
  if (!project) throw new Error('project not found')
  const result = db().prepare(`
    UPDATE works SET project_id = ?, workspace_directory = ?
    WHERE id IN (
      SELECT te.work_id
      FROM task_executions te
      JOIN scheduled_tasks st ON st.id = te.task_id
      WHERE st.agent_id IS NULL
    ) AND (project_id IS NULL OR project_id != ? OR workspace_directory != ?)
  `).run(projectId, project.folder_path, projectId, project.folder_path)
  return Number(result.changes)
}

export function ensureScheduledTaskHistoryProject(limit: number, options: { createIfMissing?: boolean } = {}): {
  project: ProjectSummary | null
  movedCount: number
  prunedIds: string[]
} {
  const existingProject = getProjectByName('定时任务')
  const executionCount = db().prepare(`
    SELECT COUNT(DISTINCT te.work_id) AS count
    FROM task_executions te
    JOIN scheduled_tasks st ON st.id = te.task_id
    WHERE st.agent_id IS NULL
  `).get() as { count: number }
  const taskCount = db().prepare('SELECT COUNT(*) AS count FROM scheduled_tasks').get() as { count: number }
  if (!existingProject && !options.createIfMissing && executionCount.count === 0 && taskCount.count === 0) {
    return { project: null, movedCount: 0, prunedIds: [] }
  }

  const project = getOrCreateScheduledTaskProject()
  const movedCount = moveScheduledTaskWorksToProject(project.id)
  const prunedIds = pruneScheduledTaskWorks(project.id, limit)
  return { project, movedCount, prunedIds }
}

export function pruneScheduledTaskWorks(projectId: string, limit: number): string[] {
  const keep = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)))
  const rows = db().prepare(`
    SELECT w.id
    FROM works w
    WHERE w.project_id = ?
      AND EXISTS (
        SELECT 1
        FROM task_executions te
        JOIN scheduled_tasks st ON st.id = te.task_id
        WHERE te.work_id = w.id AND st.agent_id IS NULL
      )
    ORDER BY w.created_at ASC, w.rowid ASC
  `).all(projectId) as Array<{ id: string }>
  const removeIds = rows.slice(0, Math.max(0, rows.length - keep)).map((row) => row.id)
  if (removeIds.length === 0) return []

  const database = db()
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const id of removeIds) {
      database.prepare('DELETE FROM task_executions WHERE work_id = ?').run(id)
      database.prepare('DELETE FROM messages WHERE work_id = ?').run(id)
      database.prepare('DELETE FROM works WHERE id = ?').run(id)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  for (const id of removeIds) removeArchivedWork(id)
  return removeIds
}

export function getProject(id: string): Project | null {
  return (db().prepare('SELECT id, name, folder_path, created_at, updated_at FROM projects WHERE id = ?').get(id) as unknown as Project) ?? null
}

function createProjectRecord(rawName: string, requestedFolderPath?: string): ProjectSummary {
  const name = normalizeProjectName(rawName)
  const folderPath = requestedFolderPath ? path.resolve(requestedFolderPath) : projectFolderPath(name)
  if (requestedFolderPath) {
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) throw new Error('project folder must exist')
  } else {
    assertProjectFolderInsideUserDirectory(folderPath)
    if (fs.existsSync(folderPath)) throw new Error('project folder already exists')
    fs.mkdirSync(folderPath)
  }
  const now = new Date().toISOString()
  const project: Project = { id: randomUUID(), name, folder_path: folderPath, created_at: now, updated_at: now }
  try {
    db().prepare('INSERT INTO projects (id, name, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      project.id, project.name, project.folder_path, project.created_at, project.updated_at,
    )
  } catch (error) {
    if (!requestedFolderPath) fs.rmdirSync(folderPath)
    throw error
  }
  return toProjectSummary(project)
}

export function createProject(rawName: string, requestedFolderPath?: string): ProjectSummary {
  const name = normalizeProjectName(rawName)
  if (name === SCHEDULED_TASK_PROJECT_NAME) throw new Error('定时任务项目由定时任务自动创建')
  return createProjectRecord(name, requestedFolderPath)
}

export function renameProject(id: string, rawName: string): ProjectSummary | null {
  const project = getProject(id)
  if (!project) return null
  if (project.name === SCHEDULED_TASK_PROJECT_NAME) throw new Error('定时任务项目不能重命名')
  const name = normalizeProjectName(rawName)
  if (name === SCHEDULED_TASK_PROJECT_NAME) throw new Error('定时任务项目由定时任务自动创建')
  if (name === project.name) return toProjectSummary(project)
  const projectInsideRoot = path.resolve(project.folder_path).startsWith(`${path.resolve(ensureUserDirectory())}${path.sep}`)
  const nextFolderPath = path.join(path.dirname(project.folder_path), name)
  if (projectInsideRoot) assertProjectFolderInsideUserDirectory(nextFolderPath)
  if (fs.existsSync(nextFolderPath)) throw new Error('project folder already exists')
  fs.renameSync(project.folder_path, nextFolderPath)
  const updatedAt = new Date().toISOString()
  try {
    db().prepare('UPDATE projects SET name = ?, folder_path = ?, updated_at = ? WHERE id = ?').run(name, nextFolderPath, updatedAt, id)
  } catch (error) {
    try { fs.renameSync(nextFolderPath, project.folder_path) } catch { /* preserve original error */ }
    throw error
  }
  return { id: project.id, name, created_at: project.created_at, updated_at: updatedAt }
}

export function deleteProject(id: string): void {
  const project = getProject(id)
  if (!project) throw new Error('project not found')
  if (project.name === SCHEDULED_TASK_PROJECT_NAME) throw new Error('定时任务项目不能删除')
  const archivedIds = new Set(listArchivedWorkIds())
  const works = db().prepare('SELECT id FROM works WHERE project_id = ?').all(id) as Array<{ id: string }>
  if (works.some((work) => !archivedIds.has(work.id))) throw new Error('project must be empty before deletion')
  if (works.length > 0) {
    const defaultDirectory = ensureProjectDirectory('default')
    db().prepare('UPDATE works SET project_id = NULL, workspace_directory = ? WHERE project_id = ?').run(defaultDirectory, id)
  }
  const projectInsideRoot = path.resolve(project.folder_path).startsWith(`${path.resolve(ensureUserDirectory())}${path.sep}`)
  if (projectInsideRoot && fs.existsSync(project.folder_path)) {
    const entries = fs.readdirSync(project.folder_path)
    if (entries.length > 0) throw new Error('project folder must be empty before deletion')
    fs.rmdirSync(project.folder_path)
  }
  db().prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function createWork(title = '', projectId: string | null = null, workspaceDirectory?: string): Work {
  if (projectId && !getProject(projectId)) throw new Error('project not found')
  const now = new Date().toISOString()
  const id = randomUUID()
  const directory = workspaceDirectory || (projectId ? getProject(projectId)!.folder_path : ensureProjectDirectory('default'))
  db().prepare('INSERT INTO works (id, title, project_id, workspace_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, title, projectId, directory, now, now)
  return { id, title, label: null, project_id: projectId, workspace_directory: directory, zcf_role: null, created_at: now, updated_at: now }
}

export function updateWorkStyle(
  id: string,
  prefs: { zcf_role?: string | null },
): Work | null {
  const work = getWork(id)
  if (!work) return null
  const zcf_role = prefs.zcf_role !== undefined ? prefs.zcf_role : work.zcf_role
  const now = new Date().toISOString()
  db().prepare('UPDATE works SET zcf_role = ?, updated_at = ? WHERE id = ?').run(
    zcf_role,
    now,
    id,
  )
  return { ...work, zcf_role, updated_at: now }
}

/** 显式投影：`SELECT *` 会带回已废弃的历史列（如 zcf_mode），API 响应不再透出它们。 */
function toWork(row: Record<string, unknown>): Work {
  return {
    id: row.id as string,
    title: (row.title as string) ?? '',
    label: (row.label as LabelColor) ?? null,
    project_id: (row.project_id as string | null) ?? null,
    workspace_directory: String(row.workspace_directory || (row.project_id ? getProject(String(row.project_id))?.folder_path : ensureProjectDirectory('default'))),
    zcf_role: (row.zcf_role as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export function listWorks(): Work[] {
  const rows = db().prepare('SELECT * FROM works ORDER BY updated_at DESC').all() as unknown as Array<Record<string, unknown>>
  return rows.map(toWork)
}

export function listArchivedWorks(): Work[] {
  const ids = listArchivedWorkIds()
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db().prepare(`SELECT * FROM works WHERE id IN (${placeholders}) ORDER BY updated_at DESC`).all(...ids) as unknown as Array<Record<string, unknown>>
  return rows.map(toWork)
}

export function archiveWork(workId: string, archived: boolean): Work | null {
  const work = getWork(workId)
  if (!work) return null
  setWorkArchived(workId, archived)
  const defaultDirectory = ensureProjectDirectory('default')
  db().prepare('UPDATE works SET project_id = NULL, workspace_directory = ? WHERE id = ?').run(defaultDirectory, workId)
  return getWork(workId)
}

/** Remove an empty user project from the sidebar while preserving any files in its folder. */
export function cleanupProjectIfNoVisibleWorks(projectId: string): boolean {
  const project = getProject(projectId)
  if (!project || project.name === SCHEDULED_TASK_PROJECT_NAME) return false
  const archivedIds = new Set(listArchivedWorkIds())
  const works = db().prepare('SELECT id FROM works WHERE project_id = ?').all(projectId) as Array<{ id: string }>
  if (works.some((work) => !archivedIds.has(work.id))) return false

  if (works.length > 0) {
    const defaultDirectory = ensureProjectDirectory('default')
    db().prepare('UPDATE works SET project_id = NULL, workspace_directory = ? WHERE project_id = ?').run(defaultDirectory, projectId)
  }

  const root = path.resolve(ensureUserDirectory())
  const folder = path.resolve(project.folder_path)
  if (folder.startsWith(`${root}${path.sep}`) && fs.existsSync(folder)) {
    try {
      if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder)
    } catch {
      // Keep the folder and its contents if it cannot be removed safely.
    }
  }
  db().prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  return true
}

export function getWork(id: string): Work | null {
  const row = db().prepare('SELECT * FROM works WHERE id = ?').get(id) as unknown as Record<string, unknown> | undefined
  return row ? toWork(row) : null
}

export function getWorkspaceDirectoryForWork(id: string): string | null {
  return getWork(id)?.workspace_directory ?? null
}

export function getWorkWithMessages(id: string): WorkWithMessages | null {
  const work = getWork(id)
  if (!work) return null
  const rows = db().prepare('SELECT * FROM messages WHERE work_id = ? ORDER BY created_at ASC, rowid ASC').all(id) as Array<{
    id: string; work_id: string; role: string; content: string; created_at: string
  }>
  const messages: Message[] = rows.map(r => ({
    ...r,
    content: JSON.parse(r.content) as ContentBlock[],
  }))
  return { ...work, messages }
}

export function appendMessage(workId: string, role: string, content: ContentBlock[], external = false): Message {
  const now = new Date().toISOString()
  const id = randomUUID()
  db().prepare('INSERT INTO messages (id, work_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, workId, role, JSON.stringify(content), now
  )
  db().prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now, workId)
  if (external) {
    // Signal external write for polling
    db().prepare('UPDATE works SET updated_at = ? WHERE id = ?').run(now, workId)
  }
  return { id, work_id: workId, role, content, created_at: now }
}

/** Update an owned assistant segment without changing its position in the conversation. */
export function updateAssistantMessageContent(workId: string, messageId: string, content: ContentBlock[]): boolean {
  const result = db().prepare("UPDATE messages SET content = ? WHERE id = ? AND work_id = ? AND role = 'assistant'").run(
    JSON.stringify(content), messageId, workId,
  )
  return Number(result.changes) > 0
}

export function updateTitle(workId: string, title: string): void {
  db().prepare('UPDATE works SET title = ?, updated_at = ? WHERE id = ?').run(title, new Date().toISOString(), workId)
}

export function updateTitlePreserveOrder(workId: string, title: string): void {
  db().prepare('UPDATE works SET title = ? WHERE id = ?').run(title, workId)
}

export function updateLabel(workId: string, label: LabelColor): void {
  db().prepare('UPDATE works SET label = ?, updated_at = ? WHERE id = ?').run(label, new Date().toISOString(), workId)
}

export function deleteWork(workId: string): void {
  removeArchivedWork(workId)
  db().prepare('DELETE FROM messages WHERE work_id = ?').run(workId)
  db().prepare('DELETE FROM works WHERE id = ?').run(workId)
}

export function deleteMessages(messageIds: string[]): void {
  if (messageIds.length === 0) return
  const placeholders = messageIds.map(() => '?').join(',')
  db().prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...messageIds)
}

export function getOrCreateChannelWork(
  channelType: string,
  externalUserId: string,
  displayName: string,
  projectId: string | null = null,
): { work: Work; created: boolean } {
  const row = db().prepare('SELECT work_id FROM channel_sessions WHERE channel_type = ? AND external_user_id = ?').get(
    channelType, externalUserId
  ) as { work_id: string } | undefined

  if (row) {
    const work = getWork(row.work_id)
    if (work) return { work, created: false }
  }

  const work = createWork(displayName, projectId)
  db().prepare('INSERT OR REPLACE INTO channel_sessions (channel_type, external_user_id, work_id) VALUES (?, ?, ?)').run(
    channelType, externalUserId, work.id
  )
  return { work, created: true }
}

export function resetChannelWork(channelType: string, externalUserId: string, displayName = '', projectId: string | null = null): Work {
  db().prepare('DELETE FROM channel_sessions WHERE channel_type = ? AND external_user_id = ?').run(channelType, externalUserId)
  const work = createWork(displayName, projectId)
  db().prepare('INSERT INTO channel_sessions (channel_type, external_user_id, work_id) VALUES (?, ?, ?)').run(
    channelType, externalUserId, work.id
  )
  return work
}

/** Bind an external channel user to an existing desktop-visible work. */
export function bindChannelWork(channelType: string, externalUserId: string, workId: string): Work | null {
  const work = getWork(workId)
  if (!work) return null
  db().prepare('INSERT OR REPLACE INTO channel_sessions (channel_type, external_user_id, work_id) VALUES (?, ?, ?)').run(
    channelType, externalUserId, work.id
  )
  return work
}

// Track last external write timestamp for polling
let _lastExternalWrite = ''

export function markExternalWrite(): void {
  _lastExternalWrite = new Date().toISOString()
}

export function getLastExternalWrite(): string {
  return _lastExternalWrite
}


// --- Scheduled Tasks CRUD ---

function rowToScheduledTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    title: row.title as string,
    cron_expression: row.cron_expression as string,
    prompt_template: row.prompt_template as string,
    enabled: (row.enabled as number) === 1,
    notify_channels: JSON.parse(row.notify_channels as string) as string[],
    agent_id: typeof row.agent_id === 'string' && row.agent_id ? row.agent_id : undefined,
    owner_user_id: typeof row.owner_user_id === 'string' && row.owner_user_id ? row.owner_user_id : undefined,
    notification_targets: (() => {
      try { return JSON.parse(String(row.notification_targets ?? '[]')) as AgentNotificationTarget[] } catch { return [] }
    })(),
    context_work_id: typeof row.context_work_id === 'string' && row.context_work_id ? row.context_work_id : undefined,
    workspace_directory: String(row.workspace_directory || ''),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

export function createScheduledTask(
  task: Omit<ScheduledTask, 'id' | 'created_at' | 'updated_at'>
): ScheduledTask {
  const now = new Date().toISOString()
  const id = randomUUID()
  const project = getOrCreateScheduledTaskProject()
  const workspaceDirectory = getProject(project.id)!.folder_path
  db()
    .prepare(
      'INSERT INTO scheduled_tasks (id, title, cron_expression, prompt_template, enabled, notify_channels, agent_id, owner_user_id, notification_targets, context_work_id, workspace_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      id,
      task.title,
      task.cron_expression,
      task.prompt_template,
      task.enabled ? 1 : 0,
      JSON.stringify(task.notify_channels),
      task.agent_id ?? null,
      task.owner_user_id ?? null,
      JSON.stringify(task.notification_targets ?? []),
      task.context_work_id ?? null,
      workspaceDirectory,
      now,
      now
    )
  return {
    id,
    title: task.title,
    cron_expression: task.cron_expression,
    prompt_template: task.prompt_template,
    enabled: task.enabled,
    notify_channels: task.notify_channels,
    agent_id: task.agent_id,
    owner_user_id: task.owner_user_id,
    notification_targets: task.notification_targets ?? [],
    context_work_id: task.context_work_id,
    workspace_directory: workspaceDirectory,
    created_at: now,
    updated_at: now,
  }
}

export function ensureScheduledTaskWorkspace(taskId: string): string {
  const task = getScheduledTask(taskId)
  if (!task) throw new Error('task not found')
  const project = getOrCreateScheduledTaskProject()
  const directory = getProject(project.id)!.folder_path
  if (path.resolve(task.workspace_directory || '') !== path.resolve(directory)) {
    db().prepare('UPDATE scheduled_tasks SET workspace_directory = ? WHERE id = ?').run(directory, taskId)
  }
  return directory
}

export function listScheduledTasks(): ScheduledTaskWithLastExecution[] {
  const rows = db()
    .prepare(
      `SELECT st.*, le.status AS last_execution_status
       FROM scheduled_tasks st
       LEFT JOIN (
         SELECT task_id, status
         FROM task_executions te1
         WHERE te1.started_at = (
           SELECT MAX(te2.started_at)
           FROM task_executions te2
           WHERE te2.task_id = te1.task_id
         )
       ) le ON le.task_id = st.id
       ORDER BY st.created_at DESC`
    )
    .all() as Array<Record<string, unknown>>

  return rows.map((row) => ({
    ...rowToScheduledTask(row),
    last_execution_status: (row.last_execution_status as string) ?? undefined,
  }))
}

export function listScheduledTasksForAgent(agentId: string): ScheduledTaskWithLastExecution[] {
  return listScheduledTasks().filter((task) => task.agent_id === agentId)
}

export function getScheduledTask(id: string): ScheduledTask | null {
  const row = db()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return rowToScheduledTask(row)
}

export function updateScheduledTask(
  id: string,
  updates: Partial<Pick<ScheduledTask, 'title' | 'cron_expression' | 'prompt_template' | 'enabled' | 'notify_channels' | 'notification_targets'>>
): ScheduledTask | null {
  const existing = getScheduledTask(id)
  if (!existing) return null

  const setClauses: string[] = []
  const values: SQLInputValue[] = []

  if (updates.title !== undefined) {
    setClauses.push('title = ?')
    values.push(updates.title)
  }
  if (updates.cron_expression !== undefined) {
    setClauses.push('cron_expression = ?')
    values.push(updates.cron_expression)
  }
  if (updates.prompt_template !== undefined) {
    setClauses.push('prompt_template = ?')
    values.push(updates.prompt_template)
  }
  if (updates.enabled !== undefined) {
    setClauses.push('enabled = ?')
    values.push(updates.enabled ? 1 : 0)
  }
  if (updates.notify_channels !== undefined) {
    setClauses.push('notify_channels = ?')
    values.push(JSON.stringify(updates.notify_channels))
  }
  if (updates.notification_targets !== undefined) {
    setClauses.push('notification_targets = ?')
    values.push(JSON.stringify(updates.notification_targets))
  }

  if (setClauses.length === 0) return existing

  const now = new Date().toISOString()
  setClauses.push('updated_at = ?')
  values.push(now)
  values.push(id)

  db()
    .prepare(`UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values)

  return getScheduledTask(id)
}

export function deleteScheduledTask(id: string): void {
  db().prepare('DELETE FROM task_executions WHERE task_id = ?').run(id)
  db().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}

export function getEnabledScheduledTasks(): ScheduledTask[] {
  const rows = db()
    .prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1')
    .all() as Array<Record<string, unknown>>
  return rows.map(rowToScheduledTask)
}

// --- Task Executions CRUD ---

export function createTaskExecution(taskId: string, workId: string): TaskExecution {
  const id = randomUUID()
  const startedAt = new Date().toISOString()
  db()
    .prepare(
      'INSERT INTO task_executions (id, task_id, work_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, taskId, workId, 'pending', startedAt)
  return {
    id,
    task_id: taskId,
    work_id: workId,
    status: 'pending',
    started_at: startedAt,
  }
}

export function updateTaskExecution(
  id: string,
  updates: Partial<Pick<TaskExecution, 'status' | 'error_message' | 'completed_at'>>
): void {
  const setClauses: string[] = []
  const values: SQLInputValue[] = []

  if (updates.status !== undefined) {
    setClauses.push('status = ?')
    values.push(updates.status)
  }
  if (updates.error_message !== undefined) {
    setClauses.push('error_message = ?')
    values.push(updates.error_message)
  }
  if (updates.completed_at !== undefined) {
    setClauses.push('completed_at = ?')
    values.push(updates.completed_at)
  }

  if (setClauses.length === 0) return

  values.push(id)
  db()
    .prepare(`UPDATE task_executions SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values)
}

export function listTaskExecutions(taskId: string): TaskExecution[] {
  const rows = db()
    .prepare('SELECT * FROM task_executions WHERE task_id = ? ORDER BY started_at DESC')
    .all(taskId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id as string,
    task_id: row.task_id as string,
    work_id: row.work_id as string,
    status: row.status as TaskExecution['status'],
    error_message: (row.error_message as string) ?? undefined,
    started_at: (row.started_at as string) ?? undefined,
    completed_at: (row.completed_at as string) ?? undefined,
  }))
}


// --- Channel Notify Targets ---

export interface ChannelNotifyTarget {
  channel_type: string
  user_id: string
  extra: Record<string, string>
  updated_at: string
}

/** Upsert a channel notify target (called when a user sends a message via channel) */
export function saveChannelNotifyTarget(
  channelType: string,
  userId: string,
  extra: Record<string, string> = {},
): void {
  const now = new Date().toISOString()
  db()
    .prepare(
      'INSERT OR REPLACE INTO channel_notify_targets (channel_type, user_id, extra, updated_at) VALUES (?, ?, ?, ?)'
    )
    .run(channelType, userId, JSON.stringify(extra), now)
}

/** Get the most recent notify target for a channel type */
export function getLatestChannelNotifyTarget(channelType: string): ChannelNotifyTarget | null {
  const row = db()
    .prepare('SELECT * FROM channel_notify_targets WHERE channel_type = ? ORDER BY updated_at DESC LIMIT 1')
    .get(channelType) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    channel_type: row.channel_type as string,
    user_id: row.user_id as string,
    extra: JSON.parse(row.extra as string) as Record<string, string>,
    updated_at: row.updated_at as string,
  }
}

/** All observed targets for an Agent channel, newest first. */
export function listChannelNotifyTargets(channelType: string): ChannelNotifyTarget[] {
  const rows = db().prepare('SELECT * FROM channel_notify_targets WHERE channel_type = ? ORDER BY updated_at DESC').all(channelType) as Array<Record<string, unknown>>
  return rows.map((row) => {
    let extra: Record<string, string> = {}
    try { extra = JSON.parse(String(row.extra ?? '{}')) as Record<string, string> } catch { /* malformed legacy row */ }
    return { channel_type: String(row.channel_type), user_id: String(row.user_id), extra, updated_at: String(row.updated_at) }
  })
}

/** Return the current database instance (for testing only). */
export function _getTestDb(): DatabaseSync {
  return db()
}

/** Reset the database to a fresh in-memory instance (for testing only). */
export function _initTestDb(): void {
  if (_db) {
    _db.close()
  }
  _db = new DatabaseSync(':memory:')
  _db.exec('PRAGMA foreign_keys = ON')
  _db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      label TEXT DEFAULT NULL,
      project_id TEXT DEFAULT NULL,
      workspace_directory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      folder_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS channel_sessions (
      channel_type TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      PRIMARY KEY (channel_type, external_user_id)
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      notify_channels TEXT NOT NULL DEFAULT '[]',
      agent_id TEXT DEFAULT NULL,
      owner_user_id TEXT DEFAULT NULL,
      notification_targets TEXT NOT NULL DEFAULT '[]',
      context_work_id TEXT DEFAULT NULL,
      workspace_directory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS channel_notify_targets (
      channel_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      extra TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel_type, user_id)
    );
  `)
}
