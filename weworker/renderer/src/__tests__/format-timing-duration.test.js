import assert from 'node:assert/strict'
import test from 'node:test'
import { formatTimingDuration } from '../utils/format-timing-duration.js'

test('timing displays exact additive milliseconds', () => {
  const segments = [11_400, 4_800, 1_900]
  assert.deepEqual(segments.map(formatTimingDuration), ['11400ms', '4800ms', '1900ms'])
  assert.equal(formatTimingDuration(segments.reduce((sum, value) => sum + value, 0)), '18100ms')
  assert.equal(formatTimingDuration(0), '0ms')
})
