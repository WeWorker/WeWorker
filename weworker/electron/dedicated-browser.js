/**
 * WeWorker 浏览器 from the desktop side.
 *
 * The Bridge (webcli) owns the browser process: whoever runs the Bridge on
 * port 3711 starts, hides and stops it (see webcli/dedicated-browser.js).
 * The desktop app is one of its clients, like standalone `webcli`:
 * - it attaches on connect, so the browser keeps running while WeWorker runs;
 * - its UI, tray and IPC send fixed actions (status / show / hide / restart /
 *   set_mode), never URLs, paths or executables;
 * - it mirrors the status the Bridge publishes.
 * It never launches or kills a browser itself.
 */
export const BROWSER_MODES = Object.freeze(['dedicated', 'system'])
export const DEFAULT_BROWSER_MODE = 'dedicated'
export const BRIDGE_URL = 'ws://localhost:3711'
const OPEN = 1

export function normalizeBrowserMode(value) {
  return BROWSER_MODES.includes(value) ? value : DEFAULT_BROWSER_MODE
}

const disconnected = (mode, detail) => ({ mode, status: 'bridge_unavailable', browser: null, extensionLoaded: false, extensionConnected: false, detail })

export class BrowserControlClient {
  constructor({
    url = BRIDGE_URL,
    log = () => {},
    WebSocketImpl = globalThis.WebSocket,
    reconnectMs = 2_000,
    requestTimeoutMs = 45_000,
    attachTimeoutMs = 5_000,
  } = {}) {
    this._url = url
    this._log = log
    this._WebSocket = WebSocketImpl
    this._reconnectMs = reconnectMs
    this._requestTimeoutMs = requestTimeoutMs
    this._attachTimeoutMs = attachTimeoutMs
    this._ws = null
    this._stopped = true
    this._reconnectTimer = null
    this._pending = new Map()
    this._nextId = 0
    this._listeners = new Set()
    this._authListeners = new Set()
    this._status = disconnected(DEFAULT_BROWSER_MODE, '正在连接 Bridge')
  }

  /** Last known status; `bridge_unavailable` while the Bridge cannot be reached. */
  getStatus() {
    return { ...this._status }
  }

  onStatus(listener) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  /** Website login progress published by the Bridge (`auth_event`). */
  onAuthEvent(listener) {
    this._authListeners.add(listener)
    return () => this._authListeners.delete(listener)
  }

  /** One fixed website-login action (`auth_control`); resolves with its result. */
  authRequest(action, extra = {}, options = {}) {
    return this._send('auth_control', action, extra, options)
  }

  get connected() {
    return this._ws?.readyState === OPEN
  }

  start() {
    if (!this._stopped) return
    this._stopped = false
    this._connect()
  }

  /** Detach: the Bridge then treats the browser as unused (it stops on its own when idle). */
  stop() {
    this._stopped = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    const ws = this._ws
    this._ws = null
    this._failPending(new Error('Bridge connection closed'))
    try { ws?.close() } catch {}
  }

  /** One fixed action; resolves with the Bridge's browser status. */
  request(action, extra = {}, options = {}) {
    return this._send('browser_control', action, extra, options)
  }

  _send(type, action, extra, { timeoutMs = this._requestTimeoutMs } = {}) {
    if (!this.connected) return Promise.reject(new Error('Bridge 未连接，WeWorker 浏览器暂不可用'))
    const id = `desktop-${++this._nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error('Bridge 未响应'))
      }, timeoutMs)
      timer.unref?.()
      this._pending.set(id, { resolve, reject, timer })
      try {
        this._ws.send(JSON.stringify({ type, id, action, ...extra }))
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(error)
      }
    })
  }

  _connect() {
    if (this._stopped) return
    let ws
    try {
      ws = new this._WebSocket(typeof this._url === 'function' ? this._url() : this._url)
    } catch (error) {
      this._log(`[browser] bridge connection failed: ${error.message}`)
      this._scheduleReconnect()
      return
    }
    this._ws = ws
    ws.addEventListener('open', () => {
      if (this._ws !== ws) return
      this.request('attach', {}, { timeoutMs: this._attachTimeoutMs })
        .catch((error) => {
          if (this._ws !== ws) return
          // An older Bridge (for example a standalone webcli daemon) ignores browser_control.
          this._log(`[browser] bridge does not manage WeWorker browser: ${error.message}`)
          this._setStatus(disconnected(this._status.mode, '当前运行的 Bridge 不支持 WeWorker 浏览器，请更新 webcli 或重启 WeWorker'))
        })
    })
    ws.addEventListener('message', (event) => {
      if (this._ws !== ws) return
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) } catch { return }
      if (msg?.type === 'browser_control_result' || msg?.type === 'auth_control_result') {
        if (msg.browser) this._setStatus(msg.browser)
        const entry = this._pending.get(msg.id)
        if (!entry) return
        this._pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) entry.resolve(msg.type === 'auth_control_result' ? msg.result : msg.browser)
        else entry.reject(new Error(msg.error || '操作失败'))
      } else if (msg?.type === 'browser_status' && msg.browser) {
        this._setStatus(msg.browser)
      } else if (msg?.type === 'auth_event' && typeof msg.site === 'string') {
        for (const listener of this._authListeners) {
          try { listener(msg) } catch {}
        }
      }
    })
    ws.addEventListener('close', () => {
      if (this._ws !== ws) return
      this._ws = null
      this._failPending(new Error('Bridge connection closed'))
      this._setStatus(disconnected(this._status.mode, 'Bridge 未运行'))
      this._scheduleReconnect()
    })
    ws.addEventListener('error', () => {})
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connect()
    }, this._reconnectMs)
    this._reconnectTimer.unref?.()
  }

  _failPending(error) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this._pending.clear()
  }

  _setStatus(status) {
    this._status = { ...status, mode: normalizeBrowserMode(status.mode) }
    for (const listener of this._listeners) {
      try { listener(this.getStatus()) } catch {}
    }
  }
}
