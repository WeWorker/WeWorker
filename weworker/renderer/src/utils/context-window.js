export const MAX_CONTEXT_LIMIT = 960_000
export const DEFAULT_CONTEXT_LIMIT = MAX_CONTEXT_LIMIT
export const DEFAULT_BUILTIN_CONTEXT_LIMIT = 200_000

export const CONTEXT_LIMIT_PRESETS = [
  '32K',
  '64K',
  '128K',
  '200K',
  '256K',
  '512K',
  '960K',
]

export function parseContextLimitInput(value) {
  const text = String(value ?? '').trim().replace(/,/g, '')
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([km])?$/iu)
  if (!match) return null
  const suffix = match[2]?.toLowerCase()
  const parsed = Number(match[1]) * (suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1)
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= MAX_CONTEXT_LIMIT ? parsed : null
}

export function formatContextLimitInput(value) {
  const tokens = parseContextLimitInput(value) ?? DEFAULT_CONTEXT_LIMIT
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`
  return String(tokens)
}
