import assert from 'node:assert/strict'
import test from 'node:test'

import { classify } from '../../webcli/scripts/run-api-adapter-live-reads.js'

test('live result classifier keeps common blocker classes actionable', () => {
  assert.equal(classify('HTTP 401 authentication required', 1, false), 'AUTH')
  assert.equal(classify('HTTP 403 forbidden', 1, false), 'PERMISSION')
  assert.equal(classify('NOT_FOUND', 1, false), 'FIXTURE_NOT_FOUND')
  assert.equal(classify('PAGE_CONTEXT_REQUIRED', 1, false), 'PAGE_CONTEXT')
  assert.equal(classify('malformed JSON response', 1, false), 'RESPONSE_ERROR')
  assert.equal(classify('', 1, true), 'TIMEOUT')
})
