import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { useSettingsStore } from '../store/settings.js'

const initial = useSettingsStore.getState()
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  useSettingsStore.setState(initial, true)
})

test('loads the stored compaction ratio with an 80 percent fallback and persists edits', async () => {
  globalThis.window = {}
  globalThis.fetch = async () => Response.json({})
  await useSettingsStore.getState().load()
  assert.equal(useSettingsStore.getState().compactionRatio, 80)
  globalThis.fetch = async () => Response.json({ compaction_ratio: 65 })
  await useSettingsStore.getState().load()
  assert.equal(useSettingsStore.getState().compactionRatio, 65)
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8765/settings/compaction')
    assert.deepEqual(JSON.parse(options.body), { compaction_ratio: 75 })
    return Response.json({ compaction_ratio: 75 })
  }
  await useSettingsStore.getState().saveCompactionRatio(75)
  assert.equal(useSettingsStore.getState().compactionRatio, 75)
  globalThis.fetch = async () => Response.json({ detail: '保存失败' }, { status: 500 })
  await assert.rejects(useSettingsStore.getState().saveCompactionRatio(40), /保存失败/)
  assert.equal(useSettingsStore.getState().compactionRatio, 75)
})
