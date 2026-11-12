import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Settings } from '../config.js'
import { BANK_CODING_PROVIDER, getBuiltinApiKey, isBuiltinProvider, publicBuiltinProviders, resolveBankCodingSettings, resolveBankCodingProvider } from '../builtin-provider.js'
import { PROVIDERS } from '../provider-registry.js'
import { createModelConfiguration, deleteModelConfiguration, renameModelConfiguration } from '../model-configurations.js'
import { buildConfiguredModelEnv } from '../agent.js'
import { listProviderModels, probeMainConnection } from '../provider-model-services.js'
import { resolveWebwrightModelConfig } from '../webwright-model-config.js'

// Exercise optional provider support without shipping a private preset.
vi.mock('../provider-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../provider-config.js')>()
  const template = actual.configuredProvider('anthropic')!
  const providers = [...actual.CONFIGURED_PROVIDERS.filter(p => p.id !== 'bank_coding'), { ...template, id: 'bank_coding', name: 'Fixture coding provider',
    authType: 'auth_token' as const, allowMultiple: false, baseUrlEnv: 'WEWORKER_BANK_CODING_BASE_URL',
    weworker: { ...template.weworker, baseUrl: 'https://example.com/public' },
    webwright: { ...template.webwright, protocol: 'anthropic_messages' as const,
      modelClass: 'anthropic' as const, baseUrl: 'https://example.com/public' } }]
  return { ...actual, CONFIGURED_PROVIDERS: providers,
    configuredProvider: (id: string | undefined) => providers.find(p => p.id === id) }
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-provider-fixture-'))
const env = {
  WEWORKER_BANK_CODING_API_KEY: 'fixture-reference-token',
  WEWORKER_BANK_CODING_BASE_URL: 'https://example.com/public/',
  WEWORKER_PROVIDER_DEPLOYMENTS_FILE: path.join(root, 'missing.json'),
}
const saved = { active_provider: 'bank_coding', api_key_bank_coding: 'fixture-user-key', model_bank_coding: 'fixture-selected-model' } as Settings
function providerInput() {
  const provider = resolveBankCodingProvider(BANK_CODING_PROVIDER, env)
  return { provider, apiKey: 'fixture-user-key', anthropicBaseUrl: provider.weworker.baseUrl, model: saved.model_bank_coding! }
}
afterEach(() => vi.unstubAllEnvs())

