import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverLocalProviders, importDiscoveredProviders, publicDiscoveredProviders, validateProviderConnection } from '../provider-discovery.js'
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
const discover = (env: NodeJS.ProcessEnv = {}) => discoverLocalProviders({ home, env, validate: false })

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

describe('DeepSeek Harness discovery', () => {
  const patch = (providers: unknown) => [{ id: 'llm-pi-ai', config: { providers } }]

  it('reads the official YAML credential reference and profile without changing source files', async () => {
    const credentials = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-harness-key\n'
    write('.dsh/.credentials.yaml', credentials)
    write('.dsh/profiles/web/cordis.patch.yml', '- id: llm-deepseek\n  config:\n    models:\n      - id: fixture-deepseek-model\n')
    const { providers } = await discover({ DEEPSEEK_API_KEY: 'fixture-env-lower-priority' })
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ product: 'DeepSeek Harness', configuration: {
      name: 'DeepSeek Harness', api_key: 'fixture-harness-key', model: 'fixture-deepseek-model',
      base_url: 'https://api.deepseek.com/anthropic', weworker_protocol: 'anthropic_messages', auth_type: 'api_key',
    } })
    expect(JSON.stringify(publicDiscoveredProviders(settings(), providers))).not.toContain('fixture-harness-key')
    const imported = importDiscoveredProviders(settings(), providers)
    expect(importDiscoveredProviders({ ...settings(), ...imported.updates }, providers).imported).toEqual([])
    expect(fs.readFileSync(path.join(home, '.dsh/.credentials.yaml'), 'utf8')).toBe(credentials)
  })

  it('still shows a grant token as a candidate but leaves importing to the user', async () => {
    write('.dsh/.credentials.yaml', [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      secret: fixture-session-secret',
      '  deepseek-account-platform/default:',
      '    kind: grant',
      '    payload:',
      '      token: fixture-account-token',
      '      issuer: https://platform.deepseek.com',
    ].join('\n'))
    write('.dsh/profiles/desktop/cordis.patch.yml', '- id: llm-deepseek\n  config:\n    models:\n      - id: fixture-record-model\n')
    // 该令牌对真实接口返回 401；识别阶段仍然要展示，只是标记为校验未通过。
    const unauthorized = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const { providers } = await discoverLocalProviders({ home, env: {}, fetchImpl: unauthorized })
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ product: 'DeepSeek Harness', configuration: { api_key: 'fixture-account-token' } })
    expect(providers[0].validation).toMatchObject({ ok: false, reason: 'auth' })
    // 启动时的自动导入不接收校验失败的来源。
    expect(importDiscoveredProviders(settings(), providers).imported).toEqual([])
    // 用户手动导入则允许。
    expect(importDiscoveredProviders(settings(), providers, true).imported).toHaveLength(1)
  })

  it('discovers a saved official key before a profile patch exists, without inventing a model', async () => {
    write('.dsh/.credentials.yaml', { version: 1, refs: { DEEPSEEK_API_KEY: 'fixture-key' } })
    const { providers } = await discover()
    expect(providers).toHaveLength(1)
    expect(providers[0].configuration.model).toBe('')
  })

  it('honors DSH_HOME, legacy refs and explicit custom protocol routes', async () => {
    write('dsh-custom/.credentials.yaml', { FIXTURE_KEY: 'fixture-key' })
    write('dsh-custom/profiles/desktop/cordis.patch.yml', patch(Object.fromEntries(
      ['openai-completions', 'openai-responses', 'anthropic-messages'].map(api => [api, {
        api, apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://example.com/v1', models: [{ id: `fixture-${api}` }],
      }]),
    )))
    const { providers } = await discover({ DSH_HOME: '~/dsh-custom' })
    expect(providers.map(item => item.configuration.weworker_protocol)).toEqual([
      'openai_chat_completions', 'openai_responses', 'anthropic_messages',
    ])
    expect(new Set(providers.map(item => item.sourceId)).size).toBe(3)
  })

  it('uses home config replacement over profile config and respects disabled entries', async () => {
    write('.dsh/.credentials.yaml', { version: 1, refs: { DEEPSEEK_API_KEY: 'fixture-key' } })
    write('.dsh/profiles/web/cordis.patch.yml', [{ id: 'llm-deepseek', config: { models: [{ id: 'old-model' }] } }])
    write('.dsh/cordis.patch.yml', [{ id: 'llm-deepseek', config: { baseURL: 'https://example.com/anthropic', models: [{ id: 'home-model' }] } }])
    expect((await discover()).providers[0].configuration).toMatchObject({ base_url: 'https://example.com/anthropic', model: 'home-model' })
    write('.dsh/cordis.patch.yml', [{ id: 'llm-deepseek', disabled: true }])
    expect((await discover()).providers).toEqual([])
  })

  it('imports explicit API-key records but skips OAuth and unresolved explicit refs', async () => {
    write('.dsh/.credentials.yaml', { version: 1, records: {
      'llm-pi-ai/key-provider': { kind: 'api-key', key: 'fixture-record-key' },
      'llm-pi-ai/oauth-provider': { kind: 'grant', payload: { access: 'fixture-login-token' } },
    } })
    const route = { api: 'openai-completions', baseURL: 'https://example.com/v1', models: [{ id: 'fixture-model' }] }
    write('.dsh/profiles/web/cordis.patch.yml', patch({ 'key-provider': route, 'oauth-provider': route }))
    expect((await discover()).providers.map(item => item.configuration.api_key)).toEqual(['fixture-record-key'])
    write('.dsh/profiles/web/cordis.patch.yml', patch({ 'key-provider': { ...route, apiKeyEnv: 'MISSING_REFERENCE' } }))
    expect((await discover()).providers).toEqual([])
  })

  it('uses launch environment references only for an existing Harness installation', async () => {
    expect((await discover({ DEEPSEEK_API_KEY: 'fixture-env-key' })).providers).toEqual([])
    write('.dsh/profiles/web/cordis.patch.yml', [])
    expect((await discover({ DEEPSEEK_API_KEY: 'fixture-env-key', DEEPSEEK_BASE_URL: 'https://example.com/anthropic' })).providers[0].configuration)
      .toMatchObject({ api_key: 'fixture-env-key', base_url: 'https://example.com/anthropic' })
  })

  it('contains malformed YAML, oversized files and unsupported credential versions without exposing data', async () => {
    claude()
    write('.dsh/.credentials.yaml', 'refs: [fixture-sensitive-value')
    let result = await discover()
    expect(result.providers.map(item => item.product)).toEqual(['Claude Code'])
    expect(result.issues).toEqual(['DeepSeek Harness'])
    expect(JSON.stringify(result)).not.toContain('fixture-sensitive-value')
    write('.dsh/.credentials.yaml', { version: 2, refs: { DEEPSEEK_API_KEY: 'fixture-key' } })
    expect((await discover()).providers.map(item => item.product)).toEqual(['Claude Code'])
    write('.dsh/.credentials.yaml', { version: 1, refs: { DEEPSEEK_API_KEY: 'fixture-key' } })
    write('.dsh/profiles/web/cordis.patch.yml', 'x'.repeat(1024 * 1024 + 1))
    result = await discover()
    expect(result.providers.map(item => item.product)).toEqual(['Claude Code'])
    expect(result.issues).toEqual(['DeepSeek Harness'])
  })

  it('skips ambiguous catalog routes, unknown protocols, login plugins and credential-bearing URLs', async () => {
    write('.dsh/.credentials.yaml', { version: 1, refs: { FIXTURE_KEY: 'fixture-key' } })
    write('.dsh/profiles/web/cordis.patch.yml', [
      { id: 'llm-deepseek-account', config: { apiKeyEnv: 'FIXTURE_KEY' } },
      ...patch({
        catalog: { apiKeyEnv: 'FIXTURE_KEY' },
        unknown: { apiKeyEnv: 'FIXTURE_KEY', api: 'other-api', baseURL: 'https://example.com' },
        unsafe: { apiKeyEnv: 'FIXTURE_KEY', api: 'openai-completions', baseURL: 'https://example.com?key=fixture-key' },
      }),
    ])
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

describe('provider validation', () => {
  const base = {
    api_key: 'fixture-key-123456', base_url: 'https://example.com/anthropic',
    weworker_protocol: 'anthropic_messages' as const,
  }

  it('rejects malformed keys before any network call', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
    const result = await validateProviderConnection({ ...base, api_key: 'has space' }, fetchImpl)
    expect(result).toMatchObject({ ok: false, reason: 'format' })
    expect(called).toBe(false)
  })

  it('treats 401 as an invalid key and 200 as usable', async () => {
    const unauthorized = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect(await validateProviderConnection(base, unauthorized)).toMatchObject({ ok: false, reason: 'auth' })
    const ok = (async () => new Response('{"data":[]}')) as unknown as typeof fetch
    expect(await validateProviderConnection(base, ok)).toMatchObject({ ok: true })
  })

  it('does not reject a gateway that has no model listing endpoint', async () => {
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch
    expect(await validateProviderConnection(base, notFound)).toMatchObject({ ok: true })
  })

  it('marks network failures as unreachable', async () => {
    const failing = (async () => { throw new Error('connect ECONNREFUSED') }) as unknown as typeof fetch
    expect(await validateProviderConnection(base, failing)).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('never imports a source that failed validation', async () => {
    claude()
    const unauthorized = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const { providers } = await discoverLocalProviders({ home, env: {}, fetchImpl: unauthorized })
    expect(providers[0].validation).toMatchObject({ ok: false, reason: 'auth' })
    expect(importDiscoveredProviders(settings(), providers).imported).toEqual([])
  })
})

describe('connection grouping and legacy migration', () => {
  const buddyModels = (key = 'fixture-shared-key') => ['model-a', 'model-b'].map(id => ({
    id, apiKey: key, url: 'https://example.com/v1/chat/completions',
  }))

  it('groups models across apps by endpoint and key, keeping distinct keys and protocols', async () => {
    write('.codebuddy/models.json', { models: buddyModels() })
    write('.workbuddy/models.json', { models: [...buddyModels(), ...buddyModels('fixture-other-key'), {
      id: 'responses-model', apiKey: 'fixture-shared-key', api: 'openai-responses', url: 'https://example.com/v1',
    }] })
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const { providers } = await discoverLocalProviders({ home, env: {}, fetchImpl })
    expect(providers).toHaveLength(3)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(providers[0].configuration.custom_models).toEqual(['model-a', 'model-b'])
    expect(providers[0].legacySourceIds).toHaveLength(4)
    expect(new Set(providers.map(item => item.sourceId)).size).toBe(3)
    expect(JSON.stringify(publicDiscoveredProviders(settings(), providers))).not.toContain('fixture-shared-key')
  })

  it('adds newly discovered models without creating connections or changing selected models', async () => {
    write('.codebuddy/models.json', { models: buddyModels().slice(0, 1) })
    const first = importDiscoveredProviders(settings(), (await discover()).providers)
    const state = { ...settings(), ...first.updates }
    const id = first.imported[0]
    write('.codebuddy/models.json', { models: buddyModels().reverse() })
    const next = importDiscoveredProviders(state, (await discover()).providers)
    expect(next.imported).toEqual([])
    expect(next.updated).toBe(1)
    expect(next.updates.model_configurations![id].model).toBe('model-a')
    expect(next.updates.model_configurations![id].custom_models).toEqual(['model-a', 'model-b'])
    expect(importDiscoveredProviders({ ...state, ...next.updates }, (await discover()).providers).updates).toEqual({})
  })

  it('folds legacy entries into the active ID and keeps renamed or independently configured entries', async () => {
    write('.codebuddy/models.json', { models: buddyModels() })
    const providers = (await discover()).providers
    const item = providers[0]
    const legacy = (index: number) => ({ ...item.configuration, custom_models: undefined,
      name: index ? 'CodeBuddy (2)' : 'CodeBuddy', model: index ? 'model-b' : 'model-a',
      external_source_id: item.legacySourceIds![index],
    })
    const state = { ...settings(), active_model_configuration: 'old-b', model_configurations: {
      'old-a': legacy(0), 'old-b': legacy(1),
      renamed: { ...legacy(0), name: 'My connection' },
      tuned: { ...legacy(0), context_limit: 12345 },
    } }
    const result = importDiscoveredProviders(state, providers)
    expect(result.imported).toEqual([])
    expect(result.merged).toBe(1)
    expect(Object.keys(result.updates.model_configurations!)).toEqual(['old-b', 'renamed', 'tuned'])
    expect(result.updates.model_configurations!['old-b']).toMatchObject({ model: 'model-b', external_source_id: item.sourceId })
    expect(result.updates).not.toHaveProperty('active_model_configuration')
    expect(state.model_configurations).toHaveProperty('old-a')
  })

  it('reuses a manually saved connection and respects old and new dismissals', async () => {
    write('.codebuddy/models.json', { models: buddyModels() })
    const providers = (await discover()).providers
    const item = providers[0]
    const manual = { ...item.configuration, name: 'My endpoint', external_source_id: undefined, external_product: undefined }
    const result = importDiscoveredProviders({ ...settings(), model_configurations: { manual } }, providers)
    expect(result.imported).toEqual([])
    for (const id of [item.sourceId, item.legacySourceIds![0]]) {
      const state = { ...settings(), dismissed_model_sources: [id] }
      expect(importDiscoveredProviders(state, providers).imported).toEqual([])
      expect(importDiscoveredProviders(state, providers, true).imported).toHaveLength(1)
    }
  })

  it('groups Harness models across profiles into one connection', async () => {
    write('.dsh/.credentials.yaml', { version: 1, refs: { DEEPSEEK_API_KEY: 'fixture-harness-key' } })
    for (const profile of ['desktop', 'web']) write(`.dsh/profiles/${profile}/cordis.patch.yml`, [{
      id: 'llm-deepseek', config: { models: [{ id: 'model-a' }, { id: 'model-b' }] },
    }])
    const { providers } = await discover()
    expect(providers).toHaveLength(1)
    expect(providers[0].configuration.custom_models).toEqual(['model-a', 'model-b'])
    expect(providers[0].legacySourceIds).toHaveLength(4)
  })
})


it('does not let an old model-based source ID hide a different key on the same URL', async () => {
  write('.codebuddy/models.json', { models: [{ id: 'same-model', apiKey: 'fixture-new-key', url: 'https://example.com/v1/chat/completions' }] })
  const providers = (await discover()).providers
  const item = providers[0]
  const old = { ...item.configuration, api_key: 'fixture-old-key', external_source_id: item.legacySourceIds![0] }
  const result = importDiscoveredProviders({ ...settings(), model_configurations: { old } }, providers)
  expect(result.imported).toHaveLength(1)
  expect(result.updates.model_configurations!.old.api_key).toBe('fixture-old-key')
  expect(Object.values(result.updates.model_configurations!).map(c => c.api_key)).toEqual(['fixture-old-key', 'fixture-new-key'])
})
