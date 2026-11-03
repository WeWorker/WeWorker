import test from 'node:test'
import assert from 'node:assert/strict'
import { getExecutionPage } from '../utils/scheduled-task-executions.js'

const records = Array.from({ length: 23 }, (_, index) => ({ id: `example-run-${index}` }))

test('execution history shows ten records per page in the supplied newest-first order', () => {
  const first = getExecutionPage(records, 1)
  const second = getExecutionPage(records, 2)
  const last = getExecutionPage(records, 3)
  assert.equal(first.pageCount, 3)
  assert.equal(first.total, 23)
  assert.deepEqual(first.items, records.slice(0, 10))
  assert.deepEqual(second.items, records.slice(10, 20))
  assert.deepEqual(last.items, records.slice(20))
  assert.deepEqual([last.start, last.end], [21, 23])
})

test('empty, single-page and exact-page histories have valid bounds', () => {
  assert.deepEqual(getExecutionPage([], 3), { items: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 })
  assert.equal(getExecutionPage(records.slice(0, 10), 1).pageCount, 1)
  assert.equal(getExecutionPage(records.slice(0, 20), 2).end, 20)
})

test('a retained history shrinking below the selected page clamps to the last page', () => {
  const result = getExecutionPage(records.slice(0, 12), 3)
  assert.equal(result.page, 2)
  assert.deepEqual(result.items, records.slice(10, 12))
  assert.equal(getExecutionPage(records, 0).page, 1)
})

test('new records do not increase the rendered page size or reset the selected page', () => {
  const updated = [{ id: 'example-new-run' }, ...records]
  assert.equal(getExecutionPage(updated, 1).items.length, 10)
  assert.equal(getExecutionPage(updated, 1).items[0].id, 'example-new-run')
  assert.equal(getExecutionPage(updated, 2).page, 2)
  assert.deepEqual(getExecutionPage(updated, 2).items, updated.slice(10, 20))
})
