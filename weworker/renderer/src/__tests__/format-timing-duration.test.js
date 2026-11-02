import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTimingDuration, formatTimingTotal } from '../utils/format-timing-duration.js'

test('timing rounds to whole seconds and carries across larger units', () => {
  const segments = [11_400, 4_800, 1_900]
  assert.deepEqual(segments.map(formatTimingDuration), ['11s', '5s', '2s'])
  assert.equal(formatTimingDuration(segments.reduce((sum, value) => sum + value, 0)), '18s')
  assert.equal(formatTimingDuration(0), '0s')
  assert.equal(formatTimingDuration(59_600), '1m0s')
  assert.equal(formatTimingDuration(60_000), '1m0s')
  assert.equal(formatTimingDuration(62_345), '1m2s')
  assert.equal(formatTimingDuration(3_661_001), '1h1m1s')
  assert.equal(formatTimingDuration(90_061_000), '1d1h1m1s')
  assert.equal(formatTimingDuration(null), '')
})

test('displayed total equals displayed thinking plus execution, including rounding boundaries', () => {
  assert.equal(formatTimingDuration(600), '1s')
  assert.equal(formatTimingTotal(600, 600), '2s')
  assert.equal(formatTimingTotal(59_600, 1_600), '1m2s')
  assert.equal(formatTimingTotal(null, 600), '')
})
