export function conversationTimestamp(work, latestMessageAt) {
  const timestamps = [work?.updated_at, work?.created_at, latestMessageAt]
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => Date.parse(value))
    .filter(Number.isFinite)
  return timestamps.length ? Math.max(...timestamps) : null
}

export function formatConversationAge(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return ''
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}
