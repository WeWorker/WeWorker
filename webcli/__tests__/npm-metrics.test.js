import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { packagedMetricsEnvironment } from '../npm-metrics.js'

const ENABLED = { enabled: true, endpoint: 'https://example.com/v1/metrics/batch', token: 'fixture-metrics-client-token-123456' }

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(config) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-npm-metrics-'))
  tempDirs.push(packageDir)
  if (config !== undefined) fs.writeFileSync(path.join(packageDir, 'metrics-client.json'), JSON.stringify(config))
  return packageDir
}

describe('packaged npm metrics defaults', () => {
  it('keeps the default install silent without a metrics config', () => {
    expect(packagedMetricsEnvironment({ packageDir: fixture(), env: {} })).toEqual({})
  })

  it('applies enabled packaged defaults and honors explicit user environment', () => {
    const packageDir = fixture(ENABLED)
    expect(packagedMetricsEnvironment({ packageDir, env: {} })).toEqual({
      WEBCLI_METRICS_ENDPOINT: ENABLED.endpoint,
      WEBCLI_METRICS_TOKEN: ENABLED.token,
      WEBCLI_METRICS_UPLOAD: 'on',
    })
    expect(packagedMetricsEnvironment({ packageDir, env: { WEBCLI_METRICS_UPLOAD: 'off', WEBCLI_METRICS_TOKEN: 'fixture-user-token-123456' } })).toEqual({
      WEBCLI_METRICS_ENDPOINT: ENABLED.endpoint,
    })
  })

  it('fails closed on disabled, tampered or unsafe packaged configuration', () => {
    expect(packagedMetricsEnvironment({ packageDir: fixture({ enabled: false }), env: {} })).toEqual({})
    expect(packagedMetricsEnvironment({ packageDir: fixture({ enabled: true, endpoint: 'https://example.com/v1/stats', token: ENABLED.token }), env: {} })).toEqual({})
    expect(packagedMetricsEnvironment({ packageDir: fixture({ enabled: true, endpoint: ENABLED.endpoint, token: 'short' }), env: {} })).toEqual({})
    const packageDir = fixture(ENABLED)
    fs.writeFileSync(path.join(packageDir, 'metrics-client.json'), '{invalid')
    expect(packagedMetricsEnvironment({ packageDir, env: {} })).toEqual({})
  })
})
