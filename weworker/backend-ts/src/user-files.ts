import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import {
  ensureUserDirectory,
  expandHomePath,
  getMaxChatAttachments,
} from './config.js'
import { isPathBlockedByBlacklist } from './user-directory-guard.js'
import type { ContentBlock } from './works-store.js'

export type UserFileEntry = {
  name: string
  path: string
  size: number
  modified_at: string
  is_directory: boolean
  children?: UserFileEntry[]
}

type UserFileImportJobStatus = 'pending' | 'running' | 'done' | 'error'

export type UserFileImportJob = {
  id: string
  status: UserFileImportJobStatus
  directory: string
  target_directory: string
  total_bytes: number
  copied_bytes: number
  total_files: number
  copied_files: number
  current_file: string | null
  files: UserFileEntry[]
  error: string | null
  created_at: string
  updated_at: string
}

type ImportSource = {
  path: string
  resolved: string
  size: number
  files: number
}

const IMPORT_JOB_TTL_MS = 10 * 60 * 1000
const importJobs = new Map<string, UserFileImportJob>()
const importJobCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function listUserFiles(workspaceRoot?: string): { directory: string; files: UserFileEntry[] } {
  const directory = ensureWorkspaceRoot(workspaceRoot)
  return { directory, files: listUserFileTree(directory) }
}

export function createUserFolder(parentPath: string | undefined, name: string, workspaceRoot?: string): { directory: string; folder: UserFileEntry } {
  const folderName = safeItemName(name || '')
  if (!folderName) throw new Error('folder name is required')
  const { root, parent } = resolveUserDirectoryParent(parentPath, workspaceRoot)
  const dest = uniqueDestinationPath(parent, folderName)
  fs.mkdirSync(dest)
  return { directory: root, folder: buildUserFileEntry(dest, true) }
}

export function createUserFile(parentPath: string | undefined, name: string, workspaceRoot?: string): { directory: string; file: UserFileEntry } {
  const fileName = safeItemName(name || '')
  if (!fileName) throw new Error('file name is required')
  const { root, parent } = resolveUserDirectoryParent(parentPath, workspaceRoot)
  const dest = uniqueDestinationPath(parent, fileName)
  fs.writeFileSync(dest, '')
  return { directory: root, file: buildUserFileEntry(dest, false) }
}

export function renameUserItem(targetPath: string | undefined, name: string, workspaceRoot?: string): { directory: string; item: UserFileEntry; folder?: UserFileEntry; file?: UserFileEntry } {
  const nextName = safeItemName(name || '')
  if (!targetPath || !nextName) throw new Error('target_path and name are required')
  const { root, target } = resolveUserDirectoryChild(targetPath, workspaceRoot)
  const dest = path.join(path.dirname(target), nextName)
  if (path.resolve(dest) === path.resolve(target)) {
    return entryResponse(root, buildUserFileEntry(target, true))
  }
  if (fs.existsSync(dest)) {
    throw new Error('目标名称已存在')
  }
  fs.renameSync(target, dest)
  return entryResponse(root, buildUserFileEntry(dest, true))
}

export function deleteUserItem(targetPath: string | undefined, workspaceRoot?: string): { directory: string; deleted_path: string } {
  if (!targetPath) throw new Error('target_path is required')
  const { root, target } = resolveUserDirectoryChild(targetPath, workspaceRoot)
  const stat = fs.statSync(target)
  fs.rmSync(target, { recursive: stat.isDirectory(), force: false })
  return { directory: root, deleted_path: target }
}

export function pasteUserItem(
  sourcePath: string | undefined,
  targetParentPath: string | undefined,
  mode: 'copy' | 'cut' | undefined,
  workspaceRoot?: string,
): { directory: string; item: UserFileEntry; folder?: UserFileEntry; file?: UserFileEntry } {
  if (!sourcePath || !targetParentPath || (mode !== 'copy' && mode !== 'cut')) {
    throw new Error('source_path, target_parent_path and mode are required')
  }

  const { root, target: source } = resolveUserDirectoryChild(sourcePath, workspaceRoot)
  const { target: parent } = resolveUserDirectoryTarget(targetParentPath, workspaceRoot)
  const sourceStat = fs.statSync(source)
  const parentStat = fs.statSync(parent)
  if (!parentStat.isDirectory()) throw new Error('target parent path must be a directory')
  if (sourceStat.isDirectory() && (source === parent || parent.startsWith(source + path.sep))) {
    throw new Error('cannot paste a folder into itself')
  }

  const dest = uniqueDestinationPath(parent, path.basename(source))
  if (mode === 'copy' && sourceStat.isDirectory()) {
    fs.cpSync(source, dest, { recursive: true, errorOnExist: true })
  } else if (mode === 'copy') {
    fs.copyFileSync(source, dest)
  } else {
    fs.renameSync(source, dest)
  }
  return entryResponse(root, buildUserFileEntry(dest, true))
}

