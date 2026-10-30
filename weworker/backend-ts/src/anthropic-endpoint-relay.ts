import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import type { Settings } from './config.js'
import { normalizeLlmUrlInput, isOpenAiProtocol } from './llm-egress.js'
import { openOpenAiChatRelay } from './anthropic-openai-compat.js'

// Claude Code always appends its Messages path. Translate only that local path
// to the user's exact endpoint, preserving the upstream URL, body and SSE stream.
export async function openAnthropicEndpointRelay(endpoint: string) {
  const target = normalizeLlmUrlInput(endpoint, true)
  const prefix = `/${randomBytes(24).toString('hex')}`
  const pending = new Set<http.ClientRequest>()
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== `${prefix}/v1/messages`) {
      res.writeHead(404).end()
      return
    }
    const headers = { ...req.headers }
    for (const name of ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']) delete headers[name]
    const request = target.startsWith('https:') ? https.request : http.request
    const upstream = request(target, { method: 'POST', headers }, response => {
      const responseHeaders = { ...response.headers }
      for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) delete responseHeaders[name]
      res.writeHead(response.statusCode || 502, responseHeaders)
      response.on('error', () => res.destroy())
      response.pipe(res)
    })
    pending.add(upstream)
    upstream.on('close', () => pending.delete(upstream))
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: '模型接口连接失败' } }))
      else res.destroy()
    })
    upstream.setTimeout(120_000, () => upstream.destroy())
    req.on('aborted', () => upstream.destroy())
    req.on('error', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  server.unref()
  const address = server.address() as import('node:net').AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    async close() {
      for (const request of pending) request.destroy()
      const stopped = new Promise<void>(resolve => server.close(() => resolve()))
      server.closeAllConnections()
      await stopped
    },
  }
}

export async function prepareModelRuntime(settings: Settings) {
  if (isOpenAiProtocol(settings.active_weworker_protocol)) {
    const relay = await openOpenAiChatRelay(settings.base_url, settings.base_url_is_full === true, fetch, settings.active_weworker_protocol || 'openai_chat_completions')
    return {
      settings: { ...settings, base_url: relay.baseUrl, base_url_is_full: false },
      close: relay.close,
    }
  }
  if (!settings.base_url_is_full) return { settings, close: async () => {} }
  const relay = await openAnthropicEndpointRelay(settings.base_url)
  return {
    settings: { ...settings, base_url: relay.baseUrl, base_url_is_full: false },
    close: relay.close,
  }
}
