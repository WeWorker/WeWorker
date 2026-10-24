export const DEFAULT_CONTEXT_LIMIT = 1_000_000

export const CONTEXT_LIMIT_PRESETS = [
  '32K',
  '64K',
  '128K',
  '200K',
  '256K',
  '512K',
  '1M',
  '2M',
]

export function parseContextLimitInput(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null
    return value >= 1_000 && value <= 100_000_000 ? value : null
  }

  const text = String(value ?? '').trim().replace(/,/g, '')
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([km])$/iu)
  if (!match) return null
  const suffix = match[2]?.toLowerCase()
  const parsed = Number(match[1]) * (suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null
  return parsed >= 1_000 && parsed <= 100_000_000 ? parsed : null
}

export function formatContextLimitInput(value) {
  const tokens = parseContextLimitInput(value) ?? DEFAULT_CONTEXT_LIMIT
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}
