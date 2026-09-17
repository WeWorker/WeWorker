import { describe, expect, it } from 'vitest'

import {
  assertValidShippedApiInventory,
  loadShippedApiInventory,
} from '../api-adapter-certification.js'

const VALID_SAFETY_CLASSES = new Set(['read', 'sensitive_read', 'mutating', 'high_risk'])

describe('shipped API Adapter certification inventory', () => {
  it('discovers API/background tools from the active build profile', async () => {
    const inventory = await loadShippedApiInventory()
    const tools = inventory.adapters.flatMap((adapter) => adapter.tools)

    expect(inventory.adapterCount).toBe(inventory.adapters.length)
    expect(inventory.toolCount).toBe(tools.length)
    expect(inventory.webcliDiscoverableToolCount).toBe(tools.length)
    expect(inventory.webcliDiscoveryGapCount).toBe(0)
    expect(inventory.executionMetadataGapCount).toBe(0)
  })

  it('contains only API/background tools with unique names and valid schemas', async () => {
    const inventory = await loadShippedApiInventory()
    const tools = inventory.adapters.flatMap((adapter) => adapter.tools)

    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    for (const tool of tools) {
      expect(tool.execution).toEqual({ type: 'api', runtime: 'background' })
      expect(tool.parameters.type, tool.name).toBe('object')
      expect(tool.parameters.properties, tool.name).toBeTypeOf('object')
      for (const requiredName of tool.parameters.required || []) {
        expect(tool.parameters.properties, `${tool.name}/${requiredName}`).toHaveProperty(requiredName)
      }
    }
  })

  it('requires an explicit valid safety class for every tool', async () => {
    const inventory = await loadShippedApiInventory()
    const tools = inventory.adapters.flatMap((adapter) => adapter.tools)

    expect(tools.every((tool) => VALID_SAFETY_CLASSES.has(tool.safety))).toBe(true)
    expect(tools.filter((tool) => (
      (tool.safety === 'read' || tool.safety === 'sensitive_read')
      && tool.requiresConfirmation
    ))).toEqual([])
  })

  it('tracks textual test references without treating them as executable proof', async () => {
    const inventory = await loadShippedApiInventory()
    expect(inventory.referencedByTestCount + inventory.noTestReferenceCount).toBe(inventory.toolCount)
  })

  it('passes the certification gate when discovery and execution metadata are complete', async () => {
    const inventory = await loadShippedApiInventory()
    expect(inventory.errors).toEqual([])
    expect(assertValidShippedApiInventory(inventory)).toBe(inventory)
  })
})
