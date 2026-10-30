import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({
  getUserDirectory: vi.fn(),
  getUserDirectoryBlacklist: vi.fn(() => []),
  getConfigDirectory: vi.fn(() => path.join(os.tmpdir(), 'weworker-access-config-test')),
  expandHomePath: (input: string) => input,
}))

import { getUserDirectory, getUserDirectoryBlacklist } from '../config.js'
import {
  checkFilesystemPath,
  checkShellCommand,
  createUnifiedToolGuard,
  evaluateToolAccess,
  buildAgentFilesystemSettings,
} from '../user-directory-access.js'

describe('user directory access control', () => {
  const root = path.join(os.tmpdir(), 'weworker-access-test')

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('allows webcli shell commands', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    expect(checkShellCommand('webcli call open_browser --url=https://example.com').allowed).toBe(true)
  })

  it('blocks shell and builtin tools outside user directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(root, { recursive: true })
    const outside = path.join(os.tmpdir(), 'outside-access.txt')
    fs.writeFileSync(outside, 'secret')

    expect(checkShellCommand(`type ${outside}`).allowed).toBe(false)
    expect(evaluateToolAccess('Read', { file_path: outside }).allowed).toBe(false)
    expect(evaluateToolAccess('mcp__weworker__send_file_to_user', { file_path: outside }).allowed).toBe(false)

    fs.rmSync(outside, { force: true })
  })

  it('allows MCP file tools inside user directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(root, { recursive: true })
    const inside = path.join(root, 'note.txt')
    fs.writeFileSync(inside, 'hello')

    expect(checkFilesystemPath(inside).allowed).toBe(true)
    expect(evaluateToolAccess('mcp__weworker__list_files', { directory: root }).allowed).toBe(true)
    expect(evaluateToolAccess('mcp__weworker__send_file_to_user', { file_path: inside }).allowed).toBe(true)
  })

  it('keeps the workspace boundary and blacklist active for edits without confirmation', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{ type: 'exact_path', pattern: 'blocked.txt' }])
    expect(evaluateToolAccess('Edit', { file_path: path.join(root, 'blocked.txt') }).allowed).toBe(false)
    expect(evaluateToolAccess('Edit', { file_path: path.join(root, 'nested', 'note.txt') }).allowed).toBe(true)
    expect(evaluateToolAccess('Write', { file_path: path.join(os.tmpdir(), 'outside.txt') }).allowed).toBe(false)
  })

  it('allows shell paths that copy or link drafts into the runtime skills directory', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    const draft = path.join(root, 'skills-test', 'basic-echo-test')
    const runtimeSkill = path.join(os.tmpdir(), 'weworker-access-config-test', 'claude-config', 'skills', 'basic-echo-test')
    fs.mkdirSync(draft, { recursive: true })

    expect(checkShellCommand(`cp -r "${draft}" "${runtimeSkill}"`).allowed).toBe(true)
    expect(checkShellCommand(`ln -s "${draft}" "${runtimeSkill}"`).allowed).toBe(true)
    expect(checkShellCommand(`xcopy /E /I /Y "${draft}" "${runtimeSkill}"`).allowed).toBe(true)
  })

  it('allows MCP tools without local paths', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    expect(evaluateToolAccess('mcp__weworker__ask_user', { question: 'choose', options: [{ label: 'A' }, { label: 'B' }] }).allowed).toBe(true)
  })

  it('blocks shell commands that reference blacklisted files by basename only', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{
      type: 'exact_path',
      pattern: 'folder-b/zcf (1)/BaiduSyncdisk/同步空间新手教程.docx',
    }])
    const dir = path.join(root, 'folder-b', 'zcf (1)', 'BaiduSyncdisk')
    fs.mkdirSync(dir, { recursive: true })
    const cmd = `cd "${dir}" && python -c "print(open('同步空间新手教程.docx','rb').read(16))"`
    expect(checkShellCommand(cmd).allowed).toBe(false)
  })

  it('blocks bash with absolute path to blacklisted pdf', () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{
      type: 'regex_path',
      pattern: '^folder-b/zcf \\(1\\)/BaiduSyncdisk/同步空间帮助文档\\.pdf$',
    }])
    const target = path.join(root, 'folder-b', 'zcf (1)', 'BaiduSyncdisk', '同步空间帮助文档.pdf')
    const posix = target.replace(/\\/g, '/')

    expect(checkShellCommand(`type "${target}"`).allowed).toBe(false)
    expect(checkShellCommand(`cat "${posix}"`).allowed).toBe(false)
    expect(checkShellCommand(`python -c "open(r'${posix}','rb').read(16)"`).allowed).toBe(false)
    expect(evaluateToolAccess('Bash', { command: `type "${target}"` }).allowed).toBe(false)
    expect(evaluateToolAccess('PowerShell', { command: `type "${target}"` }).allowed).toBe(false)
  })

  it('blocks bash with Windows absolute path to blacklisted bat file', () => {
    const userRoot = 'C:/Users/liuqi/.weworker/user-files'
    vi.mocked(getUserDirectory).mockReturnValue(userRoot)
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{
      type: 'exact_path',
      pattern: 'C:\\Users\\liuqi\\.weworker\\user-files\\build_simple.bat',
    }])
    const target = path.join(userRoot, 'build_simple.bat')
    const winPath = 'C:\\Users\\liuqi\\.weworker\\user-files\\build_simple.bat'

    expect(checkShellCommand(`type "${winPath}"`).allowed).toBe(false)
    expect(checkShellCommand(`cat "${target.replace(/\\/g, '/')}"`).allowed).toBe(false)
    expect(evaluateToolAccess('Bash', { command: `type "${winPath}"` }).allowed).toBe(false)
    expect(evaluateToolAccess('mcp__weworker__check_file_encryption', { file_path: target }).allowed).toBe(false)
  })

  it('does not pre-approve native command tools in agent filesystem settings', () => {
    const settings = buildAgentFilesystemSettings(root)
    expect(settings.permissions.allow.some((rule) => rule.startsWith('Bash('))).toBe(false)
    expect(settings.permissions.allow.some((rule) => rule.startsWith('PowerShell('))).toBe(false)
    expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(false)
    expect(settings.permissions.defaultMode).toBe('default')
  })

  it('allows full native command tools outside the user directory without weakening native file tools', async () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(root, { recursive: true })
    const outside = path.join(os.tmpdir(), 'outside-full-access.txt')
    fs.writeFileSync(outside, 'secret')
    const guard = createUnifiedToolGuard('full')

    await expect(guard('Bash', { command: `cat "${outside}"` })).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(guard('PowerShell', { command: `Get-Content "${outside}"` })).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(guard('Read', { file_path: outside })).resolves.toMatchObject({
      behavior: 'deny',
    })

    const settings = buildAgentFilesystemSettings(root, 'full')
    expect(settings.sandbox.enabled).toBe(false)
    expect(settings.permissions.allow.some((rule) => rule.startsWith('Bash('))).toBe(false)

    fs.rmSync(outside, { force: true })
  })

  it('returns updatedInput when allowing tool access for Agent SDK', async () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(root, { recursive: true })
    const guard = createUnifiedToolGuard()
    const input = { directory: root }

    await expect(guard('mcp__weworker__list_files', input)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
  })

  it('returns deny message when blocking tool access for Agent SDK', async () => {
    vi.mocked(getUserDirectory).mockReturnValue(root)
    fs.mkdirSync(root, { recursive: true })
    const outside = path.join(os.tmpdir(), 'outside-guard.txt')
    fs.writeFileSync(outside, 'secret')
    const guard = createUnifiedToolGuard()

    const result = await guard('Read', { file_path: outside })
    expect(result.behavior).toBe('deny')
    expect(typeof (result as { message?: string }).message).toBe('string')

    fs.rmSync(outside, { force: true })
  })
})
