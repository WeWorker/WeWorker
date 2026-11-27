import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import { BUILTIN_DEV_PROVIDER, BUILTIN_PROVIDER, activateBuiltinProvider, builtinProviderAccess, getBuiltinApiKey, publicBuiltinProviders, resolveBuiltinSettings } from '../builtin-provider.js'
import { getProvider, PROVIDERS } from '../provider-registry.js'
import { buildAnthropicAuthHeaders } from '../anthropic-auth.js'
import { listProviderModels, probeMainConnection, probeProviderProtocol } from '../provider-model-services.js'
import { resolveWebwrightModelConfig } from '../webwright-model-config.js'
import { createExplorationModelService } from '../exploration-model-settings.js'
import { resolveConversationModelSettings } from '../conversation-models.js'

const { fixtureEncryptionKey } = vi.hoisted(() => ({ fixtureEncryptionKey: Buffer.alloc(32, 0x5a) }))
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual,
    createDecipheriv: (algorithm: 'aes-256-gcm', _key: Buffer, iv: Buffer) => actual.createDecipheriv(algorithm, fixtureEncryptionKey, iv) }
})

// Both managed providers use synthetic addresses and credentials.
vi.mock('../provider-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../provider-config.js')>()
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const encrypt = (value: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', fixtureEncryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.')
  }
  const template = actual.configuredProvider('builtin')!
  const builtin = { ...template,
    weworker: { ...template.weworker, baseUrl: 'https://example.com/office' },
    webwright: { ...template.webwright, baseUrl: 'https://example.com/office/v1' } }
  const managed = { ...builtin, id: 'builtin_dev', name: 'Fixture managed provider',
    apiKeyEnv: 'WEWORKER_BUILTIN_DEV_API_KEY', baseUrlEnv: 'WEWORKER_BUILTIN_DEV_BASE_URL', authType: 'api_key' as const,
    models: ['fixture-dev-model'], defaultModel: 'fixture-dev-model',
    weworker: { ...builtin.weworker, baseUrl: 'https://example.com/managed' },
    webwright: { protocol: 'openai_chat_completions' as const, modelClass: 'openai_chat' as const,
      baseUrl: 'https://example.com/managed/v1', structuredOutput: 'openai_json_object' as const,
      baseUrlEnv: 'WEWORKER_BUILTIN_DEV_OPENAI_BASE_URL' } }
  const providers = [...actual.CONFIGURED_PROVIDERS.filter(p => !['builtin', 'builtin_dev'].includes(p.id)), builtin, managed]
  const credentials = new Map([['builtin', encrypt('fixture-embedded-builtin-key')], ['builtin_dev', encrypt('fixture-embedded-dev-key')]])
  return { ...actual, CONFIGURED_PROVIDERS: providers,
    configuredProvider: (id: string | undefined) => providers.find(p => p.id === id),
    configuredEncryptedApiKey: (id: string) => credentials.get(id) || '' }
})

