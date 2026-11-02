import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { query, type CanUseTool, type Query, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

const fixture = vi.hoisted(() => ({ directory: '' }))
vi.mock('../config.js', () => ({
  getUserDirectory: () => fixture.directory,
  getConfigDirectory: () => path.join(fixture.directory, 'config'),
  getUserDirectoryBlacklist: () => [{ type: 'exact_path', pattern: 'blocked.txt' }],
  getOpenBrowserAllowedOrigins: () => ['https://example.com'],
  getSiteEnabled: () => true,
  expandHomePath: (input: string) => input,
}))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))

import { resolveDesktopChatPermission } from '../chat-permission-mode.js'
import { buildAgentFilesystemSettings, createUnifiedToolGuard } from '../user-directory-access.js'
import { createWeWorkerToolPolicy } from '../agent-tool-policy.js'
import { createWorkspacePreToolUseHook } from '../workspace-tool-hook.js'
import { createAskPreToolUseHook } from '../tool-permission-approval.js'
import { resolvePendingAskUser } from '../ask-user-pending.js'
import { spawnManagedClaudeCodeProcess } from '../claude-process.js'

// Use the actual Windows CLI and PowerShell with a local model fixture. This
// catches SDK-level sandbox rejection that unit tests of our guard cannot see.
it.runIf(process.platform === 'win32').each(['workspace', 'ask'] as const)('runs %s commands through the real SDK while retaining access and approval guards', async mode => {
  fixture.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-workspace-sdk-'))
  const workspace = path.join(fixture.directory, 'workspace')
  fs.mkdirSync(workspace)
  fs.writeFileSync(path.join(workspace, 'blocked.txt'), 'blocked fixture')
  fs.writeFileSync(path.join(fixture.directory, 'outside.txt'), 'outside fixture')
  const calls = [
    { name: 'PowerShell', input: { command: "Write-Output 'workspace-native-ok'" } },
    { name: 'PowerShell', input: { command: "Set-Content -LiteralPath './created.txt' -Value 'public fixture'" } },
    { name: 'Read', input: { file_path: path.join(workspace, 'created.txt') } },
    { name: 'PowerShell', input: { command: "Get-Content -LiteralPath '../outside.txt'" } },
    { name: 'Read', input: { file_path: path.join(workspace, 'blocked.txt') } },
    { name: 'PowerShell', input: { command: "Write-Output 'unlisted-url https://unlisted.example.org'" } },
  ]
  if (mode === 'ask') calls.push({ name: 'PowerShell', input: { command: "Set-Content -LiteralPath './declined.txt' -Value 'must not run'" } })
  const confirmations: Array<{ id: string; createdFileExists: boolean }> = []
  const workId = `public-sdk-${mode}`
  const results = new Map<string, { is_error?: boolean; content: unknown }>()
  let nextCall = 0
  const server = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const request = JSON.parse(body || '{}')
    if (!request.stream) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'fixture-title', type: 'message', role: 'assistant', model: 'test-model',
        content: [{ type: 'text', text: 'Fixture' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
      return
    }
    for (const message of request.messages ?? []) {
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block.type === 'tool_result') results.set(block.tool_use_id, block)
      }
    }
    const call = calls[nextCall]
    res.setHeader('Content-Type', 'text/event-stream')
    const send = (type: string, event: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...event })}\n\n`)
    send('message_start', { message: { id: `fixture-${nextCall}`, type: 'message', role: 'assistant', model: 'test-model',
      content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
    if (call) {
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `fixture-tool-${nextCall}`, name: call.name, input: {} } })
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
      nextCall += 1
    } else {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fixture complete' } })
    }
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
    send('message_stop', {})
    res.end()
  })
  const children: ChildProcess[] = []
  let handle: Query | undefined
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 25_000)
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as import('node:net').AddressInfo).port
    const permission = resolveDesktopChatPermission(mode)
    const policy = createWeWorkerToolPolicy(permission.channelPermissionMode)
    const guard = createUnifiedToolGuard(permission.channelPermissionMode, workspace)
    const canUseTool: CanUseTool = async (name, input, context) => {
      const decision = await policy(name, input, context)
      if (!decision) return { behavior: 'deny', message: 'Fixture tool policy did not resolve permission.' }
      return decision.behavior === 'deny' ? decision : guard(name, input)
    }
    const cli = path.resolve('node_modules/@anthropic-ai/claude-code/bin/claude.exe')
    expect(fs.existsSync(cli)).toBe(true)
    handle = query({ prompt: 'Run the fixture commands.', options: {
      abortController: abort,
      pathToClaudeCodeExecutable: cli,
      model: 'test-model', systemPrompt: 'Follow the fixture tool calls.',
      tools: ['PowerShell', 'Read'], settingSources: [], persistSession: false,
      permissionMode: permission.sdkPermissionMode,
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      settings: buildAgentFilesystemSettings(workspace, permission.channelPermissionMode),
      canUseTool,
      hooks: { PreToolUse: [{ timeout: 330, hooks: [mode === 'ask' ? createAskPreToolUseHook({
        workId: () => workId, checkAccess: canUseTool, signal: abort.signal,
        onAskUser: () => event => {
          confirmations.push({ id: event.id, createdFileExists: fs.existsSync(path.join(workspace, 'created.txt')) })
          queueMicrotask(() => resolvePendingAskUser(workId, event.id.includes('fixture-tool-6') ? '拒绝' : '允许本次', event.id))
        },
      }) : createWorkspacePreToolUseHook(workspace)] }] },
      cwd: workspace,
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(fixture.directory, 'config'),
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'test-placeholder-key',
        ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
        CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDECODE: '' },
      spawnClaudeCodeProcess: args => {
        const child = spawnManagedClaudeCodeProcess(args)
        children.push(child)
        return child as unknown as SpawnedProcess
      },
    } })
    for await (const _message of handle) { /* Consume until the fixture turn finishes. */ }
    const resultText = (index: number) => JSON.stringify(results.get(`fixture-tool-${index}`)?.content)
    expect(resultText(0)).toContain('workspace-native-ok')
    expect(results.get('fixture-tool-0')?.is_error).not.toBe(true)
    expect(results.get('fixture-tool-1')?.is_error).not.toBe(true)
    expect(fs.readFileSync(path.join(workspace, 'created.txt'), 'utf8').trim()).toBe('public fixture')
    expect(resultText(2)).toContain('public fixture')
    if (mode === 'ask') {
      for (const index of [3, 4, 5]) expect(results.get(`fixture-tool-${index}`)?.is_error).not.toBe(true)
      expect(resultText(3)).toContain('outside fixture')
      expect(resultText(4)).toContain('blocked fixture')
      expect(resultText(5)).toContain('unlisted-url')
      expect(confirmations).toHaveLength(7)
      expect(confirmations.map(event => event.createdFileExists)).toEqual([false, false, true, true, true, true, true])
      expect(results.get('fixture-tool-6')?.is_error).toBe(true)
      expect(fs.existsSync(path.join(workspace, 'declined.txt'))).toBe(false)
    } else {
      for (const index of [3, 4, 5]) expect(results.get(`fixture-tool-${index}`)?.is_error).toBe(true)
      expect(resultText(3)).toMatch(/inside user directory/)
      expect(resultText(4)).toMatch(/blacklist/)
      expect(resultText(5)).toContain('白名单')
      expect(confirmations).toEqual([])
    }
  } finally {
    clearTimeout(timeout)
    handle?.close()
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill()
      await exited
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.promises.rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 35_000)
