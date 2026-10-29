import path from 'node:path'
import { expandHomePath, getConfigDirectory, getUserDirectory, getUserDirectoryBlacklist } from './config.js'
import { formatBlacklistEntry, isPathBlacklisted } from './user-directory-blacklist.js'

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(String(value || '').trim()) || String(value || '').trim().startsWith('\\\\')
}

function resolvePortablePath(targetPath: string, root?: string): string {
  if (isWindowsAbsolutePath(targetPath)) return path.win32.resolve(targetPath)
  if (root && isWindowsAbsolutePath(root)) return path.win32.resolve(root, targetPath)
  return root ? path.resolve(root, targetPath) : path.resolve(targetPath)
}

export function resolveUserDirectoryRoot(): string {
  return resolvePortablePath(getUserDirectory())
}

export function resolveRuntimeSkillsRoot(): string {
  return resolvePortablePath(path.join('claude-config', 'skills'), getConfigDirectory())
}

function resolvePathAgainstUserDirectory(targetPath: string): string {
  const expanded = expandHomePath(String(targetPath || '').trim())
  if (!expanded) return resolveUserDirectoryRoot()
  return resolvePortablePath(expanded, resolveUserDirectoryRoot())
}

function isPathInsideRoot(targetPath: string, root: string): boolean {
  const pathApi = isWindowsAbsolutePath(root) ? path.win32 : path
  const relative = pathApi.relative(root, targetPath)
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

export function isPathInsideUserDirectory(targetPath: string): boolean {
  const root = resolveUserDirectoryRoot()
  const target = resolvePathAgainstUserDirectory(targetPath)
  return isPathInsideRoot(target, root)
}

export function isPathInsideRuntimeSkillsDirectory(targetPath: string): boolean {
  const target = resolvePathAgainstUserDirectory(targetPath)
  return isPathInsideRoot(target, resolveRuntimeSkillsRoot())
}

export function isPathInsideAllowedDirectory(targetPath: string): boolean {
  return isPathInsideUserDirectory(targetPath) || isPathInsideRuntimeSkillsDirectory(targetPath)
}

export function isPathBlockedByBlacklist(targetPath: string, workspaceDirectory?: string): boolean {
  const root = workspaceDirectory ? resolvePortablePath(workspaceDirectory) : resolveUserDirectoryRoot()
  const resolved = workspaceDirectory
    ? resolvePortablePath(expandHomePath(String(targetPath || '').trim()), root)
    : resolvePathAgainstUserDirectory(targetPath)
  if (!isPathInsideRoot(resolved, root)) return false
  if (isPathInsideRuntimeSkillsDirectory(resolved)) return false
  return isPathBlacklisted(resolved, getUserDirectoryBlacklist(), root)
}

export function assertPathNotBlacklisted(targetPath: string, label = 'path'): void {
  const resolved = resolvePathAgainstUserDirectory(targetPath)
  const entries = getUserDirectoryBlacklist()
  if (!entries.length) return
  if (isPathBlacklisted(resolved, entries, resolveUserDirectoryRoot())) {
    const matched = entries.find((entry) =>
      isPathBlacklisted(resolved, [entry], resolveUserDirectoryRoot()),
    )
    const detail = matched ? formatBlacklistEntry(matched) : 'blocked by user directory blacklist'
    throw new Error(`${label} is blocked by user directory blacklist (${detail})`)
  }
}

export function assertPathInsideUserDirectory(targetPath: string, label = 'path'): string {
  const target = resolvePathAgainstUserDirectory(targetPath)
  if (!isPathInsideAllowedDirectory(target)) {
    throw new Error(`${label} must stay inside user directory: ${resolveUserDirectoryRoot()}`)
  }
  if (isPathInsideRuntimeSkillsDirectory(target)) return target
  assertPathNotBlacklisted(target, label)
  return target
}

export function assertPathInsideWorkspaceDirectory(targetPath: string, directory: string, label = 'path'): string {
  const root = resolvePortablePath(directory)
  const expanded = expandHomePath(String(targetPath || '').trim())
  const target = isWindowsAbsolutePath(expanded)
    ? path.win32.resolve(expanded)
    : path.isAbsolute(expanded) ? path.resolve(expanded) : resolvePortablePath(expanded, root)
  if (!isPathInsideRoot(target, root)) {
    throw new Error(`${label} must stay inside workspace directory: ${root}`)
  }
  const entries = getUserDirectoryBlacklist()
  if (entries.length && isPathBlacklisted(target, entries, root)) {
    const matched = entries.find((entry) => isPathBlacklisted(target, [entry], root))
    const detail = matched ? formatBlacklistEntry(matched) : 'blocked by user directory blacklist'
    throw new Error(`${label} is blocked by user directory blacklist (${detail})`)
  }
  return target
}

export function resolveDirectoryInsideUserDirectory(directory = ''): string {
  const trimmed = String(directory || '').trim()
  if (!trimmed) return resolveUserDirectoryRoot()
  return assertPathInsideUserDirectory(trimmed, 'directory')
}
