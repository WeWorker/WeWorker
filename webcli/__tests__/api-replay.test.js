import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import fs from 'node:fs'
import { handleBackendRuntimeFetch, performApiReplayRequest } from '../bridge.js'

const servers = []

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      servers.push(server)
      resolve(server.address().port)
    })
  })
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

describe('api replay request', () => {
  it('sends a Node-side request with browser cookie headers', async () => {
    let observed = null
    const server = http.createServer(async (req, res) => {
      observed = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: await readBody(req),
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ retCode: 0, data: { ok: true } }))
    })
    const port = await listen(server)

    const result = await performApiReplayRequest({
      url: `http://127.0.0.1:${port}/api/list`,
      method: 'POST',
      headers: {
        Cookie: 'sid=abc; user=steven',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: '{"pageSize":1}',
    })

    expect(result.ok).toBe(true)
    expect(result.response.status).toBe(200)
    expect(JSON.parse(result.response.body)).toEqual({ retCode: 0, data: { ok: true } })
    expect(observed).toMatchObject({
      method: 'POST',
      url: '/api/list',
      body: '{"pageSize":1}',
    })
    expect(observed.headers.cookie).toBe('sid=abc; user=steven')
    expect(observed.headers['x-requested-with']).toBe('XMLHttpRequest')
  })

  it('filters hop-by-hop and transport-owned headers', async () => {
    let observedHeaders = null
    const server = http.createServer((req, res) => {
      observedHeaders = req.headers
      res.end('ok')
    })
    const port = await listen(server)

    const result = await performApiReplayRequest({
      url: `http://127.0.0.1:${port}/`,
      headers: {
        Host: 'evil.example',
        Connection: 'close',
        'X-Test': 'kept',
      },
    })

    expect(result.ok).toBe(true)
    expect(observedHeaders.host).toBe(`127.0.0.1:${port}`)
    expect(observedHeaders.connection).not.toBe('close')
    expect(observedHeaders['x-test']).toBe('kept')
  })

  it('falls back to curl when Node fetch cannot reach the endpoint', async () => {
    let observed = null
    const server = http.createServer(async (req, res) => {
      observed = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: await readBody(req),
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, via: 'curl' }))
    })
    const port = await listen(server)

    const result = await performApiReplayRequest(
      {
        url: `http://127.0.0.1:${port}/api/fallback`,
        method: 'POST',
        headers: {
          Cookie: 'sid=abc',
          'Content-Type': 'application/json',
        },
        body: '{"hello":"world"}',
      },
      {
        fetchImpl: async () => {
          const err = new Error('fetch failed')
          err.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'certificate rejected' }
          throw err
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.response.status).toBe(200)
    expect(result.response.replay.transport).toBe('curl')
    expect(result.response.replay.fetchError).toContain('fetch failed')
    expect(JSON.parse(result.response.body)).toEqual({ ok: true, via: 'curl' })
    expect(observed).toMatchObject({
      method: 'POST',
      url: '/api/fallback',
      body: '{"hello":"world"}',
    })
    expect(observed.headers.cookie).toBe('sid=abc')
    expect(observed.headers['content-type']).toBe('application/json')
  })

  it('sends a single request after an uncertain write failure', async () => {
    let received = 0
    const server = http.createServer((req) => {
      received++
      req.socket.destroy()
    })
    const port = await listen(server)
    await expect(handleBackendRuntimeFetch({
      url: `http://127.0.0.1:${port}/api/create`,
      singleAttempt: true,
      redactBodyInTrace: true,
      options: { method: 'POST', body: '{"name":"example"}' },
    })).rejects.toThrow('Backend fetch failed')
    expect(received).toBe(1)
  })

  it('does not follow redirects for single-attempt requests', async () => {
    const visited = []
    const server = http.createServer((req, res) => {
      visited.push(req.url)
      res.writeHead(307, { Location: '/target' })
      res.end()
    })
    const port = await listen(server)
    const result = await handleBackendRuntimeFetch({
      url: `http://127.0.0.1:${port}/start`, singleAttempt: true,
      options: { method: 'POST', body: 'example', redirect: 'follow' },
    })
    expect(result.status).toBe(307)
    expect(visited).toEqual(['/start'])
  })

  it('redacts API key headers and nested JSON fields from bridge traces', async () => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: { apiKey: 'example-response-key-placeholder', label: 'visible' } }))
    })
    const port = await listen(server)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const result = await handleBackendRuntimeFetch({
        url: `http://127.0.0.1:${port}/api`,
        options: { headers: { 'Example-Cli-Api-Key': 'example-header-key-placeholder' } },
      }, 'trace-placeholder')
      expect(JSON.parse(result.body).data.apiKey).toBe('example-response-key-placeholder')
      const logs = write.mock.calls.map(([line]) => String(line)).join('')
      expect(logs).toContain('visible')
      expect(logs).not.toContain('example-response-key-placeholder')
      expect(logs).not.toContain('example-header-key-placeholder')
    } finally { write.mockRestore() }
  })

  it('hides unstructured request and response bodies when requested', async () => {
    const server = http.createServer((req, res) => res.end('example-unstructured-response-placeholder'))
    const port = await listen(server)
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await handleBackendRuntimeFetch({
        url: `http://127.0.0.1:${port}/api`, redactBodyInTrace: true,
        options: { method: 'POST', body: 'example-unstructured-request-placeholder' },
      }, 'trace-placeholder')
      const logs = write.mock.calls.map(([line]) => String(line)).join('')
      expect(logs).not.toContain('example-unstructured-request-placeholder')
      expect(logs).not.toContain('example-unstructured-response-placeholder')
      expect(logs).toContain('[redacted]')
    } finally { write.mockRestore() }
  })

  it('does not follow redirects in curl fallback when manual handling is requested', async () => {
    const visited = []
    const server = http.createServer((req, res) => {
      visited.push(req.url)
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/target' })
        res.end()
      } else {
        res.end('unexpected')
      }
    })
    const port = await listen(server)
    const result = await performApiReplayRequest(
      { url: `http://127.0.0.1:${port}/start`, redirect: 'manual' },
      { fetchImpl: async () => { throw new Error('fixture fetch failure') } },
    )
    expect(result.ok).toBe(true)
    expect(result.response.status).toBe(302)
    expect(visited).toEqual(['/start'])
  })

  it('keeps Windows Schannel revocation checks from breaking curl fallback', () => {
    const bridgeSource = fs.readFileSync(new URL('../bridge.js', import.meta.url), 'utf8')

    expect(bridgeSource).toContain("'ssl-no-revoke'")
    expect(bridgeSource).not.toContain("'insecure'")
    expect(bridgeSource).not.toContain('"insecure"')
  })
})
