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

test('WebCLI route defaults on for older settings and saves immediately through the extensions API', async () => {
  globalThis.window = {}
  globalThis.fetch = async () => Response.json({})
  await useSettingsStore.getState().load()
  assert.equal(useSettingsStore.getState().webcliRouteEnabled, true)
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push([url, options.method, JSON.parse(options.body)])
    return Response.json({ webcli_route_enabled: true })
  }
  await useSettingsStore.getState().saveWebcliRouteEnabled(true)
  assert.deepEqual(requests, [['http://127.0.0.1:8765/settings/extensions/webcli-route', 'POST', { webcli_route_enabled: true }]])
  assert.equal(useSettingsStore.getState().webcliRouteEnabled, true)
})

test('a failed settings save keeps the previous switch value and surfaces the error', async () => {
  globalThis.window = {}
  useSettingsStore.setState({ webcliRouteEnabled: true })
  globalThis.fetch = async () => Response.json({ detail: '保存失败' }, { status: 500 })
  await assert.rejects(useSettingsStore.getState().saveWebcliRouteEnabled(false), /保存失败/)
  assert.equal(useSettingsStore.getState().webcliRouteEnabled, true)
})
