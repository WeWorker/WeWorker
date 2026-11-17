import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Express } from 'express'
import type { Settings } from '../config.js'
import { EXPLORATION_ATTACHMENT_BYTES, readExplorationAttachments } from '../exploration-attachments.js'
import { resolveWebwrightModelConfig } from '../webwright-model-config.js'
import { createExplorationModelService, registerExplorationModelRoutes } from '../exploration-model-settings.js'
import { applySecrets, clearSecretsOnDisk, extractSecrets } from '../settings-secrets.js'

function settings(): Settings {
  return { active_provider: 'glm', api_key: 'placeholder-main-key', model: 'example-main', context_limit: 200000,
    exploration_base_url: '', exploration_model: '', exploration_use_main_key: true,
    model_configurations: { 'example-config': { provider_id: 'custom', name: 'Example', api_key: 'placeholder-main-config-key', openai_api_key: 'placeholder-exploration-key',
      model: 'example-chat', openai_model: 'example-explorer', base_url: 'https://example.com/anthropic', openai_base_url: 'https://example.com/anthropic/v1/messages',
      openai_base_url_is_full: true, context_limit: 128000, auth_type: 'api_key' } },
  } as unknown as Settings
}

describe('exploration composer configuration', () => {
  it('lists named exploration configurations using their settings names and excludes chat-only entries', () => {
    const saved = settings()
    saved.model_configurations!['chat-only'] = { ...saved.model_configurations!['example-config'], name: 'Chat only' }
    saved.exploration_providers = { 'example-config': { api_key: 'placeholder-explore-key', model: 'explorer',
      base_url: 'https://example.org/explore', protocol: 'anthropic_messages', auth_type: 'api_key' } }
    const before = structuredClone(saved)
    const data = createExplorationModelService().status(saved)
    expect(data.providers.find(item => item.id === 'example-config')).toMatchObject({ name: 'Example', configured: true, model: 'explorer' })
    expect(data.providers.find(item => item.id === 'chat-only')).toMatchObject({ name: 'Chat only', configured: false })
    expect(data.providers.find(item => item.id === 'builtin')).toMatchObject({ selection_provider: 'builtin', configured: true })
    expect(JSON.stringify(data)).not.toContain('placeholder-')
    expect(saved).toEqual(before)
    expect(resolveWebwrightModelConfig({ ...saved, exploration_model_selection: { provider: '__exploration__:example-config', model: 'session-model' } }))
      .toMatchObject({ base_url: 'https://example.org/explore', api_key: 'placeholder-explore-key', protocol: 'anthropic_messages', model: 'session-model' })
  })
  it.each(['anthropic_messages', 'openai_chat_completions', 'openai_responses'] as const)('saves a named %s exploration connection independently and catalogs it with the same credentials', async protocol => {
    let saved = settings()
    const before = structuredClone(saved)
    const handlers = new Map<string, Function>(), calls: { url: unknown; options?: RequestInit }[] = []
    saved.model_configurations!['example-config'].models_url = 'https://example.com/chat-only-catalog'
    before.model_configurations!['example-config'].models_url = 'https://example.com/chat-only-catalog'
    registerExplorationModelRoutes({ get: (p: string, h: Function) => handlers.set('GET ' + p, h), post: (p: string, h: Function) => handlers.set(p, h) } as unknown as Express,
      { getSettings: () => saved, updateSettings: patch => (saved = { ...saved, ...patch }), fetchImpl: async (url, options) => {
        calls.push({ url, options })
        if (!options?.body) return Response.json({ data: [{ id: 'explorer-next' }] })
        return Response.json(protocol === 'anthropic_messages' ? { content: [{ type: 'text', text: '{"ok":true}' }] }
          : protocol === 'openai_responses' ? { output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }] }
          : { choices: [{ message: { content: '{"ok":true}' } }] })
      } })
    let data: any, status = 200
    const res = { json(value: unknown) { data = value; return this }, status(code: number) { status = code; return this } }
    await handlers.get('/settings/exploration-model')!({ body: { configuration: 'example-config', base_url: 'https://example.org/explore',
      base_url_is_full: false, use_main_key: false, api_key: 'placeholder-independent-key', model: 'explorer', protocol, auth_type: 'api_key' } }, res)
    expect(status).toBe(200)
    expect(data).toMatchObject({ ok: true, configuration_id: 'example-config', configured_model: 'explorer', configured_base_url: 'https://example.org/explore' })
    expect(saved).toEqual({ ...before, exploration_providers: { 'example-config': expect.objectContaining({ model: 'explorer', key_source: 'example-config', protocol }) } })
    expect(calls[0].url).toBe('https://example.org/explore' + (protocol === 'anthropic_messages' ? '/v1/messages' : protocol === 'openai_responses' ? '/responses' : '/chat/completions'))
    expect(JSON.parse(String(calls[0].options?.body)).model).toBe('explorer')
    expect(JSON.stringify(data)).not.toContain('placeholder-')
    handlers.get('GET /settings/exploration-model')!({ query: { configuration: 'builtin' } }, res)
    expect(data).toMatchObject({ builtin: true, main_model: 'ark-code-latest' })
    expect(data.configured_base_url).not.toBe('https://example.org/explore')
    const snapshot = structuredClone(saved)
    await handlers.get('/settings/exploration-model/models')!({ body: { provider: '__exploration__:example-config', model: 'explorer' } }, res)
    expect(data.models).toContain('explorer-next')
    expect(calls[1].url).toBe('https://example.org/explore' + (protocol === 'anthropic_messages' ? '/v1/models?limit=1000' : '/models'))
    const headers = new Headers(calls[1].options?.headers)
    expect(headers.get('x-api-key') || headers.get('authorization')?.replace(/^Bearer /, '')).toBe('placeholder-independent-key')
    expect(saved).toEqual(snapshot)
    const restored = applySecrets(clearSecretsOnDisk(saved), extractSecrets(saved))
    expect(restored.exploration_providers!['example-config']).toEqual(saved.exploration_providers!['example-config'])
    expect(extractSecrets(restored)).toEqual(extractSecrets(saved))
    expect(JSON.stringify(clearSecretsOnDisk(saved))).not.toContain('placeholder-independent-key')
  })

  it('binds reuse of the main key to the named configuration, regardless of the active chat provider', () => {
    const saved = settings()
    saved.exploration_providers = { 'example-config': { api_key: '', use_main_key: true, key_source: 'example-config', model: 'explorer',
      base_url: 'https://example.org/explore', protocol: 'anthropic_messages', auth_type: 'api_key' } }
    const selection = { provider: '__exploration__:example-config', model: 'session-model' }
    expect(resolveWebwrightModelConfig({ ...saved, exploration_model_selection: selection }).api_key).toBe('placeholder-main-config-key')
    expect(resolveWebwrightModelConfig({ ...saved, active_provider: 'deepseek', api_key: 'placeholder-another-key', exploration_model_selection: selection }).api_key).toBe('placeholder-main-config-key')
  })
  it('uses the selected builtin window without inheriting another providers default window', () => {
    const initial = { ...settings(), context_limit: 1000000, exploration_model_selection: { provider: 'builtin', model: 'ignored' } }
    expect(resolveWebwrightModelConfig(initial).context_limit).toBe(200000)
    expect(resolveWebwrightModelConfig({ ...initial, builtin_context_limits: { builtin: 128000 } }).context_limit).toBe(128000)
  })
  it('resolves and checks a conversation selection without saving either default', async () => {
    const saved = settings(), before = structuredClone(saved)
    let writes = 0
    const handlers = new Map<string, Function>(), calls: any[] = []
    registerExplorationModelRoutes({ get() {}, post: (p: string, h: Function) => handlers.set(p, h) } as unknown as Express,
      { getSettings: () => saved, updateSettings: () => { writes++; return saved }, fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(String(options?.body)) })
        return Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] })
      } })
    let data: any
    const res = { json(value: unknown) { data = value; return this }, status() { return this } }
    const selection = { provider: 'example-config', model: 'session-example', thinking_effort: 'high' }
    await handlers.get('/settings/exploration-model/resolve')!({ body: { selection } }, res)
    expect(data).toMatchObject({ selection, effective_model: 'session-example', context_limit: 128000 })
    await handlers.get('/settings/exploration-model/check')!({ body: { selection } }, res)
    expect(data.ok).toBe(true)
    expect(calls[0]).toMatchObject({ url: 'https://example.com/anthropic/v1/messages', body: { model: 'session-example' } })
    expect(writes).toBe(0)
    expect(saved).toEqual(before)
  })
  it('selects the conversation endpoint, key, model and context without mutating main chat', () => {
    const saved = settings()
    const original = structuredClone(saved)
    const config = resolveWebwrightModelConfig({ ...saved, exploration_model_selection: { provider: 'example-config', model: 'example-new' }, exploration_thinking_effort: 'high' })
    expect(config).toMatchObject({ base_url: 'https://example.com/anthropic', protocol: 'anthropic_messages', api_key: 'placeholder-main-config-key', model: 'example-new', context_limit: 128000, thinking_effort: 'high' })
    expect(saved).toEqual(original)
  })

  it('persists selection through the settings route and returns no credentials', () => {
    let saved = settings()
    const handlers = new Map<string, Function>()
    registerExplorationModelRoutes({ get() {}, post(route: string, handler: Function) { handlers.set(route, handler) } } as unknown as Express,
      { getSettings: () => saved, updateSettings: patch => (saved = { ...saved, ...patch }) })
    let response: any
    let status = 200
    const res = { json(value: unknown) { response = value; return this }, status(code: number) { status = code; return this } }
    handlers.get('/settings/exploration-model/selection')!({ body: { provider: 'example-config', model: 'example-picked', thinking_effort: 'medium' } }, res)
    expect(status).toBe(200)
    expect(response).toMatchObject({ selected_provider: 'example-config', effective_model: 'example-picked', context_limit: 128000, thinking_effort: 'medium' })
    expect(saved.active_provider).toBe('glm')
    expect(saved.model).toBe('example-main')
    expect(JSON.stringify(response)).not.toContain('placeholder-')
    const before = structuredClone(saved)
    handlers.get('/settings/exploration-model/selection')!({ body: { provider: 'missing', model: 'example' } }, res)
    expect(status).toBe(400)
    expect(saved).toEqual(before)
    handlers.get('/settings/exploration-model/selection')!({ body: { thinking_effort: 'invalid' } }, res)
    expect(status).toBe(400)
    expect(saved).toEqual(before)
  })

})

