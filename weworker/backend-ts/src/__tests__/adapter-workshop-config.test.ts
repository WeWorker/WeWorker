import { describe, expect, it, vi } from 'vitest'
import type { ModelConfiguration } from '../model-configurations.js'
import { detectValidatedWorkshop, sharedOpenAiWorkshopAddress, automaticWorkshopUpdate } from '../adapter-workshop-config.js'

const configuration = (patch: Partial<ModelConfiguration> = {}): ModelConfiguration => ({
  provider_id: 'custom', api_key: 'fixture-api-key', model: 'fixture-model',
  base_url: 'https://example.com/gateway', weworker_protocol: 'anthropic_messages',
  openai_base_url: '', auth_type: 'api_key', context_limit: 200000, ...patch,
})
const success = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] })

const validSource = () => Response.json({ data: [{ id: 'fixture-model' }] })
const probe = (fallback: typeof fetch): typeof fetch => (url, init) =>
  /\/v1\/models\?limit=1$/.test(String(url)) || String(url).endsWith('/messages')
    ? Promise.resolve(String(url).endsWith('/messages') ? Response.json({ content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }] }) : validSource())
    : fallback(url, init)
async function discoverWorkshopConfig(input: ModelConfiguration, fetchImpl: typeof fetch) {
  return (await detectValidatedWorkshop(input, probe(fetchImpl))).workshop
}

describe('automatic Adapter workshop configuration', () => {
  it.each([
    ['https://example.com/gateway', false, 'https://example.com/gateway/v1'],
    ['https://example.com/gateway/v1/', false, 'https://example.com/gateway/v1'],
    ['https://example.com/gateway/v1/messages', true, 'https://example.com/gateway/v1'],
  ])('verifies Anthropic sibling %s with OpenAI bearer authentication', async (base_url, full, expected) => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(`${expected}/chat/completions`)
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-api-key' })
      expect(init?.headers).not.toHaveProperty('x-api-key')
      expect(JSON.parse(init!.body as string).model).toBe('fixture-model')
      return success()
    }) as typeof fetch
    const result = await discoverWorkshopConfig(configuration({ base_url, base_url_is_full: full }), fetchImpl)
    expect(result).toMatchObject({ openai_base_url: expected, openai_base_url_is_full: false,
      openai_api_key: 'fixture-api-key', openai_model: 'fixture-model' })
  })

  it.each([401, 403, 404, 405, 500])('does not infer OpenAI availability from HTTP %s', async status => {
    expect(await discoverWorkshopConfig(configuration(), async () => new Response('{}', { status }))).toEqual({})
  })

  it('rejects HTML successes, malformed protocol responses and network failures', async () => {
    for (const fetchImpl of [async () => new Response('<html>gateway</html>'),
      async () => Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] }),
      async () => { throw new Error('fixture network error') }]) {
      expect(await discoverWorkshopConfig(configuration(), fetchImpl)).toEqual({})
    }
  })

  it('uses a returned model when the source has no model and verifies it before configuring', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'fixture-discovered-model' }] })
      expect(JSON.parse(init!.body as string).model).toBe('fixture-discovered-model')
      return success()
    }) as typeof fetch
    expect(await discoverWorkshopConfig(configuration({ model: '' }), fetchImpl)).toMatchObject({
      openai_model: 'fixture-discovered-model', openai_base_url: 'https://example.com/gateway/v1',
    })
  })

  it.each(['openai_chat_completions', 'openai_responses'] as const)('copies %s chat settings without changing the chat protocol', async protocol => {
    const input = configuration({ weworker_protocol: protocol, base_url: 'https://example.org/v1' })
    const fetchImpl = vi.fn()
    expect(sharedOpenAiWorkshopAddress(input)).toMatchObject({
      openai_base_url: 'https://example.org/v1',
    })
    expect(input.weworker_protocol).toBe(protocol)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a full Responses endpoint to the workshop Chat Completions endpoint', async () => {
    expect(sharedOpenAiWorkshopAddress(configuration({ base_url: 'https://example.org/v1/responses?version=1&route=a%2Fb',
      weworker_protocol: 'openai_responses', base_url_is_full: true }))).toMatchObject({
      openai_base_url: 'https://example.org/v1/chat/completions?version=1&route=a%2Fb', openai_base_url_is_full: true,
    })
  })

  it('fills empty workshop settings when saving a main connection and syncs later edits', async () => {
    const current = configuration()
    const first = await automaticWorkshopUpdate(current, current, { base_url: current.base_url }, probe(async () => success()))
    expect(first.openai_base_url).toBe('https://example.com/gateway/v1')
    const saved = { ...current, ...first }
    expect(await automaticWorkshopUpdate(saved, { ...saved, model: 'fixture-next-model', api_key: 'fixture-next-key' },
      { model: 'fixture-next-model', api_key: 'fixture-next-key' }, probe(async () => success()))).toMatchObject({
      openai_model: 'fixture-next-model', openai_api_key: 'fixture-next-key',
    })
  })

  it('preserves a distinct manual workshop connection and skips unrelated saves', async () => {
    const current = configuration({ openai_base_url: 'https://example.org/manual/v1', openai_api_key: 'fixture-manual-key' })
    const fetchImpl = vi.fn()
    expect(await automaticWorkshopUpdate(current, { ...current, model: 'next' }, { model: 'next' }, fetchImpl)).toEqual({})
    expect(await automaticWorkshopUpdate(configuration(), configuration(), { context_limit: 400000 }, fetchImpl)).toEqual({})
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
