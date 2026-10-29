import path from 'node:path'
import type { ChannelPermissionMode } from './channels/channel-permissions.js'
import { expandHomePath, getUserDirectoryBlacklist } from './config.js'
import {
  assertPathInsideUserDirectory,
  assertPathInsideWorkspaceDirectory,
  isPathInsideRuntimeSkillsDirectory,
  isPathBlockedByBlacklist,
  resolveUserDirectoryRoot,
  resolveRuntimeSkillsRoot,
} from './user-directory-guard.js'
import { extractShellCommandPathTokens, isShellCommandReferencingBlacklistedPath } from './user-directory-blacklist.js'

const MCP_PREFIX = /^mcp__weworker__/
const INTERACTIVE_TUI_COMMAND = /(^|[;&|]\s*)(?:env\s+)?(?:vim|vi|nvim|nano)(?:\s|$)/i

const TOOLS_WITHOUT_LOCAL_PATH = new Set([
  'ask_user',
  'create_scheduled_task',
  'list_scheduled_tasks',
])

const BUILTIN_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'])

const PATH_INPUT_KEYS = [
  'file_path',
  'filePath',
  'path',
  'directory',
  'notebook_path',
  'source',
  'destination',
  'src',
  'dest',
  'target',
  'target_path',
  'parent_path',
]

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(String(value || '').trim()) || String(value || '').trim().startsWith('\\\\')
}

function resolveAgainstUserRoot(targetPath: string, root = resolveUserDirectoryRoot()): string {
  const expanded = expandHomePath(String(targetPath || '').trim())
  if (!expanded) return root
  if (isWindowsAbsolutePath(expanded)) return path.win32.resolve(expanded)
  if (isWindowsAbsolutePath(root)) return path.win32.resolve(root, expanded)
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded)
}

function isInsideUserRoot(resolvedPath: string, root = resolveUserDirectoryRoot()): boolean {
  const pathApi = isWindowsAbsolutePath(root) ? path.win32 : path
  const relative = pathApi.relative(root, pathApi.resolve(resolvedPath))
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

export function checkFilesystemPath(pathValue: string, label = 'path', workspaceDirectory?: string): AccessDecision {
  const trimmed = String(pathValue || '').trim()
  if (!trimmed) return { allowed: true }
  try {
    if (workspaceDirectory) assertPathInsideWorkspaceDirectory(trimmed, workspaceDirectory, label)
    else assertPathInsideUserDirectory(trimmed, label)
    return { allowed: true }
  } catch (e) {
    return { allowed: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

function checkShellPathToken(token: string, root = resolveUserDirectoryRoot()): AccessDecision {
  const value = String(token || '').trim()
  if (!value || value.startsWith('-')) return { allowed: true }
  if (/^\/[a-z]$/i.test(value)) return { allowed: true }
  if (/^https?:\/\//i.test(value)) return { allowed: true }

  const resolved = resolveAgainstUserRoot(value, root)
  if (isPathInsideRuntimeSkillsDirectory(resolved)) return { allowed: true }
  if (!isInsideUserRoot(resolved, root)) {
    return {
      allowed: false,
      reason: `Shell command blocked: "${value}" must stay inside user directory (${root})`,
    }
  }
  if (isPathBlockedByBlacklist(resolved, root)) {
    return {
      allowed: false,
      reason: `Shell command blocked: "${value}" matches a user directory blacklist rule and cannot be accessed`,
    }
  }
  return { allowed: true }
}

export function checkShellCommand(command: string, workspaceDirectory?: string): AccessDecision {
  const trimmed = String(command || '').trim()
  if (!trimmed) return { allowed: false, reason: 'Shell command is empty' }
  if (INTERACTIVE_TUI_COMMAND.test(trimmed)) {
    return {
      allowed: false,
      reason: 'WeWorker Shell 当前不是交互式 PTY 终端，暂不支持 vim/vi/nvim/nano 这类全屏交互命令。请使用 cat/sed/grep 查看文件，或在系统终端中编辑。',
    }
  }

  const root = workspaceDirectory ? path.resolve(workspaceDirectory) : resolveUserDirectoryRoot()
  if (isShellCommandReferencingBlacklistedPath(trimmed, getUserDirectoryBlacklist(), root)) {
    return {
      allowed: false,
      reason: 'Shell command blocked: command references a path blocked by the user directory blacklist',
    }
  }
  for (const token of extractShellCommandPathTokens(trimmed)) {
    const decision = checkShellPathToken(token, root)
    if (!decision.allowed) return decision
  }
  return { allowed: true }
}

export function assertShellCommand(command: string, workspaceDirectory?: string): void {
  const decision = checkShellCommand(command, workspaceDirectory)
  if (!decision.allowed) throw new Error(decision.reason)
}

function normalizeToolName(toolName: string): string {
  return toolName.replace(MCP_PREFIX, '')
}

function collectPathValues(input: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
  }
  return values
}

export function evaluateToolAccess(toolName: string, input: Record<string, unknown>, workspaceDirectory?: string): AccessDecision {
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return checkShellCommand(String(input.command ?? input.cmd ?? ''), workspaceDirectory)
  }

  const shortName = normalizeToolName(toolName)
  if (TOOLS_WITHOUT_LOCAL_PATH.has(shortName)) return { allowed: true }

  if (BUILTIN_PATH_TOOLS.has(toolName)) {
    for (const pathValue of collectPathValues(input)) {
      const decision = checkFilesystemPath(pathValue, toolName, workspaceDirectory)
      if (!decision.allowed) return decision
    }
    return { allowed: true }
  }

  for (const pathValue of collectPathValues(input)) {
    const decision = checkFilesystemPath(pathValue, shortName || toolName, workspaceDirectory)
    if (!decision.allowed) return decision
  }
  return { allowed: true }
}

/** Agent SDK：所有工具执行前的统一拦截点 */
export function createUnifiedToolGuard(mode: ChannelPermissionMode = 'no_bash', workspaceDirectory?: string) {
  return async (toolName: string, input: Record<string, unknown>) => {
    if (mode === 'full' && (toolName === 'Bash' || toolName === 'PowerShell')) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    const decision = evaluateToolAccess(toolName, input, workspaceDirectory)
    if (!decision.allowed) return { behavior: 'deny' as const, message: decision.reason }
    return { behavior: 'allow' as const, updatedInput: input }
  }
}

export function buildAgentFilesystemSettings(
  userRoot = resolveUserDirectoryRoot(),
  mode: ChannelPermissionMode = 'no_bash',
) {
  const normalized = userRoot.replace(/\\/g, '/')
  const runtimeSkillsRoot = resolveRuntimeSkillsRoot().replace(/\\/g, '/')
  return {
    permissions: {
      // Do not pre-approve native command tools — that skips canUseTool and bypasses blacklist checks.
      allow: [
        `Read(${normalized}/**)`,
        `Edit(${normalized}/**)`,
        `Write(${normalized}/**)`,
        `Read(${runtimeSkillsRoot}/**)`,
        `Edit(${runtimeSkillsRoot}/**)`,
        `Write(${runtimeSkillsRoot}/**)`,
      ],
      defaultMode: 'default' as const,
    },
    sandbox: {
      enabled: mode !== 'full',
      // Sandbox auto-allow also skips canUseTool for native command tools.
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    },
  }
}

// 兼容旧命名
export const checkShellCommandAllowed = checkShellCommand
export const assertShellCommandAllowed = assertShellCommand
export const createUserDirectoryToolGuard = createUnifiedToolGuard
export const buildUserDirectoryPermissionSettings = buildAgentFilesystemSettings
