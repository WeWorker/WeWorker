import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { createModelHealthStore, modelHealthKey } from '../store/model-health.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow })
const memoryStorage = () => {
  let saved = null
  return { getItem: () => saved, setItem: (_key, value) => { saved = value } }
}

it('keeps historical success and failure after reload without requesting or scheduling probes', async () => {
  const storage = memoryStorage()
  let calls = 0
  const probe = async (_provider, model) => { calls++; return { ok: model === 'model-a', elapsed_ms: 12, checked_at: 1234, detail: 'not persisted' } }
  const store = createModelHealthStore({ storage, probe })
  assert.equal(calls, 0)
  await store.getState().checkModels('fixture-provider', ['model-a', 'model-b'])
  const restored = createModelHealthStore({ storage, probe })
  assert.deepEqual(restored.getState().results, store.getState().results)
  assert.equal(restored.getState().results[modelHealthKey('fixture-provider', 'model-a')].elapsedMs, 12)
  assert.equal(restored.getState().results[modelHealthKey('fixture-provider', 'model-b')].ok, false)
  assert.equal(calls, 2)
  assert.ok(!storage.getItem().includes('not persisted'))
})

it('deduplicates batches, caps concurrency at two and retains old results while rechecking', async () => {
  const storage = memoryStorage()
  const key = modelHealthKey('fixture-provider', 'model-a')
  storage.setItem('', JSON.stringify({ [key]: { ok: true, elapsedMs: 12, checkedAt: 10 } }))
  const pending = []
  let calls = 0
  const store = createModelHealthStore({ storage, probe: async () => { calls++; return new Promise(resolve => pending.push(resolve)) } })
  const first = store.getState().checkModels('fixture-provider', ['model-a', 'model-a', 'model-b', 'model-c'])
  const second = store.getState().checkModels('fixture-provider', ['model-a', 'model-b'])
  assert.equal(calls, 2)
  assert.equal(store.getState().results[key].elapsedMs, 12)
  assert.equal(store.getState().checking[key], true)
  pending.shift()({ ok: false, elapsed_ms: 24, checked_at: 20 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 3)
  pending.splice(0).forEach(resolve => resolve({ ok: true, elapsed_ms: 30, checked_at: 20 }))
  await Promise.all([first, second])
  assert.equal(store.getState().running['fixture-provider'], false)
  assert.equal(store.getState().results[key].ok, false)
})

it('stops queued probes on provider change and keeps provider results separate', async () => {
  const pending = []
  const store = createModelHealthStore({ probe: async () => new Promise(resolve => pending.push(resolve)) })
  const first = store.getState().checkModels('fixture-a', ['model-a', 'model-b', 'model-c'])
  store.getState().cancelBatch('fixture-a')
  assert.equal(pending.length, 2)
  pending.splice(0).forEach(resolve => resolve({ ok: true, elapsed_ms: 12 }))
  await first
  assert.equal(pending.length, 0)
  assert.equal(store.getState().results[modelHealthKey('fixture-a', 'model-c')], undefined)
  assert.equal(store.getState().results[modelHealthKey('fixture-b', 'model-a')], undefined)
})

it('uses only the conversation protocol and records request failures', async () => {
  globalThis.window = {}
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { provider: 'fixture-provider', model: 'fixture-model', target: 'weworker', openai_base_url: '', openai_base_url_is_full: false })
    return Response.json({ ok: true, elapsed_ms: 42, checked_at: 1234 })
  }
  const store = createModelHealthStore()
  await store.getState().checkModels('fixture-provider', ['fixture-model'])
  assert.equal(store.getState().results[modelHealthKey('fixture-provider', 'fixture-model')].elapsedMs, 42)
  globalThis.fetch = async () => { throw new Error('offline') }
  await store.getState().checkModels('fixture-provider', ['fixture-model'])
  assert.equal(store.getState().results[modelHealthKey('fixture-provider', 'fixture-model')].error, 'network_error')
})

it('runs individually selected models concurrently, deduplicates each model and finishes independently', async () => {
  const pending = new Map()
  const calls = []
  const store = createModelHealthStore({ probe: (provider, model) => {
    calls.push([provider, model])
    return new Promise(resolve => pending.set(model, resolve))
  } })
  const first = store.getState().checkModel('fixture', 'model-a')
  const duplicate = store.getState().checkModel('fixture', 'model-a')
  const second = store.getState().checkModel('fixture', 'model-b')
  const third = store.getState().checkModel('fixture', 'model-c')
  assert.equal(first, duplicate)
  assert.deepEqual(calls.map(item => item[1]), ['model-a', 'model-b', 'model-c'])
  pending.get('model-b')({ ok: false, elapsed_ms: 24 })
  await second
  assert.equal(store.getState().checking[modelHealthKey('fixture', 'model-b')], false)
  assert.equal(store.getState().checking[modelHealthKey('fixture', 'model-a')], true)
  assert.equal(store.getState().running.fixture, true)
  pending.get('model-c')({ ok: true, elapsed_ms: 30 })
  pending.get('model-a')({ ok: true, elapsed_ms: 42 })
  await Promise.all([first, third])
  assert.equal(store.getState().running.fixture, false)
  assert.equal(store.getState().results[modelHealthKey('fixture', 'model-b')].ok, false)
})

it('shares in-flight probes with batches and does not repeat a manually started queued model', async () => {
  const pending = new Map()
  const calls = []
  const store = createModelHealthStore({ probe: (_provider, model) => {
    calls.push(model)
    return new Promise(resolve => pending.set(model, resolve))
  } })
  const batch = store.getState().checkModels('fixture', ['a', 'b', 'c'])
  const shared = store.getState().checkModel('fixture', 'a')
  const queued = store.getState().checkModel('fixture', 'c')
  assert.deepEqual(calls, ['a', 'b', 'c'])
  pending.get('c')({ ok: true })
  await queued
  pending.get('a')({ ok: true })
  pending.get('b')({ ok: true })
  await Promise.all([batch, shared])
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.equal(store.getState().running.fixture, false)
})

it('keeps running status while an independent probe outlives a cancelled batch', async () => {
  const pending = new Map()
  const store = createModelHealthStore({ probe: (_provider, model) => new Promise(resolve => pending.set(model, resolve)) })
  const batch = store.getState().checkModels('fixture', ['a', 'b', 'queued'])
  const independent = store.getState().checkModel('fixture', 'manual')
  store.getState().cancelBatch('fixture')
  pending.get('a')({ ok: true })
  pending.get('b')({ ok: true })
  await batch
  assert.equal(pending.has('queued'), false)
  assert.equal(store.getState().running.fixture, true)
  pending.get('manual')({ ok: true })
  await independent
  assert.equal(store.getState().running.fixture, false)
})
