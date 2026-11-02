import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config.js', () => ({
  getUserDirectory: () => path.resolve('/example/user-files'),
  getUserDirectoryBlacklist: vi.fn(() => [{ type: 'exact_path', pattern: 'blocked.txt' }]),
  getConfigDirectory: () => path.resolve('/example/config'),
  getOpenBrowserAllowedOrigins: () => ['https://extra.example.org'],
  getSiteEnabled: (id: string) => id !== 'disabled.example.com',
  expandHomePath: (input: string) => input,
}))

vi.mock('../adapter-parser.js', () => ({
  parseAllAdapters: () => new Map([
    ['example.com', { homepageUrl: 'https://example.com', match: ['example.com', 'share.example.com'], tools: [{ name: 'example.com.read' }] }],
    ['example-toolkit', { homepageUrl: '', match: [], tools: [{ name: 'example-toolkit.list' }] }],
    ['disabled.example.com', { homepageUrl: 'https://disabled.example.com', match: ['disabled.example.com'], tools: [{ name: 'disabled.example.com.read' }] }],
  ]),
}))

import { runWithWorkspaceDirectory } from '../workspace-access-context.js'
import { resolveUserDirectoryRoot } from '../user-directory-guard.js'
import { createUnifiedToolGuard, checkFilesystemPath } from '../user-directory-access.js'
import { getUserDirectoryBlacklist } from '../config.js'
import { createWorkspacePreToolUseHook } from '../workspace-tool-hook.js'
import { runWeWorkerPowerShell } from '../powershell-runner.js'

describe('bound workspace access', () => {
  const workspace = path.resolve('/example/user-files/projects/one')
  const otherWorkspace = path.resolve('/example/user-files/projects/two')
  afterEach(() => vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{ type: 'exact_path', pattern: 'blocked.txt' }]))

  it('scopes concurrent tool callbacks without changing the user directory', async () => {
    const roots = await Promise.all([workspace, otherWorkspace].map(root =>
      runWithWorkspaceDirectory(root, async () => {
        await Promise.resolve()
        return resolveUserDirectoryRoot()
      }),
    ))
    expect(roots).toEqual([workspace, otherWorkspace])
    expect(resolveUserDirectoryRoot()).toBe(path.resolve('/example/user-files'))
  })

  it('allows files in the bound workspace and rejects sibling projects and blacklisted files', async () => {
    const guard = createUnifiedToolGuard('workspace', workspace)
    await expect(guard('Write', { file_path: path.join(workspace, 'note.txt') })).resolves.toMatchObject({ behavior: 'allow' })
    await expect(guard('Read', { file_path: path.join(otherWorkspace, 'note.txt') })).resolves.toMatchObject({ behavior: 'deny' })
    await expect(guard('Edit', { file_path: path.join(workspace, 'blocked.txt') })).resolves.toMatchObject({ behavior: 'deny' })
    expect(runWithWorkspaceDirectory(workspace, () => checkFilesystemPath('../two/note.txt').allowed)).toBe(false)
  })

  it('keeps native command path checks active for workspace mode', async () => {
    const guard = createUnifiedToolGuard('workspace', workspace)
    await expect(guard('PowerShell', { command: 'Get-Content ./note.txt' })).resolves.toMatchObject({ behavior: 'allow' })
    await expect(guard('Bash', { command: 'cat ../two/note.txt' })).resolves.toMatchObject({ behavior: 'deny' })
    await expect(guard('PowerShell', { command: 'Get-Content ./blocked.txt' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('allows authorized Adapter sites and rejects sites outside the whitelist', async () => {
    const guard = createUnifiedToolGuard('workspace', workspace)
    for (const command of [
      'webcli call example.com.read --url=https://share.example.com/public',
      'webcli call example-toolkit.list --limit=5',
      'webcli call open_browser --url=https://extra.example.org/page',
      'npm test',
    ]) {
      await expect(guard('PowerShell', { command })).resolves.toMatchObject({ behavior: 'allow' })
    }
    for (const command of [
      'webcli call open_browser --url=https://unlisted.example.org',
      'curl https://unlisted.example.org/data',
      'webcli call example.com.read --url=https://example.com.unlisted.example.org',
      'webcli call disabled.example.com.read',
    ]) {
      await expect(guard('PowerShell', { command })).resolves.toMatchObject({ behavior: 'deny' })
    }
  })

  it('checks local file arguments on Adapter commands', async () => {
    const guard = createUnifiedToolGuard('workspace', workspace)
    await expect(guard('PowerShell', { command: `webcli call example.com.read --output=${otherWorkspace}/note.txt` })).resolves.toMatchObject({ behavior: 'deny' })
    await expect(guard('PowerShell', { command: 'webcli call example.com.read --output=./blocked.txt' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('preserves blacklist rules relative to the original user directory', async () => {
    vi.mocked(getUserDirectoryBlacklist).mockReturnValue([{ type: 'regex_path', pattern: '^projects/one/private\\.txt$' }])
    const guard = createUnifiedToolGuard('workspace', workspace)
    await expect(guard('Edit', { file_path: './private.txt' })).resolves.toMatchObject({ behavior: 'deny' })
    await expect(guard('PowerShell', { command: 'Get-Content ./private.txt' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('checks accepted edits before execution even when SDK canUseTool is skipped', async () => {
    const hook = createWorkspacePreToolUseHook(workspace)
    const invoke = (file: string) => hook({
      hook_event_name: 'PreToolUse', session_id: 'example-session', transcript_path: '', cwd: workspace,
      tool_name: 'Write', tool_input: { file_path: file, content: 'public example' }, tool_use_id: 'example-tool',
    }, 'example-tool', { signal: new AbortController().signal })
    await expect(invoke(path.join(workspace, 'note.txt'))).resolves.toEqual({})
    await expect(invoke(path.join(workspace, 'blocked.txt'))).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    await expect(invoke(path.join(otherWorkspace, 'note.txt'))).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('executes a real command with the bound workspace as its default cwd', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-workspace-command-'))
    try {
      const result = await runWithWorkspaceDirectory(directory, () => runWeWorkerPowerShell({
        command: 'node -e "process.stdout.write(process.cwd())"',
        workId: 'example-work',
      }))
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(directory)
      expect(result.cwd).toBe(directory)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
