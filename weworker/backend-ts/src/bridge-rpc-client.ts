import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createLogger } from './logger.js'

const log = createLogger('bridge-rpc')
const DEFAULT_BRIDGE_URL = 'ws://localhost:3711'
const SENSITIVE_URL_KEY_RE = /api[_-]?key|authorization|cookie|credential|password|passwd|secret|session|ticket|token|csrf/i

export interface ExplorableTab {
  id: number
  title: string
  url: string
  active: boolean
  windowId: number
}

export interface BridgeCapabilities {
  bridgeConnected: boolean
  extensionConnected: boolean
  extensionVersion: string | null
  capabilities: string[]
}

export interface GenerationRunSnapshot {
  id: string
  siteKey: string
  status: string
  [key: string]: unknown
}

export interface GenerationModelConfig {
  provider: string
  protocol: 'anthropic' | 'openai'
  api_key: string
  base_url: string
  model: string
}

export type ActionCaptureSnapshot = Record<string, unknown>

interface PendingRequest {
  expectedTypes: Set<string>
  resolve: (message: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type SocketFactory = (url: string) => WebSocket

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim() !== ''))]
}

function sanitizeExplorableTabUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_KEY_RE.test(key)) url.searchParams.set(key, '[redacted]')
    }
    const hash = url.hash
    if (hash.includes('?')) {
      const hashQueryIndex = hash.indexOf('?')
      const hashPath = hash.slice(0, hashQueryIndex + 1)
      const params = new URLSearchParams(hash.slice(hashQueryIndex + 1))
      for (const key of [...params.keys()]) {
        if (SENSITIVE_URL_KEY_RE.test(key)) params.set(key, '[redacted]')
      }
      url.hash = `${hashPath}${params.toString()}`
    }
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return '[invalid-url]'
  }
}

export class BridgeRpcClient {
  private _ws: WebSocket | null = null
  private _connected = false
  private _extensionConnected = false
  private _extensionVersion: string | null = null
  private _capabilities: string[] = []
  private _stopped = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _pending = new Map<string, PendingRequest>()

  constructor(
    private readonly _url = DEFAULT_BRIDGE_URL,
    private readonly _socketFactory: SocketFactory = (url) => new WebSocket(url),
  ) {}

  start(): void {
    this._stopped = false
    this._connect()
  }

  stop(): void {
    this._stopped = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._rejectPending(new Error('Bridge RPC client stopped'))
    this._ws?.close()
    this._ws = null
    this._connected = false
    this._extensionConnected = false
  }

  getCapabilities(): BridgeCapabilities {
    return {
      bridgeConnected: this._connected,
      extensionConnected: this._extensionConnected,
      extensionVersion: this._extensionVersion,
      capabilities: [...this._capabilities],
    }
  }

  async listExplorableTabs(): Promise<ExplorableTab[]> {
    const message = await this.request(
      { type: 'exploration_list_tabs' },
      ['call_tool_result'],
      10_000,
    )
    const result = asRecord(message.result)
    const tabs = Array.isArray(result.tabs) ? result.tabs : []
    return tabs.flatMap((item) => {
      const tab = asRecord(item)
      if (!Number.isInteger(tab.id) || typeof tab.url !== 'string') return []
      return [{
        id: tab.id as number,
        title: typeof tab.title === 'string' ? tab.title : '',
        url: sanitizeExplorableTabUrl(tab.url),
        active: tab.active === true,
        windowId: Number.isInteger(tab.windowId) ? tab.windowId as number : -1,
      }]
    })
  }

  async runPassiveExploration(tabId: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid tabId is required')
    const message = await this.request(
      { type: 'exploration_capture_passive', tabId },
      ['call_tool_result'],
      120_000,
    )
    return asRecord(message.result)
  }

  async inspectSafeApiActions(tabId: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid tabId is required')
    const message = await this.request(
      { type: 'exploration_safe_actions_inspect', tabId },
      ['call_tool_result'],
      15_000,
    )
    return asRecord(message.result)
  }

  async runSafeApiProbe(input: { tabId: number; candidateId: string; value?: string }): Promise<Record<string, unknown>> {
    if (!Number.isInteger(input.tabId) || input.tabId < 0) throw new Error('A valid tabId is required')
    if (!input.candidateId.trim()) throw new Error('candidateId required')
    const message = await this.request(
      {
        type: 'exploration_safe_probe_run',
        tabId: input.tabId,
        candidateId: input.candidateId,
        value: (input.value || '').slice(0, 80),
      },
      ['call_tool_result'],
      30_000,
    )
    return asRecord(message.result)
  }

