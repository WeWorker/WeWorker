import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

it('persists encrypted imports and deletion dismissals across settings reloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-provider-storage-'))
  const home = vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.resetModules()
  const config = await import('../config.js')
  const { setMasterKeyForTests } = await import('../secret-store.js')
  const { discoverLocalProviders, importDiscoveredProviders } = await import('../provider-discovery.js')
  const { deleteModelConfiguration } = await import('../model-configurations.js')
  setMasterKeyForTests('0123456789abcdef0123456789abcdef')
  try {
    expect(config.getSettings().model_discovery_enabled).toBe(true)
    config.updateSettings({ model_discovery_enabled: false })
    fs.mkdirSync(path.join(root, '.claude'))
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ env: {
      ANTHROPIC_API_KEY: 'fixture-imported-secret', ANTHROPIC_MODEL: 'fixture-model', ANTHROPIC_BASE_URL: 'https://example.com',
    } }))
    const discovered = (await discoverLocalProviders({ home: root, env: {} })).providers
    const imported = importDiscoveredProviders(config.getSettings(), discovered)
    config.updateSettings(imported.updates)
    const diskPath = path.join(root, '.weworker', 'settings.json')
    expect(fs.readFileSync(diskPath, 'utf8')).not.toContain('fixture-imported-secret')
    config.resetSettingsStateForTests()
    let state = config.getSettings()
    expect(state.model_discovery_enabled).toBe(false)
    const id = imported.imported[0]
    expect(state.active_model_configuration).toBe(id)
    expect(state.model_configurations![id].api_key).toBe('fixture-imported-secret')
    expect(importDiscoveredProviders(state, discovered).imported).toEqual([])
    state = config.updateSettings({ active_model_configuration: '', active_provider: 'anthropic' })
    config.updateSettings(deleteModelConfiguration(state, id))
    config.resetSettingsStateForTests()
    state = config.getSettings()
    expect(state.model_configurations![id]).toBeUndefined()
    expect(importDiscoveredProviders(state, discovered).imported).toEqual([])
    expect(importDiscoveredProviders(state, discovered, true).imported).toHaveLength(1)
    config.updateSettings({ model_discovery_enabled: true })
    config.resetSettingsStateForTests()
    expect(config.getSettings().model_discovery_enabled).toBe(true)
  } finally {
    home.mockRestore()
    setMasterKeyForTests(null)
    config.resetSettingsStateForTests()
    vi.resetModules()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
