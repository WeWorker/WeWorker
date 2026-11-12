import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registeredTools: new Map<string, (args: Record<string, unknown>) => Promise<unknown>>(),
  toolDescriptions: new Map<string, string>(),
  runWeWorkerPowerShell: vi.fn(async () => ({
    exitCode: 0, sessionId: 'fixture-shell-session', shell: 'bash',
    cwd: '/fixture/workspace', output: 'fixture-shell-output',
  })),
}))

vi.mock('../powershell-runner.js', () => ({
  runWeWorkerPowerShell: mocks.runWeWorkerPowerShell,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
    mocks.registeredTools.set(name, handler)
    mocks.toolDescriptions.set(name, description)
    return { name, handler }
  },
  createSdkMcpServer: (config: { tools: unknown[] }) => config,
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../works-store.js', () => ({
  createScheduledTask: vi.fn(),
  listScheduledTasks: vi.fn(() => []),
}))

vi.mock('../scheduler.js', () => ({
  scheduler: { register: vi.fn() },
  Scheduler: { validateCron: vi.fn(() => ({ valid: true })), getNextRun: vi.fn() },
}))

vi.mock('../channels/channel-manager.js', () => ({
  channelManager: { getChannel: vi.fn(() => null) },
}))

vi.mock('../file-tools.js', () => ({
  listFiles: vi.fn(() => []),
}))

describe('Adapter command boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.registeredTools.clear()
    mocks.toolDescriptions.clear()
  })

  it('does not expose website automation tools in qa_only mode', async () => {
    const { buildMcpServer } = await import('../tools.js')

    const server = buildMcpServer({ channelPermissionMode: 'qa_only' })

    expect((server as unknown as { tools: unknown[] }).tools).toEqual([])
    expect(mocks.registeredTools.has('webcli_call')).toBe(false)
  })

  it('does not register the removed webcli_call MCP and describes unrestricted commands in full mode', async () => {
    const { buildMcpServer } = await import('../tools.js')

    buildMcpServer({ channelPermissionMode: 'full' })

    expect(mocks.registeredTools.has('webcli_call')).toBe(false)
    expect(mocks.registeredTools.has('call_adapter_tool')).toBe(false)
    expect(mocks.toolDescriptions.get('weworker_powershell')).toContain('Commands are unrestricted')
  })

  it('allows webcli through WeWorker Shell in full mode', async () => {
    const { buildMcpServer } = await import('../tools.js')

    const server = buildMcpServer({ channelPermissionMode: 'full' }) as unknown as {
      tools: Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<unknown> }>
    }
    const handler = server.tools.find(tool => tool.name === 'weworker_powershell')?.handler

    const result = await handler!({
      command: 'webcli call blog-admin.search-blog --limit=5',
    })

    expect(mocks.runWeWorkerPowerShell).toHaveBeenCalledOnce()
    expect(mocks.runWeWorkerPowerShell).toHaveBeenCalledWith(expect.objectContaining({
      command: 'webcli call blog-admin.search-blog --limit=5',
      source: 'ai',
    }))
    expect(JSON.stringify(result)).toContain('fixture-shell-output')
    expect(JSON.stringify(result)).not.toContain('must stay inside user directory')
    expect(JSON.stringify(result)).not.toContain('Adapter commands must run with')
  })

  it('does not expose webcli_call in no_bash mode', async () => {
    const { buildMcpServer } = await import('../tools.js')

    buildMcpServer({ channelPermissionMode: 'no_bash' })
    expect(mocks.registeredTools.has('webcli_call')).toBe(false)
  })

  it('rejects webcli through WeWorker Shell in no_bash mode at the tool policy boundary', async () => {
    const { createWeWorkerToolPolicy } = await import('../agent-tool-policy.js')
    const result = await createWeWorkerToolPolicy('no_bash')(
      'mcp__weworker__weworker_powershell',
      { command: 'webcli call open_browser --url=https://example.com/' },
      {} as never,
    )
    expect(result).toMatchObject({ behavior: 'deny' })
  })
})
