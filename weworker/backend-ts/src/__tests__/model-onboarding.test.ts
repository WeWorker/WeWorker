import express from 'express'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import { getProvider } from '../provider-registry.js'
import { listProviderModels, probeMainConnection } from '../provider-model-services.js'
import { createExplorationModelService, registerExplorationModelRoutes } from '../exploration-model-settings.js'

const settings = (patch: Partial<Settings> = {}) => ({
  active_provider: 'custom', api_key: 'fixture-main-key', model: 'fixture-model',
  base_url_custom: 'https://example.com/proxy', weworker_protocol_custom: 'openai_chat_completions', openai_base_url_custom: '',
  exploration_base_url: '', exploration_api_key: '', exploration_model: '', exploration_use_main_key: true,
  ...patch,
} as Settings)
const chatResponse = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
const toolResponse = () => Response.json({ content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }] })
const anthropicTextResponse = () => Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] })
const mainInput = () => ({ provider: getProvider('custom')!, apiKey: 'fixture-main-key', model: 'fixture-model', anthropicBaseUrl: 'https://example.com/proxy', autoAuth: true })
const configuredSettings = (id: string, baseUrl: string) => settings({
  active_model_configuration: id,
  model_configurations: {
    [id]: { provider_id: 'custom', api_key: 'fixture-main-key', model: 'fixture-model',
      base_url: baseUrl, weworker_protocol: 'openai_chat_completions', openai_base_url: '', context_limit: 1000000, auth_type: 'api_key' },
  },
})

describe('main model onboarding', () => {
  it('preserves a complete endpoint through protocol verification and automatic authentication retry', async () => {
    const endpoint = 'https://example.com/custom/inference/?version=1&route=a%2Fb'
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('invalid key', { status: 401 })).mockResolvedValueOnce(toolResponse())
    expect(await probeMainConnection({ ...mainInput(), anthropicBaseUrl: endpoint, anthropicFullUrl: true }, fetchMock))
      .toMatchObject({ ok: true, auth_type: 'api_key' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([endpoint, endpoint])
    expect(fetchMock.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true)
  })

  it('lists models only through an explicitly configured base URL when the other protocol uses a complete URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
    const input = { ...mainInput(), anthropicBaseUrl: 'https://example.com/inference/?version=1', anthropicFullUrl: true,
      openaiBaseUrl: 'https://example.org/v1', openaiFullUrl: false }
    expect(await listProviderModels(input, fetchMock)).toEqual({ models: ['fixture-model'], source: 'remote' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://example.org/v1/models'])
  })

  it('verifies a tool call using only the Claude Code address', async () => {
    const fetchMock = vi.fn(async () => toolResponse())
    expect(await probeMainConnection(mainInput(), fetchMock)).toMatchObject({ ok: true, auth_type: 'auth_token' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/proxy/v1/messages')
    expect(JSON.parse(options.body as string).tool_choice).toEqual({ type: 'tool', name: 'connection_check' })
    expect(JSON.parse(options.body as string)).toMatchObject({ max_tokens: 1024 })
    expect(JSON.parse(options.body as string).messages[0].content).toMatch(/call.*connection_check/i)
    expect(JSON.parse(options.body as string).tools[0].input_schema).toEqual({
      type: 'object', properties: { status: { type: 'string', enum: ['ok'] } },
      required: ['status'], additionalProperties: false,
    })
    expect(options.redirect).toBe('error')
  })

  it('reports a truncated tool probe instead of declaring the model incompatible or available', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }],
    }))
    const result = await probeMainConnection(mainInput(), fetchMock)
    expect(result).toMatchObject({ ok: false, error: 'protocol_mismatch' })
    expect(result.detail).toContain('输出上限')
    expect(result.detail).not.toContain('不支持')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([{ status: true }, { raw_arguments: '{"status":' }, { status: 'failed' }, { status: 'ok</true>\n' }, { ok: 'true' }, {}])('rejects malformed tool confirmation %j without coercion', async input => {
    const fetchMock = vi.fn(async () => Response.json({
      stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'connection_check', input }],
    }))
    const result = await probeMainConnection(mainInput(), fetchMock)
    expect(result).toMatchObject({ ok: false, error: 'protocol_mismatch' })
    expect(result.detail).toContain('完整工具调用')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a confirmation returned by the wrong tool', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'different_tool', input: { status: 'ok' } }],
    }))
    expect(await probeMainConnection(mainInput(), fetchMock)).toMatchObject({ ok: false, error: 'protocol_mismatch' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries without tools when a thinking model rejects tool_choice', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('tool_choice is not supported in thinking mode', { status: 400 }))
      .mockResolvedValueOnce(Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] }))

    expect(await probeMainConnection(mainInput(), fetchMock)).toMatchObject({ ok: true, auth_type: 'auth_token' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
    expect(firstBody.tool_choice).toEqual({ type: 'tool', name: 'connection_check' })
    expect(retryBody).not.toHaveProperty('tools')
    expect(retryBody).not.toHaveProperty('tool_choice')
  })

  it('retries the other auth header only after an authentication failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('invalid key', { status: 401 })).mockResolvedValueOnce(toolResponse())
    expect(await probeMainConnection(mainInput(), fetchMock)).toMatchObject({ ok: true, auth_type: 'api_key' })
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('x-api-key')).toBe('fixture-main-key')
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('authorization')).toBe(false)
  })

  it.each([404, 429, 500])('does not rotate auth on HTTP %s', async status => {
    const fetchMock = vi.fn(async () => new Response('failure', { status }))
    expect((await probeMainConnection(mainInput(), fetchMock)).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honors an explicit auth choice and redacts reflected keys', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid fixture-main-key', { status: 401 }))
    const result = await probeMainConnection({ ...mainInput(), autoAuth: false }, fetchMock)
    expect(result.detail).not.toContain('fixture-main-key')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['{}', '<html>OK</html>', '{"content":[{"type":"text","text":"hello"}]}'])('rejects false positive HTTP success: %s', async body => {
    expect(await probeMainConnection(mainInput(), vi.fn(async () => new Response(body)))).toMatchObject({ ok: false, error: 'protocol_mismatch' })
  })

  it('probes DeepSeek main models without forced tool_choice', async () => {
    const fetchMock = vi.fn(async () => anthropicTextResponse())
    expect(await probeMainConnection({
      provider: getProvider('deepseek')!,
      apiKey: 'fixture-deepseek-key',
      model: 'deepseek-v4-flash',
    }, fetchMock)).toMatchObject({ ok: true, protocol: 'anthropic_messages', model: 'deepseek-v4-flash' })
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    const body = JSON.parse(options.body as string)
    expect(body).toMatchObject({ model: 'deepseek-v4-flash' })
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('tools')
  })

  it('falls back to a text probe when a custom Anthropic endpoint rejects tool_choice', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        error: {
          message: 'Thinking mode does not support this tool_choice',
          type: 'invalid_request_error',
        },
      }, { status: 400 }))
      .mockResolvedValueOnce(anthropicTextResponse())

    expect(await probeMainConnection(mainInput(), fetchMock)).toMatchObject({ ok: true, auth_type: 'auth_token' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
    expect(firstBody.tool_choice).toEqual({ type: 'tool', name: 'connection_check' })
    expect(secondBody).not.toHaveProperty('tool_choice')
    expect(secondBody).not.toHaveProperty('tools')
  })

  it('treats a custom DeepSeek Anthropic base url like the built-in provider', async () => {
    const fetchMock = vi.fn(async () => anthropicTextResponse())
    expect(await probeMainConnection({
      ...mainInput(),
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    }, fetchMock)).toMatchObject({ ok: true, auth_type: 'api_key' })

    const [_url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(options.headers)
    const body = JSON.parse(options.body as string)
    expect(headers.get('x-api-key')).toBe('fixture-main-key')
    expect(headers.has('authorization')).toBe(false)
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('tools')
  })
})

