import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isBuiltinProvider, hasFixedModel, PROVIDERS, useSettingsStore } from '../store/settings.js'
import { buildSettingsProviderLists } from '../utils/model-selection.js'

const initialState = useSettingsStore.getState()
const previousFetch = globalThis.fetch
const previousWindow = globalThis.window
afterEach(() => {
  globalThis.fetch = previousFetch
  globalThis.window = previousWindow
  useSettingsStore.setState(initialState, true)
})

test('built-in metadata is visible before configuration without claiming a key exists', () => {
  assert.ok(PROVIDERS.some(provider => provider.id === 'builtin'))
  assert.equal(initialState.providers.builtin.has_key, false)
  assert.equal(initialState.providers.builtin.readonly, true)
  assert.equal(initialState.providers.builtin.context_limit, 200000)
})

test('renderer initial state lists the built-ins and fixed presets declared in JSON before settings load', () => {
  const { visible } = buildSettingsProviderLists(PROVIDERS, initialState.providers)
  assert.deepEqual(visible.map(provider => provider.id), PROVIDERS.filter(provider => provider.builtin || provider.fixed).map(provider => provider.id))
})

test('unavailable built-in activation preserves the previous selection', async () => {
  globalThis.window = {}
  globalThis.fetch = async () => Response.json({ detail: '内置模型服务尚未配置' }, { status: 400 })
  await assert.rejects(useSettingsStore.getState().activateProvider('builtin'), /服务尚未配置/)
  assert.equal(useSettingsStore.getState().activeProvider, initialState.activeProvider)
})

test('built-in activation uses server state and does not send credentials from the renderer', async () => {
  globalThis.window = {}
  globalThis.fetch = async (url, options) => {
    assert.ok(url.endsWith('/settings/provider/activate'))
    assert.deepEqual(JSON.parse(options.body), { provider: 'builtin' })
    return Response.json({ active_provider: 'builtin', model: 'ark-code-latest', has_api_key: true,
      providers: { builtin: { model: 'ark-code-latest', has_key: true, readonly: true } },
    })
  }
  await useSettingsStore.getState().activateProvider('builtin')
  assert.equal(useSettingsStore.getState().activeProvider, 'builtin')
  assert.equal(useSettingsStore.getState().model, 'ark-code-latest')
})


test('provider visibility and initial state follow the JSON entries', () => {
  const { visible, addable } = buildSettingsProviderLists(PROVIDERS, {})
  for (const provider of PROVIDERS) {
    assert.equal(visible.some(item => item.id === provider.id), Boolean(provider.builtin || provider.fixed))
    assert.equal(initialState.providers[provider.id].readonly === true, provider.builtin === true)
  }
  for (const id of ['fixture-unconfigured-provider']) {
    assert.equal(visible.some(provider => provider.id === id), false)
    assert.equal(addable.some(provider => provider.id === id), false)
    assert.equal(initialState.providers[id], undefined)
    assert.equal(isBuiltinProvider(id), false)
  }
})

test('model locks and managed credentials follow JSON flags', () => {
  for (const provider of PROVIDERS) {
    assert.equal(hasFixedModel(provider.id), provider.fixedModel === true)
    assert.equal(isBuiltinProvider(provider.id), provider.builtin === true)
  }
})
