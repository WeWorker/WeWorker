/**
 * Notifier — 任务执行完成后的通知分发。
 *
 * 1. 系统通知：通过 SSE 推送 `task_notification` 事件到前端（前端再调用 Electron Notification API）
 * 2. 通道通知：检查 channelManager 中通道连接状态，尝试发送消息
 *    - 通道未连接或发送失败时回退到系统通知，并在执行记录中记录失败信息
 */

import type { Response } from 'express'
import { channelManager } from './channels/channel-manager.js'
import { createLogger } from './logger.js'

const log = createLogger('notifier')
import * as store from './works-store.js'

// ---------------------------------------------------------------------------
// NotificationPayload — 与 task-executor.ts 中定义的接口保持一致
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  taskId: string
  taskTitle: string
  status: 'completed' | 'failed'
  summary?: string
  fullText?: string
  error?: string
  executionId: string
  workId: string
}

// ---------------------------------------------------------------------------
// SSE Client Registry — 管理连接的前端 SSE 客户端
// ---------------------------------------------------------------------------

const sseClients = new Set<Response>()

/** 注册一个 SSE 客户端（由 server.ts 的 GET /events 端点调用） */
export function registerSSEClient(res: Response): void {
  sseClients.add(res)
}

/** 注销一个 SSE 客户端（客户端断开时调用） */
export function unregisterSSEClient(res: Response): void {
  sseClients.delete(res)
}

/** 向所有已连接的 SSE 客户端广播事件 */
export function broadcastSSE(event: object): void {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(data)
    } catch {
      // 写入失败，移除断开的客户端
      sseClients.delete(client)
    }
  }
}

/** 获取当前连接的 SSE 客户端数量（用于测试/调试） */
export function getSSEClientCount(): number {
  return sseClients.size
}

// ---------------------------------------------------------------------------
// 系统通知 — 通过 SSE 推送 task_notification 事件
// ---------------------------------------------------------------------------

function sendSystemNotification(payload: NotificationPayload): void {
  broadcastSSE({
    type: 'task_notification',
    data: {
      taskId: payload.taskId,
      taskTitle: payload.taskTitle,
      executionId: payload.executionId,
      workId: payload.workId,
      status: payload.status,
      summary: payload.summary,
    },
  })
}

// ---------------------------------------------------------------------------
// 通道通知 — 尝试通过消息通道发送通知
// ---------------------------------------------------------------------------

export function formatNotificationMessage(payload: NotificationPayload): string {
  const statusText = payload.status === 'completed' ? '✅ 执行完成' : '❌ 执行失败'
  let msg = `[定时任务] ${payload.taskTitle}\n${statusText}`
  // 通道正文始终是原始执行结果：表格、列表原样保留；摘要只追加在后面做补充，不能替换正文。
  if (payload.fullText) {
    msg += `\n\n${payload.fullText}`
    if (payload.summary) msg += `\n\n摘要: ${payload.summary}`
  } else if (payload.summary) {
    msg += `\n摘要: ${payload.summary}`
  }
  if (payload.error) {
    msg += `\n错误: ${payload.error}`
  }
  return msg
}

async function sendChannelNotification(
  payload: NotificationPayload,
  channel: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const statuses = channelManager.getStatuses()
    const channelStatus = statuses[channel]

    if (!channelStatus || channelStatus.status !== 'connected') {
      return {
        success: false,
        error: `通道 "${channel}" 未连接 (状态: ${channelStatus?.status ?? '未注册'})`,
      }
    }

    // 尝试通过通道的 sendNotification 方法发送
    const channelInstance = channelManager.getChannel(channel)
    if (!channelInstance?.sendNotification) {
      return {
        success: false,
        error: `通道 "${channel}" 不支持主动推送通知`,
      }
    }

    const message = formatNotificationMessage(payload)
    await channelInstance.sendNotification(message)
    log.info(`通道 "${channel}" 通知发送成功`)
    return { success: true }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { success: false, error: `通道 "${channel}" 发送失败: ${errorMsg}` }
  }
}

// ---------------------------------------------------------------------------
// notify — 主入口
// ---------------------------------------------------------------------------

/**
 * 发送任务执行通知。
 *
 * 1. 始终发送系统通知（SSE → 前端 → Electron Notification）
 * 2. 如果指定了通道，尝试通过通道发送；失败则回退到系统通知并记录失败信息
 */
export async function notify(
  payload: NotificationPayload,
  channels: string[],
): Promise<void> {
  // 1. 始终发送系统通知
  sendSystemNotification(payload)

  // 2. 尝试通道通知
  if (channels.length === 0) return

  const failures: string[] = []

  for (const channel of channels) {
    const result = await sendChannelNotification(payload, channel)
    if (result.success) {
      // 记录通知发送成功到对话中，方便桌面端追踪
      const channelLabel = channel === 'weixin' ? '微信' : channel === 'qq' ? 'QQ' : channel === 'wecom' ? '企业微信' : channel === 'feishu' ? '飞书' : channel
      try {
        store.appendMessage(payload.workId, 'assistant', [{
          type: 'text',
          text: `📨 已通过${channelLabel}发送通知`,
        }])
      } catch {
        // ignore
      }
    }
    if (!result.success && result.error) {
      failures.push(result.error)
    }
  }

  // 3. 记录通道通知失败信息到执行记录
  if (failures.length > 0) {
    const failureMsg = `通道通知失败: ${failures.join('; ')}`
    try {
      store.updateTaskExecution(payload.executionId, {
        error_message: payload.error
          ? `${payload.error} | ${failureMsg}`
          : failureMsg,
      })
    } catch (err) {
      log.error('更新执行记录失败:', err)
    }
  }
}
