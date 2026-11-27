import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

test('first launch appends and labels imported configurations without replacing presets', async () => {
  const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    define: { __BUILD_DEPLOYMENT_CONFIG__: '{}' },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  try {
    const { providerOptions } = await server.ssrLoadModule('/src/components/onboarding/InitialSetup.jsx')
    const presets = providerOptions({})
    assert.ok(presets.some(option => option.value === 'builtin'))
    const options = providerOptions({
      'detected-ready': { external_source_id: 'fixture-a', has_key: true, base_url: 'https://example.com', name: 'Fixture app', model: 'fixture-model' },
      'detected-incomplete': { external_source_id: 'fixture-b', has_key: true, base_url: 'https://example.org', name: 'Incomplete' },
      'manual-config': { name: 'Manual', has_key: true, model: 'manual-model' },
    })
    assert.deepEqual(options.slice(0, presets.length), presets)
    assert.deepEqual(options.slice(presets.length), [
      { value: 'detected-ready', label: 'Fixture app（本地识别）', description: 'fixture-model', disabled: false, discovered: true },
      { value: 'detected-incomplete', label: 'Incomplete（本地识别）', description: '未识别到模型名称', disabled: true, discovered: true },
    ])
  } finally {
    await server.close()
  }
})
