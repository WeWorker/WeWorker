import { expect, it, vi } from 'vitest'
import { getProvider } from '../provider-registry.js'
import { probeTimedMainConnection } from '../provider-model-services.js'

const input = { provider: getProvider('custom')!, model: 'fixture-model', apiKey: 'fixture-key',
  anthropicBaseUrl: 'https://example.com', openaiBaseUrl: 'https://example.org/v1' }

it('measures a verified conversation request and never calls the exploration protocol', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ content: [{ type: 'tool_use', name: 'connection_check', input: { status: 'ok' } }] }))
  const clock = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(22)
  const result = await probeTimedMainConnection(input, fetchMock, clock)
  expect(result).toMatchObject({ ok: true, model: 'fixture-model', elapsed_ms: 12, target: 'weworker' })
  expect(result.checked_at).toBeGreaterThan(0)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, options] = fetchMock.mock.calls[0]
  expect(url).toBe('https://example.com/v1/messages')
  expect(JSON.parse(String(options?.body))).toMatchObject({ model: 'fixture-model', max_tokens: 1024 })
})

it('does not label HTTP success with invalid content as available', async () => {
  const result = await probeTimedMainConnection(input, vi.fn(async () => Response.json({ content: [] })))
  expect(result).toMatchObject({ ok: false, error: 'protocol_mismatch' })
  expect(result.elapsed_ms).toBeGreaterThanOrEqual(1)
})

it('records authentication failure timing without leaking the key', async () => {
  const result = await probeTimedMainConnection(input, vi.fn(async () => new Response('invalid fixture-key', { status: 401 })))
  expect(result).toMatchObject({ ok: false, error: 'auth_failed' })
  expect(result.detail).not.toContain('fixture-key')
  expect(result.elapsed_ms).toBeGreaterThanOrEqual(1)
})
