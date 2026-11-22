/**
 * send_agent_message 的附件参数。
 *
 * 修复的约束：WeWorker Bot 定时任务推送要能随消息附带文件，但附件必须
 * 「先整体校验再发正文」——路径在用户目录外、文件缺失或通道不支持时
 * 整体失败，不能留下一条没带附件的半成品文本推送。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registeredTools: new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>(),
  userDir: '',
  channel: null as Record<string, unknown> | null,
  task: null as Record<string, unknown> | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) => {
    mocks.registeredTools.set(name, handler)
    return { name, handler }
  },
  createSdkMcpServer: (config: unknown) => config,
}))
vi.mock('../config.js', () => ({ getUserDirectory: () => mocks.userDir }))
vi.mock('../user-directory-guard.js', () => ({
  // Normalize separators only; test paths are already absolute under mocks.userDir.
  assertPathInsideUserDirectory: (value: string) => {
    const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    const resolved = norm(value)
    const root = norm(mocks.userDir)
    if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error('路径不在用户目录内')
    return value
  },
}))
vi.mock('../works-store.js', () => ({
  getScheduledTask: (id: string) => (mocks.task && (mocks.task as { id: string }).id === id ? mocks.task : null),
}))
vi.mock('../channels/channel-manager.js', () => ({
  channelManager: { getChannel: (key: string) => (key === 'agent:agent-fixture' ? mocks.channel : undefined) },
}))

const { buildMcpServer } = await import('../tools.js')

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-agent-msg-'))
  mocks.userDir = dir
  mocks.registeredTools.clear()
  mocks.channel = {
    sendNotificationToTarget: vi.fn(async () => {}),
    sendFilesToTarget: vi.fn(async () => {}),
  }
  mocks.task = {
    id: 'task-fixture',
    agent_id: 'agent-fixture',
    enabled: true,
    notification_targets: [{ id: 'chat-fixture', chat_type: 1 }],
  }
  buildMcpServer({
    channelPermissionMode: 'full',
    dedicatedAgent: { agentId: 'agent-fixture', ownerUserId: 'owner-fixture', taskId: 'task-fixture', desktop: true },
  })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const call = async (input: Record<string, unknown>) => JSON.parse((await mocks.registeredTools.get('send_agent_message')!(input)).content[0].text)
const channelMocks = () => mocks.channel as unknown as {
  sendNotificationToTarget: ReturnType<typeof vi.fn>
  sendFilesToTarget: ReturnType<typeof vi.fn>
}

describe('send_agent_message 附件', () => {
  it('正文送达后把用户目录内的文件作为附件发送', async () => {
    const report = path.join(dir, 'report-fixture.pdf')
    fs.writeFileSync(report, 'fixture-report')

    const result = await call({ target_id: 'chat-fixture', message: '报告已生成', file_paths: [report] })

    expect(result).toMatchObject({ success: true, target_id: 'chat-fixture', delivered: true, attachments_sent: 1 })
    expect(channelMocks().sendNotificationToTarget).toHaveBeenCalledWith({ id: 'chat-fixture', chatType: 1 }, '报告已生成')
    expect(channelMocks().sendFilesToTarget).toHaveBeenCalledWith({ id: 'chat-fixture', chatType: 1 }, [{ path: report, name: 'report-fixture.pdf' }])
  })

  it('不带 file_paths 时行为与原来完全一致', async () => {
    const result = await call({ target_id: 'chat-fixture', message: '仅文本' })
    expect(result).toMatchObject({ success: true, delivered: true })
    expect(channelMocks().sendFilesToTarget).not.toHaveBeenCalled()
  })

  it('用户目录外的附件先被拒绝，正文不会发出', async () => {
    const result = await call({ target_id: 'chat-fixture', message: '报告已生成', file_paths: [path.join(os.tmpdir(), 'outside-fixture.pdf')] })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('附件无法发送')
    expect(channelMocks().sendNotificationToTarget).not.toHaveBeenCalled()
    expect(channelMocks().sendFilesToTarget).not.toHaveBeenCalled()
  })

  it('磁盘上不存在的附件先被拒绝，正文不会发出', async () => {
    const result = await call({ target_id: 'chat-fixture', message: '报告已生成', file_paths: [path.join(dir, 'missing-fixture.pdf')] })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('missing-fixture.pdf')
    expect(channelMocks().sendNotificationToTarget).not.toHaveBeenCalled()
  })

  it('通道不支持文件推送时整体失败并说明原因，不发出缺附件的正文', async () => {
    mocks.channel = { sendNotificationToTarget: vi.fn(async () => {}) }
    const result = await call({ target_id: 'chat-fixture', message: '报告已生成', file_paths: [path.join(dir, 'report-fixture.pdf')] })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('不支持随消息发送文件')
    expect((mocks.channel as { sendNotificationToTarget: ReturnType<typeof vi.fn> }).sendNotificationToTarget).not.toHaveBeenCalled()
  })
})
