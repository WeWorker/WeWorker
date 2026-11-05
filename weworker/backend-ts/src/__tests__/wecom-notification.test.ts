import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WecomChannel } from '../channels/wecom-channel.js'

describe('WecomChannel proactive notifications', () => {
  it('rejects when WeCom acknowledges an aibot_send_msg request with an error', async () => {
    const channel = new WecomChannel({ enabled: true, bot_id: 'fixture-bot', secret: 'fixture-secret' })
    const socket = {
      readyState: WebSocket.OPEN,
      send: vi.fn((raw: string) => {
        const request = JSON.parse(raw)
        setImmediate(() => (channel as any)._handleFrame({
          headers: { req_id: request.headers.req_id },
          errcode: 93000,
          errmsg: 'fixture rejected',
        }))
      }),
    }
    ;(channel as any)._ws = socket

    await expect(channel.sendNotificationToTarget({ id: 'fixture-chat', chatType: 1 }, 'fixture summary'))
      .rejects.toThrow(/企业微信.*93000/)
    expect(socket.send).toHaveBeenCalledTimes(1)
  })
})
