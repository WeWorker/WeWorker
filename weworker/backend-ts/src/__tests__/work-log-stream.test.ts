import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as logs from '../work-log-file.js'
import { getTurnExecutionContext } from '../memory/turn-execution-context.js'

let directory: string
const workId = 'fixture-stream'
const work = { id: workId, messages: [] }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-stream-'))
  logs.configureWorkLogs(directory)
})
afterEach(() => {
  logs.configureWorkLogs(undefined)
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('execution stream logging', () => {
  it('persists full events before delivery and preserves diagnostic context inside the producer', async () => {
    expect(logs.recordWorkLogStream).toBeTypeOf('function')
    const first = { type: 'tool_call_start', id: 'call-1', args: { query: 'q'.repeat(1_000) } }
    const result = { type: 'tool_call_result', id: 'call-1', result: '中文'.repeat(30_000) + 'TOOL-END' }
    async function* source() {
      expect(getTurnExecutionContext()?.workId).toBe(workId)
      yield first
      yield result
      yield { type: 'done' }
    }
    const output = []
    for await (const event of logs.recordWorkLogStream(workId, source(), { message: 'INPUT-END' })) {
      output.push(event)
      expect(logs.readWorkLog(work)).toContain(JSON.stringify(event))
    }
    expect(output).toEqual([first, result, { type: 'done' }])
    expect(logs.readWorkLog(work)).toContain('INPUT-END')
    expect(logs.readWorkLog(work)).toContain('"status":"completed"')
  })

  it('retains partial output and records thrown errors without swallowing them', async () => {
    expect(logs.recordWorkLogStream).toBeTypeOf('function')
    async function* source() {
      yield { type: 'text_delta', content: 'PARTIAL-END' }
      throw new Error('fixture failure')
    }
    const output = logs.recordWorkLogStream(workId, source(), {})
    await output.next()
    await expect(output.next()).rejects.toThrow('fixture failure')
    const text = logs.readWorkLog(work)
    expect(text).toContain('PARTIAL-END')
    expect(text).toContain('fixture failure')
    expect(text).toContain('"status":"failed"')
  })

  it('marks error events as failed even if the producer later emits done', async () => {
    expect(logs.recordWorkLogStream).toBeTypeOf('function')
    async function* source() {
      yield { type: 'error', content: 'fixture error event' }
      yield { type: 'done' }
    }
    for await (const _ of logs.recordWorkLogStream(workId, source(), {})) { /* consume */ }
    expect(logs.readWorkLog(work)).toContain('"status":"failed"')
  })

  it('closes the producer and records cancellation when a consumer stops early', async () => {
    expect(logs.recordWorkLogStream).toBeTypeOf('function')
    let closed = false
    async function* source() {
      try { yield { type: 'text_delta', content: 'BEFORE-CANCEL' } }
      finally { closed = true }
    }
    const abort = new AbortController()
    for await (const _ of logs.recordWorkLogStream(workId, source(), {}, abort.signal)) {
      abort.abort()
      break
    }
    expect(closed).toBe(true)
    expect(logs.readWorkLog(work)).toContain('BEFORE-CANCEL')
    expect(logs.readWorkLog(work)).toContain('"status":"cancelled"')
  })
})
