import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverLocalProviders, importDiscoveredProviders } from '../provider-discovery.js'
import { deleteModelConfiguration, publicModelConfigurations, updateModelConfiguration } from '../model-configurations.js'
import { applySecrets, clearSecretsOnDisk, extractSecrets } from '../settings-secrets.js'
import type { Settings } from '../config.js'

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-provider-discovery-')) })
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
function write(file: string, value: unknown) {
  const target = path.join(home, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
}
function settings(): Settings {
  return { active_provider: 'anthropic', api_key: 'fixture-current-key', model: 'fixture-current-model',
    model_configurations: {}, model_configuration_names: {}, added_providers: [] } as unknown as Settings
}
function claude(key = 'fixture-claude-key') {
  write('.claude/settings.json', { env: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://example.com/anthropic', ANTHROPIC_MODEL: 'fixture-claude-model' } })
}
const discover = (env: NodeJS.ProcessEnv = {}) => discoverLocalProviders({ home, env })

describe('local provider discovery', () => {
  it('reads Claude settings and local overrides without changing the source', async () => {
    claude()
    write('.claude/settings.local.json', { env: { ANTHROPIC_AUTH_TOKEN: 'fixture-local-token' } })
    const before = fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')
    const { providers } = await discover()
    expect(providers).toHaveLength(1)
    expect(providers[0].configuration).toMatchObject({ name: 'Claude Code', provider_id: 'custom',
      api_key: 'fixture-local-token', auth_type: 'auth_token', model: 'fixture-claude-model', weworker_protocol: 'anthropic_messages' })
    expect(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).toBe(before)
  })

  it('honors Claude and Codex configuration roots and resolves explicit environment references', async () => {
    write('claude-config/settings.json', { env: { ANTHROPIC_API_KEY: '${FIXTURE_KEY}', ANTHROPIC_MODEL: 'fixture-model' } })
    write('codex-config/config.toml', 'model = "fixture-codex-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://example.com/v1"\nenv_key = "FIXTURE_KEY"\nwire_api = "responses"')
    const result = await discover({ CLAUDE_CONFIG_DIR: path.join(home, 'claude-config'), CODEX_HOME: path.join(home, 'codex-config'), FIXTURE_KEY: 'fixture-environment-key' })
    expect(result.providers.map(item => item.configuration.api_key)).toEqual(['fixture-environment-key', 'fixture-environment-key'])
    expect(result.providers[1].configuration.weworker_protocol).toBe('openai_responses')
  })

  it('parses Codex TOML tables, quoted IDs and active profiles, using API-key auth only', async () => {
    write('.codex/config.toml', 'model="root-model"\nmodel_provider="fixture.api"\nprofile="work"\n[model_providers."fixture.api"]\nbase_url="https://example.com/v1" # comment\nwire_api="chat"\n[profiles.work]\nmodel="profile-model"')
    write('.codex/auth.json', { OPENAI_API_KEY: 'fixture-codex-key' })
    const { providers } = await discover()
    expect(providers[0].configuration).toMatchObject({ model: 'profile-model', weworker_protocol: 'openai_chat_completions', api_key: 'fixture-codex-key' })
    write('.codex/auth.json', { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-product-login-token' } })
    expect((await discover()).providers).toEqual([])
  })

  it('imports WorkBuddy and CodeBuddy model files with full endpoints and environment references', async () => {
    write('.workbuddy/settings.json', { env: { FIXTURE_MODEL_KEY: 'fixture-workbuddy-key' } })
    write('.workbuddy/models.json', { models: [{ id: 'fixture-workbuddy-model', apiKey: '${FIXTURE_MODEL_KEY}', url: 'https://example.com/v1/chat/completions' }] })
    write('.codebuddy/models.json', { models: [{ id: 'fixture-codebuddy-model', apiKey: 'fixture-codebuddy-key', api: 'openai-responses', url: 'https://example.org/v1' }] })
    const { providers } = await discover()
    expect(providers.map(item => item.product)).toEqual(['WorkBuddy', 'CodeBuddy'])
    expect(providers[0].configuration).toMatchObject({ api_key: 'fixture-workbuddy-key', base_url: 'https://example.com/v1/chat/completions', base_url_is_full: true, weworker_protocol: 'openai_chat_completions' })
    expect(providers[1].configuration).toMatchObject({ base_url_is_full: false, weworker_protocol: 'openai_responses' })
  })

  it('reads OpenCode API credentials and JSONC configuration without importing OAuth', async () => {
    write('.config/opencode/opencode.jsonc', '{ // fixture\n "model": "fixture/fixture-model", "provider": { "fixture": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://example.com/v1" } } }, }')
    write('.local/share/opencode/auth.json', { fixture: { type: 'api', key: 'fixture-opencode-key' } })
    expect((await discover()).providers[0].configuration).toMatchObject({ api_key: 'fixture-opencode-key', model: 'fixture-model', weworker_protocol: 'openai_chat_completions' })
    write('.local/share/opencode/auth.json', { fixture: { type: 'oauth', access: 'fixture-login-token' } })
    expect((await discover()).providers).toEqual([])
  })

  it('supports WorkBuddy GUI arrays and explicit configuration roots', async () => {
    write('buddy-config/models.json', [{ id: 'fixture-model', apiKey: 'fixture-key', url: 'https://example.com/v1/chat/completions' }])
    const { providers } = await discover({ WORKBUDDY_CONFIG_DIR: path.join(home, 'buddy-config') })
    expect(providers).toHaveLength(1)
    expect(providers[0].product).toBe('WorkBuddy')
    expect(providers[0].configuration.model).toBe('fixture-model')
  })

  it('distinguishes WorkBuddy base URLs from exact custom protocol endpoints', async () => {
    write('.workbuddy/models.json', [
      { id: 'base', apiKey: 'fixture-key', url: 'https://example.com/v1' },
      { id: 'exact', apiKey: 'fixture-key', url: 'https://example.com/gateway', useCustomProtocol: true },
    ])
    expect((await discover()).providers.map(item => item.configuration.base_url_is_full)).toEqual([false, true])
  })

  it('uses OpenCode official provider defaults only for API credentials', async () => {
    write('.config/opencode/opencode.json', { model: 'anthropic/fixture-model' })
    write('.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'fixture-key' } })
    expect((await discover()).providers[0].configuration).toMatchObject({
      base_url: 'https://api.anthropic.com', weworker_protocol: 'anthropic_messages',
    })
    write('.local/share/opencode/auth.json', { anthropic: { type: 'oauth', access: 'fixture-login-token' } })
    expect((await discover()).providers).toEqual([])
    expect((await discover({ OPENAI_API_KEY: 'fixture-unrelated-key' })).providers).toEqual([])
  })

  it('supports explicit Codex bearer configuration without importing login sessions', async () => {
    write('.codex/config.toml', 'model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nbase_url="https://example.com/v1"\nexperimental_bearer_token="fixture-explicit-api-key"')
    expect((await discover()).providers[0].configuration.api_key).toBe('fixture-explicit-api-key')
  })

  it('keeps API credentials without an explicit model, and does not send Claude aliases to the API', async () => {
    claude()
    write('.claude/settings.local.json', { model: 'sonnet', env: { ANTHROPIC_MODEL: '' } })
    const { providers } = await discover()
    expect(providers).toHaveLength(1)
    expect(providers[0].configuration.model).toBe('')
    const result = importDiscoveredProviders({ ...settings(), api_key: '' }, providers)
    expect(result.imported).toHaveLength(1)
    expect(result.updates).not.toHaveProperty('active_model_configuration')
  })

  it('rejects unresolved references in URLs and keys, and supports OpenCode env references', async () => {
    write('.workbuddy/models.json', [
      { id: 'missing-url', apiKey: 'fixture-key', url: 'https://example.com/${MISSING}/v1/chat/completions' },
      { id: 'partial-key', apiKey: 'prefix-${MISSING}', url: 'https://example.com/v1/chat/completions' },
    ])
    write('.config/opencode/opencode.json', { model: 'fixture/fixture-model', provider: { fixture: {
      npm: '@ai-sdk/openai-compatible', options: { apiKey: '{env:FIXTURE_KEY}', baseURL: 'https://example.com/v1' },
    } } })
    const { providers } = await discover({ FIXTURE_KEY: 'fixture-env-key' })
    expect(providers).toHaveLength(1)
    expect(providers[0].product).toBe('OpenCode')
    expect(providers[0].configuration.api_key).toBe('fixture-env-key')
  })

  it('isolates malformed or oversized files, ignores incomplete credentials and never returns raw errors', async () => {
    claude()
    write('.codex/config.toml', '[not valid TOML fixture-key')
    write('.workbuddy/models.json', 'x'.repeat(1024 * 1024 + 1))
    write('.codebuddy/models.json', { models: [{ id: 'fixture', apiKey: '${MISSING_KEY}', url: 'https://example.com/v1/chat/completions' }] })
    const result = await discover()
    expect(result.providers).toHaveLength(1)
    expect(result.issues).toEqual(['Codex', 'WorkBuddy'])
    expect(JSON.stringify(result.issues)).not.toContain(home)
    expect(JSON.stringify(result.issues)).not.toContain('fixture-key')
  })

  it('does not execute helper scripts or use product login credentials', async () => {
    write('.claude/settings.json', { apiKeyHelper: 'must-not-run-fixture-command', model: 'fixture-model' })
    write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'fixture-login-token' } })
    write('.codex/auth.json', { tokens: { access_token: 'fixture-login-token' } })
    expect((await discover()).providers).toEqual([])
  })

  it('rejects credential-bearing URLs and unsafe protocols', async () => {
    write('.workbuddy/models.json', { models: [
      { id: 'fixture-a', apiKey: 'fixture-key', url: 'https://user:fixture-password@example.com/v1/chat/completions' },
      { id: 'fixture-b', apiKey: 'fixture-key', url: 'file:///fixture/chat/completions' },
      { id: 'fixture-c', apiKey: 'fixture-key', url: 'https://example.com/v1/chat/completions?api_key=fixture-secret' },
    ] })
    expect((await discover()).providers).toEqual([])
  })
})

describe('discovered provider import', () => {
  it('appends custom entries once, preserves user changes and leaves active settings intact', async () => {
    claude()
    const discovered = (await discover()).providers
    const original = settings()
    const first = importDiscoveredProviders(original, discovered)
    expect(first.imported).toHaveLength(1)
    expect(first.updates).not.toHaveProperty('active_provider')
    const state = { ...original, ...first.updates }
    const id = first.imported[0]
    const edited = { ...state, ...updateModelConfiguration(state, id, { name: 'My edited provider', api_key: 'fixture-edited-key' }) }
    const again = importDiscoveredProviders(edited, discovered, true)
    expect(again.imported).toEqual([])
    expect(again.existing).toBe(1)
    expect(again.updates).toEqual({})
    expect(edited.model_configurations![id].name).toBe('My edited provider')
    expect(original.model_configurations).toEqual({})
  })

  it('fills an unconfigured setup, and keeps deleted entries dismissed until manual discovery', async () => {
    claude()
    const discovered = (await discover()).providers
    const empty = { ...settings(), api_key: '' }
    const first = importDiscoveredProviders(empty, discovered)
    expect(first.updates.active_model_configuration).toBe(first.imported[0])
    expect(first.updates.onboarding_completed).toBe(true)
    let state: Settings = { ...settings(), ...first.updates, active_model_configuration: undefined }
    state = { ...state, ...deleteModelConfiguration(state, first.imported[0]) }
    expect(importDiscoveredProviders(state, discovered).imported).toEqual([])
    const manual = importDiscoveredProviders(state, discovered, true)
    expect(manual.imported).toHaveLength(1)
    expect(manual.updates.dismissed_model_sources).toEqual([])
  })

  it('numbers product configurations and stores imported keys through the existing secret projection', async () => {
    write('.workbuddy/models.json', { models: ['a', 'b'].map(id => ({ id, apiKey: `fixture-${id}-key`, url: 'https://example.com/v1/chat/completions' })) })
    const result = importDiscoveredProviders(settings(), (await discover()).providers)
    const state = { ...settings(), ...result.updates }
    expect(Object.values(state.model_configurations!).map(item => item.name)).toEqual(['WorkBuddy', 'WorkBuddy (2)'])
    const publicData = JSON.stringify(publicModelConfigurations(state))
    expect(publicData).not.toContain('fixture-a-key')
    expect(publicData).not.toContain('fixture-b-key')
    expect(publicData).not.toContain(home)
    const disk = clearSecretsOnDisk(state)
    expect(JSON.stringify(disk)).not.toContain('fixture-a-key')
    expect(applySecrets(disk, extractSecrets(state)).model_configurations).toEqual(state.model_configurations)
  })

  it('ignores a malformed legacy dismissal list', async () => {
    claude()
    const state = { ...settings(), dismissed_model_sources: {} } as unknown as Settings
    expect(importDiscoveredProviders(state, (await discover()).providers).imported).toHaveLength(1)
  })
})