describe('exploration menu model probes', () => {
  function harness(initial = settings(), fetchImpl: typeof fetch = async () => Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] })) {
    let saved = initial
    let writes = 0
    const handlers = new Map<string, Function>()
    registerExplorationModelRoutes({ get() {}, post(route: string, handler: Function) { handlers.set(route, handler) } } as unknown as Express,
      { getSettings: () => saved, updateSettings: patch => { writes++; return (saved = { ...saved, ...patch }) }, fetchImpl })
    return {
      get saved() { return saved }, get writes() { return writes },
      replace(value: Settings) { saved = value },
      async probe(body: unknown) {
        let status = 200, data: any
        const res = { json(value: unknown) { data = value; return this }, status(code: number) { status = code; return this } }
        await handlers.get('/settings/exploration-model/probe')!({ body }, res)
        return { status, data }
      },
    }
  }

  it('probes only the requested model with the conversation endpoint/key and never changes settings', async () => {
    const calls: any[] = []
    const saved = settings()
    const before = structuredClone(saved)
    const api = harness(saved, async (url, options) => {
      calls.push({ url, headers: options?.headers, body: JSON.parse(String(options?.body)) })
      return Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] })
    })
    const { status, data } = await api.probe({ provider: 'example-config', model: 'example-candidate' })
    expect(status).toBe(200)
    expect(data).toMatchObject({ ok: true, target: 'webwright', model: 'example-candidate' })
    expect(data.elapsed_ms).toBeGreaterThan(0)
    expect(data.checked_at).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: 'https://example.com/anthropic/v1/messages', headers: { 'x-api-key': 'placeholder-main-config-key' },
      body: { model: 'example-candidate', output_config: { format: { type: 'json_schema' } } } })
    expect(api.saved).toEqual(before)
    expect(api.writes).toBe(0)
    expect(JSON.stringify(data)).not.toContain('placeholder-')
  })

  it('rejects retired independent selections without contacting their endpoint or changing settings', async () => {
    const saved = { ...settings(), exploration_base_url: 'https://example.org/old', exploration_api_key: 'placeholder-old-key' }
    const api = harness(saved, async () => { throw new Error('must not request') })
    const result = await api.probe({ provider: '__independent__', model: 'example' })
    expect(result.status).toBe(400)
    expect(result.data.detail).toContain('统一使用对话接口')
    expect(api.writes).toBe(0)
  })

  it('rejects invalid selections before making any model request', async () => {
    const api = harness(settings(), async () => { throw new Error('must not request') })
    for (const body of [{}, { provider: 'example-config', model: '' }, { provider: 'missing', model: 'example' }, { provider: '__independent__', model: 'example' }]) {
      expect((await api.probe(body)).status).toBe(400)
    }
    expect(api.writes).toBe(0)
  })

  it('preserves provider failures without activating the failed model', async () => {
    const api = harness(settings(), async () => Response.json({ error: { message: 'Example failure' } }, { status: 503 }))
    const result = await api.probe({ provider: 'example-config', model: 'example-failed' })
    expect(result.data).toMatchObject({ ok: false, model: 'example-failed' })
    expect(api.writes).toBe(0)
    expect(api.saved.model).toBe('example-main')
  })

  it('rejects a stale result when the exploration connection changes during detection', async () => {
    let release!: (response: Response) => void
    const api = harness(settings(), () => new Promise(resolve => { release = resolve }))
    const pending = api.probe({ provider: 'example-config', model: 'example-candidate' })
    api.replace({ ...api.saved, model_configurations: { ...api.saved.model_configurations,
      'example-config': { ...api.saved.model_configurations!['example-config'], api_key: 'placeholder-replaced-key' } } })
    release(Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] }))
    expect((await pending).status).toBe(409)
    expect(api.writes).toBe(0)
  })

  it('invalidates menu results only when the actual connection changes', () => {
    const service = createExplorationModelService()
    const saved = { ...settings(), exploration_model_selection: { provider: 'example-config', model: 'example-first' } }
    const scope = service.status(saved).health_scope
    expect(scope).toMatch(/^[a-f0-9]{64}$/)
    expect(service.status({ ...saved, exploration_thinking_effort: 'high', exploration_model_selection: { provider: 'example-config', model: 'example-next' } }).health_scope).toBe(scope)
    const changed = structuredClone(saved)
    changed.model_configurations!['example-config'].api_key = 'placeholder-new-key'
    expect(service.status(changed).health_scope).not.toBe(scope)
  })
})

