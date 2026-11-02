/** Display timing rounded to whole seconds; totals are calculated from raw milliseconds. */
export function formatTimingDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  let remainder = Math.round(ms / 1000)
  const days = Math.floor(remainder / 86_400)
  remainder -= days * 86_400
  const hours = Math.floor(remainder / 3_600)
  remainder -= hours * 3_600
  const minutes = Math.floor(remainder / 60)
  const seconds = remainder - minutes * 60
  if (days) return `${days}d${hours}h${minutes}m${seconds}s`
  if (hours) return `${hours}h${minutes}m${seconds}s`
  if (minutes) return `${minutes}m${seconds}s`
  return `${seconds}s`
}