const env = {
  WEWORKER_BUILTIN_API_KEY: 'fixture-builtin-key',
  WEWORKER_BUILTIN_DEV_API_KEY: 'fixture-dev-key',
  WEWORKER_BUILTIN_DEV_BASE_URL: 'https://example.org/runtime',
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('managed built-in models', () => {
  it('defaults every built-in context window to 200K and honors independent overrides', () => {
    const providers = [BUILTIN_PROVIDER, BUILTIN_DEV_PROVIDER]
    const limits = { builtin: 128000, builtin_dev: 512000 }
    const defaults = publicBuiltinProviders(providers, env)
    expect(defaults.builtin.context_limit).toBe(200000)
    expect(defaults.builtin_dev.context_limit).toBe(200000)
    expect(activateBuiltinProvider(BUILTIN_PROVIDER, env).context_limit).toBe(200000)
    const metadata = publicBuiltinProviders(providers, env, limits)
    for (const provider of providers) {
      const settings = { ...activateBuiltinProvider(provider, env), builtin_context_limits: limits } as Settings
      expect(metadata[provider.id].context_limit).toBe(limits[provider.id as keyof typeof limits])
      expect(resolveBuiltinSettings(settings, providers, env).context_limit).toBe(metadata[provider.id].context_limit)
    }
    expect(resolveBuiltinSettings({ ...activateBuiltinProvider(BUILTIN_PROVIDER, env), builtin_context_limits: { builtin: -1 } } as Settings, providers, env).context_limit).toBe(200000)
  })

  it('registers JSON gateways without exposing encrypted credentials', () => {
    expect(getProvider('builtin')).toEqual(BUILTIN_PROVIDER)
    expect(getProvider('builtin_dev')).toEqual(BUILTIN_DEV_PROVIDER)
    expect(getProvider('builtin_dev')?.weworker.baseUrl).toBeTruthy()
    expect(PROVIDERS.some(p => 'encryptedApiKey' in p)).toBe(false)
    expect(JSON.stringify(PROVIDERS)).not.toContain(env.WEWORKER_BUILTIN_API_KEY)
    expect(JSON.stringify(PROVIDERS)).not.toContain(env.WEWORKER_BUILTIN_DEV_BASE_URL)
  })

  it('reports embedded-provider availability without exposing either credential', () => {
    const providers = [BUILTIN_PROVIDER, BUILTIN_DEV_PROVIDER]
    expect(publicBuiltinProviders(providers, {})).toMatchObject({ builtin: { has_key: true, readonly: true }, builtin_dev: { has_key: true } })
    const ready = publicBuiltinProviders(providers, env)
    expect(ready.builtin.has_key).toBe(true)
    expect(ready.builtin_dev.has_key).toBe(true)
    for (const credential of [env.WEWORKER_BUILTIN_API_KEY, env.WEWORKER_BUILTIN_DEV_API_KEY,
      'fixture-embedded-builtin-key', 'fixture-embedded-dev-key']) {
      expect(JSON.stringify(ready)).not.toContain(credential)
    }
    expect(publicBuiltinProviders([], env)).toEqual({})
  })

  it('uses embedded credentials by default and accepts deployment overrides', () => {
    expect(getBuiltinApiKey('builtin', {})).not.toBe('')
    expect(getBuiltinApiKey('builtin_dev', {})).not.toBe('')
    expect(getBuiltinApiKey('builtin', env)).toBe(env.WEWORKER_BUILTIN_API_KEY)
    expect(builtinProviderAccess(BUILTIN_DEV_PROVIDER, { WEWORKER_BUILTIN_API_KEY: 'fixture-other-key' }).apiKey).not.toBe('')
    expect(builtinProviderAccess(BUILTIN_DEV_PROVIDER, { WEWORKER_BUILTIN_DEV_API_KEY: 'fixture-dev-key' }).apiKey).toBe('fixture-dev-key')
  })

  it('persists only the selection and resolves the fixed runtime values separately', () => {
    vi.stubEnv('WEWORKER_BUILTIN_API_KEY', env.WEWORKER_BUILTIN_API_KEY)
    const patch = activateBuiltinProvider(BUILTIN_PROVIDER, env)
    expect(patch.api_key).toBe('')
    const saved = { custom_auth_type: 'api_key', ...patch } as Settings
    const runtime = resolveBuiltinSettings(saved, PROVIDERS, env)
    expect(runtime.api_key).toBe(env.WEWORKER_BUILTIN_API_KEY)
    expect(runtime.model).toBe(BUILTIN_PROVIDER.defaultModel)
    expect(saved.api_key).toBe('')
    expect(resolveWebwrightModelConfig(runtime)).toMatchObject({
      provider_id: 'builtin', protocol: BUILTIN_PROVIDER.webwright.protocol,
      base_url: BUILTIN_PROVIDER.webwright.baseUrl, api_key: env.WEWORKER_BUILTIN_API_KEY,
    })
    expect(buildAnthropicAuthHeaders(runtime.api_key, 'builtin', 'api_key')).toEqual({ authorization: 'Bearer fixture-builtin-key' })
  })

  it('isolates deployment model keys and keeps profile exclusions closed', () => {
    const saved = { active_provider: 'builtin_dev', api_key: 'fixture-stale-key', base_url: 'https://example.org/stale' } as Settings
    expect(resolveBuiltinSettings(saved, [BUILTIN_DEV_PROVIDER], env)).toMatchObject({ api_key: 'fixture-dev-key', base_url: 'https://example.org/runtime' })
    expect(resolveBuiltinSettings(saved, PROVIDERS, env)).toMatchObject({ api_key: 'fixture-dev-key', base_url: 'https://example.org/runtime' })
    expect(resolveBuiltinSettings(saved, [BUILTIN_PROVIDER], env)).toMatchObject({ api_key: '', base_url: '', model: '' })
    expect(resolveBuiltinSettings({ ...saved, active_provider: 'builtin' }, PROVIDERS, {}).api_key).not.toBe('')
  })

  it.each(['openai_responses', 'openai_chat_completions'] as const)('replaces a stale %s protocol when selecting or loading a built-in', staleProtocol => {
    const patch = activateBuiltinProvider(BUILTIN_PROVIDER, env)
    expect(patch.active_weworker_protocol).toBe(BUILTIN_PROVIDER.weworker.protocol)
    const saved = { ...patch, active_weworker_protocol: staleProtocol } as Settings
    const runtime = resolveBuiltinSettings(saved, PROVIDERS, env)
    expect(runtime.active_weworker_protocol).toBe(BUILTIN_PROVIDER.weworker.protocol)
    expect(saved.active_weworker_protocol).toBe(staleProtocol)
    const custom = { ...saved, active_provider: 'custom' }
    expect(resolveBuiltinSettings(custom, PROVIDERS, env).active_weworker_protocol).toBe(staleProtocol)
  })

  it('preserves custom settings and ignores retired exploration overrides', () => {
    vi.stubEnv('WEWORKER_BUILTIN_API_KEY', env.WEWORKER_BUILTIN_API_KEY)
    const custom = { active_provider: 'custom', api_key: 'fixture-custom-key' } as Settings
    expect(resolveBuiltinSettings(custom, PROVIDERS, env)).toBe(custom)
    const runtime = resolveBuiltinSettings({ ...activateBuiltinProvider(BUILTIN_PROVIDER, env),
      exploration_base_url: 'https://example.org/v1', exploration_use_main_key: false,
      exploration_api_key: 'fixture-independent-key', exploration_model: 'fixture-independent-model',
    } as Settings, PROVIDERS, env)
    expect(resolveWebwrightModelConfig(runtime)).toMatchObject({ base_url: BUILTIN_PROVIDER.webwright.baseUrl, protocol: BUILTIN_PROVIDER.webwright.protocol, api_key: env.WEWORKER_BUILTIN_API_KEY, model: BUILTIN_PROVIDER.defaultModel })
  })

  it('probes both protocols with the deployment credential and redacts reflected errors', async () => {
    const input = builtinProviderAccess(BUILTIN_PROVIDER, env)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
      .mockResolvedValueOnce(new Response('invalid fixture-builtin-key', { status: 401 }))
    expect((await probeMainConnection(input, fetchMock)).ok).toBe(true)
    expect((await probeProviderProtocol({ ...input, target: 'webwright', verifyResponse: true }, fetchMock)).ok).toBe(true)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BUILTIN_PROVIDER.weworker.baseUrl}/v1/messages`, `${BUILTIN_PROVIDER.webwright.baseUrl}/chat/completions`,
    ])
    for (const [, init] of fetchMock.mock.calls) expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-builtin-key')
    const failure = await probeMainConnection(input, fetchMock)
    expect(failure.ok).toBe(false)
    expect(failure.detail).not.toContain('fixture-builtin-key')
  })

  const devSelection = { provider: 'builtin_dev', model: 'fixture-dev-model' }
  const devSettings = {
    active_provider: devSelection.provider, model: devSelection.model, api_key: 'fixture-stale-key',
    base_url: 'https://example.org/stale', builtin_context_limits: { builtin_dev: 256000 },
    compaction_ratio: 65, compaction_max_attempts: 5,
  } as unknown as Settings
  function stubDevDeployment(deployment: NodeJS.ProcessEnv) {
    for (const name of ['WEWORKER_BUILTIN_DEV_BASE_URL', 'WEWORKER_BUILTIN_DEV_OPENAI_BASE_URL', 'WEWORKER_BUILTIN_DEV_API_KEY']) {
      vi.stubEnv(name, deployment[name])
    }
  }

  it.each([
    { label: 'bundled routes', deployment: {}, mainBase: 'https://example.com/managed',
      workshopBase: 'https://example.com/managed/v1', key: 'fixture-embedded-dev-key' },
    { label: 'bundled address after normalization', deployment: { WEWORKER_BUILTIN_DEV_BASE_URL: ' https://example.com/managed/ ' },
      mainBase: 'https://example.com/managed', workshopBase: 'https://example.com/managed/v1', key: 'fixture-embedded-dev-key' },
    { label: 'separate deployment routes', deployment: { ...env, WEWORKER_BUILTIN_DEV_OPENAI_BASE_URL: ' https://example.net/openai/api/ ' },
      mainBase: 'https://example.org/runtime', workshopBase: 'https://example.net/openai/api', key: 'fixture-dev-key' },
  ])('resolves the managed provider consistently across chat, Workshop and status with $label', async ({ deployment, mainBase, workshopBase, key }) => {
    stubDevDeployment(deployment)
    expect(resolveConversationModelSettings(devSettings, devSelection)).toMatchObject({
      active_weworker_protocol: 'anthropic_messages', base_url: mainBase, api_key: key,
    })
    expect(resolveWebwrightModelConfig(devSettings)).toMatchObject({
      provider_id: 'builtin_dev', protocol: 'openai_chat_completions', model_class: 'openai_chat',
      base_url: workshopBase, base_url_is_full: false, api_key: key, model: devSelection.model,
      context_limit: 256000, compaction_ratio: 65, compaction_max_attempts: 5,
    })
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }))
    const service = createExplorationModelService(fetchMock)
    expect(await service.check(devSettings, true)).toMatchObject({ ok: true, protocol: 'openai_chat_completions' })
    const status = service.status(devSettings, 'builtin_dev')
    expect(status).toMatchObject({ status: 'connected', base_url: workshopBase,
      candidate_url: workshopBase, configured_base_url: workshopBase, has_key: true })
    expect(status.providers.find(provider => provider.id === 'builtin_dev')).toMatchObject({
      base_url: workshopBase, configured: true, has_key: true, auth_type: 'auth_token',
    })
    expect(JSON.stringify(status)).not.toContain(key)
    const [[endpoint, request]] = fetchMock.mock.calls
    expect(endpoint).toBe(`${workshopBase}/chat/completions`)
    expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${key}`)
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: devSelection.model, response_format: { type: 'json_object' } })
  })

  it.each([
    { label: 'missing Workshop override for a changed chat gateway', deployment: env, key: 'fixture-dev-key' },
    { label: 'full request endpoint in a Workshop override', deployment: { ...env, WEWORKER_BUILTIN_DEV_OPENAI_BASE_URL: 'https://example.net/v1/chat/completions' }, key: 'fixture-dev-key' },
    { label: 'separate Workshop route with an embedded key', deployment: { WEWORKER_BUILTIN_DEV_OPENAI_BASE_URL: 'https://example.net/v1' }, key: 'fixture-embedded-dev-key' },
  ])('keeps chat available and disables Workshop with $label', async ({ deployment, key }) => {
    stubDevDeployment(deployment)
    const input = builtinProviderAccess(BUILTIN_DEV_PROVIDER)
    expect(input.apiKey).toBe(key)
    expect(input.openaiBaseUrl).toBe('')
    expect(() => resolveWebwrightModelConfig(devSettings)).toThrow(/OpenAI/)
    const fetchMock = vi.fn<typeof fetch>()
    const service = createExplorationModelService(fetchMock)
    await expect(service.check(devSettings)).rejects.toThrow(/OpenAI/)
    expect(await probeProviderProtocol({ ...input, target: 'webwright' }, fetchMock)).toMatchObject({ ok: false, error: 'not_configured' })
    expect(await listProviderModels({ ...input, target: 'webwright' }, fetchMock)).toEqual({ models: [devSelection.model], source: 'fallback' })
    expect(fetchMock).not.toHaveBeenCalled()
    const status = service.status(devSettings)
    expect(status).toMatchObject({ status: 'pending', base_url: '', candidate_url: '', has_key: false })
    expect(status.providers.find(provider => provider.id === 'builtin_dev')).toMatchObject({ base_url: '', configured: false, has_key: false })
  })

  it('refuses to reuse an embedded key or caller-supplied gateway for a different chat deployment', () => {
    const deployment = { WEWORKER_BUILTIN_DEV_BASE_URL: env.WEWORKER_BUILTIN_DEV_BASE_URL }
    const supplied = { ...BUILTIN_DEV_PROVIDER,
      weworker: { ...BUILTIN_DEV_PROVIDER.weworker, baseUrl: 'https://example.org/runtime' } }
    expect(getBuiltinApiKey('builtin_dev', deployment)).toBe('')
    expect(publicBuiltinProviders([BUILTIN_DEV_PROVIDER], deployment).builtin_dev.has_key).toBe(false)
    expect(() => builtinProviderAccess(supplied, deployment)).toThrow(/尚未配置/)
    expect(builtinProviderAccess(supplied, {}).anthropicBaseUrl).toBe('https://example.com/managed')
    expect(resolveBuiltinSettings(devSettings, PROVIDERS, deployment)).toMatchObject({ api_key: '', base_url: '', model: '' })
  })

  it('omits reflected deployment addresses and credentials from Workshop probe errors', async () => {
    stubDevDeployment({ ...env, WEWORKER_BUILTIN_DEV_OPENAI_BASE_URL: 'https://example.net/v1' })
    const input = builtinProviderAccess(BUILTIN_DEV_PROVIDER)
    const reflected = `${input.openaiBaseUrl} ${input.apiKey}`
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(reflected, { status: 404 }))
      .mockRejectedValueOnce(new Error(reflected))
    expect(await probeProviderProtocol({ ...input, target: 'webwright' }, fetchMock))
      .toMatchObject({ ok: false, error: 'endpoint_missing', detail: 'HTTP 404' })
    expect(await createExplorationModelService(fetchMock).check(devSettings))
      .toMatchObject({ ok: false, error: 'network_error', detail: '连接失败' })
  })

  it('does not reinsert built-ins excluded by a build profile', async () => {
    vi.doUnmock('../provider-config.js')
    vi.stubGlobal('__BUILD_PROVIDERS__', [])
    vi.resetModules()
    const registry = await import('../provider-registry.js')
    expect(registry.PROVIDERS).toEqual([])
    expect(registry.getProvider('builtin')).toBeUndefined()
  })
})