export function importUserFiles(paths: string[] | undefined, targetParentPath?: string, workspaceRoot?: string): { directory: string; target_directory: string; files: UserFileEntry[] } {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths is required')
  const root = ensureWorkspaceRoot(workspaceRoot)
  let targetDir = root
  if (targetParentPath) {
    const resolved = resolveUserDirectoryTarget(targetParentPath, root).target
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('target parent must be a folder')
    }
    targetDir = resolved
  }
  return {
    directory: root,
    target_directory: targetDir,
    files: paths.map((source) => copyUserImport(source, targetDir)),
  }
}

export function startUserFileImportJob(paths: string[] | undefined, targetParentPath?: string, workspaceRoot?: string): UserFileImportJob {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths is required')
  cleanupExpiredImportJobs()
  const root = ensureWorkspaceRoot(workspaceRoot)
  let targetDir = root
  if (targetParentPath) {
    const resolved = resolveUserDirectoryTarget(targetParentPath, root).target
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('target parent must be a folder')
    }
    targetDir = resolved
  }

  const sources = paths.map((source) => collectImportSource(source))
  const job: UserFileImportJob = {
    id: randomUUID(),
    status: 'pending',
    directory: root,
    target_directory: targetDir,
    total_bytes: sources.reduce((sum, source) => sum + source.size, 0),
    copied_bytes: 0,
    total_files: sources.reduce((sum, source) => sum + source.files, 0),
    copied_files: 0,
    current_file: null,
    files: [],
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  importJobs.set(job.id, job)
  void runUserFileImportJob(job, sources, targetDir)
  return cloneImportJob(job)
}

export function getUserFileImportJob(id: string | undefined): UserFileImportJob | null {
  if (!id) return null
  const job = importJobs.get(id)
  return job ? cloneImportJob(job) : null
}

export function importChatAttachments(attachments: Array<{ path?: string; name?: string }>, workspaceRoot?: string): ContentBlock[] {
  const maxChatAttachments = getMaxChatAttachments()
  if (attachments.length > maxChatAttachments) {
    throw new Error(`too many attachments: max ${maxChatAttachments}`)
  }
  const dir = ensureWorkspaceRoot(workspaceRoot)
  return attachments.map((attachment) => {
    const source = attachment.path || ''
    if (!source) throw new Error('attachment path is required')
    const resolved = path.resolve(expandHomePath(source))
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('attachment must be a file: ' + source)
    if (isPathInsideDirectory(resolved, dir)) {
      return {
        type: 'file_attachment' as const,
        name: path.basename(resolved),
        path: resolved,
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
      }
    }
    const rawName = attachment.name || path.basename(resolved)
    const dest = uniqueDestinationPath(dir, safeUploadName(rawName))
    fs.copyFileSync(resolved, dest)
    const nextStat = fs.statSync(dest)
    return {
      type: 'file_attachment' as const,
      name: path.basename(dest),
      path: dest,
      size: nextStat.size,
      modified_at: nextStat.mtime.toISOString(),
    }
  })
}

function buildUserFileEntry(filePath: string, includeChildren = false): UserFileEntry {
  const stat = fs.statSync(filePath)
  const isDirectory = stat.isDirectory()
  const item: UserFileEntry = {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
    is_directory: isDirectory,
  }
  if (includeChildren && isDirectory) item.children = []
  return item
}

function safeItemName(name: string): string {
  const safeName = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
  if (safeName === '.' || safeName === '..') return ''
  return safeName
}

function safeUploadName(name: string): string {
  return safeItemName(name) || 'file'
}

