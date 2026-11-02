/** Use seconds and larger units while retaining millisecond precision for additivity. */
export function formatTimingDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  // The ledger records milliseconds; do not round segments to whole seconds,
  // because that makes displayed subtotals disagree with their components.
  let remainder = Math.round(ms)
  const days = Math.floor(remainder / 86_400_000)
  remainder -= days * 86_400_000
  const hours = Math.floor(remainder / 3_600_000)
  remainder -= hours * 3_600_000
  const minutes = Math.floor(remainder / 60_000)
  remainder -= minutes * 60_000
  const wholeSeconds = Math.floor(remainder / 1000)
  const fraction = remainder % 1000
  const secondsText = `${days || hours || minutes ? String(wholeSeconds).padStart(2, '0') : wholeSeconds}${fraction ? `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}` : ''}s`
  if (days) return `${days}d${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}m${secondsText}`
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m${secondsText}`
  if (minutes) return `${minutes}m${secondsText}`
  return secondsText
}