  async replayApiCandidate(input: {
    tabId: number
    url: string
    method: string
    headers?: Record<string, unknown>
    body?: string
  }): Promise<Record<string, unknown>> {
    if (!Number.isInteger(input.tabId) || input.tabId < 0) throw new Error('A valid tabId is required')
    const message = await this.request(
      {
        type: 'exploration_replay_candidate',
        tabId: input.tabId,
        url: input.url,
        method: input.method,
        headers: input.headers || {},
        body: input.body || '',
      },
      ['call_tool_result'],
      30_000,
    )
    return asRecord(message.result)
  }

  async startActionCapture(input: {
    tabId: number
    siteKey: string
    actionName: string
    mode?: string
    timeoutSeconds?: number
    pattern?: string
  }): Promise<ActionCaptureSnapshot> {
    const message = await this.request(
      {
        type: 'exploration_action_capture_start',
        tabId: input.tabId,
        siteKey: input.siteKey,
        actionName: input.actionName,
        mode: input.mode || 'intercept',
        timeoutSeconds: input.timeoutSeconds || 60,
        pattern: input.pattern || '',
      },
      ['call_tool_result'],
      10_000,
    )
    return asRecord(message.result)
  }

  async stopActionCapture(input: { tabId: number; siteKey?: string; actionName?: string }): Promise<ActionCaptureSnapshot> {
    const message = await this.request(
      {
        type: 'exploration_action_capture_stop',
        tabId: input.tabId,
        ...(input.siteKey ? { siteKey: input.siteKey } : {}),
        ...(input.actionName ? { actionName: input.actionName } : {}),
      },
      ['call_tool_result'],
      10_000,
    )
    return asRecord(message.result)
  }

  async getActionCapture(input: { tabId: number; siteKey?: string }): Promise<ActionCaptureSnapshot | null> {
    const message = await this.request(
      {
        type: 'exploration_action_capture_get',
        tabId: input.tabId,
        ...(input.siteKey ? { siteKey: input.siteKey } : {}),
      },
      ['call_tool_result'],
      10_000,
    )
    return message.result == null ? null : asRecord(message.result)
  }

  async selectActionCaptureCandidate(input: {
    tabId: number
    siteKey: string
    candidateIndex: number
  }): Promise<ActionCaptureSnapshot> {
    const message = await this.request(
      {
        type: 'exploration_action_capture_select',
        tabId: input.tabId,
        siteKey: input.siteKey,
        candidateIndex: input.candidateIndex,
      },
      ['call_tool_result'],
      10_000,
    )
    return asRecord(message.result)
  }

  async clearActionCapture(input: { tabId: number; siteKey: string }): Promise<ActionCaptureSnapshot> {
    const message = await this.request(
      {
        type: 'exploration_action_capture_clear',
        tabId: input.tabId,
        siteKey: input.siteKey,
      },
      ['call_tool_result'],
      10_000,
    )
    return asRecord(message.result)
  }

