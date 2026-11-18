/**
 * WeWorker Bot 定时任务会话工具：list / update / disable。
 * 与 create_agent_scheduled_task 相同的边界：仅供 Bot 使用、仅主人可操作、
 * 通知目标必须来自已观察到的会话、cron 必须合法、任务必须属于当前 Bot。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** buildMcpServer 的 dedicatedAgent 上下文（受信运行时注入，不来自模型输入）。 */
type DedicatedAgentContext = { agentId: string; ownerUserId: string; actorUserId?: string; taskId?: string }

const mocks = vi.hoisted(() => ({
  registeredTools: new Map<string, (args: Record<string, unknown>) => Promise<unknown>>(),
  getScheduledTask: vi.fn(),
  updateScheduledTask: vi.fn(),
  listScheduledTasksForAgent: vi.fn(),
  listChannelNotifyTargets: vi.fn(),
  getAgent: vi.fn(),
  schedulerRegister: vi.fn(),
  schedulerUnregister: vi.fn(),
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
  listScheduledTasksForAgent: mocks.listScheduledTasksForAgent,
  listChannelNotifyTargets: mocks.listChannelNotifyTargets,
  getScheduledTask: mocks.getScheduledTask,
  updateScheduledTask: mocks.updateScheduledTask,
  createWork: vi.fn(),
}))

vi.mock('../scheduler.js', () => ({
  scheduler: { register: mocks.schedulerRegister, unregister: mocks.schedulerUnregister },
  Scheduler: { validateCron: vi.fn(() => ({ valid: true })), getNextRun: vi.fn(() => new Date('2026-11-17T01:00:00.000Z')) },
}))

vi.mock('../dedicated-agents/agent-store.js', () => ({ getAgent: mocks.getAgent, addAgentWork: vi.fn() }))

vi.mock('../channels/channel-manager.js', () => ({ channelManager: { getChannel: vi.fn(() => null) } }))

vi.mock('../powershell-runner.js', () => ({ runWeWorkerPowerShell: vi.fn() }))

vi.mock('../file-tools.js', () => ({ listFiles: vi.fn(() => []) }))

const OWNER: DedicatedAgentContext = { agentId: 'agent-1', ownerUserId: 'owner-1' }
const NON_OWNER: DedicatedAgentContext = { agentId: 'agent-1', ownerUserId: 'owner-1', actorUserId: 'someone-else' }

function taskFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: '旧标题',
    cron_expression: '0 9 * * *',
    prompt_template: '旧提示词',
    enabled: true,
    notify_channels: [],
    agent_id: 'agent-1',
    owner_user_id: 'owner-1',
    notification_targets: [],
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

function observedFixture() {
  return [{
    user_id: 'target-1',
    extra: { chat_type: 1, user_id: '' },
    updated_at: '2026-11-01T00:00:00.000Z',
  }]
}

