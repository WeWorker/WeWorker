import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTimingDuration } from '../utils/format-timing-duration.js'

test('timing uses seconds, minutes, hours and days with exact sub-second precision', () => {
  const segments = [11_400, 4_800, 1_900]
  assert.deepEqual(segments.map(formatTimingDuration), ['11.4s', '4.8s', '1.9s'])
  assert.equal(formatTimingDuration(segments.reduce((sum, value) => sum + value, 0)), '18.1s')
  assert.equal(formatTimingDuration(0), '0s')
  assert.equal(formatTimingDuration(60_000), '1m00s')
  assert.equal(formatTimingDuration(62_345), '1m02.345s')
  assert.equal(formatTimingDuration(3_661_001), '1h01m01.001s')
  assert.equal(formatTimingDuration(90_061_000), '1d01h01m01s')
  assert.equal(formatTimingDuration(null), '')
})