describe('exploration connection preparation', () => {
  it('passes through a complete OpenAI endpoint and rechecks after changing its URL mode', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => chatResponse())
    const service = createExplorationModelService(fetchMock)
    const full = settings({ base_url_custom: 'https://example.com/inference', base_url_is_full_custom: true })
    await service.check(full)
    expect(service.status(full)).toMatchObject({ status: 'connected', base_url_is_full: true })
    const base = { ...full, base_url_is_full_custom: false }
    expect(service.status(base).status).toBe('pending')
    await service.check(base)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/inference', 'https://example.com/inference/chat/completions',
    ])
  })

  it.each(['switch', 'edit'])('invalidates a verified address after a configuration %s with the same model and key', async change => {
    const fetchMock = vi.fn<typeof fetch>(async () => chatResponse())
    const service = createExplorationModelService(fetchMock)
    const first = configuredSettings('model-fixture-a', 'https://example.com/first')
    const second = configuredSettings(change === 'switch' ? 'model-fixture-b' : 'model-fixture-a', 'https://example.org/second')
    await service.check(first)
    expect(service.status(first).status).toBe('connected')
    expect(service.status(second).status).toBe('pending')
    await service.check(second)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/first/chat/completions', 'https://example.org/second/chat/completions',
    ])
    expect(service.status(second).status).toBe('connected')
  })

  it('keeps status readable when the active configuration cannot be resolved', async () => {
    const service = createExplorationModelService(vi.fn(async () => chatResponse()))
    await service.check(settings())
    expect(service.status(configuredSettings('model-fixture-a', 'file:///tmp/fixture')).status).toBe('pending')
    expect(service.status(settings({ api_key: '' })).status).toBe('pending')
  })

  it('reuses the exact address, deduplicates checks and invalidates success after model or key changes', async () => {
    const fetchMock = vi.fn(async () => chatResponse())
    const service = createExplorationModelService(fetchMock)
    await Promise.all([service.check(settings()), service.check(settings())])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://example.com/proxy/chat/completions')
    await service.check(settings())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await service.check(settings({ model: 'other-model' }))
    await service.check(settings({ api_key: 'fixture-changed-key' }))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(service.status(settings()))).not.toContain('fixture-main-key')
  })

  it.each(['{}', '<html>OK</html>', '{"choices":[{"message":{"content":"{}"}}]}'])('rejects invalid structured responses: %s', async body => {
    const service = createExplorationModelService(vi.fn(async () => new Response(body)))
    expect(await service.check(settings())).toMatchObject({ ok: false, error: 'protocol_mismatch' })
    expect(service.status(settings()).status).toBe('pending')
  })

  it.each([['TimeoutError', 'timeout'], ['TypeError', 'network_error']])('keeps %s distinct from protocol errors and allows retry', async (name, error) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(Object.assign(new Error('fixture connection failed'), { name })).mockResolvedValueOnce(chatResponse())
    const service = createExplorationModelService(fetchMock)
    expect(await service.check(settings())).toMatchObject({ ok: false, error })
    expect(await service.check(settings())).toMatchObject({ ok: true })
  })

})

