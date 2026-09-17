import assert from 'node:assert/strict'
import test from 'node:test'

import { loadShippedApiInventory } from '../../webcli/api-adapter-certification.js'
import {
  findRuntimeTool,
  loadAdapterBundle,
  minimalToolArgs,
  withTimeout,
} from './helpers/adapter-test-loader.mjs'

function successEnvelope() {
  return { ok: true, success: true, code: 0, data: [], result: [], rows: [], total: 0 }
}

function successResponse() {
  const body = JSON.stringify(successEnvelope())
  return {
    ok: true,
    status: 200,
    url: 'https://example.com/api',
    headers: { get: () => 'application/json' },
    async json() { return JSON.parse(body) },
    async text() { return body },
    async arrayBuffer() { return new TextEncoder().encode(body).buffer },
  }
}

test('shipped API tools settle under generic mocked success I/O', async (t) => {
  const inventory = await loadShippedApiInventory()
  assert.deepEqual(inventory.errors, [])

  for (const adapter of inventory.adapters) {
    const runtime = {
      getContext: () => ({ adapterId: adapter.id, routeDomain: adapter.id, tabDomain: adapter.id }),
      requireConfirmation: () => true,
      async requestPrivileged(action) {
        if (action === 'cookies_get') return { cookies: [] }
        if (action === 'storage_get') return { value: null }
        if (action === 'backend_fetch' || action === 'browser_fetch') {
          return { status: 200, ok: true, body: JSON.stringify(successEnvelope()), headers: { 'content-type': 'application/json' } }
        }
        if (action === 'main_world_eval') return { value: successEnvelope() }
        return successEnvelope()
      },
      async fetchJson() { return successEnvelope() },
    }
    const bundle = await loadAdapterBundle(adapter.id, {
      runtime,
      globals: { fetch: async () => successResponse() },
    })

    for (const inventoryTool of adapter.tools) {
      await t.test(`${inventoryTool.name} handles mocked success`, async () => {
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
