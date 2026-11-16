import WebSocket from 'ws'
import { createLogger } from './logger.js'
import { BridgeExtensionConnections } from './bridge-extension-connections.js'

const log = createLogger('bridge-status')

const BRIDGE_URL = `ws://127.0.0.1:${process.env.WEBCLI_BRIDGE_PORT || 3711}`

export interface AdapterScaffoldGeneratedEvent {
  siteKey: string
  adapterDir?: string
}

export type ExtensionInstance = 'dedicated' | 'system'

export interface AdapterStateChangedEvent {
  profile: string
  previousRevision: number
  revision: number
  adapters: string[]
}

/**
 * Bridge event monitor. Connects to the WebSocket bridge, tracks connection
 * state, and exposes local runtime events such as scaffold generation.
 * It never sends mutation requests to the bridge.
 */
export class BridgeStatus {
  private _ws: WebSocket | null = null
  private _connected = false
  private _extensionConnected = false
  private _extensionVersion: string | null = null
  private _extensionInstance: ExtensionInstance = 'system'
  private readonly _extensionConnections = new BridgeExtensionConnections()
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _stopped = false
  private _adapterScaffoldListeners = new Set<(event: AdapterScaffoldGeneratedEvent) => void>()
  private _adapterStateListeners = new Set<(event: AdapterStateChangedEvent) => void>()

  start(): void {
    this._connect()
  }

  stop(): void {
    this._stopped = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._ws?.close()
  }

  private _connect(): void {
    if (this._stopped) return
    const ws = new WebSocket(BRIDGE_URL)
    this._ws = ws

    ws.on('open', () => {
      this._connected = true
      log.info('connected to bridge')
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this._handleMessage(msg)
      } catch {}
    })

    ws.on('close', () => {
      this._connected = false
      this._extensionConnections.clear()
      this._syncExtensionStatus()
      this._ws = null
      if (!this._stopped) {
        this._reconnectTimer = setTimeout(() => this._connect(), 2000)
      }
    })

    ws.on('error', () => {})
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string

    if (type === 'extension_connected') {
      this._extensionConnections.connected(msg)
      this._syncExtensionStatus()
    } else if (type === 'extension_disconnected') {
      this._extensionConnections.disconnected(msg)
      this._syncExtensionStatus()
    } else if (type === 'adapter_scaffold_generated' || type === 'adapter_installed') {
      const siteKey = typeof msg.siteKey === 'string' ? msg.siteKey.trim() : ''
      if (!siteKey) return
      const event: AdapterScaffoldGeneratedEvent = {
        siteKey,
        ...(typeof msg.adapterDir === 'string' ? { adapterDir: msg.adapterDir } : {}),
      }
      for (const listener of this._adapterScaffoldListeners) {
        try {
          listener(event)
        } catch (e) {
          log.warn('adapter scaffold listener failed', e)
        }
      }
    } else if (type === 'adapter_state_changed') {
      const previousRevision = Number(msg.previousRevision)
      const revision = Number(msg.revision)
      if (!Number.isSafeInteger(previousRevision) || !Number.isSafeInteger(revision)) return
      const event: AdapterStateChangedEvent = {
        profile: typeof msg.profile === 'string' ? msg.profile : '',
        previousRevision,
        revision,
        adapters: Array.isArray(msg.adapters)
          ? msg.adapters.filter((name): name is string => typeof name === 'string')
          : [],
      }
      for (const listener of this._adapterStateListeners) {
        try {
          listener(event)
        } catch (e) {
          log.warn('adapter state listener failed', e)
        }
      }
    }
  }

  private _syncExtensionStatus(): void {
    const status = this._extensionConnections.snapshot()
    this._extensionConnected = status.connected
    this._extensionVersion = status.version
    this._extensionInstance = status.instance
  }

  onAdapterScaffoldGenerated(listener: (event: AdapterScaffoldGeneratedEvent) => void): () => void {
    this._adapterScaffoldListeners.add(listener)
    return () => this._adapterScaffoldListeners.delete(listener)
  }

  onAdapterStateChanged(listener: (event: AdapterStateChangedEvent) => void): () => void {
    this._adapterStateListeners.add(listener)
    return () => this._adapterStateListeners.delete(listener)
  }

  isConnected(): boolean { return this._connected }
  isExtensionConnected(): boolean { return this._extensionConnected }
  getExtensionVersion(): string | null { return this._extensionVersion }
  getExtensionInstance(): ExtensionInstance { return this._extensionInstance }

  /** Test hook: feed one bridge message. */
  handleMessageForTest(msg: Record<string, unknown>): void { this._handleMessage(msg) }
}

export const bridgeStatus = new BridgeStatus()
