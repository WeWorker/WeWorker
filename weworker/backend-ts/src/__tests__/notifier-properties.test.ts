/**
 * **Feature: scheduled-tasks, Property 9: 通知分发**
 *
 * For any completed scheduled task (status is completed or failed), the system
 * should send a notification containing the task title and execution status.
 *
 * 1. System notification (SSE broadcast) is ALWAYS sent regardless of channels.
 * 2. If notify_channels are configured and the channel is connected, channel
 *    notification is attempted.
 * 3. If the channel is NOT connected or sending fails, the system falls back to
 *    system notification and records the failure in the execution record.
 *
 * **Validates: Requirements 7.1, 7.5, 7.6**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock channel-manager: control getStatuses() per test
const mockGetStatuses = vi.fn<() => Record<string, { status: string; error?: string }>>()
const mockGetChannel = vi.fn()
vi.mock('../channels/channel-manager.js', () => ({
  channelManager: {
    getStatuses: (...args: unknown[]) => mockGetStatuses(...(args as [])),
    getChannel: (...args: unknown[]) => mockGetChannel(...args),
  },
}))

// Mock works-store: spy on updateTaskExecution
const mockUpdateTaskExecution = vi.fn()
vi.mock('../works-store.js', () => ({
  updateTaskExecution: (...args: unknown[]) => mockUpdateTaskExecution(...args),
}))

// Mock heavy dependencies to avoid side-effect imports
vi.mock('../task-executor.js', () => ({ executeTask: vi.fn() }))
vi.mock('../agent.js', () => ({ streamChat: vi.fn() }))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are set up
// ---------------------------------------------------------------------------
import {
  formatNotificationMessage,
  notify,
  registerSSEClient,
  unregisterSSEClient,
  broadcastSSE,
} from '../notifier.js'

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const arbNonEmptyStr = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0)

const arbStatus = fc.constantFrom<'completed' | 'failed'>('completed', 'failed')

const arbPayload = fc.record({
  taskId: fc.uuid(),
  taskTitle: arbNonEmptyStr,
  status: arbStatus,
  summary: fc.option(arbNonEmptyStr, { nil: undefined }),
  error: fc.option(arbNonEmptyStr, { nil: undefined }),
  executionId: fc.uuid(),
  workId: fc.uuid(),
})

const arbChannelName = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[a-z]+$/.test(s))

const arbChannels = fc.uniqueArray(arbChannelName, { minLength: 0, maxLength: 4 })

// ---------------------------------------------------------------------------
// Helpers — fake SSE Response object
// ---------------------------------------------------------------------------

function createFakeSSEClient() {
  const chunks: string[] = []
  const res = {
    write: vi.fn((data: string) => {
      chunks.push(data)
      return true
    }),
    // Minimal Response-like shape
    writeHead: vi.fn(),
    end: vi.fn(),
  }
  return { res: res as unknown as import('express').Response, chunks }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 9: 通知分发', () => {
  let fakeClient: ReturnType<typeof createFakeSSEClient>

  beforeEach(() => {
    vi.clearAllMocks()
    // Register a fake SSE client so we can observe broadcastSSE writes
    fakeClient = createFakeSSEClient()
    registerSSEClient(fakeClient.res)
    // Default: no channels connected
    mockGetStatuses.mockReturnValue({})
    mockGetChannel.mockReset()
  })

  afterEach(() => {
    unregisterSSEClient(fakeClient.res)
  })

  // -------------------------------------------------------------------------
  // Scenario 1: No channels → only system notification (SSE broadcast)
  // -------------------------------------------------------------------------
  it('always sends system notification via SSE when no channels are specified', async () => {
    await fc.assert(
      fc.asyncProperty(arbPayload, async (payload) => {
        vi.clearAllMocks()

        // Act — no channels
        await notify(payload, [])

        // Assert — SSE client received exactly one write with task_notification
        expect(fakeClient.res.write).toHaveBeenCalledTimes(1)
        const written = (fakeClient.res.write as ReturnType<typeof vi.fn>).mock
          .calls[0][0] as string
        const parsed = JSON.parse(written.replace(/^data: /, '').trim())
        expect(parsed.type).toBe('task_notification')
        expect(parsed.data.taskTitle).toBe(payload.taskTitle)
        expect(parsed.data.status).toBe(payload.status)

        // No channel interaction
        expect(mockGetStatuses).not.toHaveBeenCalled()
        // No execution record update (no failures)
        expect(mockUpdateTaskExecution).not.toHaveBeenCalled()
      }),
      { numRuns: 100 },
    )
  })

  it('sends the original execution text and appends the summary for channels', async () => {
    const sendNotification = vi.fn()
    mockGetStatuses.mockReturnValue({ wecom: { status: 'connected' } })
    mockGetChannel.mockReturnValue({ sendNotification })

    await notify({
      taskId: 'fixture-task',
      taskTitle: 'Fixture task',
      status: 'completed',
      summary: 'Concise notification summary',
      fullText: 'Long original execution output',
      executionId: 'fixture-execution',
      workId: 'fixture-work',
    }, ['wecom'])

    // 原始执行结果（可能含表格）必须在正文里，摘要只做补充。
    expect(sendNotification).toHaveBeenCalledWith(expect.stringContaining('Long original execution output'))
    expect(sendNotification).toHaveBeenCalledWith(expect.stringContaining('Concise notification summary'))
    const sent = String(sendNotification.mock.calls[0][0])
    expect(sent.indexOf('Long original execution output')).toBeLessThan(sent.indexOf('Concise notification summary'))
  })

  // -------------------------------------------------------------------------
  // Scenario 2: Channels specified & connected → SSE + channel attempt
  // -------------------------------------------------------------------------
  it('sends system notification AND attempts channel notification when channel is connected', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPayload,
        fc.uniqueArray(arbChannelName, { minLength: 1, maxLength: 3 }),
        async (payload, channels) => {
          vi.clearAllMocks()

          // All channels are connected
          const statuses: Record<string, { status: string }> = {}
          for (const ch of channels) {
            statuses[ch] = { status: 'connected' }
          }
          mockGetStatuses.mockReturnValue(statuses)

          await notify(payload, channels)

          // SSE broadcast always happens
          expect(fakeClient.res.write).toHaveBeenCalled()
          const written = (fakeClient.res.write as ReturnType<typeof vi.fn>)
            .mock.calls[0][0] as string
          const parsed = JSON.parse(written.replace(/^data: /, '').trim())
          expect(parsed.type).toBe('task_notification')

          // Channel statuses were checked (once per channel)
          expect(mockGetStatuses).toHaveBeenCalledTimes(channels.length)

          // Connected channels still fail (no sendMessage support) → failure recorded
          expect(mockUpdateTaskExecution).toHaveBeenCalledTimes(1)
          const [execId, updates] = mockUpdateTaskExecution.mock.calls[0]
          expect(execId).toBe(payload.executionId)
          expect(typeof updates.error_message).toBe('string')
          expect(updates.error_message.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  // -------------------------------------------------------------------------
  // Scenario 3: Channels NOT connected → SSE + fallback + failure recorded
  // -------------------------------------------------------------------------
  it('falls back and records failure when channels are not connected', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPayload,
        fc.uniqueArray(arbChannelName, { minLength: 1, maxLength: 3 }),
        async (payload, channels) => {
          vi.clearAllMocks()

          // All channels are disconnected (status != 'connected')
          const statuses: Record<string, { status: string }> = {}
          for (const ch of channels) {
            statuses[ch] = { status: 'error' }
          }
          mockGetStatuses.mockReturnValue(statuses)

          await notify(payload, channels)

          // SSE broadcast always happens
          expect(fakeClient.res.write).toHaveBeenCalled()

          // Failure recorded in execution record
          expect(mockUpdateTaskExecution).toHaveBeenCalledTimes(1)
          const [execId, updates] = mockUpdateTaskExecution.mock.calls[0]
          expect(execId).toBe(payload.executionId)
          expect(typeof updates.error_message).toBe('string')
          expect(updates.error_message.length).toBeGreaterThan(0)

          // Each channel's failure should be mentioned
          for (const ch of channels) {
            expect(updates.error_message).toContain(ch)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('通知正文保留原始执行结果', () => {
  const base = {
    taskId: 'task-1',
    taskTitle: '查看到期待办',
    executionId: 'exec-1',
    workId: 'work-1',
    status: 'completed' as const,
  }
  const table = [
    '| 工单号 | 标题 | 到期时间 |',
    '| --- | --- | --- |',
    '| 10135662 | 测试环境 log4j | 2026-11-30 |',
  ].join('\n')

  it('summary 只追加在 fullText 后面，不替换正文', () => {
    const message = formatNotificationMessage({ ...base, fullText: table, summary: '共 1 条，最早 11-30 到期。' })
    expect(message).toContain('| 工单号 | 标题 | 到期时间 |')
    expect(message).toContain('摘要: 共 1 条，最早 11-30 到期。')
    expect(message.indexOf(table)).toBeLessThan(message.indexOf('摘要:'))
  })

  it('没有 fullText 时才单独使用 summary', () => {
    const message = formatNotificationMessage({ ...base, summary: '共 1 条。' })
    expect(message).toContain('摘要: 共 1 条。')
  })

  it('没有 summary 时正文就是 fullText', () => {
    const message = formatNotificationMessage({ ...base, fullText: table })
    expect(message).toContain(table)
    expect(message).not.toContain('摘要:')
  })
})
