import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { useSettingsStore } from '../store/settings.js'

const initialState = useSettingsStore.getState()
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  useSettingsStore.setState(initialState, true)
})

function setup() {
  globalThis.window = {}
  const settings = { active_provider: 'custom-example', providers: {
    'custom-example': { model: 'remote-model', custom_models: [], base_url: 'https://example.com' },
    anthropic: { model: 'remote-model', custom_models: [] },
  } }
  useSettingsStore.setState({ providers: structuredClone(settings.providers) })
  const writes = []
  globalThis.fetch = async (url, options) => {
    if (options.method === 'POST') {
      const { provider, ...updates } = JSON.parse(options.body)
      writes.push({ provider, ...updates })
      Object.assign(settings.providers[provider], updates)
    }
    return Response.json(url.endsWith('/channels') ? {} : settings)
  }
  return { settings, writes }
}

test('adding and deleting custom models survives settings reload for custom and standard providers', async () => {
  const { writes } = setup()
  for (const provider of ['custom-example', 'anthropic']) {
    await useSettingsStore.getState().saveCustomModels(provider, 'example-custom', ['example-custom'])
    assert.deepEqual(writes.at(-1), { provider, model: 'example-custom', custom_models: ['example-custom'] })
    useSettingsStore.setState({ providers: {} })
    await useSettingsStore.getState().load()
    assert.deepEqual(useSettingsStore.getState().providers[provider].custom_models, ['example-custom'])
    assert.equal(useSettingsStore.getState().providers[provider].model, 'example-custom')
    await useSettingsStore.getState().saveCustomModels(provider, 'remote-model', [])
    await useSettingsStore.getState().load()
    assert.deepEqual(useSettingsStore.getState().providers[provider].custom_models, [])
  }
  assert.equal(useSettingsStore.getState().providers['custom-example'].base_url, 'https://example.com')
})

test('pending model save stays in shared state and rejects overlapping writes to the same provider', async () => {
  setup()
  const fetch = globalThis.fetch
  let release
  const gate = new Promise(resolve => { release = resolve })
  globalThis.fetch = async (...args) => { await gate; return fetch(...args) }
  const saving = useSettingsStore.getState().saveCustomModels('custom-example', 'example-custom', ['example-custom'])
  assert.equal(useSettingsStore.getState().customModelsSaving['custom-example'], true)
  await assert.rejects(useSettingsStore.getState().saveCustomModels('custom-example', 'other', ['other']), /正在保存/)
  release()
  await saving
  assert.deepEqual(useSettingsStore.getState().customModelsSaving, {})
  assert.equal(useSettingsStore.getState().providers['custom-example'].model, 'example-custom')
  assert.deepEqual(useSettingsStore.getState().providers.anthropic.custom_models, [])
})

test('failed persistence preserves the saved selection and allows retry', async () => {
  setup()
  const fetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ detail: 'Example failure' }, { status: 500 })
  await assert.rejects(useSettingsStore.getState().saveCustomModels('custom-example', 'example-custom', ['example-custom']))
  assert.equal(useSettingsStore.getState().providers['custom-example'].model, 'remote-model')
  assert.deepEqual(useSettingsStore.getState().providers['custom-example'].custom_models, [])
  assert.deepEqual(useSettingsStore.getState().customModelsSaving, {})
  globalThis.fetch = fetch
  await useSettingsStore.getState().saveCustomModels('custom-example', 'example-custom', ['example-custom'])
  assert.equal(useSettingsStore.getState().providers['custom-example'].model, 'example-custom')
})
