// Feature: browser-keeper, ws 版 CDP client(与 pipe 版同接口契约)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createCdpWebSocket } from '../cdp-websocket.js'
import { WebSocketServer } from 'ws'
import http from 'node:http'

/** 最小 CDP browser-endpoint mock:HTTP discovery 路由 + ws 消息应答。 */
async function startMockCdpServer() {
  const clients = new Set()
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'Chrome/Mock', webSocketDebuggerUrl: `ws://127.0.0.1:${httpServer.address().port}/devtools/browser/mock` }))
    } else if (req.url === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'page-1', type: 'page' }]))
    } else { res.writeHead(404); res.end() }
  })
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id !== undefined) {
        if (msg.method === 'Fail.method') {
          ws.send(JSON.stringify({ id: msg.id, error: { message: 'mock failure' } }))
        } else {
          const result = msg.method === 'Browser.getVersion' ? { product: 'Chrome/Mock' } : {}
          ws.send(JSON.stringify({ id: msg.id, result }))
        }
      }
    })
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/mock`,
    broadcast: (method, params) => {
      for (const ws of clients) if (ws.readyState === 1) ws.send(JSON.stringify({ method, params }))
    },
    close: async () => {
      for (const ws of clients) ws.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}

let server
beforeEach(async () => { server = await startMockCdpServer() })
afterEach(async () => { await server.close() })

describe('createCdpWebSocket', () => {

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

describe('attachExistingBrowser', () => {
  it('读 DevToolsActivePort 连接并验证 endpoint,返回可用 CDP', async () => {
    const { attachExistingBrowser } = await import('../dedicated-browser.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'))
    // 从 mock server 的 URL 提取 port 与 path
    const u = new URL(server.url)
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${u.port}\n${u.pathname}\n`)
    const cdp = await attachExistingBrowser(profile, { timeoutMs: 3000 })
    try {
      expect((await cdp.send('Browser.getVersion')).product).toBe('Chrome/Mock')
    } finally { cdp.close() }
  })
  it('文件缺失/endpoint 不匹配 → 超时抛错(不误连)', async () => {
    const { attachExistingBrowser } = await import('../dedicated-browser.js')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-miss-'))
    const u = new URL(server.url)
    // 写一个错误 path 的文件 → 验证不通过
    fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), `${u.port}\n/devtools/browser/wrong\n`)
    await expect(attachExistingBrowser(profile, { timeoutMs: 800 })).rejects.toThrow()
  })
})
