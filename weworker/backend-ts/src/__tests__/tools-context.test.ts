import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { getActiveWorkspaceDirectory, runWithWorkspaceDirectory } from '../workspace-access-context.js'
import { assertPathInsideUserDirectory } from '../user-directory-guard.js'

const runWeWorkerPowerShell = vi.fn(async (options) => ({
  sessionId: 'ps-test',
  command: options.command,
  cwd: options.cwd || 'cwd',
  shell: options.shell || 'bash',
  exitCode: 0,
  signal: null,
  output: 'ok',
  stdout: 'ok',
  stderr: '',
  workspaceDirectory: getActiveWorkspaceDirectory(),
}))

vi.mock('../powershell-runner.js', () => ({
  runWeWorkerPowerShell,
}))

vi.mock('../webcli-runner.js', () => ({
  runWebcliCall: vi.fn(),
}))

describe('MCP tool context', () => {
  it('runs file and shell handlers in the bound workspace', async () => {
    const { buildMcpServer } = await import('../tools.js')
    const directory = path.resolve('/example/workspace')
    const server = buildMcpServer({ channelPermissionMode: 'workspace', workspaceDirectory: directory })
    type RegisteredTools = { _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> }
    const tools = (server.instance as unknown as RegisteredTools)._registeredTools
    const files = await tools.list_files.handler({})
    expect(JSON.parse(files.content[0].text).directory).toBe(directory)
    const shell = await tools.weworker_powershell.handler({ command: 'echo example' })
    expect(JSON.parse(shell.content[0].text).success).toBe(true)
    expect((await runWeWorkerPowerShell.mock.results.at(-1)?.value)?.workspaceDirectory).toBe(directory)
    expect(getActiveWorkspaceDirectory()).toBeUndefined()
    runWeWorkerPowerShell.mockClear()
  })
  it.each(['ask', 'workspace', 'full'] as const)('passes %s mode through MCP handlers to file guards', async mode => {
    const { buildMcpServer } = await import('../tools.js')
    const server = buildMcpServer({ channelPermissionMode: mode, workspaceDirectory: path.resolve('/example/workspace') })
    type RegisteredTool = { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
    const tools = (server.instance as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools
    const outside = path.resolve('/example/outside.txt')
    const result = await tools.send_file_to_user.handler({ file_path: outside })
    const error = JSON.parse(result.content[0].text).error || ''
    if (mode === 'workspace') {
      expect(error).toContain('must stay inside user directory')
      expect(() => runWithWorkspaceDirectory(path.resolve('/example/workspace'), () => assertPathInsideUserDirectory(outside), mode)).toThrow(/must stay inside user directory/)
    } else {
      expect(error).not.toContain('must stay inside user directory')
      expect(runWithWorkspaceDirectory(path.resolve('/example/workspace'), () => assertPathInsideUserDirectory(outside), mode)).toBe(outside)
    }
  })
  it('keeps shell tool work context scoped to each MCP server instance', async () => {
    const { buildMcpServer } = await import('../tools.js')
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const firstServer = buildMcpServer({ workId: 'work-1', abortSignal: firstAbort.signal })
    const secondServer = buildMcpServer({ workId: 'work-2', abortSignal: secondAbort.signal })
    type RegisteredTool = { handler: (input: { command: string }) => Promise<unknown> }
    type ServerWithRegisteredTools = { _registeredTools: Record<string, RegisteredTool> }
    const firstTools = firstServer.instance as unknown as ServerWithRegisteredTools
    const secondTools = secondServer.instance as unknown as ServerWithRegisteredTools

    await firstTools._registeredTools.weworker_powershell.handler({ command: 'echo first' })
    await secondTools._registeredTools.weworker_powershell.handler({ command: 'echo second' })
    await firstTools._registeredTools.weworker_powershell.handler({ command: 'echo again' })

    expect(runWeWorkerPowerShell.mock.calls.map(([options]) => ({
      command: options.command,
      workId: options.workId,
      signal: options.signal,
    }))).toEqual([
      { command: 'echo first', workId: 'work-1', signal: firstAbort.signal },
      { command: 'echo second', workId: 'work-2', signal: secondAbort.signal },
      { command: 'echo again', workId: 'work-1', signal: firstAbort.signal },
    ])
  })
})
