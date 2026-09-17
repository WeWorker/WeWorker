import assert from 'node:assert/strict'
import test from 'node:test'

import { loadShippedApiInventory } from '../../webcli/api-adapter-certification.js'
import { findRuntimeTool, loadAdapterBundle, minimalToolArgs } from './helpers/adapter-test-loader.mjs'

test('safety-classified API tools block I/O before confirmation or use declared dry-run', async (t) => {
  const inventory = await loadShippedApiInventory()
  assert.deepEqual(inventory.errors, [])

  for (const adapter of inventory.adapters) {
    const safetyTools = adapter.tools.filter((tool) => (
      tool.requiresConfirmation || ['mutating', 'high_risk'].includes(tool.safety)
    ))
    if (safetyTools.length === 0) continue

    for (const inventoryTool of safetyTools) {
      await t.test(`${inventoryTool.name} blocks I/O before confirmation or dry-run`, async () => {
        const events = []
        const rejectIo = async (kind) => {
          events.push(kind)
          throw Object.assign(new Error(`I/O attempted before confirmation: ${kind}`), { code: 'IO_BEFORE_CONFIRMATION' })
        }
        const bundle = await loadAdapterBundle(adapter.id, {
          runtime: {
            requireConfirmation() {
              throw Object.assign(new Error('Explicit confirmation is required'), { code: 'CONFIRMATION_REQUIRED' })
            },
            requestPrivileged: (action) => rejectIo(`privileged:${action}`),
            fetchJson: () => rejectIo('fetchJson'),
          },
          globals: { fetch: () => rejectIo('fetch') },
        })
        const runtimeTool = findRuntimeTool(bundle.tools, inventoryTool.name)
        assert.ok(runtimeTool, `${inventoryTool.name} is missing from the runtime bundle`)
        const parameters = runtimeTool.parameters || inventoryTool.parameters || {}
        const hasDryRun = Object.hasOwn(parameters.properties || {}, 'dry-run')

        let failure
        let result
        try {
          result = await runtimeTool.handler(minimalToolArgs(parameters, { dryRun: hasDryRun }))
        } catch (error) {
          failure = error
        }

        assert.deepEqual(events, [], `${inventoryTool.name} attempted I/O before confirmation`)
        if (failure) assert.equal(failure.code, 'CONFIRMATION_REQUIRED', failure.message)
        else {
          assert.equal(hasDryRun, true, `${inventoryTool.name} has no confirmation barrier or dry-run guard`)
          assert.notEqual(result, undefined)
        }
      })
    }
  }
})
