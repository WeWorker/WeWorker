import fs from 'node:fs'
import path from 'node:path'
import { getDownloadDirectory } from './config.js'
import {
  assertPathInsideUserDirectory,
  assertPathInsideWorkspaceDirectory,
  isPathBlockedByBlacklist,
  resolveDirectoryInsideUserDirectory,
  resolveUserDirectoryRoot,
} from './user-directory-guard.js'

export function listDownloads(keyword = '', limit = 50): { files: Array<{ name: string; path: string; size: number; modified: string }> } {
  return listFiles(getDownloadDirectory(), keyword, limit)
}

export function listFiles(directory = '', keyword = '', limit = 50, workspaceDirectory?: string): { directory: string; files: Array<{ name: string; path: string; size: number; modified: string; isDirectory: boolean }> } {
  const root = workspaceDirectory ? path.resolve(workspaceDirectory) : resolveUserDirectoryRoot()
  const resolved = workspaceDirectory
    ? (directory ? assertPathInsideWorkspaceDirectory(directory, root, 'directory') : root)
    : resolveDirectoryInsideUserDirectory(directory)
  if (!fs.existsSync(resolved)) return { directory: resolved, files: [] }
  if (!fs.statSync(resolved).isDirectory()) return { directory: resolved, files: [] }
  const entries = fs.readdirSync(resolved)
    .map(name => {
      try {
        const p = path.join(resolved, name)
        const stat = fs.statSync(p)
        return { name, path: p, size: stat.size, modified: stat.mtime.toISOString(), mtime: stat.mtimeMs, isDirectory: stat.isDirectory() }
      } catch { return null }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null && !e.name.startsWith('.'))
    .filter((e) => !isPathBlockedByBlacklist(e.path, root))
    .filter(e => !keyword || e.name.toLowerCase().includes(keyword.toLowerCase()))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ name, path: p, size, modified, isDirectory }) => ({ name, path: p, size, modified, isDirectory }))
  return { directory: resolved, files: entries }
}

export function listWeworkFiles(category = ''): { files: Array<{ name: string; path: string; size: number; modified: string }> } {
  const root = resolveUserDirectoryRoot()
  const dir = category
    ? assertPathInsideUserDirectory(path.join(root, category), 'category')
    : root
  if (!fs.existsSync(dir)) return { files: [] }
  const entries = fs.readdirSync(dir)
    .map(name => {
      try {
        const p = path.join(dir, name)
        const stat = fs.statSync(p)
        return { name, path: p, size: stat.size, modified: stat.mtime.toISOString() }
      } catch { return null }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null && !e.name.startsWith('.'))
    .filter((e) => !isPathBlockedByBlacklist(e.path))
  return { files: entries }
}

export function moveToWework(filename: string, category = ''): { success: boolean; path: string } {
  const downloadDirectory = getDownloadDirectory()
  const userDirectory = resolveUserDirectoryRoot()
  const src = assertPathInsideUserDirectory(path.join(downloadDirectory, filename), 'filename')
  if (!fs.existsSync(src)) throw new Error(`File not found: ${filename}`)
  const destDir = category
    ? assertPathInsideUserDirectory(path.join(userDirectory, category), 'category')
    : userDirectory
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, path.basename(src))
  fs.renameSync(src, dest)
  return { success: true, path: dest }
}

export function readFileText(filePath: string, maxChars = 8000): { content: string; truncated: boolean } {
  const resolved = assertPathInsideUserDirectory(filePath, 'file_path')
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`)
  const ext = path.extname(resolved).toLowerCase()
  if (!['.txt', '.md', '.csv', '.json', '.log', '.ts', '.js', '.py'].includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`)
  }
  const content = fs.readFileSync(resolved, 'utf8')
  if (content.length <= maxChars) return { content, truncated: false }
  return { content: content.slice(0, maxChars), truncated: true }
}

export function getFileInfo(filePath: string): Record<string, unknown> {
  const resolved = assertPathInsideUserDirectory(filePath, 'file_path')
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`)
  const stat = fs.statSync(resolved)
  const ext = path.extname(resolved).toLowerCase()

  return {
    name: path.basename(resolved),
    path: resolved,
    directory: path.dirname(resolved),
    extension: ext || '(none)',
    size: stat.size,
    sizeHuman: formatSize(stat.size),
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function deleteWeworkFile(filePath: string): { success: boolean } {
  const resolved = assertPathInsideUserDirectory(filePath, 'file_path')
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${filePath}`)
  fs.unlinkSync(resolved)
  return { success: true }
}

export { isPathInsideUserDirectory } from './user-directory-guard.js'