describe('user-configured coding provider', () => {
  it('preserves distinct JSON gateways without a deployment override and honors a model lock', () => {
    const provider = { ...BANK_CODING_PROVIDER, fixedModel: true, defaultModel: 'fixture-locked',
      weworker: { ...BANK_CODING_PROVIDER.weworker, baseUrl: 'https://example.com/anthropic' },
      webwright: { ...BANK_CODING_PROVIDER.webwright, baseUrl: 'https://example.org/v1' } }
    const deployment = { WEWORKER_PROVIDER_DEPLOYMENTS_FILE: env.WEWORKER_PROVIDER_DEPLOYMENTS_FILE }
    expect(resolveBankCodingProvider(provider, deployment)).toEqual(provider)
    expect(resolveBankCodingSettings(saved, [provider], deployment)).toMatchObject({
      base_url: 'https://example.com/anthropic', model: 'fixture-locked', api_key: 'fixture-user-key',
    })
    const file = path.join(root, 'legacy-gateway.json')
    fs.writeFileSync(file, JSON.stringify({ bank_coding: { baseUrl: 'https://example.org/stale' } }))
    expect(resolveBankCodingProvider(provider, { WEWORKER_PROVIDER_DEPLOYMENTS_FILE: file })).toEqual(provider)
    expect(resolveBankCodingProvider(provider, env).weworker.baseUrl).toBe('https://example.com/public')
  })

  it('requires a user key and ignores deployment credentials from files and environment', () => {
    const file = path.join(root, 'providers.json')
    fs.writeFileSync(file, JSON.stringify({ bank_coding: { apiKey: 'fixture-old-reference-key', baseUrl: 'https://example.org/public' } }))
    const deployment = { ...env, WEWORKER_PROVIDER_DEPLOYMENTS_FILE: file }
    expect(isBuiltinProvider('bank_coding')).toBe(false)
    expect(getBuiltinApiKey('bank_coding', deployment)).toBe('')
    expect(publicBuiltinProviders([BANK_CODING_PROVIDER], deployment)).toEqual({})
    expect(resolveBankCodingSettings({ active_provider: 'bank_coding', api_key: 'fixture-stale-key' } as Settings, PROVIDERS, deployment).api_key).toBe('')
    expect(resolveBankCodingProvider({ ...BANK_CODING_PROVIDER, weworker: { ...BANK_CODING_PROVIDER.weworker, baseUrl: '' } }, { WEWORKER_PROVIDER_DEPLOYMENTS_FILE: file }).weworker.baseUrl).toBe('https://example.org/public')
    expect(resolveBankCodingSettings(saved, [], deployment)).toMatchObject({ api_key: '', base_url: '' })
    expect(JSON.stringify(PROVIDERS)).not.toContain('fixture-user-key')
  })

  it('prevents deletion, renaming and duplicate creation', () => {
    expect(() => deleteModelConfiguration({} as Settings, 'bank_coding')).toThrow('不能删除')
    expect(() => renameModelConfiguration({} as Settings, 'bank_coding', 'Fixture rename')).toThrow('不能修改')
    expect(() => createModelConfiguration({} as Settings, 'bank_coding')).toThrow()
  })

  it('maps the selected model to every Claude tier and clears inherited tier overrides when switching provider', () => {
    const runtime = resolveBankCodingSettings(saved, PROVIDERS, env)
    const configured = buildConfiguredModelEnv(runtime, { ANTHROPIC_API_KEY: 'fixture-stale', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-stale-model' }, path.join(root, 'claude'))
    expect(configured.ANTHROPIC_AUTH_TOKEN).toBe('fixture-user-key')
    expect(configured.ANTHROPIC_API_KEY).toBeUndefined()
    expect(configured.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) expect(configured[key]).toBe('fixture-selected-model')
    const switched = buildConfiguredModelEnv({ api_key: 'fixture-next-key', base_url: 'https://api.anthropic.com', active_provider: 'anthropic' }, configured, path.join(root, 'claude'))
    expect(switched.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(switched.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
    expect(switched.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
    expect(switched.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(switched.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
  })

  it('probes the gateway with Bearer authentication and the selected model', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }] }))
    expect((await probeMainConnection({ ...providerInput(), model: 'fixture-selected-model' }, fetchMock)).ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/public/v1/messages')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-user-key')
    expect(new Headers(init?.headers).has('x-api-key')).toBe(false)
    expect(JSON.parse(String(init?.body)).model).toBe('fixture-selected-model')
  })

  it('resolves the managed endpoint for exploration without failing its allowlist', () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    const runtime = resolveBankCodingSettings(saved, PROVIDERS, env)
    expect(resolveWebwrightModelConfig(runtime)).toMatchObject({ provider_id: 'bank_coding', protocol: 'anthropic_messages', base_url: 'https://example.com/public', model: 'fixture-selected-model' })
  })
})

it('fetches the gateway catalog using the user key without a hardcoded fallback', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [{ id: 'fixture-model-a' }, { id: 'fixture-model-b' }] }))
  const input = providerInput()
  expect(await listProviderModels(input, fetchMock)).toEqual({ source: 'remote', models: ['fixture-model-a', 'fixture-model-b'] })
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://example.com/public/v1/models?limit=1000')
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-user-key')
  fetchMock.mockRejectedValue(new Error('fixture unavailable'))
  expect(await listProviderModels(input, fetchMock)).toMatchObject({ source: 'fallback', models: [] })
})

it('restores only the selected provider user key and model', () => {
  const inactive = { ...saved, active_provider: 'anthropic', model: 'fixture-other', api_key: 'fixture-other-key' }
  expect(resolveBankCodingSettings(inactive, PROVIDERS, env)).toBe(inactive)
  expect(resolveBankCodingSettings({ ...inactive, active_provider: 'bank_coding' }, PROVIDERS, env))
    .toMatchObject({ model: 'fixture-selected-model', api_key: 'fixture-user-key' })
})
