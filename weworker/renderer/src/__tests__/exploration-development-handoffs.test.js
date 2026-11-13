import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExplorationDevelopmentHandoffsStore, isDevelopmentSubmitted } from '../store/exploration-development-handoffs.js'

test('handoff markers survive reload, isolate records and never persist exploration evidence', () => {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const first = createExplorationDevelopmentHandoffsStore(storage)
  first.getState().record('exp_one', 'chat_one', 'run_one')
  first.getState().record('exp_two', 'chat_two', 'run_two')
  const reloaded = createExplorationDevelopmentHandoffsStore(storage)
  assert.deepEqual(reloaded.getState().handoffs, first.getState().handoffs)
  const marker = reloaded.getState().handoffs.exp_one
  assert.equal(isDevelopmentSubmitted(marker, 'run_one'), true)
  assert.equal(isDevelopmentSubmitted(marker, 'run_new'), false)
  assert.equal(isDevelopmentSubmitted(undefined, 'run_one'), false)
  assert.deepEqual(Object.keys(marker).sort(), ['runId', 'workId'])
  reloaded.getState().clear('exp_one')
  const next = createExplorationDevelopmentHandoffsStore(storage)
  assert.equal(next.getState().handoffs.exp_one, undefined)
  assert.equal(isDevelopmentSubmitted(next.getState().handoffs.exp_two, 'run_two'), true)
})

test('deleted records cannot reappear through stale development polling', () => {
  const store = createExplorationDevelopmentHandoffsStore({ getItem: () => null, setItem() {}, removeItem() {} })
  const first = { explorationId: 'example', work: { id: 'one' } }
  const second = { explorationId: 'other', work: { id: 'two' } }
  store.getState().remember(first)
  store.getState().remember(second)
  store.getState().record('example', 'one')
  store.getState().forget('example')
  store.getState().remember(first)
  assert.deepEqual(store.getState().sessions, { two: second })
  assert.equal(store.getState().handoffs.example, undefined)
})
