import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { WebSocketBridge } from '../bridge.js'

const daemons = []

afterAll(async () => {
  for (const bridge of daemons.splice(0)) {
    bridge.stopAdapterStateWatcher()
    await new Promise(resolve => bridge._wss.close(resolve))
  }
})

/** Start a real Bridge on an ephemeral loopback port and answer via its dispatch. */
async function startDaemon(instance) {
  const bridge = new WebSocketBridge({
    workspaceDir: undefined, port: 0, host: '127.0.0.1',
    instanceKind: instance.kind, serviceTokenHash: instance.tokenHash,
  })
  await bridge.init({ webcliVersion: 'test' })
  const { port } = bridge._wss.address()
  daemons.push(bridge)
  return { bridge, url: `ws://127.0.0.1:${port}` }
}

function request(url, message) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no reply')) }, 3000)
    ws.on('open', () => ws.send(JSON.stringify({ ...message, id: 'probe' })))
    ws.on('message', data => {
      const msg = JSON.parse(data.toString())
      if (msg.id !== 'probe') return
      clearTimeout(timer)
      ws.close()
      resolve(msg)
    })
    ws.on('error', reject)
  })
}

describe('Bridge service identity over the real dispatch path', () => {
  it('answers service_info for npm and desktop instances', async () => {
    for (const instance of [
      { kind: 'npm', port: 3712, tokenHash: 'fixture-token-hash' },
      { kind: 'desktop', port: 3711, tokenHash: null },
    ]) {
      const { bridge, url } = await startDaemon(instance)
      const reply = await request(url, { type: 'service_info' })
      expect(reply.type).toBe('service_info_result')
      expect(reply.instance).toMatchObject({ kind: instance.kind, port: bridge._wss.address().port })
    }
  })
})
