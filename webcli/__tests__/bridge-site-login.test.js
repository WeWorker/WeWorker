import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const fixture = vi.hoisted(() => ({
  manifest: {
    name: 'fixture.example.com', match: ['www.example.com'],
    auth: { login_url: 'https://passport.example.com/login', check: { cookies: { url: 'https://www.example.com/', all: ['sid'] } } },
    commands: [{ id: 'list', runtime: 'extension', safety: 'read' }],
  },
}))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { WebSocketServer: class extends EventEmitter {} }
})
vi.mock('../adapter-host.js', () => ({
  describeAdapterCatalog: () => ({ adapters: [fixture.manifest] }),
  readAdapterBundle: vi.fn(),
  resolveAdapterCall: (toolName) => (toolName.startsWith('fixture.example.com.')
    ? { adapter: { name: 'fixture.example.com', manifest: fixture.manifest }, command: { id: toolName.split('.').pop(), runtime: 'extension', safety: 'read' } }
    : null),
}))

const { WebSocketBridge } = await import('../bridge.js')

function createBridge() {
  const bridge = Object.create(WebSocketBridge.prototype)
  bridge._clients = new Set()
  bridge._extensionWs = null
  bridge._extensionCapabilities = []
  bridge._pendingRequests = new Map()
  bridge._requestCounter = 0
  bridge._broadcast = vi.fn()
  bridge._handleExtensionMessage = vi.fn()
  bridge._clearCaptureModelContexts = vi.fn()
  bridge._adapterStateWatcher = { snapshot: () => null }
  bridge._browserHost = {
    mode: 'dedicated', token: 'fixture-token-0123456789abcdef0123456789', status: () => ({ mode: 'dedicated', status: 'running' }),
    onStatus() {}, notify() {}, detach() {}, control: vi.fn(async () => ({ mode: 'dedicated', status: 'running' })),
  }
  bridge._startServer()
  bridge._wss.clients = new Set()
  return bridge
}

