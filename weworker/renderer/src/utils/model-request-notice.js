/** Retry progress is temporary; terminal errors keep their existing message path. */
export function updateModelRequestNotice(current, event) {
  if (event.type === 'api_retry') {
    return event.content || `模型请求正在重试（第 ${event.attempt}/${event.maxRetries} 次）`
  }
  if (['api_retry_resolved', 'error', 'done', 'turn_end'].includes(event.type)) return null
  return current
}