async function withRoutes(upstream: typeof fetch, run: (url: string, get: () => Settings, set: (patch: Partial<Settings>) => void) => Promise<void>) {
  let current = settings()
  const app = express()
  app.use(express.json())
  registerExplorationModelRoutes(app, { getSettings: () => current, updateSettings: patch => (current = { ...current, ...patch }), fetchImpl: upstream })
  const server = app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/exploration-model`, () => current, patch => { current = { ...current, ...patch } })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('exploration settings API', () => {
  it('rejects legacy independent configuration writes without sending or saving anything', async () => {
    const upstream = vi.fn<typeof fetch>(async () => chatResponse())
    await withRoutes(upstream, async (url, get) => {
      const before = structuredClone(get())
      const response = await post(url, { base_url: 'https://example.org/custom', use_main_key: true, model: '' })
      expect(response.status).toBe(400)
      expect((await response.json()).detail).toContain('统一使用对话接口')
      expect(get()).toEqual(before)
      expect(upstream).not.toHaveBeenCalled()
    })
  })

  it.each([
    ['check', 'switch'], ['check', 'edit'],
  ])('rejects an in-flight %s after a configuration address %s', async (action, change) => {
    let release!: (value: Response) => void
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const upstream = vi.fn(() => { started(); return new Promise<Response>(resolve => { release = resolve }) })
    await withRoutes(upstream, async (url, get, set) => {
      set(configuredSettings('model-fixture-a', 'https://example.com/first'))
      const response = post(`${url}/check`, {})
      await start
      set(configuredSettings(change === 'switch' ? 'model-fixture-b' : 'model-fixture-a', 'https://example.org/second'))
      release(chatResponse())
      expect((await response).status).toBe(409)
      expect(get().exploration_base_url).toBe('')
      expect(await (await fetch(url)).json()).toMatchObject({ status: 'pending' })
    })
  })

  it('keeps incomplete shared configuration readable without persisting or verifying it', async () => {
    const upstream = vi.fn(async () => chatResponse())
    await withRoutes(upstream, async (url, get, set) => {
      set({ api_key: '', model: '' })
      const before = { ...get() }
      const data = await (await fetch(url)).json()
      expect(data).toMatchObject({ base_url: '', status: 'pending' })
      expect(data).not.toHaveProperty('mode')
      expect(get()).toEqual(before)
      expect(upstream).not.toHaveBeenCalled()
    })
  })

  it('returns shared configuration status without exposing the key', async () => {
    await withRoutes(vi.fn(async () => chatResponse()), async (url, get) => {
      const before = structuredClone(get())
      const response = await post(`${url}/check`, {})
      const data = await response.json()
      expect(data).toMatchObject({ ok: true, status: 'connected', has_key: true, effective_model: 'fixture-model', base_url: 'https://example.com/proxy' })
      expect(JSON.stringify(data)).not.toContain('fixture-main-key')
      expect(get()).toEqual(before)
    })
  })

  it('does not save failed checks', async () => {
    await withRoutes(vi.fn(async () => new Response('invalid key', { status: 401 })), async (url, get, set) => {
      set({ exploration_base_url: 'https://example.com/saved' })
      const before = { ...get() }
      const response = await post(`${url}/check`, {})
      expect(await response.json()).toMatchObject({ ok: false, error: 'auth_failed' })
      expect(get()).toEqual(before)
    })
  })

  it('rejects stale verification when the main configuration changes during a request', async () => {
    let release!: (value: Response) => void
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const upstream = vi.fn(() => { started(); return new Promise<Response>(resolve => { release = resolve }) })
    await withRoutes(upstream, async (url, get, set) => {
      const response = post(`${url}/check`, {})
      await start
      set({ model: 'changed-model' })
      release(chatResponse())
      expect((await response).status).toBe(409)
      expect(get().exploration_base_url).toBe('')
    })
  })
})