describe('exploration attachment transport', () => {
  it('transports bytes and basename without forwarding the host path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exploration-file-'))
    try {
      const file = path.join(dir, 'example.txt')
      const bytes = Buffer.from('示例文档\n\x00binary')
      await fs.writeFile(file, bytes)
      const files = await readExplorationAttachments([{ path: file, name: '../spoofed' }], 2)
      expect(files).toEqual([{ name: 'example.txt', data: bytes.toString('base64') }])
      expect(JSON.stringify(files)).not.toContain(dir)
      await expect(readExplorationAttachments([{ path: dir }], 2)).rejects.toThrow('必须是文件')
      await expect(readExplorationAttachments([{ path: file }], 0)).rejects.toThrow('最多')
      await fs.truncate(file, EXPLORATION_ATTACHMENT_BYTES + 1)
      await expect(readExplorationAttachments([{ path: file }], 2)).rejects.toThrow('20 MB')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('rejects malformed input rather than passing arbitrary encoded files through', async () => {
    await expect(readExplorationAttachments([{ name: 'example.txt', data: 'payload' }], 1)).rejects.toThrow('本地文件')
    await expect(readExplorationAttachments([{ path: 'relative.txt' }], 1)).rejects.toThrow('本地文件')
    await expect(readExplorationAttachments('file', 1)).rejects.toThrow('最多')
  })
})
