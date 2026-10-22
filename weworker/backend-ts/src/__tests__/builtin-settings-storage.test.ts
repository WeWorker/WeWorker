import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.doUnmock('../provider-config.js'); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules() })

it('keeps deployment keys out of settings during activation, unrelated saves and reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-builtin-fixture-'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.stubEnv('WEWORKER_BUILTIN_API_KEY', 'fixture-runtime-only-key')
  vi.resetModules()
  const config = await import('../config.js')
  const { activateBuiltinProvider, BUILTIN_PROVIDER } = await import('../builtin-provider.js')
  expect(config.updateSettings(activateBuiltinProvider(BUILTIN_PROVIDER)).api_key).toBe('fixture-runtime-only-key')
  expect(config.updateSettings({ welcome_featured_site_limit: 12 }).api_key).toBe('fixture-runtime-only-key')
  const saved = fs.readFileSync(path.join(root, '.weworker', 'settings.json'), 'utf8')
  expect(saved).not.toContain('fixture-runtime-only-key')
  expect(JSON.parse(saved).active_provider).toBe('builtin')
  config.resetSettingsStateForTests()
  expect(config.getSettings().api_key).toBe('fixture-runtime-only-key')
  vi.stubEnv('WEWORKER_BUILTIN_API_KEY', '')
  expect(config.getSettings().api_key).not.toBe('')
  expect(JSON.parse(fs.readFileSync(path.join(root, '.weworker', 'settings.json'), 'utf8')).api_key).toBe('')
  expect(config.updateSettings({ active_provider: 'anthropic', api_key: '' }).api_key).toBe('')
})

it('starts a fresh settings file in onboarding and persists completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-onboarding-fixture-'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.resetModules()
  const config = await import('../config.js')
  expect(config.getSettings().onboarding_completed).toBe(false)
  config.updateSettings({ onboarding_completed: true })
  config.resetSettingsStateForTests()
  expect(config.getSettings().onboarding_completed).toBe(true)
})

it('encrypts the user coding key and restores it across reload and provider switching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-coding-fixture-'))
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.stubEnv('WEWORKER_BANK_CODING_API_KEY', 'fixture-ignored-reference-key')
  vi.stubEnv('WEWORKER_BANK_CODING_BASE_URL', 'https://example.com/public')
  vi.resetModules()
  vi.doMock('../provider-config.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../provider-config.js')>()
    const template = actual.configuredProvider('anthropic')!
    const providers = [...actual.CONFIGURED_PROVIDERS, { ...template, id: 'bank_coding', name: 'Fixture coding provider',
      authType: 'auth_token' as const, allowMultiple: false, baseUrlEnv: 'WEWORKER_BANK_CODING_BASE_URL',
      weworker: { ...template.weworker, baseUrl: 'https://example.com/public' } }]
    return { ...actual, CONFIGURED_PROVIDERS: providers,
      configuredProvider: (id: string | undefined) => providers.find(provider => provider.id === id) }
  })
  const { setMasterKeyForTests } = await import('../secret-store.js')
  setMasterKeyForTests('0123456789abcdef0123456789abcdef')
  try {
    const config = await import('../config.js')
    const { activateBuiltinProvider, BUILTIN_PROVIDER } = await import('../builtin-provider.js')
    config.updateSettings({ active_provider: 'bank_coding', active_model_configuration: '' })
    expect(config.getSettings().api_key).toBe('')
    config.updateSettings({ api_key_bank_coding: 'fixture-user-key', model_bank_coding: 'fixture-selected-model', context_limit_bank_coding: 250000 })
    config.resetSettingsStateForTests()
    expect(config.getSettings()).toMatchObject({ api_key: 'fixture-user-key', model: 'fixture-selected-model', context_limit: 250000, active_auth_type: 'auth_token' })
    config.updateSettings(activateBuiltinProvider(BUILTIN_PROVIDER))
    const restored = config.updateSettings({ active_provider: 'bank_coding', active_model_configuration: '' })
    expect(restored).toMatchObject({ api_key: 'fixture-user-key', model: 'fixture-selected-model' })
    const saved = fs.readFileSync(path.join(root, '.weworker', 'settings.json'), 'utf8')
    expect(saved).not.toContain('fixture-user-key')
    expect(saved).not.toContain('fixture-ignored-reference-key')
    expect(JSON.parse(saved).api_key_bank_coding).toBe('')
    expect(JSON.parse(saved)._encrypted.fields.api_key_bank_coding).toBeTruthy()
  } finally { setMasterKeyForTests(null) }
})
