import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NPM_BRIDGE_PORT, resolveBridgeInstance, bridgeUrl } from '../bridge-instance.js'
import { prepareNpmEnvironment } from '../npm-environment.js'

const home = path.resolve('/tmp/fixture-home')

describe('Bridge instance resolution', () => {
  it('keeps the core and desktop entry on 3711', () => {
    const instance = resolveBridgeInstance({ env: {}, home })
    expect(instance).toMatchObject({ kind: 'desktop', port: 3711, connectHost: 'localhost', bindHost: undefined })
    expect(instance.stateDir).toBeUndefined()
    expect(bridgeUrl(instance)).toBe('ws://localhost:3711')
  })

  it('gives npm its own loopback port and state directory', () => {
    const instance = resolveBridgeInstance({ env: { WEWORKER_WEBCLI_DISTRIBUTION: 'npm' }, home })
    expect(NPM_BRIDGE_PORT).toBe(3712)
    expect(instance).toMatchObject({
      kind: 'npm', port: 3712, connectHost: '127.0.0.1', bindHost: '127.0.0.1',
      stateDir: path.join(home, '.webcli', 'npm-3712'),
    })
    expect(bridgeUrl(instance)).toBe('ws://127.0.0.1:3712')
  })

  it('rejects invalid or mismatched npm ports instead of falling back to 3711', () => {
    expect(() => resolveBridgeInstance({ env: { WEWORKER_WEBCLI_DISTRIBUTION: 'npm', WEBCLI_BRIDGE_PORT: '3713' }, home })).toThrow(/3712/)
    expect(() => resolveBridgeInstance({ env: { WEBCLI_BRIDGE_PORT: 'abc' }, home })).toThrow(/integer/)
    expect(() => resolveBridgeInstance({ env: { WEBCLI_BRIDGE_PORT: '80' }, home })).toThrow(/between/)
  })

  it('accepts an explicit desktop port for development but never a desktop fallback for npm', () => {
    const instance = resolveBridgeInstance({ env: { WEBCLI_BRIDGE_PORT: '3811' }, home })
    expect(instance).toMatchObject({ kind: 'desktop', port: 3811, connectHost: 'localhost' })
  })
})

describe('npm executable', () => {
  const npmEntry = fileURLToPath(new URL('../npm-entry.js', import.meta.url))

  it('runs the CLI without starting a Bridge and without touching desktop resources', () => {
    const result = spawnSync(process.execPath, [npmEntry, '--version'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, WEWORKER_RESOURCES_PATH: '' },
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^webcli \d+\.\d+\.\d+/)
  })

  it('refuses a desktop resource override before loading the CLI', () => {
    const result = spawnSync(process.execPath, [npmEntry, '--version'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, WEWORKER_RESOURCES_PATH: home },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WEWORKER_RESOURCES_PATH')
  })
})

describe('npm environment', () => {
  it('selects the packaged npm port and isolated writable roots without overriding explicit paths', () => {
    const env = prepareNpmEnvironment({}, home)
    expect(env).toMatchObject({
      WEWORKER_WEBCLI_DISTRIBUTION: 'npm',
      WEBCLI_BRIDGE_PORT: '3712',
      WEWORKER_BROWSER_HOME: path.join(home, '.webcli', 'browser'),
      WEWORKER_USER_ADAPTERS_DIR: path.join(home, '.webcli', 'adapters'),
      WEWORKER_ADAPTER_DATA_DIR: path.join(home, '.webcli'),
    })
    const explicit = prepareNpmEnvironment({ WEWORKER_BROWSER_HOME: path.join(home, 'custom-browser'), WEWORKER_ADAPTER_DATA_DIR: path.join(home, 'custom-data') }, home)
    expect(explicit.WEWORKER_BROWSER_HOME).toBe(path.join(home, 'custom-browser'))
    expect(explicit.WEWORKER_ADAPTER_DATA_DIR).toBe(path.join(home, 'custom-data'))
  })

  it('refuses desktop resource overrides and user-selected npm ports', () => {
    expect(() => prepareNpmEnvironment({ WEWORKER_RESOURCES_PATH: path.join(home, 'desktop-resources') }, home)).toThrow(/WEWORKER_RESOURCES_PATH/)
    expect(() => prepareNpmEnvironment({ WEBCLI_BRIDGE_PORT: '3711' }, home)).toThrow(/3712/)
  })
})
