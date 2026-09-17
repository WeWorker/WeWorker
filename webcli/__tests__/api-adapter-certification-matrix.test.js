import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadShippedApiInventory } from '../api-adapter-certification.js'
import {
  buildApiAdapterCertificationMatrix,
  certifyMutation,
  certifyReadStatus,
} from '../api-adapter-certification-matrix.js'

describe('API Adapter release certification matrix', () => {
  it('classifies live reads without promoting environment limitations to PASS', () => {
    expect(certifyReadStatus('PASS')).toEqual({ result: 'PASS', reasonCode: 'LIVE_READ_PASS' })
    expect(certifyReadStatus('AUTH').result).toBe('CONDITIONAL')
    expect(certifyReadStatus('PAGE_CONTEXT').result).toBe('CONDITIONAL')
    expect(certifyReadStatus('RESPONSE_ERROR').result).toBe('FAIL')
    expect(certifyReadStatus('HTTP_ERROR').result).toBe('FAIL')
  })

  it('requires a confirmed zero-write guard before mutation tools can be conditional', () => {
    expect(certifyMutation({ guard: null, dryRun: null }).result).toBe('FAIL')
    expect(certifyMutation({
      guard: { status: 'CONFIRMATION_GUARD', expectationMet: true },
      dryRun: null,
    })).toEqual({ result: 'CONDITIONAL', reasonCode: 'PRODUCTION_MUTATION_NOT_AUTHORIZED' })
    expect(certifyMutation({
      guard: { status: 'CONFIRMATION_GUARD', expectationMet: true },
      dryRun: { status: 'PASS', expectationMet: true },
    })).toEqual({ result: 'CONDITIONAL', reasonCode: 'SAFE_DRY_RUN_PASS' })
  })

  it('does not promote tools when live evidence is absent', async () => {
    const liveDir = mkdtempSync(join(tmpdir(), 'api-adapter-matrix-'))
    try {
      const inventory = await loadShippedApiInventory()
      const mockEvidence = {
        adapters: inventory.adapters.map((adapter) => ({
          id: adapter.id,
          tools: adapter.tools.map((tool) => ({ name: tool.name, mockStatus: 'PASS' })),
        })),
      }
      const matrix = await buildApiAdapterCertificationMatrix({ mockEvidence, liveDir })

      expect(matrix.adapterCount).toBe(inventory.adapterCount)
      expect(matrix.toolCount).toBe(inventory.toolCount)
      expect(matrix.summary.mock.PASS || 0).toBe(inventory.toolCount)
      expect(matrix.summary.tools.PASS || 0).toBe(0)
      expect(matrix.summary.intermittentTools).toBe(0)
    } finally {
      rmSync(liveDir, { recursive: true, force: true })
    }
  })
})
