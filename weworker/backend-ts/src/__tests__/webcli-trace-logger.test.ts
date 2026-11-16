import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as logs from '../work-log-file.js'
import { chatTurns } from '../chat-turn-lifecycle.js'
import { wireWebcliTraceLogging, type TraceClient } from '../webcli-trace-logger.js'
import type { BridgeTraceEvent } from '../bridge-rpc-client.js'

let directory: string
const workId = 'fixture-trace'
const work = { id: workId, messages: [] }

// `wireWebcliTraceLogging` is a one-shot startup hook. Wire one hub for the
// whole file and point each test's fixture at it, so per-test clients do not
// depend on the module-level `wired` flag or on test execution order.
let listener: ((event: BridgeTraceEvent) => void) | null = null
let activeClient: TraceClient | null = null
const hub: TraceClient = {
  onTraceEvent(next) {
    listener = next
    return () => { if (listener === next) listener = null }
  },
  request(payload, expectedTypes, timeoutMs) {
    if (!activeClient) return Promise.reject(new Error('fixture client not selected'))
    return activeClient.request(payload, expectedTypes, timeoutMs)
  },
}

function fixtureClient(logsByTrace: Record<string, string[]>, failRequests = false): { emit: (event: BridgeTraceEvent) => void } {
  activeClient = {
    onTraceEvent() { throw new Error('fixture client must not be wired directly') },
    async request(payload) {
      if (failRequests) throw new Error('EXTENSION_DISCONNECTED')
      if (payload.type !== 'get_trace_logs') throw new Error('unexpected request')
      const traceID = String(payload.traceID)
      return { type: 'get_trace_logs_result', traceID, logs: logsByTrace[traceID] ?? [] }
    },
  }
  return { emit: event => listener?.(event) }
}

function stage(traceID: string, stageName: BridgeTraceEvent['stage'], extra: Partial<BridgeTraceEvent> = {}): BridgeTraceEvent {
  return { type: 'trace_event', workId, traceID, toolName: 'mail.example.com.search-emails', stage: stageName, ...extra }
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-trace-'))
  logs.configureWorkLogs(directory)
  activeClient = null
  wireWebcliTraceLogging(hub)
})
afterEach(() => {
  logs.configureWorkLogs(undefined)
  fs.rmSync(directory, { recursive: true, force: true })
  chatTurns.stop(workId, 0)
})

describe('webcli trace events → work log', () => {
  it('writes stage events under the active turn and pulls extension logs on completion', async () => {
    expect(chatTurns.start(workId, 'turn-active-1')).toBeTruthy()
    const { emit } = fixtureClient({
      trace01: ['[t] [trace01] [ServiceWorker] 收到 call_tool', '[t] [trace01] [ContentScript] call_tool 完成'],
    })

    emit(stage('trace01', 'received', { loginWaitMs: 0 }))
    emit(stage('trace01', 'dispatched', { timeoutMs: 120000 }))
    emit(stage('trace01', 'done', { durationMs: 1234 }))
    await new Promise(resolve => setTimeout(resolve, 20))

    const lines = logs.readWorkLog(work).split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    const stages = lines.filter(l => l.type === 'webcli.stage')
    expect(stages.map(s => s.data.stage)).toEqual(['received', 'dispatched', 'done'])
    for (const line of stages) expect(line.turnId).toBe('turn-active-1')
    expect(stages[1].data.timeoutMs).toBe(120000)
    const extLog = lines.find(l => l.type === 'webcli.ext_log')
    expect(extLog?.data.trigger).toBe('completion')
    expect(extLog?.data.logs).toHaveLength(2)
  })

  it('drops malformed events and rejects unknown work IDs without writing', () => {
    const { emit } = fixtureClient({})
    emit({ type: 'trace_event', workId: '../escape', traceID: 'trace02', toolName: 't', stage: 'received' })
    emit({ type: 'trace_event', workId, traceID: '', toolName: 't', stage: 'received' })
    expect(logs.readWorkLog(work).split('\n').filter(l => l.startsWith('{'))).toHaveLength(0)
  })

  it('keeps error stage metadata (code, auth) and skips empty extension buffers', async () => {
    const { emit } = fixtureClient({ trace03: [] })
    emit(stage('trace03', 'error', { code: 'AUTH_REQUIRED', auth: { site: 'mail.example.com', status: 'waiting_user' } }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const lines = logs.readWorkLog(work).split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0].data.code).toBe('AUTH_REQUIRED')
    expect(lines[0].data.auth).toEqual({ site: 'mail.example.com', status: 'waiting_user' })
  })

  it('swallows bridge request failures: the stage trail still lands', async () => {
    const { emit } = fixtureClient({}, true)
    emit(stage('trace04', 'done'))
    await new Promise(resolve => setTimeout(resolve, 20))
    const stages = logs.readWorkLog(work).split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l))
    expect(stages.map(s => s.data.stage)).toEqual(['done'])
  })
})
