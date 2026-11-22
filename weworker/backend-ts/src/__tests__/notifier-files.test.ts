/**
 * 定时任务推送的附件分发。
 *
 * 修复的约束：本轮 send_file_to_user 产出的文件要随推送一起发给通知目标，
 * 但附件是「尽力而为」——正文送达后附件失败只记警告（写执行记录），
 * 不改变文本推送的成败语义；通道不支持文件推送时安静跳过。
 *
 * 同时覆盖 collectExecutionFiles：只收本轮 file_attachment、按路径去重。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetStatuses = vi.fn<() => Record<string, { status: string; error?: string }>>()
const mockGetChannel = vi.fn()
const mockUpdateTaskExecution = vi.fn()
const mockAppendMessage = vi.fn()
vi.mock('../channels/channel-manager.js', () => ({
  channelManager: {
    getStatuses: (...args: unknown[]) => mockGetStatuses(...(args as [])),
    getChannel: (...args: unknown[]) => mockGetChannel(...args),
  },
}))
vi.mock('../works-store.js', () => ({
  updateTaskExecution: (...args: unknown[]) => mockUpdateTaskExecution(...(args as [string, Record<string, unknown>])),
  appendMessage: (...args: unknown[]) => mockAppendMessage(...(args as [])),
  getOrCreateChannelWork: () => ({ work: { id: 'work-fixture' }, created: false }),
  markExternalWrite: () => {},
}))
vi.mock('../task-executor.js', () => ({ executeTask: vi.fn() }))
vi.mock('../agent.js', () => ({ streamChat: vi.fn() }))

const { collectExecutionFiles, notify } = await import('../notifier.js')

const basePayload = {
  taskId: 'task-fixture',
  taskTitle: 'fixture 任务',
  status: 'completed' as const,
  executionId: 'exec-fixture',
  workId: 'work-fixture',
}

describe('collectExecutionFiles', () => {
  it('只收本轮 file_attachment，按路径去重且后写的名字生效', () => {
    const files = collectExecutionFiles([
      { type: 'text', text: '报告已生成' },
      { type: 'file_attachment', name: 'report-draft.pdf', path: 'C:/tmp/report.pdf', size: 10 },
      { type: 'file_attachment', name: 'report-final.pdf', path: 'C:/tmp/report.pdf', size: 20 },
      { type: 'file_attachment', name: 'list.tsv', path: 'C:/tmp/list.tsv' },
      { type: 'tool_use', id: 't1', name: 'send_file_to_user', args: {}, status: 'done' },
      { type: 'file_attachment', name: 'no-path.bin', path: '' },
    ])
    expect(files).toEqual([
      { path: 'C:/tmp/report.pdf', name: 'report-final.pdf' },
      { path: 'C:/tmp/list.tsv', name: 'list.tsv' },
    ])
  })

  it('没有附件时返回空数组', () => {
    expect(collectExecutionFiles([{ type: 'text', text: '纯文本结果' }])).toEqual([])
  })
})

describe('notify 的附件分发', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetStatuses.mockReturnValue({ wecom: { status: 'connected' } })
  })

  it('正文送达后把附件交给支持文件推送的通道', async () => {
    const sendNotification = vi.fn()
    const sendNotificationFiles = vi.fn()
    mockGetChannel.mockReturnValue({ sendNotification, sendNotificationFiles })
    const files = [{ path: 'C:/tmp/report.pdf', name: 'report.pdf' }]

    await notify({ ...basePayload, fullText: '执行完成', files }, ['wecom'])

    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotificationFiles).toHaveBeenCalledWith(files)
    // 文本推送成功照旧落一条追踪消息，执行记录不写任何错误。
    expect(mockAppendMessage).toHaveBeenCalledWith('work-fixture', 'assistant', [{ type: 'text', text: '📨 已通过企业微信发送通知' }])
    expect(mockUpdateTaskExecution).not.toHaveBeenCalled()
  })

  it('附件失败只记警告，不改变文本推送的成败', async () => {
    const sendNotification = vi.fn()
    const sendNotificationFiles = vi.fn().mockRejectedValue(new Error('文件上传失败'))
    mockGetChannel.mockReturnValue({ sendNotification, sendNotificationFiles })

    await notify({ ...basePayload, fullText: '执行完成', files: [{ path: 'C:/tmp/report.pdf', name: 'report.pdf' }] }, ['wecom'])

    // 正文已经送达：成功追踪消息仍在，不产生「通道通知失败」。
    expect(mockAppendMessage).toHaveBeenCalled()
    const [execId, updates] = mockUpdateTaskExecution.mock.calls[0]
    expect(execId).toBe('exec-fixture')
    expect(updates.error_message).toContain('附件发送失败')
    expect(updates.error_message).toContain('文件上传失败')
    expect(updates.error_message).not.toContain('通道通知失败')
  })

  it('通道不支持文件推送时安静跳过附件', async () => {
    const sendNotification = vi.fn()
    mockGetChannel.mockReturnValue({ sendNotification })
    await notify({ ...basePayload, files: [{ path: 'C:/tmp/report.pdf', name: 'report.pdf' }] }, ['wecom'])
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(mockUpdateTaskExecution).not.toHaveBeenCalled()
  })

  it('payload 没有附件时不触碰文件通道方法', async () => {
    const sendNotification = vi.fn()
    const sendNotificationFiles = vi.fn()
    mockGetChannel.mockReturnValue({ sendNotification, sendNotificationFiles })
    await notify({ ...basePayload, fullText: '执行完成' }, ['wecom'])
    expect(sendNotificationFiles).not.toHaveBeenCalled()
  })
})
