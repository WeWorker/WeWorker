import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeSiteAuthRequest, siteAuthNotification } from '../site-auth-ipc.js'
import { BrowserControlClient } from '../dedicated-browser.js'

test('only fixed login actions with a valid site reach the Bridge', () => {
  assert.deepEqual(sanitizeSiteAuthRequest('status', { refresh: true, url: 'https://example.com/' }), { action: 'status', extra: { refresh: true } })
  assert.deepEqual(sanitizeSiteAuthRequest('login', { site: 'fixture.example.com', waitMs: 600000 }), { action: 'login', extra: { site: 'fixture.example.com', waitMs: 0 } })
  assert.deepEqual(sanitizeSiteAuthRequest('set_autologin', { site: 'fixture.example.com', enabled: 'yes', dismissed: true }),
    { action: 'set_autologin', extra: { site: 'fixture.example.com', enabled: false, dismissed: true } })
  assert.deepEqual(sanitizeSiteAuthRequest('save_credential', { site: 'fixture.example.com', username: 'fixture-user', password: 'fixture-password', extra: 'x' }),
    { action: 'save_credential', extra: { site: 'fixture.example.com', username: 'fixture-user', password: 'fixture-password' } })
  assert.throws(() => sanitizeSiteAuthRequest('open_url', { site: 'fixture.example.com' }), /Unsupported/)
  assert.throws(() => sanitizeSiteAuthRequest('check', { site: '../etc/passwd' }), /Invalid site/)
  assert.throws(() => sanitizeSiteAuthRequest('save_credential', { site: 'fixture.example.com', username: 'a', password: '' }), /密码/)
})

test('system notifications cover the moments the user must act', () => {
  assert.match(siteAuthNotification({ status: 'waiting_user', name: '示例站' }).title, /需要登录 示例站/)
  assert.match(siteAuthNotification({ status: 'autologin_failed', name: '示例站', message: '密码错误' }).body, /密码错误/)
  assert.match(siteAuthNotification({ status: 'waiting_user', name: '动态口令站点', autologinMode: 'off' }).body, /动态密码/)
  assert.equal(siteAuthNotification({ status: 'logged_in', name: '示例站' }), null)
})

test('the desktop client sends auth_control and delivers auth events', async () => {
  const sockets = []
  class FakeWebSocket {
    constructor() { this.readyState = 0; this.sent = []; this.listeners = {}; sockets.push(this) }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener) }
    emit(type, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3 }
  }
  const client = new BrowserControlClient({ WebSocketImpl: FakeWebSocket, reconnectMs: 5, attachTimeoutMs: 20, requestTimeoutMs: 50 })
  const events = []
  client.onAuthEvent((event) => events.push(event.status))
  client.start()
  const [ws] = sockets
  ws.readyState = 1
  ws.emit('open')
  const pending = client.authRequest('status', { refresh: true })
  const request = ws.sent.at(-1)
  assert.deepEqual({ type: request.type, action: request.action, refresh: request.refresh }, { type: 'auth_control', action: 'status', refresh: true })
  ws.emit('message', { data: JSON.stringify({ type: 'auth_control_result', id: request.id, ok: true, result: { sites: [] } }) })
  assert.deepEqual(await pending, { sites: [] })
  ws.emit('message', { data: JSON.stringify({ type: 'auth_event', site: 'fixture.example.com', status: 'waiting_user' }) })
  assert.deepEqual(events, ['waiting_user'])
  client.stop()
})