/** Build the MCP server once with a context; return a direct tool caller. */
async function makeCaller(dedicatedAgent: DedicatedAgentContext | undefined) {
  const { buildMcpServer } = await import('../tools.js')
  buildMcpServer({ channelPermissionMode: 'full', dedicatedAgent })
  return (name: string, args: Record<string, unknown>) =>
    mocks.registeredTools.get(name)!(args) as Promise<{ content: Array<{ text: string }> }>
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

describe('WeWorker Bot 定时任务会话工具', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.registeredTools.clear()
    mocks.getAgent.mockReturnValue({ id: 'agent-1', enabled: true })
  })

  describe('list_agent_scheduled_tasks', () => {
    it('主人可查看本 Bot 的任务及下次执行时间', async () => {
      mocks.listScheduledTasksForAgent.mockReturnValue([
        taskFixture(),
        taskFixture({ id: 'task-2', enabled: false }),
      ])
      const call = await makeCaller(OWNER)

      const result = payload(await call('list_agent_scheduled_tasks', {}))

      expect(mocks.listScheduledTasksForAgent).toHaveBeenCalledWith('agent-1')
      expect(result.total).toBe(2)
      const tasks = result.tasks as Array<Record<string, unknown>>
      expect(tasks).toHaveLength(2)
      expect(tasks[0]).toMatchObject({ task_id: 'task-1', enabled: true, next_run: '2026-11-17T01:00:00.000Z' })
      expect(tasks[1]).toMatchObject({ task_id: 'task-2', enabled: false, next_run: null })
    })

    it('非主人和非 Bot 会话被拒绝', async () => {
      mocks.listScheduledTasksForAgent.mockReturnValue([])
      const ownerCall = await makeCaller(OWNER)
      expect(payload(await ownerCall('list_agent_scheduled_tasks', {})).total).toBe(0)

      const nonOwnerCall = await makeCaller(NON_OWNER)
      expect(payload(await nonOwnerCall('list_agent_scheduled_tasks', {})).error).toContain('主人')

      const plainCall = await makeCaller(undefined)
      expect(payload(await plainCall('list_agent_scheduled_tasks', {})).error).toContain('WeWorker Bot')
    })
  })

  describe('update_agent_scheduled_task', () => {
    it('主人确认后可修改标题、频率和提示词并刷新调度', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture())
      const updated = taskFixture({ title: '新标题', cron_expression: '0 8 * * *', prompt_template: '新提示词' })
      mocks.updateScheduledTask.mockReturnValue(updated)
      const call = await makeCaller(OWNER)

      const result = payload(await call('update_agent_scheduled_task', {
        task_id: 'task-1', title: '新标题', cron_expression: '0 8 * * *', prompt_template: '新提示词', confirmed: true,
      }))

      expect(result.success).toBe(true)
      expect(mocks.updateScheduledTask).toHaveBeenCalledWith('task-1', {
        title: '新标题', cron_expression: '0 8 * * *', prompt_template: '新提示词',
      })
      expect(mocks.schedulerRegister).toHaveBeenCalledWith('task-1', '0 8 * * *')
      expect(result.next_run).toBe('2026-11-17T01:00:00.000Z')
    })

    it('无效 cron 与未观察到的通知目标被拒绝且不落库', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture())
      mocks.listChannelNotifyTargets.mockReturnValue(observedFixture())
      const { Scheduler } = await import('../scheduler.js')
      vi.mocked(Scheduler.validateCron).mockReset().mockReturnValueOnce({ valid: false, error: '字段不足' })
      const call = await makeCaller(OWNER)

      expect(payload(await call('update_agent_scheduled_task', { task_id: 'task-1', cron_expression: 'x', confirmed: true })).error).toContain('cron')
      expect(payload(await call('update_agent_scheduled_task', { task_id: 'task-1', target_ids: ['ghost'], confirmed: true })).error).toContain('通知目标')
      expect(mocks.updateScheduledTask).not.toHaveBeenCalled()
    })

    it('可替换为已观察到的通知目标', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture())
      mocks.listChannelNotifyTargets.mockReturnValue(observedFixture())
      mocks.updateScheduledTask.mockReturnValue(taskFixture())
      const call = await makeCaller(OWNER)

      const result = payload(await call('update_agent_scheduled_task', { task_id: 'task-1', target_ids: ['target-1'], confirmed: true }))

      expect(result.success).toBe(true)
      expect(mocks.updateScheduledTask).toHaveBeenCalledWith('task-1', {
        notification_targets: [{ id: 'target-1', chat_type: 1, observed_user_id: '', observed_at: '2026-11-01T00:00:00.000Z' }],
      })
    })

    it('不修改任何字段、任务不属于本 Bot 或 Bot 已停用时拒绝', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture())
      const call = await makeCaller(OWNER)

      expect(payload(await call('update_agent_scheduled_task', { task_id: 'task-1', confirmed: true })).error).toContain('没有需要修改的字段')

      mocks.getScheduledTask.mockReturnValue(taskFixture({ agent_id: 'agent-2' }))
      expect(payload(await call('update_agent_scheduled_task', { task_id: 'task-1', title: 'x', confirmed: true })).error).toContain('不属于当前WeWorker Bot')

      mocks.getScheduledTask.mockReturnValue(taskFixture())
      mocks.getAgent.mockReturnValueOnce(null)
      expect(payload(await call('update_agent_scheduled_task', { task_id: 'task-1', title: 'x', confirmed: true })).error).toContain('不存在或已停用')
    })

    it('停用状态的任务修改后不重新注册调度，非主人被拒绝', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture({ enabled: false }))
      mocks.updateScheduledTask.mockReturnValue(taskFixture({ enabled: false, title: '新标题' }))
      const call = await makeCaller(OWNER)

      const result = payload(await call('update_agent_scheduled_task', { task_id: 'task-1', title: '新标题', confirmed: true }))

      expect(result.success).toBe(true)
      expect(result.next_run).toBeNull()
      expect(mocks.schedulerRegister).not.toHaveBeenCalled()

      const nonOwnerCall = await makeCaller(NON_OWNER)
      expect(payload(await nonOwnerCall('update_agent_scheduled_task', { task_id: 'task-1', title: 'x', confirmed: true })).error).toContain('主人')
    })
  })

  describe('disable_agent_scheduled_task', () => {
    it('主人确认后停用任务并注销调度', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture())
      mocks.updateScheduledTask.mockReturnValue(taskFixture({ enabled: false }))
      const call = await makeCaller(OWNER)

      const result = payload(await call('disable_agent_scheduled_task', { task_id: 'task-1', confirmed: true }))

      expect(result).toMatchObject({ success: true, disabled: true })
      expect(mocks.schedulerUnregister).toHaveBeenCalledWith('task-1')
      expect(mocks.updateScheduledTask).toHaveBeenCalledWith('task-1', { enabled: false })
    })

    it('已停用的任务幂等返回，不再注销或写库', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture({ enabled: false }))
      const call = await makeCaller(OWNER)

      const result = payload(await call('disable_agent_scheduled_task', { task_id: 'task-1', confirmed: true }))

      expect(result).toMatchObject({ success: true, already_disabled: true })
      expect(mocks.schedulerUnregister).not.toHaveBeenCalled()
      expect(mocks.updateScheduledTask).not.toHaveBeenCalled()
    })

    it('任务不属于本 Bot 或非主人时拒绝', async () => {
      mocks.getScheduledTask.mockReturnValue(taskFixture({ agent_id: 'agent-2' }))
      const call = await makeCaller(OWNER)
      expect(payload(await call('disable_agent_scheduled_task', { task_id: 'task-1', confirmed: true })).error).toContain('不属于当前WeWorker Bot')

      const nonOwnerCall = await makeCaller(NON_OWNER)
      expect(payload(await nonOwnerCall('disable_agent_scheduled_task', { task_id: 'task-1', confirmed: true })).error).toContain('主人')
    })
  })
})
