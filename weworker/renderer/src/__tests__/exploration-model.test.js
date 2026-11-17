import assert from 'node:assert/strict'
import { test } from 'node:test'
import { useExplorationModelStore as store } from '../store/exploration-model.js'
import { useSettingsStore } from '../store/settings.js'

globalThis.window = { electronAPI: {} }
const originalFetch = globalThis.fetch
const data = { active_provider: 'glm', providers: [{ id: 'glm', model: 'glm-explore', configured: true }] }
const reset = () => store.setState({ data: null, revision: 0, busy: false, error: '' })

test('advanced settings and exploration picker share independent saved state', async () => {
  reset()
  const ordinary = useSettingsStore.getState()
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push([url, options])
    return Response.json({ ok: true, ...data })
  }
  try {
    assert.equal(await store.getState().save({ provider: 'glm', model: 'glm-explore', api_key: 'fixture-explore-key' }), true)
    assert.equal(store.getState().data.active_provider, 'glm')
    assert.equal(store.getState().revision, 1)
    assert.equal(await store.getState().activate('glm', 'glm-next'), true)
    assert.equal(calls[1][0], 'http://127.0.0.1:8765/settings/exploration-model/activate')
    assert.deepEqual(JSON.parse(calls[1][1].body), { provider: 'glm', model: 'glm-next' })
    assert.equal(useSettingsStore.getState(), ordinary)
  } finally { globalThis.fetch = originalFetch }
})

test('failed exploration switches retain the saved selection and permit retry', async () => {
  reset()
  store.setState({ data })
  globalThis.fetch = async () => Response.json({ ok: false, detail: 'fixture model unavailable' })
  try {
    assert.equal(await store.getState().activate('deepseek'), false)
    assert.equal(store.getState().data, data)
    assert.equal(store.getState().revision, 0)
    assert.equal(store.getState().busy, false)
    assert.equal(store.getState().error, 'fixture model unavailable')
  } finally { globalThis.fetch = originalFetch }
})

test('a stale settings load cannot overwrite a newly saved exploration selection', async () => {
  reset()
  let release
  globalThis.fetch = () => new Promise(resolve => { release = resolve })
  try {
    const loading = store.getState().load()
    await new Promise(resolve => setImmediate(resolve))
    globalThis.fetch = async () => Response.json({ ok: true, ...data })
    await store.getState().save({ provider: 'glm', model: 'glm-explore' })
    release(Response.json({ active_provider: 'custom', providers: [] }))
    await loading
    assert.equal(store.getState().data.active_provider, 'glm')
  } finally { globalThis.fetch = originalFetch }
})
