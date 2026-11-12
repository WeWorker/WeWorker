import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createBackgroundChatSync } from '../utils/scheduled-task-sync.js'

function fixture() {
  let state = { backgroundChatRuns: {}, streamingWorkIds: new Set(), messages: {}, abortControllers: {} }
  let runs = [{ workId: 'example-work', executionId: 'example-run', source: 'scheduled_task', messages: [{ role: 'assistant', content: [] }] }]
  const finished = []
  const options = {
    getState: () => state,
    setState: update => { state = { ...state, ...update(state) } },
    fetchRuns: async () => runs,
    fetchWork: async () => ({ messages: [{ role: 'assistant', content: ['Final result'] }] }),
    onFinished: workId => finished.push(workId),
  }
  const sync = createBackgroundChatSync(options)
  return { get state() { return state }, set runs(value) { runs = value }, finished, options, sync }
}

it('restores running tasks after reload and retains the lock until final history loads', async () => {
  const f = fixture()
  await f.sync()
  assert.equal(f.state.streamingWorkIds.has('example-work'), true)
  assert.deepEqual(f.state.messages['example-work'], [{ role: 'assistant', content: [] }])
  f.runs = []
  let release
  f.options.fetchWork = () => new Promise(resolve => { release = resolve })
  // Use the same handler references through a delegating function.
  const sync = createBackgroundChatSync({ ...f.options, fetchWork: (...args) => f.options.fetchWork(...args) })
  const finishing = sync()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.state.streamingWorkIds.has('example-work'), true)
  assert.deepEqual(f.finished, [])
  release({ messages: ['Final result'] }); await finishing
  assert.equal(f.state.streamingWorkIds.has('example-work'), false)
  assert.deepEqual(f.state.messages['example-work'], ['Final result'])
  assert.deepEqual(f.finished, ['example-work'])
})

it('does not overwrite a locally owned chat or clear running state on failed fetches', async () => {
  const f = fixture()
  f.state.abortControllers['example-work'] = {}
  f.state.messages['example-work'] = ['Local stream']
  await f.sync()
  assert.deepEqual(f.state.messages['example-work'], ['Local stream'])
  delete f.state.abortControllers['example-work']
  await f.sync()
  const sync = createBackgroundChatSync({ ...f.options, fetchRuns: async () => { throw new Error('Offline') } })
  await assert.rejects(sync(), /Offline/)
  assert.equal(f.state.streamingWorkIds.has('example-work'), true)
  f.runs = []
  const retry = createBackgroundChatSync({ ...f.options, fetchWork: async () => { throw new Error('Offline') } })
  await retry()
  assert.equal(f.state.streamingWorkIds.has('example-work'), true)
  assert.deepEqual(f.finished, [])
})

it('serializes polling and explicit refreshes to prevent stale snapshots arriving last', async () => {
  const f = fixture()
  let release
  let calls = 0
  const sync = createBackgroundChatSync({ ...f.options, fetchRuns: () => { calls++; return new Promise(resolve => { release = resolve }) } })
  const first = sync()
  assert.equal(sync(), first)
  assert.equal(calls, 1)
  release([]); await first
})

it('restores channel turns with the same busy state and final refresh as scheduled tasks', async () => {
  const f = fixture()
  f.runs = [{ workId: 'example-channel', executionId: 'example-channel-run', source: 'channel', messages: [
    { role: 'user', content: ['Example question'] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'example-tool', status: 'running' }] },
  ] }]
  await f.sync()
  assert.equal(f.state.streamingWorkIds.has('example-channel'), true)
  assert.equal(f.state.backgroundChatRuns['example-channel'], 'example-channel-run')
  assert.equal(f.state.messages['example-channel'][1].content[0].status, 'running')
  f.runs = []; await f.sync()
  assert.equal(f.state.streamingWorkIds.has('example-channel'), false)
  assert.deepEqual(f.finished, ['example-channel'])
  assert.deepEqual(f.state.messages['example-channel'], [{ role: 'assistant', content: ['Final result'] }])
})
