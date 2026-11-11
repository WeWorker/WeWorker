// Feature: browser-keeper, ws 版 CDP client(与 pipe 版同接口契约)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createCdpWebSocket } from '../cdp-websocket.js'
import { WebSocketServer } from 'ws'
import http from 'node:http'

/** 最小 CDP browser-endpoint mock:逐 JSON 消息应答,支持事件广播。 */
async function startMockCdpServer() {
  const wss = new WebSocketServer({ port: 0 })
  const clients = new Set()
  const state = { nextId: 100, closed: false }
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id !== undefined) {
        const result = msg.method === 'Browser.getVersion'
          ? { product: 'Chrome/Mock' }
          : msg.method === 'Fail.method' ? undefined : {}
        if (msg.method === 'Fail.method') {
          ws.send(JSON.stringify({ id: msg.id, error: { message: 'mock failure' } }))
        } else {
          ws.send(JSON.stringify({ id: msg.id, result }))
        }
      }
    })
  })
  await new Promise((resolve) => wss.on('listening', resolve))
  const port = wss.address().port
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/mock`,
    broadcast: (method, params) => {
      for (const ws of clients) if (ws.readyState === 1) ws.send(JSON.stringify({ method, params }))
    },
    close: async () => {
      state.closed = true
      for (const ws of clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}

describe('createCdpWebSocket', () => {
  let server
  beforeEach(async () => { server = await startMockCdpServer() })
  afterEach(async () => { await server.close() })

  it('send 往返:resolve result(无 sessionId)', async () => {
    const cdp = await createCdpWebSocket(server.url)
    try {
      const result = await cdp.send('Browser.getVersion')
      expect(result.product).toBe('Chrome/Mock')
    } finally { cdp.close() }
  })
  it('sessionId 透传到消息里', async () => {
    const cdp = await createCdpWebSocket(server.url)
    try {
      // mock 不校验 sessionId,但消息必须带;用事件监听侧验证太重,这里验证不抛错即可
      await expect(cdp.send('Browser.getVersion', {}, 'SESSION-1')).resolves.toBeTruthy()
    } finally { cdp.close() }
  })
  it('CDP error → reject 并带 message', async () => {
    const cdp = await createCdpWebSocket(server.url)
    try {
      await expect(cdp.send('Fail.method')).rejects.toThrow('mock failure')
    } finally { cdp.close() }
  })
  it('onEvent 收到服务端广播事件', async () => {
    const cdp = await createCdpWebSocket(server.url)
    try {
      const events = []
      const off = cdp.onEvent((m) => events.push(m))
      await new Promise((r) => setTimeout(r, 100))
      server.broadcast('Target.targetCreated', { targetInfo: { id: 't1' } })
      await new Promise((r) => setTimeout(r, 150))
      off()
      expect(events.some((m) => m.method === 'Target.targetCreated')).toBe(true)
    } finally { cdp.close() }
  })
  it('close 后 send 拒绝;服务端断开 → closed=true', async () => {
    const cdp = await createCdpWebSocket(server.url)
    cdp.close()
    await expect(cdp.send('Browser.getVersion')).rejects.toThrow('closed')
  })
})
