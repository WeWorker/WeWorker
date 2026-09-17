import assert from 'node:assert/strict'
import test from 'node:test'

import { loadShippedApiInventory } from '../../webcli/api-adapter-certification.js'
import {
  findRuntimeTool,
  loadAdapterBundle,
  minimalToolArgs,
  withTimeout,
} from './helpers/adapter-test-loader.mjs'

function injectedFailure(kind) {
  return Object.assign(new Error(`Injected certification I/O failure: ${kind}`), {
    code: 'CERTIFICATION_IO_FAILURE',
  })
}

test('shipped API tools settle under injected I/O failure', async (t) => {
  const inventory = await loadShippedApiInventory()
  assert.deepEqual(inventory.errors, [])

  for (const adapter of inventory.adapters) {
    const bundle = await loadAdapterBundle(adapter.id, {
      runtime: {
        requireConfirmation: () => true,
        async requestPrivileged(action) { throw injectedFailure(action) },
        async fetchJson() { throw injectedFailure('fetchJson') },
      },
      globals: { fetch: async () => { throw injectedFailure('fetch') } },
    })

    for (const inventoryTool of adapter.tools) {
      await t.test(`${inventoryTool.name} handles mocked API failure`, async () => {
        const runtimeTool = findRuntimeTool(bundle.tools, inventoryTool.name)
        assert.ok(runtimeTool, `${inventoryTool.name} is missing from the runtime bundle`)
        try {
          await withTimeout(Promise.resolve(runtimeTool.handler(minimalToolArgs(
            runtimeTool.parameters || inventoryTool.parameters,
            { confirmed: true, dryRun: true },
          ))), inventoryTool.name)
        } catch (error) {
          assert.notEqual(error.code, 'CERTIFICATION_TIMEOUT', error.message)
          assert.notEqual(error.code, 'INVALID_ARGS', error.message)
          assert.notEqual(error.code, 'ARG_ERROR', error.message)
          assert.notEqual(error.code, 'MISSING_ARG', error.message)
        }
      })
    }
  }
})
