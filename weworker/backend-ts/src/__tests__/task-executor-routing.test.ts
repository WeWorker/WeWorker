/**
 * 定时任务（task-executor）接入智能路由的接线约束。
 *
 * 这是本次改动的核心：定时任务此前直接 `streamChat`，整条级联在它身上根本不存在。
 * 这里用**真实 works-store（内存库）**加少量桩，断言真正会发生的事：
 * - 命中时不再为这一轮付模型成本，且落库的 timing 带 `routeTool`；
 * - 未命中时行为与接线前完全一致（照常跑模型、照常落一条带耗时的 timing）；
 * - 专属 Agent 任务不接入路由（它有自己的站点/技能边界）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  tryRoutedTurn: vi.fn(),
  streamChat: vi.fn(),
  getAgent: vi.fn(),
  workspaceRoot: '',
  historyLimit: 50,
}))

// 路由引擎不在这里测（routed-turn.test.ts 覆盖），只桩掉 API 免得加载全部配置。
vi.mock('../api-query-router/index.js', () => ({ tryIntelligentQueryRoute: vi.fn() }))

vi.mock('../routed-turn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routed-turn.js')>()
  return { ...actual, tryRoutedTurn: mocks.tryRoutedTurn }
})

vi.mock('../agent.js', () => ({ streamChat: mocks.streamChat }))
vi.mock('../conversation-archive.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversation-archive.js')>()
  const archiveFile = () => path.join(mocks.workspaceRoot, 'archived-works.json')
  return {
    listArchivedWorkIds: () => actual.listArchivedWorkIds(archiveFile()),
    removeArchivedWork: (id: string) => actual.removeArchivedWork(id, archiveFile()),
    setWorkArchived: (id: string, archived: boolean) => actual.setWorkArchived(id, archived, archiveFile()),
  }
})
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))
vi.mock('../style-settings.js', () => ({ resolveStyleId: () => null }))
vi.mock('../config.js', () => ({
  getSettings: () => ({ memory_budgets: {}, api_query_llm_route: false, scheduled_task_history_limit: mocks.historyLimit }),
  getSiteEnabled: () => true,
  getUserDirectory: () => mocks.workspaceRoot,
  getConfigDirectory: () => path.join(mocks.workspaceRoot, '.weworker'),
  expandHomePath: (value: string) => value,
  ensureProjectsDirectory: () => {
    const directory = path.join(mocks.workspaceRoot, 'projects')
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  ensureProjectDirectory: (...segments: string[]) => {
    const directory = path.join(mocks.workspaceRoot, 'projects', ...segments)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
}))
vi.mock('../dedicated-agents/agent-store.js', () => ({ getAgent: mocks.getAgent }))
vi.mock('../dedicated-agents/agent-runtime.js', () => ({ buildAgentChatOptions: () => ({}) }))
vi.mock('../memory/memory-event-context.js', () => ({
  buildMemoryEventContext: () => ({ scope: { user: 'local' } }),
}))
vi.mock('../memory/memory-event-planner.js', () => ({
  planTaskMemoryEvent: () => ({
    event: { trigger: 'task_completed', scope: { user: 'local' }, expectedMemoryType: 'task_execution' },
  }),
}))

import {
  _initTestDb,
  _getTestDb,
  createWork,
  createTaskExecution,
  createScheduledTask,
  getProjectByName,
  getWork,
  getScheduledTask,
  getWorkWithMessages,
  listWorks,
  listTaskExecutions,
  updateTaskExecution,
  type ScheduledTask,
} from '../works-store.js'
import { executeTask } from '../task-executor.js'

function makeTask(overrides: Partial<Parameters<typeof createScheduledTask>[0]> = {}): ScheduledTask {
  const created = createScheduledTask({
    title: '每日巡检',
    cron_expression: '0 9 * * *',
    prompt_template: '示例 仓库列表',
    enabled: true,
    notify_channels: [],
    ...overrides,
  })
  return getScheduledTask(created.id)!
}

/** 取任务 work 的 assistant 消息里的 timing 块。 */
function assistantTiming(workId: string): Record<string, unknown> | null {
  const messages = getWorkWithMessages(workId)!.messages
  const assistant = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!assistant) return null
  return (assistant.content.find((block) => block.type === 'timing') ?? null) as Record<string, unknown> | null
}