function uniqueDestinationPath(dir: string, filename: string): string {
  const parsed = path.parse(filename)
  let candidate = path.join(dir, filename)
  let i = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, parsed.name + ' (' + i + ')' + parsed.ext)
    i += 1
  }
  return candidate
}

function copyUserImport(source: string, targetDir: string): UserFileEntry {
  const resolved = path.resolve(expandHomePath(source))
  const stat = fs.statSync(resolved)
  const dest = uniqueDestinationPath(targetDir, safeUploadName(path.basename(resolved)))
  const relativeDest = path.relative(resolved, dest)
  if (stat.isDirectory() && relativeDest && !relativeDest.startsWith('..') && !path.isAbsolute(relativeDest)) {
    throw new Error('cannot copy a folder into itself: ' + source)
  }
  if (stat.isDirectory()) {
    fs.cpSync(resolved, dest, { recursive: true })
    return buildUserFileEntry(dest, true)
  }
  if (stat.isFile()) {
    fs.copyFileSync(resolved, dest)
    return buildUserFileEntry(dest, false)
  }
  throw new Error('not a file or folder: ' + source)
}

function collectImportSource(source: string): ImportSource {
  const resolved = path.resolve(expandHomePath(source))
  const stat = fs.statSync(resolved)
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a file or folder: ' + source)
  const info = stat.isDirectory()
    ? collectDirectoryStats(resolved)
    : { size: stat.size, files: 1 }
  return { path: source, resolved, ...info }
}

function collectDirectoryStats(dir: string): { size: number; files: number } {
  let size = 0
  let files = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const childInfo = collectDirectoryStats(child)
      size += childInfo.size
      files += childInfo.files
    } else if (entry.isFile()) {
      size += fs.statSync(child).size
      files += 1
    }
  }
  return { size, files: Math.max(files, 1) }
}

async function runUserFileImportJob(job: UserFileImportJob, sources: ImportSource[], targetDir: string): Promise<void> {
  try {
    updateImportJob(job, { status: 'running' })
    for (const source of sources) {
      const entry = await copyUserImportWithProgress(source, targetDir, job)
      job.files.push(entry)
      updateImportJob(job, {})
    }
    updateImportJob(job, { status: 'done', current_file: null, copied_bytes: job.total_bytes, copied_files: job.total_files })
    scheduleImportJobCleanup(job.id)
  } catch (e) {
    updateImportJob(job, {
      status: 'error',
      error: e instanceof Error ? e.message : 'failed to import files',
      current_file: null,
    })
    scheduleImportJobCleanup(job.id)
  }
}

async function copyUserImportWithProgress(source: ImportSource, targetDir: string, job: UserFileImportJob): Promise<UserFileEntry> {
  const stat = fs.statSync(source.resolved)
  const dest = uniqueDestinationPath(targetDir, safeUploadName(path.basename(source.resolved)))
  const relativeDest = path.relative(source.resolved, dest)
  if (stat.isDirectory() && relativeDest && !relativeDest.startsWith('..') && !path.isAbsolute(relativeDest)) {
    throw new Error('cannot copy a folder into itself: ' + source.path)
  }
  if (stat.isDirectory()) {
    await copyDirectoryWithProgress(source.resolved, dest, job)
    return buildUserFileEntry(dest, true)
  }
  if (stat.isFile()) {
    await copyFileWithProgress(source.resolved, dest, job)
    return buildUserFileEntry(dest, false)
  }
  throw new Error('not a file or folder: ' + source.path)
}

async function copyDirectoryWithProgress(sourceDir: string, destDir: string, job: UserFileImportJob): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryWithProgress(source, dest, job)
    } else if (entry.isFile()) {
      await copyFileWithProgress(source, dest, job)
    }
  }
}

async function copyFileWithProgress(source: string, dest: string, job: UserFileImportJob): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  updateImportJob(job, { current_file: path.basename(source) })
  const read = fs.createReadStream(source)
  read.on('data', (chunk) => {
    job.copied_bytes = Math.min(job.total_bytes, job.copied_bytes + chunk.length)
    job.updated_at = new Date().toISOString()
  })
  await pipeline(read, fs.createWriteStream(dest))
  updateImportJob(job, { copied_files: Math.min(job.total_files, job.copied_files + 1) })
}

