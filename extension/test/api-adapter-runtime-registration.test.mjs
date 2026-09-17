import assert from 'node:assert/strict'
import test from 'node:test'

import { loadShippedApiInventory } from '../../webcli/api-adapter-certification.js'
import { loadAdapterBundle } from './helpers/adapter-test-loader.mjs'

test('every shipped API declaration is registered by the real Extension bundle order', async (t) => {
  const inventory = await loadShippedApiInventory()
  assert.deepEqual(inventory.errors, [])

  const registeredNames = new Set()
  for (const adapter of inventory.adapters) {
    await t.test(adapter.id, async () => {
      const bundle = await loadAdapterBundle(adapter.id)
      const actualNames = new Set(bundle.tools.flatMap((tool) => [tool.name, tool.publicName].filter(Boolean)))
      for (const tool of adapter.tools) {
        assert.equal(actualNames.has(tool.name), true, `${adapter.id}/${tool.name}: missing runtime registration`)
        assert.equal(registeredNames.has(tool.name), false, `${adapter.id}/${tool.name}: duplicate runtime registration`)
        registeredNames.add(tool.name)
      }
    })
  }

  assert.equal(registeredNames.size, inventory.toolCount)
})
