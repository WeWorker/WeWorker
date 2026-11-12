/**
 * 队列因为“发送结果未知”暂停后，是否应该自动恢复。
 *
 * 暂停本身是必要的：请求可能已经送达，只是响应丢了，自动重发有重复风险。
 * 但如果对话已经空闲、队列里确实还有消息，就不应该永久卡住——只有用户主动
 * 停止（「已停止，队列暂停」）时才保持暂停，把决定权留给用户。
 */
export function shouldAutoResumeQueue(queueState, streaming) {
  const reason = String(queueState?.pausedReason || '')
  if (!reason) return false
  if (queueState?.running || queueState?.transitioning) return false
  if (streaming) return false
  if (!queueState?.items?.length) return false
  return !reason.includes('已停止')
}
