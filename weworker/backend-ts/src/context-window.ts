export const DEFAULT_CONTEXT_LIMIT = 960_000
export const DEFAULT_BUILTIN_CONTEXT_LIMIT = 200_000
export const MIN_CONTEXT_LIMIT = 1_000
export const MAX_CONTEXT_LIMIT = 100_000_000
export const MIN_CONVERSATION_CONTEXT_LIMIT = 64_000
export const MAX_CONVERSATION_CONTEXT_LIMIT = 960_000
export const MODEL_CONTEXT_LIMIT_ERROR = '上下文窗口请输入 1000 至 960000 之间的 token 数，支持 K 或 M 单位'

export function parseModelContextLimit(value: unknown): number | null {
  const limit = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  const tokens = parseContextLimit(limit)
  return tokens !== null && tokens <= MAX_CONVERSATION_CONTEXT_LIMIT ? tokens : null
}

export function normalizeModelContextLimit(value: unknown, fallback = DEFAULT_CONTEXT_LIMIT): number {
  const limit = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return Math.min(MAX_CONVERSATION_CONTEXT_LIMIT, normalizeContextLimit(limit, fallback))
}

export function parseConversationContextLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_CONVERSATION_CONTEXT_LIMIT && value <= MAX_CONVERSATION_CONTEXT_LIMIT ? value : null
}

export function normalizeConversationContextLimit(value: unknown): number {
  return Math.max(MIN_CONVERSATION_CONTEXT_LIMIT, Math.min(MAX_CONVERSATION_CONTEXT_LIMIT, normalizeContextLimit(value)))
}

export function parseContextLimit(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null
    return value >= MIN_CONTEXT_LIMIT && value <= MAX_CONTEXT_LIMIT ? value : null
  }

  const text = String(value ?? '').trim().replace(/,/g, '')
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([km])$/iu)
  if (!match) return null
  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1_000_000
    : match[2]?.toLowerCase() === 'k'
      ? 1_000
      : 1
  const parsed = Number(match[1]) * multiplier
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null
  return parsed >= MIN_CONTEXT_LIMIT && parsed <= MAX_CONTEXT_LIMIT ? parsed : null
}

export function normalizeContextLimit(value: unknown, fallback = DEFAULT_CONTEXT_LIMIT): number {
  return parseContextLimit(value) ?? fallback
}
