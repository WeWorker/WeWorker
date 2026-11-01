/** Exact millisecond display for additive timing; rounding seconds would hide reconciliation. */
export function formatTimingDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  return `${Math.round(ms)}ms`
}
