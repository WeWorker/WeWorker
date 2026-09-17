import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  registeredTools: new Map<string, (args: Record<string, unknown>) => Promise<unknown>>(),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
    mocks.registeredTools.set(name, handler)
    return { name, handler }
  },
  createSdkMcpServer: (config: { tools: unknown[] }) => config,
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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

const { buildMcpServer, registerExplorationCoordinator } = await import('../tools.js')

type RegisteredTools = Record<string, { handler: (args: unknown) => Promise<unknown> }>

function createFakeCoordinator() {
  return {
    list: vi.fn().mockReturnValue([{
      taskId: 'task-1',
      status: 'completed',
      phase: 'completed',
      tabTitle: 'Todo',
      tabUrl: 'https://todo.example.com/list',
      goal: '生成列表查询工具',
      hasSiteMemory: true,
      generationStatus: 'needs_user_input',
    }]),
    listTabs: vi.fn().mockResolvedValue([
      { id: 7, title: 'Todo', url: 'https://todo.example.com/list' },
    ]),
    startFromTabId: vi.fn().mockResolvedValue({ taskId: 'task-2', status: 'preparing' }),
    get: vi.fn().mockReturnValue({
      taskId: 'task-1',
      generationRun: {
        status: 'needs_user_input',
        currentAction: 'await_user_input',
        artifacts: {
          draft: { toolNames: ['todo.example.com.search_records'] },
          staticValidation: { passed: true },
          runtimeValidation: { passed: false },
          pendingQuestion: { question: '目标页面需要登录，请处理后继续', context: 'LOGIN_REQUIRED' },
          blockerNote: { question: '是否允许转人工验证？' },
        },
        failureAttribution: { summary: '目标页面不可用或需要登录' },
        lastError: { code: '' },
      },
    }),
    startGeneration: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      generationRun: { status: 'planning', currentAction: 'create_generation_plan', artifacts: {} },
    }),
    resumeGeneration: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      generationRun: { status: 'awaiting_approval', currentAction: 'await_publish_approval', artifacts: {} },
    }),
    publishGeneration: vi.fn().mockResolvedValue({
      taskId: 'task-1',
      generationRun: { status: 'completed' },
      generationRefreshError: null,
    }),
  }
}

function readRegisteredTools(server: unknown): RegisteredTools {
  const tools = (server as { tools: Array<{ name: string, handler: (args: unknown) => Promise<unknown> }> }).tools
  return Object.fromEntries(tools.map((entry) => [entry.name, entry]))
}

async function readJson(result: unknown): Promise<Record<string, unknown>> {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0].text)
}

describe('exploration chat mcp tools', () => {
  beforeEach(() => {
    registerExplorationCoordinator(() => null)
  })

  it('exposes the exploration and generation lifecycle only in full mode', () => {
    const coordinator = createFakeCoordinator()
    registerExplorationCoordinator(() => coordinator)

    const fullServer = buildMcpServer({ channelPermissionMode: 'full' })
    const fullTools = readRegisteredTools(fullServer)
    for (const name of [
      'list_explorable_tabs',
      'start_api_exploration',
      'list_api_explorations',
      'start_adapter_generation',
      'get_adapter_generation',
      'resume_adapter_generation',
      'publish_adapter_generation',
    ]) {
      expect(fullTools[name], `missing tool: ${name}`).toBeTruthy()
    }

    const qaServer = buildMcpServer({ channelPermissionMode: 'qa_only' })
    expect(Object.keys(readRegisteredTools(qaServer))).toHaveLength(0)

    registerExplorationCoordinator(() => null)
    const noCoordinatorServer = buildMcpServer({ channelPermissionMode: 'full' })
    expect(readRegisteredTools(noCoordinatorServer).start_adapter_generation).toBeUndefined()
  })

  it('lists tabs, explorations and starts exploration through the coordinator', async () => {
    const coordinator = createFakeCoordinator()
    registerExplorationCoordinator(() => coordinator)
    const tools = readRegisteredTools(buildMcpServer({ channelPermissionMode: 'full' }))

    const tabs = await readJson(await tools.list_explorable_tabs.handler({}))
    expect(tabs).toEqual({ tabs: [{ id: 7, title: 'Todo', url: 'https://todo.example.com/list' }] })

    const runs = await readJson(await tools.list_api_explorations.handler({}))
    expect(runs).toEqual({ runs: [expect.objectContaining({ taskId: 'task-1', generationStatus: 'needs_user_input' })] })

    const started = await readJson(await tools.start_api_exploration.handler({ tabId: 7, goal: '沉淀待办查询能力' }))
    expect(started).toMatchObject({ taskId: 'task-2' })
    expect(coordinator.startFromTabId).toHaveBeenCalledWith('沉淀待办查询能力', 7)
  })

  it('starts agent-mode generation and surfaces pending questions for the chat agent', async () => {
    const coordinator = createFakeCoordinator()
    registerExplorationCoordinator(() => coordinator)
    const tools = readRegisteredTools(buildMcpServer({ channelPermissionMode: 'full' }))

    const started = await readJson(await tools.start_adapter_generation.handler({ taskId: 'task-1', mode: 'agent' }))
    expect(started).toMatchObject({ taskId: 'task-1', status: 'planning' })
    expect(coordinator.startGeneration).toHaveBeenCalledWith('task-1', undefined, 'agent')

    const status = await readJson(await tools.get_adapter_generation.handler({ taskId: 'task-1' }))
    expect(status).toMatchObject({
      status: 'needs_user_input',
      toolNames: ['todo.example.com.search_records'],
      staticValidationPassed: true,
      runtimeValidationPassed: false,
      pendingQuestion: { question: '目标页面需要登录，请处理后继续', context: 'LOGIN_REQUIRED' },
      blockerQuestion: '是否允许转人工验证？',
      failureSummary: '目标页面不可用或需要登录',
    })
  })

  it('resumes with the user answer and publishes after approval', async () => {
    const coordinator = createFakeCoordinator()
    registerExplorationCoordinator(() => coordinator)
    const tools = readRegisteredTools(buildMcpServer({ channelPermissionMode: 'full' }))

    const resumed = await readJson(await tools.resume_adapter_generation.handler({ taskId: 'task-1', answer: '已重新登录页面' }))
    expect(resumed).toMatchObject({ status: 'awaiting_approval' })
    expect(coordinator.resumeGeneration).toHaveBeenCalledWith('task-1', '已重新登录页面')

    const published = await readJson(await tools.publish_adapter_generation.handler({ taskId: 'task-1' }))
    expect(published).toMatchObject({ published: true, status: 'completed' })
    expect(coordinator.publishGeneration).toHaveBeenCalledWith('task-1')
  })

  it('returns tool errors as json instead of throwing', async () => {
    const coordinator = createFakeCoordinator()
    coordinator.startGeneration = vi.fn().mockRejectedValue(new Error('探索尚未完成'))
    registerExplorationCoordinator(() => coordinator)
    const tools = readRegisteredTools(buildMcpServer({ channelPermissionMode: 'full' }))

    const result = await readJson(await tools.start_adapter_generation.handler({ taskId: 'task-x' }))
    expect(result).toEqual({ error: '探索尚未完成' })
  })
})
