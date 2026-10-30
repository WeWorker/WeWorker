import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { normalizeLlmUrlInput, resolveAnthropicEndpoint, resolveOpenAiEndpoint } from '../llm-egress.js'
import { openAnthropicEndpointRelay, prepareModelRuntime } from '../anthropic-endpoint-relay.js'
import { listProviderModels, probeProviderProtocol } from '../provider-model-services.js'
import { getProvider } from '../provider-registry.js'
import { activateModelConfiguration, createModelConfiguration, publicModelConfigurations, updateModelConfiguration } from '../model-configurations.js'
import type { Settings } from '../config.js'

describe('custom Anthropic full URL', () => {
  const exact = 'https://example.com/tenant/inference/?api-version=2026&route=a%2Fb'
  it('uses the exact OpenAI URL for probes and skips model list suffixes', async () => {
    expect(resolveOpenAiEndpoint(exact, true)).toBe(exact)
    expect(resolveOpenAiEndpoint('https://example.com/v1/')).toBe('https://example.com/v1/chat/completions')
    expect(resolveOpenAiEndpoint('https://example.com/v1/', false, 'openai_responses')).toBe('https://example.com/v1/responses')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [] }))
    const input = { provider: getProvider('custom')!, apiKey: 'test', model: 'test', openaiBaseUrl: exact, openaiFullUrl: true }
    expect((await probeProviderProtocol({ ...input, target: 'webwright' }, fetcher)).ok).toBe(true)
    expect(fetcher.mock.calls[0][0]).toBe(exact)
    fetcher.mockClear()
    expect((await listProviderModels(input, fetcher)).warning).toContain('手动填写模型名称')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('saves independent URL modes and preserves them on activation and model-only edits', () => {
    let state = { active_provider: 'builtin', custom_auth_type: 'api_key', base_url_custom: '', openai_base_url_custom: '' } as Settings
    const created = createModelConfiguration(state, 'custom')
    state = { ...state, ...created.updates }
    state = { ...state, ...updateModelConfiguration(state, created.id, { base_url: 'https://example.com/prefix', base_url_is_full: false, openai_base_url: exact, openai_base_url_is_full: true, api_key: 'test', model: 'test' }) }
    state = { ...state, ...activateModelConfiguration(state, created.id) }
    state = { ...state, ...updateModelConfiguration(state, created.id, { model: 'edited' }) }
    expect(state.base_url_is_full).toBe(false)
    expect(publicModelConfigurations(state)[created.id]).toMatchObject({ openai_base_url: exact, openai_base_url_is_full: true })
    const second = createModelConfiguration(state, 'custom')
    expect(second.updates.model_configurations[second.id]).toMatchObject({ openai_base_url: '', openai_base_url_is_full: false, base_url_is_full: false })
    expect(() => updateModelConfiguration(state, created.id, { openai_base_url_is_full: false })).toThrow()
    expect(() => updateModelConfiguration(state, created.id, { openai_base_url_is_full: 'true' })).toThrow()
  })

  it('preserves arbitrary path, trailing slash and query; base mode appends the messages path', () => {
    expect(normalizeLlmUrlInput(exact, true)).toBe(exact)
    expect(resolveAnthropicEndpoint({ base_url: exact, base_url_is_full: true })).toBe(exact)
    expect(resolveAnthropicEndpoint({ base_url: 'https://example.com/proxy/' })).toBe('https://example.com/proxy/v1/messages')
    expect(resolveAnthropicEndpoint({ base_url: 'https://example.com/v1/messages', base_url_is_full: true })).toBe('https://example.com/v1/messages')
    expect(() => normalizeLlmUrlInput(exact, false)).toThrow()
    expect(() => normalizeLlmUrlInput(exact, 'true')).toThrow()
    for (const value of ['', 'file:///tmp/test', 'https://user:pass@example.com/x', 'https://example.com/x#fragment']) {
      expect(() => normalizeLlmUrlInput(value, true)).toThrow()
    }
  })

  it('retains full URL mode across saves and activation while new configurations stay blank', () => {
    let state = { active_provider: 'builtin', custom_auth_type: 'api_key', base_url_custom: '', openai_base_url_custom: '' } as Settings
    const created = createModelConfiguration(state, 'custom')
    state = { ...state, ...created.updates }
    expect(state.model_configurations![created.id].base_url_is_full).toBe(false)
    state = { ...state, ...updateModelConfiguration(state, created.id, { base_url: exact, base_url_is_full: true, model: 'test-model', api_key: 'test-key' }) }
    state = { ...state, ...activateModelConfiguration(state, created.id) }
    state = { ...state, ...updateModelConfiguration(state, created.id, { model: 'new-model' }) }
    expect(state).toMatchObject({ base_url: exact, base_url_is_full: true, model: 'new-model' })
    expect(publicModelConfigurations(state)[created.id]).toMatchObject({ base_url: exact, base_url_is_full: true })
    const second = createModelConfiguration(state, 'custom')
    expect(second.updates.model_configurations[second.id]).toMatchObject({ base_url: '', base_url_is_full: false })
    expect(second.updates.model_configurations[created.id]).toMatchObject({ base_url: exact, base_url_is_full: true })
    expect(() => updateModelConfiguration(state, created.id, { base_url_is_full: false })).toThrow()
    state = { ...state, ...updateModelConfiguration(state, created.id, { base_url: 'https://example.com/prefix', base_url_is_full: false }) }
    expect(resolveAnthropicEndpoint(state)).toBe('https://example.com/prefix/v1/messages')
  })

  it('probes the exact endpoint and never guesses a model list URL from it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ content: [] }))
    const input = { provider: getProvider('custom')!, apiKey: 'test', model: 'test-model', anthropicBaseUrl: exact, anthropicFullUrl: true }
    expect((await probeProviderProtocol({ ...input, target: 'weworker' }, fetcher)).ok).toBe(true)
    expect(fetcher.mock.calls[0][0]).toBe(exact)
    fetcher.mockClear()
    expect((await listProviderModels(input, fetcher)).warning).toContain('手动填写模型名称')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('forwards real SDK requests and SSE without adding SDK query/path; closes its own listener', async () => {
    const seen: Array<{ url: string; body: string; key: string }> = []
    const upstream = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      seen.push({ url: req.url!, body, key: String(req.headers['x-api-key']) })
      if (req.headers['x-test-stream']) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"text":"hello"}\n\n')
        res.end('data: [DONE]\n\n')
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg-test', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const port = (upstream.address() as import('node:net').AddressInfo).port
    const path = '/tenant/custom-inference/?version=1&encoded=a%2Fb'
    const relay = await openAnthropicEndpointRelay(`http://127.0.0.1:${port}${path}`)
    try {
      const sdk = new Anthropic({ baseURL: relay.baseUrl, apiKey: 'test-key', maxRetries: 0 })
      const result = await sdk.messages.create({ model: 'test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
      expect(result.id).toBe('msg-test')
      const stream = await fetch(`${relay.baseUrl}/v1/messages?beta=true`, { method: 'POST', headers: { 'x-test-stream': '1', 'x-api-key': 'test-key' }, body: '{"stream":true}' })
      expect(await stream.text()).toBe('data: {"text":"hello"}\n\ndata: [DONE]\n\n')
      expect(seen.map(item => item.url)).toEqual([path, path])
      expect(JSON.parse(seen[0].body).model).toBe('test')
      expect(seen[0].key).toBe('test-key')
      expect((await fetch(`${relay.baseUrl}/v1/models`)).status).toBe(404)
      expect((await fetch(`${new URL(relay.baseUrl).origin}/v1/messages`, { method: 'POST' })).status).toBe(404)
      expect(seen).toHaveLength(2)
    } finally {
      await relay.close()
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    }
    await expect(fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST' })).rejects.toThrow()
  })

  it('keeps base mode direct and prepares isolated SDK settings for full mode', async () => {
    const base = { base_url: 'https://example.com', base_url_is_full: false } as Settings
    const direct = await prepareModelRuntime(base)
    expect(direct.settings).toBe(base)
    await direct.close()
    const full = { ...base, base_url: exact, base_url_is_full: true }
    const runtime = await prepareModelRuntime(full)
    try {
      expect(runtime.settings.base_url).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect(runtime.settings.base_url_is_full).toBe(false)
      expect(full.base_url).toBe(exact)
    } finally { await runtime.close() }
  })

  it('preserves upstream errors and aborts active streams during cleanup', async () => {
    let activeRequestClosed: Promise<void> | undefined
    const upstream = http.createServer((req, res) => {
      if (req.headers['x-hang']) {
        activeRequestClosed = new Promise(resolve => res.on('close', resolve))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: waiting\n\n')
      } else res.writeHead(429, { 'retry-after': '10' }).end('limited')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const relay = await openAnthropicEndpointRelay(`http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}/custom`)
    try {
      const error = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', body: '{}' })
      expect(error.status).toBe(429)
      expect(error.headers.get('retry-after')).toBe('10')
      expect(await error.text()).toBe('limited')
      const stream = await fetch(`${relay.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-hang': '1' }, body: '{}' })
      const reader = stream.body!.getReader()
      await reader.read()
      await relay.close()
      await activeRequestClosed
      await expect(reader.read()).rejects.toThrow()
    } finally {
      await relay.close()
      await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections() })
    }
  })
})
