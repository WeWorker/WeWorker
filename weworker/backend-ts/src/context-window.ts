export const DEFAULT_CONTEXT_LIMIT = 1_000_000
export const MIN_CONTEXT_LIMIT = 1_000
export const MAX_CONTEXT_LIMIT = 100_000_000

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
