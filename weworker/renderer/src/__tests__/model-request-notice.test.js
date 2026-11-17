import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateModelRequestNotice } from '../utils/model-request-notice.js'

test('immediately displays first retry and updates the same notice with every count', () => {
  let notice = updateModelRequestNotice(null, { type: 'api_retry', content: 'HTTP 429，第 1/3 次' })
  assert.equal(notice, 'HTTP 429，第 1/3 次')
  notice = updateModelRequestNotice(notice, { type: 'api_retry', content: 'HTTP 500，第 2/3 次' })
  assert.equal(notice, 'HTTP 500，第 2/3 次')
})

test('preserves retry progress during unrelated events and clears it on recovery or failure', () => {
  const notice = '网络连接错误，第 1/3 次'
  assert.equal(updateModelRequestNotice(notice, { type: 'context_snapshot' }), notice)
  for (const type of ['api_retry_resolved', 'error', 'done', 'turn_end']) {
    assert.equal(updateModelRequestNotice(notice, { type }), null)
  }
})