  async startGenerationRun(input: {
    siteKey: string
    memory: Record<string, unknown>
    goal: string
    tabId: number | null
    budget?: Record<string, unknown>
    modelConfig?: GenerationModelConfig
    previousRunId?: string
    mode?: 'agent' | 'classic'
  }): Promise<GenerationRunSnapshot> {
    const message = await this.request(
      {
        type: 'start_generation_run',
        siteKey: input.siteKey,
        memory: input.memory,
        goal: input.goal,
        tabId: input.tabId,
        ...(input.budget ? { budget: input.budget } : {}),
        ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}),
        ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      },
      ['start_generation_run_result'],
      30_000,
    )
    return this.readGenerationRun(message)
  }

  async resumeGenerationRun(runId: string, answer: string, modelConfig?: GenerationModelConfig): Promise<GenerationRunSnapshot> {
    const message = await this.request(
      {
        type: 'resume_generation_run',
        runId,
        answer,
        ...(modelConfig ? { modelConfig } : {}),
      },
      ['resume_generation_run_result'],
      30_000,
    )
    return this.readGenerationRun(message)
  }

  async getGenerationRun(runId: string, includeTrace = false): Promise<GenerationRunSnapshot> {
    const message = await this.request(
      { type: 'get_generation_run', runId, includeTrace },
      ['get_generation_run_result'],
      10_000,
    )
    return this.readGenerationRun(message)
  }

  async cancelGenerationRun(runId: string): Promise<GenerationRunSnapshot> {
    const message = await this.request(
      { type: 'cancel_generation_run', runId, reason: 'cancelled from WeWorker client exploration' },
      ['cancel_generation_run_result'],
      10_000,
    )
    return this.readGenerationRun(message)
  }

  async publishGenerationRun(runId: string): Promise<GenerationRunSnapshot> {
    const message = await this.request(
      { type: 'publish_generation_run', runId },
      ['publish_generation_run_result'],
      60_000,
    )
    return this.readGenerationRun(message)
  }

  async refreshAdapterTabs(siteKey: string): Promise<Record<string, unknown>> {
    const message = await this.request(
      { type: 'refresh_adapter_tabs', siteKey },
      ['call_tool_result'],
      15_000,
    )
    return asRecord(message.result)
  }

  async request(
    payload: Record<string, unknown>,
    expectedTypes: string[],
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const ws = this._ws
    if (!ws || !this._connected || ws.readyState !== WebSocket.OPEN) {
      throw new Error('BRIDGE_DISCONNECTED')
    }
    if (!this._extensionConnected) throw new Error('EXTENSION_DISCONNECTED')

    const id = randomUUID()
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`Bridge request timed out: ${String(payload.type || 'unknown')}`))
      }, timeoutMs)
      this._pending.set(id, {
        expectedTypes: new Set(expectedTypes),
        resolve,
        reject,
        timer,
      })
      try {
        ws.send(JSON.stringify({ ...payload, id }))
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private _connect(): void {
    if (this._stopped || this._ws) return
    const ws = this._socketFactory(this._url)
    this._ws = ws

    ws.on('open', () => {
      if (this._ws !== ws) return
      this._connected = true
      log.info('connected to bridge')
    })

    ws.on('message', (data) => {
      if (this._ws !== ws) return
      try {
        this._handleMessage(asRecord(JSON.parse(data.toString())))
      } catch {
        // Ignore malformed messages from unrelated bridge clients.
      }
    })

    ws.on('close', () => {
      if (this._ws !== ws) return
      this._connected = false
      this._extensionConnected = false
      this._extensionVersion = null
      this._capabilities = []
      this._ws = null
      this._rejectPending(new Error('BRIDGE_DISCONNECTED'))
      if (!this._stopped) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null
          this._connect()
        }, 2_000)
      }
    })

    ws.on('error', () => {})
  }

  private _handleMessage(message: Record<string, unknown>): void {
    const type = typeof message.type === 'string' ? message.type : ''
    if (type === 'extension_connected') {
      this._extensionConnected = true
      this._extensionVersion = typeof message.version === 'string' ? message.version : null
      this._capabilities = normalizeCapabilities(message.capabilities)
      return
    }
    if (type === 'extension_disconnected') {
      this._extensionConnected = false
      this._extensionVersion = null
      this._capabilities = []
      this._rejectPending(new Error('EXTENSION_DISCONNECTED'))
      return
    }

    const id = typeof message.id === 'string' ? message.id : ''
    if (!id) return
    const pending = this._pending.get(id)
    if (!pending) return
    if (type === 'call_tool_error') {
      clearTimeout(pending.timer)
      this._pending.delete(id)
      pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Bridge request failed'))
      return
    }
    if (!pending.expectedTypes.has(type)) return
    clearTimeout(pending.timer)
    this._pending.delete(id)
    pending.resolve(message)
  }

  private readGenerationRun(message: Record<string, unknown>): GenerationRunSnapshot {
    if (message.ok === false) {
      throw new Error(typeof message.error === 'string' ? message.error : 'Generation Harness request failed')
    }
    const run = asRecord(message.run)
    if (typeof run.id !== 'string' || typeof run.siteKey !== 'string' || typeof run.status !== 'string') {
      throw new Error('Generation Harness returned an invalid run')
    }
    return run as GenerationRunSnapshot
  }

  private _rejectPending(error: Error): void {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pending.clear()
  }
}

export const bridgeRpcClient = new BridgeRpcClient()