function connect(bridge) {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.send = vi.fn()
  bridge._wss.clients.add(ws)
  bridge._wss.emit('connection', ws, { headers: {} })
  return ws
}
const sentTo = (ws) => ws.send.mock.calls.map(([value]) => JSON.parse(value))
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('Bridge login wiring', () => {
  it('hands AUTH_REQUIRED from an Extension command to the login flow with the caller\'s wait', async () => {
    const bridge = createBridge()
    const failure = Object.assign(new Error('Session expired'), { code: 'AUTH_REQUIRED', auth: { site: 'fixture.example.com', phase: 'handler' } })
    bridge._callToolInner = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ rows: 1 })
    const handleFailure = vi.fn(async (_error, { retry }) => retry())
    bridge._siteLoginCoordinator = { handleFailure, hasWaitingFlow: () => false }
    await expect(bridge.callTool('fixture.example.com.list', {}, null, null, { loginWaitMs: 20_000 })).resolves.toEqual({ rows: 1 })
    expect(handleFailure).toHaveBeenCalledWith(failure, expect.objectContaining({ site: 'fixture.example.com', loginWaitMs: 20_000, command: expect.objectContaining({ id: 'list' }) }))
    expect(bridge._callToolInner).toHaveBeenCalledTimes(2)

    // Generic open_browser remains a pure opener and never enters login recovery.
    bridge.openBrowser = vi.fn(async (url) => ({ success: true, url, tabId: 7 }))
    await expect(bridge.callTool('open_browser', { url: 'https://www.example.com/' })).resolves.toMatchObject({ success: true })
    expect(handleFailure).toHaveBeenCalledTimes(1)

    // Explicit Adapter binding starts its login flow without replaying the opener.
    bridge._siteLoginCoordinator.login = vi.fn(async () => ({ site: fixture.manifest.name, status: 'waiting_user' }))
    bridge._request = vi.fn(async (message) => ({ tabId: message.tabId, state: 'login', url: 'https://passport.example.com/login' }))
    await expect(bridge.callTool('open_browser', { url: 'https://www.example.com/', adapter: fixture.manifest.name }))
      .resolves.toMatchObject({ success: true, auth: { site: fixture.manifest.name, status: 'waiting_user', flowActive: true } })
    expect(bridge._request).toHaveBeenCalledWith({ type: 'auth_observe_open', site: fixture.manifest.name, tabId: 7 }, 7_000)
    expect(bridge._siteLoginCoordinator.login).toHaveBeenCalledWith(fixture.manifest.name, {
      waitMs: 0, skipCheck: true, targetTabId: 7, pageUrl: 'https://passport.example.com/login',
    })
    await expect(bridge.callTool('open_browser', { url: 'https://other.example.net/', adapter: fixture.manifest.name }))
      .rejects.toThrow(/not allowed/)
    expect(bridge.openBrowser).toHaveBeenCalledTimes(2)
  })

  it('forwards code and auth fields of CLI-initiated calls', async () => {
    const bridge = createBridge()
    bridge.callTool = vi.fn(async () => { throw Object.assign(new Error('需要登录'), { code: 'AUTH_REQUIRED', auth: { site: 'fixture.example.com', status: 'waiting_user' } }) })
    const client = connect(bridge)
    await bridge._handleClientRequest({ type: 'call_tool', id: 'cli-1', toolName: 'fixture.example.com.list', args: {}, loginWaitMs: 5000 }, client)
    expect(bridge.callTool).toHaveBeenCalledWith('fixture.example.com.list', {}, null, undefined, { loginWaitMs: 5000 })
    expect(sentTo(client)).toContainEqual(expect.objectContaining({ type: 'call_tool_error', id: 'cli-1', code: 'AUTH_REQUIRED', auth: { site: 'fixture.example.com', status: 'waiting_user' } }))
  })

  it('publishes auth events to clients but not to browser extensions', () => {
    const bridge = createBridge()
    const desktop = connect(bridge)
    const extension = connect(bridge)
    bridge._extensionConnectionMap().set(extension, { instance: 'dedicated' })
    bridge._broadcastToClients({ type: 'auth_event', site: 'fixture.example.com', status: 'waiting_user' })
    expect(sentTo(desktop)).toContainEqual({ type: 'auth_event', site: 'fixture.example.com', status: 'waiting_user' })
    expect(sentTo(extension).some((message) => message.type === 'auth_event')).toBe(false)
  })

  it('publishes profile login events to the caller and desktop, never extensions', () => {
    const bridge = createBridge()
    const caller = connect(bridge)
    const desktop = connect(bridge)
    const extension = connect(bridge)
    bridge._extensionConnectionMap().set(extension, { instance: 'dedicated' })

    bridge._publishSiteLoginEvent(
      { type: 'auth_event', site: 'fixture.example.com', status: 'waiting_user' },
      'profile-fixture',
      caller,
    )

    const expected = { type: 'auth_event', site: 'fixture.example.com', status: 'waiting_user', contextId: 'profile-fixture' }
    expect(sentTo(caller)).toContainEqual(expected)
    expect(sentTo(desktop)).toContainEqual(expected)
    expect(sentTo(extension).some((message) => message.type === 'auth_event')).toBe(false)
  })

  it('answers auth_control with results and never echoes credentials', async () => {
    const bridge = createBridge()
    const vault = { save: vi.fn(async () => ({ enabled: true, username: 'fi****' })), hasCredential: () => true, updateSite: vi.fn(() => ({ enabled: false })), remove: vi.fn(() => true) }
    bridge._siteLoginCoordinator = {
      vault, hasWaitingFlow: () => false,
      status: vi.fn(async () => ({ sites: [], autologinSupported: true })),
      login: vi.fn(async () => ({ site: 'fixture.example.com', status: 'waiting_user' })),
      check: vi.fn(async () => ({ logged_in: true, method: 'cookies' })),
      cancel: vi.fn(() => true),
    }
    const client = connect(bridge)
    const send = async (message) => { client.emit('message', JSON.stringify({ type: 'auth_control', ...message })); await flush(); await flush(); return sentTo(client).at(-1) }
    expect(await send({ id: 'a1', action: 'status', refresh: true })).toMatchObject({ type: 'auth_control_result', id: 'a1', ok: true, result: { sites: [] } })
    expect(await send({ id: 'a2', action: 'login', site: 'fixture.example.com', waitMs: 0 })).toMatchObject({ ok: true, result: { status: 'waiting_user' } })
    expect(bridge._siteLoginCoordinator.login).toHaveBeenCalledWith('fixture.example.com', { waitMs: 0 })
    const saved = await send({ id: 'a3', action: 'save_credential', site: 'fixture.example.com', username: 'fixture-user', password: 'fixture-password' })
    expect(saved).toMatchObject({ ok: true, result: { enabled: true } })
    expect(JSON.stringify(sentTo(client))).not.toContain('fixture-password')
    expect(vault.save).toHaveBeenCalledWith('fixture.example.com', { username: 'fixture-user', password: 'fixture-password' })
    expect(await send({ id: 'a4', action: 'check', site: 'unknown.example.com' })).toMatchObject({ ok: false, error: expect.stringMatching(/does not declare a login/) })
    expect(await send({ id: 'a5', action: 'drop_database' })).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown login action/) })
  })

  it('a per-turn soft hide leaves a waiting login page on screen', async () => {
    const bridge = createBridge()
    bridge._siteLoginCoordinator = { hasWaitingFlow: () => true }
    const client = connect(bridge)
    client.emit('message', JSON.stringify({ type: 'browser_control', id: 'h1', action: 'hide', soft: true }))
    await flush()
    expect(sentTo(client).at(-1)).toMatchObject({ type: 'browser_control_result', id: 'h1', ok: true, skipped: 'login_waiting' })
    expect(bridge._browserHost.control).not.toHaveBeenCalled()
    client.emit('message', JSON.stringify({ type: 'browser_control', id: 'h2', action: 'hide' }))
    await flush()
    expect(bridge._browserHost.control).toHaveBeenCalledWith('hide', { mode: undefined }, client)
  })
})

describe('Bridge managed calls before the browser runs', () => {
  it('starts WeWorker 浏览器 before checking the extension capabilities', async () => {
    const bridge = createBridge()
    const order = []
    bridge._ensureBrowser = vi.fn(async () => {
      order.push('ensure')
      // The extension connects while the browser starts.
      bridge._extensionCapabilities = ['adapter_catalog_v1']
    })
    bridge._requestNow = vi.fn(async (msg) => { order.push(msg.type); return { ok: true } })
    await expect(bridge._callToolInner('fixture.example.com.list', {})).resolves.toEqual({ ok: true })
    expect(order[0]).toBe('ensure')
    expect(order).toContain('call_tool')
  })

  it('still reports an old extension that lacks managed package support', async () => {
    const bridge = createBridge()
    bridge._ensureBrowser = vi.fn(async () => {})
    await expect(bridge._callToolInner('fixture.example.com.list', {})).rejects.toThrow(/Reload the browser extension/)
    // A connected extension with known capabilities needs no browser start.
    bridge._extensionCapabilities = ['some_other_capability']
    bridge._ensureBrowser.mockClear()
    await expect(bridge._callToolInner('fixture.example.com.list', {})).rejects.toThrow(/Reload the browser extension/)
    expect(bridge._ensureBrowser).not.toHaveBeenCalled()
  })
})