describe('executeTask 的路由接线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-task-routing-'))
    _initTestDb()
    mocks.historyLimit = 50
    mocks.getAgent.mockReturnValue(null)
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: 'text_delta', content: '模型回答' }
    })
    mocks.tryRoutedTurn.mockResolvedValue({ handled: false, text: '', timing: null })
  })

  afterEach(() => {
    fs.rmSync(mocks.workspaceRoot, { recursive: true, force: true })
  })

  it('命中路由时跳过模型回合，落库的 timing 带 routeTool', async () => {
    mocks.tryRoutedTurn.mockResolvedValue({
      handled: true,
      text: '| 名称 | 状态 |',
      timing: { totalMs: 42, llmMs: 0, execMs: 40, steps: 1, routeTool: 'example.com.list' },
    })
    const task = makeTask()

    const result = await executeTask(task)

    expect(result.status).toBe('completed')
    expect(mocks.streamChat).not.toHaveBeenCalled()
    const timing = assistantTiming(result.workId)
    expect(timing).toMatchObject({ type: 'timing', llmMs: 0, routeTool: 'example.com.list', execMs: 40 })
    // 摘要来自路由渲染的正文，通知与执行记录都能用。
    expect(result.summary).toContain('| 名称 | 状态 |')
    expect(listTaskExecutions(task.id)[0].status).toBe('completed')
  })

  it('用任务原文与其之前的历史调用共享入口', async () => {
    const task = makeTask({ prompt_template: '  示例 仓库列表 ' })

    await executeTask(task)

    const input = mocks.tryRoutedTurn.mock.calls[0][0]
    expect(input).toMatchObject({ message: '  示例 仓库列表 ', persist: false })
    // 刚写入的那条 user 消息不能进 history，否则追问闸门会把本轮当成追问。
    expect(input.history).toEqual([])
    expect(typeof input.workId).toBe('string')
  })

  it('未命中时照常跑模型回合，行为与接线前一致', async () => {
    const task = makeTask()

    const result = await executeTask(task)

    expect(result.status).toBe('completed')
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
    const timing = assistantTiming(result.workId)
    expect(timing).toBeTruthy()
    expect(timing!.routeTool).toBeUndefined()
    expect(result.summary).toBe('模型回答')
  })

  it('专属 Agent 任务不接入路由', async () => {
    mocks.getAgent.mockReturnValue({
      id: 'agent-1',
      name: '巡检助手',
      enabled: true,
      project_id: null,
      site_id: 'example.com',
      description: '',
      skill_name: null,
    })
    const task = makeTask({ agent_id: 'agent-1' })

    const result = await executeTask(task)

    expect(result.status).toBe('completed')
    expect(mocks.tryRoutedTurn).not.toHaveBeenCalled()
    expect(mocks.streamChat).toHaveBeenCalledTimes(1)
  })

  it('提示词为空时既不路由也不跑模型', async () => {
    const task = makeTask({ prompt_template: '   ' })

    const result = await executeTask(task)

    expect(result.status).toBe('failed')
    expect(mocks.tryRoutedTurn).not.toHaveBeenCalled()
    expect(mocks.streamChat).not.toHaveBeenCalled()
  })

  it('cleans an accumulated 65-run history to the configured 50 without restarting or saving settings', async () => {
    const task = makeTask()
    const project = getProjectByName('定时任务')!
    const previousIds: string[] = []
    for (let index = 0; index < 65; index += 1) {
      const work = createWork(`Fixture run ${index}`, project.id)
      previousIds.push(work.id)
      _getTestDb().prepare('UPDATE works SET created_at = ? WHERE id = ?').run(new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString(), work.id)
      const execution = createTaskExecution(task.id, work.id)
      updateTaskExecution(execution.id, { status: 'completed' })
    }
    const unrelated = createWork('Unrelated conversation')

    const result = await executeTask(task)

    expect(result.status).toBe('completed')
    expect(listWorks().filter(work => work.project_id === project.id)).toHaveLength(50)
    for (const id of previousIds.slice(0, 16)) expect(getWork(id)).toBeNull()
    for (const id of previousIds.slice(16)) expect(getWork(id)).not.toBeNull()
    expect(getWork(result.workId)).not.toBeNull()
    expect(getWork(unrelated.id)).not.toBeNull()
    expect(listTaskExecutions(task.id)).toHaveLength(50)
  })

  it.each(['completed', 'failed', 'empty-prompt'] as const)('enforces a changed cap after a %s run', async outcome => {
    const task = makeTask()
    const previous = await executeTask(task)
    mocks.historyLimit = 1
    if (outcome === 'failed') mocks.streamChat.mockImplementation(async function* () { throw new Error('Fixture failure') })
    if (outcome === 'empty-prompt') task.prompt_template = ''

    const result = await executeTask(task)

    expect(result.status).toBe(outcome === 'completed' ? 'completed' : 'failed')
    expect(getWork(previous.workId)).toBeNull()
    expect(getWork(result.workId)).not.toBeNull()
    expect(listTaskExecutions(task.id).map(execution => execution.work_id)).toEqual([result.workId])
  })
})
