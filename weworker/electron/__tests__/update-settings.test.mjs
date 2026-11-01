import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_UPDATE_SETTINGS,
  UPDATE_CHECK_INTERVAL_HOURS,
  normalizeUpdateSettings,
} from '../update-settings.js'

test('update checks default to a twice-daily interval', () => {
  assert.deepEqual(normalizeUpdateSettings(), DEFAULT_UPDATE_SETTINGS)
})

test('update checks keep one of the supported intervals', () => {
  assert.deepEqual(UPDATE_CHECK_INTERVAL_HOURS, [6, 12, 24])
  for (const checkIntervalHours of UPDATE_CHECK_INTERVAL_HOURS) {
    assert.equal(normalizeUpdateSettings({ checkIntervalHours }).checkIntervalHours, checkIntervalHours)
  }
})

test('legacy intervals are normalized to the nearest supported interval', () => {
  assert.equal(normalizeUpdateSettings({ checkIntervalHours: 1 }).checkIntervalHours, 6)
  assert.equal(normalizeUpdateSettings({ checkIntervalHours: 9 }).checkIntervalHours, 6)
  assert.equal(normalizeUpdateSettings({ checkIntervalHours: 15 }).checkIntervalHours, 12)
  assert.equal(normalizeUpdateSettings({ checkIntervalHours: 21 }).checkIntervalHours, 24)
  assert.equal(normalizeUpdateSettings({ checkIntervalMinutes: 720 }).checkIntervalHours, 12)
  assert.equal(normalizeUpdateSettings({ checkIntervalHours: 0 }).checkIntervalHours, 12)
  assert.equal(normalizeUpdateSettings({ checkIntervalHours: 30 }).checkIntervalHours, 12)
})
