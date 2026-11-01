export const DEFAULT_UPDATE_SETTINGS = Object.freeze({
  autoCheckEnabled: true,
  checkIntervalHours: 12,
})

export const UPDATE_CHECK_INTERVAL_HOURS = Object.freeze([6, 12, 24])

export function normalizeUpdateSettings(settings = {}) {
  const legacyIntervalHours = Number(settings.checkIntervalMinutes) / 60
  const explicitInterval = Number(settings.checkIntervalHours)
  const interval = Number.isFinite(explicitInterval) && explicitInterval > 0
    ? explicitInterval
    : legacyIntervalHours
  const checkIntervalHours = Number.isFinite(interval) && interval >= 1 && interval <= 24
    ? UPDATE_CHECK_INTERVAL_HOURS.reduce((nearest, candidate) => (
      Math.abs(candidate - interval) < Math.abs(nearest - interval) ? candidate : nearest
    ), UPDATE_CHECK_INTERVAL_HOURS[0])
    : DEFAULT_UPDATE_SETTINGS.checkIntervalHours

  return {
    autoCheckEnabled: settings.autoCheckEnabled !== false,
    checkIntervalHours,
  }
}
