import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { useWorkActivityStore, workActivityStatus, folderActivityStatus } from '../store/work-activity.js'

const state = () => useWorkActivityStore.getState()
beforeEach(() => useWorkActivityStore.setState({ activities: {}, visibleWorkId: null }))

test('unrelated tool results leave idle, running and completed conversations unchanged', () => {
  state().answer('missing', undefined)
  state().start('a', 'turn')
  state().answer('a', undefined)
  assert.equal(state().activities.a.status, 'running')
  state().finish('a', 'turn', 'completed')
  state().answer('a', 'other-tool')
  assert.equal(state().activities.a.status, 'completed')
})

test('parallel conversations finish independently; only background success becomes unread', () => {
  state().view('a')
  state().start('a', 'turn-a')
  state().start('b', 'turn-b')
  state().finish('b', 'turn-b', 'completed')
  assert.equal(state().activities.a.status, 'running')
  assert.equal(state().activities.b.status, 'completed')
  state().finish('a', 'turn-a', 'completed')
  assert.equal(state().activities.a, undefined)
  state().view('b')
  assert.equal(state().activities.b, undefined)
})

test('opening a waiting conversation does not erase its question; matching answer resumes it', () => {
  state().start('a', 'turn')
  state().wait('a', 'turn', 'choice-1')
  state().view('a')
  assert.equal(workActivityStatus(state().activities.a, true, true), 'waiting')
  state().wait('a', 'turn', 'choice-2')
  state().answer('a', 'choice-1')
  assert.equal(state().activities.a.status, 'waiting')
  state().answer('a', 'choice-2')
  assert.equal(state().activities.a.status, 'running')
})

test('old turn events cannot overwrite a newer run, and stop never indicates success', () => {
  state().start('a', 'old')
  state().start('a', 'new')
  state().wait('a', 'old', 'old-choice')
  state().finish('a', 'old', 'completed')
  assert.deepEqual(state().activities.a, { token: 'new', status: 'running' })
  state().finish('a', 'new', 'stopped')
  assert.equal(state().activities.a, undefined)
})

test('failure is distinct from completion and opening another page preserves unread status', () => {
  state().view('a')
  state().start('a', 'turn')
  state().leave('a')
  state().finish('a', 'turn', 'failed')
  assert.equal(workActivityStatus(state().activities.a, false), 'failed')
  state().view('b')
  state().leave('a')
  assert.equal(state().visibleWorkId, 'b')
  state().discard('a')
  assert.equal(state().activities.a, undefined)
})

test('folder status prioritizes intervention over running and unread completion', () => {
  assert.equal(folderActivityStatus(['running', 'completed', 'waiting']), 'waiting')
  assert.equal(folderActivityStatus(['completed', 'failed']), 'failed')
  assert.equal(folderActivityStatus(['completed', 'running']), 'running')
  assert.equal(folderActivityStatus([]), null)
  assert.equal(workActivityStatus(undefined, true), 'running')
  assert.equal(workActivityStatus({ status: 'completed' }, false, true), null)
})
