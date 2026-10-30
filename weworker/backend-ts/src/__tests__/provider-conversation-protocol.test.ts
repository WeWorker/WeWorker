import { describe, expect, it, vi } from 'vitest'
import type { ProviderEntry } from '../llm-egress.js'
import { listProviderModels, probeMainConnection, probeProviderProtocol } from '../provider-model-services.js'

const provider: ProviderEntry = {
  id: 'custom', name: 'Custom', models: [], defaultModel: '',
  weworker: { protocol: 'anthropic_messages', baseUrl: '' },
  webwright: { protocol: 'openai_chat_completions', modelClass: 'openai_chat', baseUrl: '', structuredOutput: 'openai_json_object' },
}

describe('custom WeWorker protocol selection', () => {
  it('lists models through OpenAI when OpenAI is selected for chat', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://gateway.example/v1/models')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key')
      return Response.json({ data: [{ id: 'fixture-openai-model' }] })
    })

    await expect(listProviderModels({ provider, target: 'weworker', weworkerProtocol: 'openai_chat_completions',
      apiKey: 'fixture-key', weworkerBaseUrl: 'https://gateway.example/v1' }, fetchMock))
      .resolves.toMatchObject({ models: ['fixture-openai-model'], source: 'remote' })
  })

  it('probes OpenAI Chat Completions using the selected custom chat endpoint', async () => {
    let requestedBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://gateway.example/custom/chat/completions')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key')
      requestedBody = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
    })

    await expect(probeProviderProtocol({ provider, target: 'weworker', weworkerProtocol: 'openai_chat_completions',
      apiKey: 'fixture-key', model: 'fixture-model', weworkerBaseUrl: 'https://gateway.example/custom/chat/completions', weworkerFullUrl: true,
      verifyResponse: true }, fetchMock)).resolves.toMatchObject({ ok: true, protocol: 'openai_chat_completions' })
    expect(requestedBody).toMatchObject({ model: 'fixture-model', response_format: { type: 'json_object' } })
  })

  it('probes OpenAI Responses with its endpoint and request/response format', async () => {
    let requestedBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://gateway.example/v1/responses')
      requestedBody = JSON.parse(String(init?.body))
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] })
    })
    await expect(probeProviderProtocol({ provider, target: 'weworker', weworkerProtocol: 'openai_responses',
      apiKey: 'fixture-key', model: 'fixture-model', weworkerBaseUrl: 'https://gateway.example/v1', verifyResponse: true }, fetchMock))
      .resolves.toMatchObject({ ok: true, protocol: 'openai_responses' })
    expect(requestedBody).toMatchObject({ model: 'fixture-model', max_output_tokens: 256, text: { format: { type: 'json_object' } } })
  })

  it('uses the selected OpenAI protocol for the main connection check', async () => {
    const endpoint = 'https://gateway.example/custom/chat/completions?route=fixture'
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(endpoint)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key')
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })
    })

    await expect(probeMainConnection({ provider, target: 'weworker', weworkerProtocol: 'openai_chat_completions',
      apiKey: 'fixture-key', model: 'fixture-model', weworkerBaseUrl: endpoint, weworkerFullUrl: true }, fetchMock))
      .resolves.toMatchObject({ ok: true, protocol: 'openai_chat_completions' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