function updateImportJob(job: UserFileImportJob, patch: Partial<UserFileImportJob>): void {
  Object.assign(job, patch, { updated_at: new Date().toISOString() })
}

function cloneImportJob(job: UserFileImportJob): UserFileImportJob {
  return {
    ...job,
    files: job.files.map((file) => ({ ...file, children: file.children ? [...file.children] : undefined })),
  }
}

function scheduleImportJobCleanup(jobId: string): void {
  const existingTimer = importJobCleanupTimers.get(jobId)
  if (existingTimer) clearTimeout(existingTimer)
  const timer = setTimeout(() => {
    importJobs.delete(jobId)
    importJobCleanupTimers.delete(jobId)
  }, IMPORT_JOB_TTL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  importJobCleanupTimers.set(jobId, timer)
}

function cleanupExpiredImportJobs(): void {
  const now = Date.now()
  for (const [jobId, job] of importJobs.entries()) {
    if (job.status !== 'done' && job.status !== 'error') continue
    const updatedAt = Date.parse(job.updated_at)
    if (!Number.isFinite(updatedAt) || now - updatedAt < IMPORT_JOB_TTL_MS) continue
    const timer = importJobCleanupTimers.get(jobId)
    if (timer) clearTimeout(timer)
    importJobCleanupTimers.delete(jobId)
    importJobs.delete(jobId)
  }
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedDir = path.resolve(directory)
  const relative = path.relative(resolvedDir, resolvedFile)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function ensureWorkspaceRoot(workspaceRoot?: string): string {
  const root = path.resolve(workspaceRoot || ensureUserDirectory())
  fs.mkdirSync(root, { recursive: true })
  if (!fs.statSync(root).isDirectory()) throw new Error('workspace root must be a directory')
  return root
}

function assertPathInsideWorkspace(targetPath: string, root: string, label: string): string {
  const resolvedRoot = fs.realpathSync(root)
  const candidate = path.resolve(path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath))
  const nearestExisting = fs.existsSync(candidate) ? candidate : path.dirname(candidate)
  const realCandidate = fs.existsSync(candidate)
    ? fs.realpathSync(candidate)
    : path.join(fs.realpathSync(nearestExisting), path.basename(candidate))
  const relative = path.relative(resolvedRoot, realCandidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside workspace directory`)
  }
  return candidate
}

function resolveUserDirectoryParent(parentPath?: string, workspaceRoot?: string): { root: string; parent: string } {
  const root = ensureWorkspaceRoot(workspaceRoot)
  const parent = parentPath ? assertPathInsideWorkspace(parentPath, root, 'parent path') : root
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error('parent path must be a directory')
  }
  return { root, parent }
}

function resolveUserDirectoryChild(targetPath: string, workspaceRoot?: string): { root: string; target: string } {
  const root = ensureWorkspaceRoot(workspaceRoot)
  const target = assertPathInsideWorkspace(targetPath, root, 'path')
  return { root, target }
}

function resolveUserDirectoryTarget(targetPath: string, workspaceRoot?: string): { root: string; target: string } {
  const root = ensureWorkspaceRoot(workspaceRoot)
  const target = assertPathInsideWorkspace(targetPath, root, 'path')
  return { root, target }
}

function listUserFileTree(dir: string, depth = 0, limit = { count: 0 }): UserFileEntry[] {
  if (depth > 8 || limit.count > 2000) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      limit.count += 1
      const filePath = path.join(dir, entry.name)
      const stat = fs.statSync(filePath)
      const isDirectory = entry.isDirectory()
      const item: UserFileEntry = {
        name: entry.name,
        path: filePath,
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
        is_directory: isDirectory,
      }
      if (isDirectory && limit.count <= 2000) {
        item.children = listUserFileTree(filePath, depth + 1, limit)
      }
      return item
    })
    .filter((item) => !isPathBlockedByBlacklist(item.path))
    .sort((a, b) => {
      if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    })
}

function entryResponse(root: string, item: UserFileEntry): { directory: string; item: UserFileEntry; folder?: UserFileEntry; file?: UserFileEntry } {
  return {
    directory: root,
    item,
    folder: item.is_directory ? item : undefined,
    file: item.is_directory ? undefined : item,
  }
}
