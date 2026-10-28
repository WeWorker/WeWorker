import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import { allowedExplorationRequest, createWebsiteExplorationRouter, mapExplorationResources } from '../website-exploration.js'

const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })
async function harness(fetcher: typeof fetch, instanceId = 'owned') {
  const app = express()
  app.use((req, res, next) => { if (req.header('X-WeWorker-Auth') !== 'client') { res.sendStatus(401); return }; next() })
  app.use(express.json())
  app.use('/api/website-exploration', createWebsiteExplorationRouter({ fetch: fetcher, instanceId }))
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
  servers.push(server)
  const address = server.address() as { port: number }
  return (path: string, options: RequestInit = {}) => fetch('http://127.0.0.1:' + address.port + '/api/website-exploration' + path, { headers: { 'X-WeWorker-Auth': 'client' }, ...options })
}
const health = () => Response.json({ ok: true, instance_id: 'owned' })

describe('website exploration route boundary', () => {
  it.each([
    ['GET', '/api/toolkits', true], ['GET', '/api/browser/match?url=https%3A%2F%2Fexample.com', true],
    ['GET', '/api/browser/match?toolkit_id=demo&tool_id=read_page', true],
    ['GET', '/api/browser/match?toolkit_id=demo&allowed_domains=other.example.org', false],
    ['POST', '/api/explorations/run-1/cancel?force=true', true],
    ['GET', '/api/tasks', false], ['POST', '/api/health', false],
    ['GET', '/api/toolkits?url=http://attacker', false],
    ['GET', '/api/explorations/a/files/../secret', false],
    ['GET', '/api/explorations/a/files/%2e%2e/secret', false],
    ['GET', '/api/explorations/a/files/%252e%252e/secret', false],
    ['GET', '/api/internal/model-config', false],
    ['GET', 'http://attacker/api/toolkits', false],
  ])('%s %s => %s', (method, path, allowed) => expect(allowedExplorationRequest(method, path)).toBe(allowed))

  it('maps only allowed local resource addresses', () => {
    expect(mapExplorationResources({ screenshot_url: '/api/explorations/a/files/a.png', nested: [{ events_url: '/api/debug-runs/b/events' }], code: 'print(1)' })).toEqual({ screenshot_url: '/api/website-exploration/explorations/a/files/a.png', nested: [{ events_url: '/api/website-exploration/debug-runs/b/events' }], code: 'print(1)' })
  })
  it('rejects requests before forwarding when unauthenticated or unknown', async () => {
    const upstream = vi.fn()
    const request = await harness(upstream)
    expect((await request('/toolkits', { headers: {} })).status).toBe(401)
    expect((await request('/tasks')).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('does not reuse another local process', async () => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ ok: true, instance_id: 'other' }))
    const request = await harness(upstream)
    expect((await request('/toolkits')).status).toBe(503)
    expect(upstream).toHaveBeenCalledTimes(1)
  })
  it('preserves conflict response, body and redirection policy without client credentials', async () => {
    const upstream = vi.fn().mockImplementationOnce(health).mockResolvedValueOnce(Response.json({ error: { message: 'stale code' } }, { status: 409 }))
    const request = await harness(upstream)
    const result = await request('/toolkits/a/tools/b/development', { method: 'PUT', headers: { 'X-WeWorker-Auth': 'client', 'Content-Type': 'application/json', Cookie: 'private=1' }, body: JSON.stringify({ code: 'x', expected_code_hash: 'old' }) })
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: { message: 'stale code' } })
    const call = upstream.mock.calls[1]
    expect(call[0]).toBe('http://127.0.0.1:8766/api/toolkits/a/tools/b/development')
    expect(call[1].headers).toEqual({ 'Content-Type': 'application/json' })
    expect(call[1].redirect).toBe('error')
    expect(JSON.parse(call[1].body).expected_code_hash).toBe('old')
  })
  it('streams downloads and named events without JSON wrapping', async () => {
    const stream = 'event: step_finished\ndata: {"step":1}\n\n'
    const upstream = vi.fn().mockImplementationOnce(health).mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    const request = await harness(upstream)
    const result = await request('/explorations/a/events')
    expect(result.headers.get('content-type')).toContain('text/event-stream')
    expect(await result.text()).toBe(stream)
  })
  it('fails closed without managed instance configuration', async () => {
    const upstream = vi.fn()
    const request = await harness(upstream, '')
    expect((await request('/health')).status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
})
