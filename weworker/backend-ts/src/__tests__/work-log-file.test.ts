import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as logs from '../work-log-file.js'
import { createLogger } from '../logger.js'
import { runWithTurnExecutionContext } from '../memory/turn-execution-context.js'

let directory: string
const workId = '12345678-1234-1234-1234-123456789abc'
const otherId = '12345678-0000-0000-0000-000000000000'
const work = { id: workId, title: 'Public fixture', created_at: '', updated_at: '', messages: [] }
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-log-fixture-'))
  logs.configureWorkLogs?.(directory)
})
afterEach(() => {
  logs.configureWorkLogs?.(undefined)
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('append-only conversation log files', () => {
  it('appends from a fresh backend process without overwriting earlier execution', () => {
    logs.appendWorkLog(workId, 'done', { content: 'BEFORE-RESTART' })
    const before = logs.readWorkLog(work)
    const moduleUrl = new URL('../work-log-file.ts', import.meta.url).href
    const script = 'import { configureWorkLogs, appendWorkLog } from ' + JSON.stringify(moduleUrl)
      + ';configureWorkLogs(' + JSON.stringify(directory) + ');appendWorkLog(' + JSON.stringify(workId)
      + ',"done",{content:"AFTER-RESTART"})'
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), windowsHide: true,
    })
    const output = logs.readWorkLog(work)
    expect(output.startsWith(before)).toBe(true)
    expect(output).toContain('AFTER-RESTART')
  })
  it('writes before export, preserves earlier runs, and isolates full conversation IDs', () => {
    expect(logs.appendWorkLog).toBeTypeOf('function')
    const result = '第一行\n' + '完整中文结果'.repeat(25_000) + '\nRESULT-END'
    logs.appendWorkLog(workId, 'tool_call_result', { result })
    const file = path.join(directory, workId + '.log')
    const first = fs.readFileSync(file, 'utf8')
    expect(first).toContain(JSON.stringify(result))
    logs.appendWorkLog(otherId, 'text_delta', { content: 'OTHER-CONVERSATION' })
    logs.configureWorkLogs(directory)
    logs.appendWorkLog(workId, 'text_delta', { content: 'SECOND-RUN' })
    const copy = logs.readWorkLog(work)
    const download = logs.readWorkLog(work)
    expect(copy).toBe(download)
    expect(copy).toBe(fs.readFileSync(file, 'utf8'))
    expect(copy.startsWith(first)).toBe(true)
    expect(copy).toContain('SECOND-RUN')
    expect(copy).not.toContain('OTHER-CONVERSATION')
  })

  it('writes scoped diagnostic logs, full error stacks and credentials redacted at rest', () => {
    expect(logs.appendWorkLog).toBeTypeOf('function')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('fixture failed')
    error.stack = 'Error: fixture failed\n    at fixture.js:12:1\nSTACK-END'
    runWithTurnExecutionContext({ workId, turnId: 'turn-fixture' }, () => {
      createLogger('fixture').error('tool failed', error)
    })
    logs.appendWorkLog(workId, 'tool_call_start', { args: { api_key: 'fixture-secret-value', query: 'QUERY-END' } })
    const raw = fs.readFileSync(path.join(directory, workId + '.log'), 'utf8')
    expect(raw).toContain('STACK-END')
    expect(raw).toContain('turn-fixture')
    expect(raw).toContain('QUERY-END')
    expect(raw).not.toContain('fixture-secret-value')
  })

  it('creates an explicitly limited legacy snapshot once when no execution file exists', () => {
    expect(logs.readWorkLog).toBeTypeOf('function')
    const legacy = { ...work, messages: [{ id: 'fixture-message', work_id: workId, role: 'user', created_at: '', content: [{ type: 'text' as const, text: '旧消息'.repeat(2_000) + 'LEGACY-END' }] }] }
    const text = logs.readWorkLog(legacy)
    expect(text).toContain('旧版存量消息')
    expect(text).toContain('无法恢复')
    expect(text).not.toContain('LEGACY-END')
    expect(text).toContain('text: [content omitted]')
    logs.appendWorkLog(workId, 'done', {})
    expect(logs.readWorkLog(legacy)).not.toContain('LEGACY-END')
    expect(logs.readWorkLog(legacy)).toContain('done')
  })

  it('does not crash execution on write failure and records a gap when writing recovers', () => {
    expect(logs.appendWorkLog).toBeTypeOf('function')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const blocker = path.join(directory, 'not-a-directory')
    fs.writeFileSync(blocker, '')
    logs.configureWorkLogs(blocker)
    expect(() => logs.appendWorkLog(workId, 'tool_call_result', { result: 'not persisted' })).not.toThrow()
    expect(() => logs.readWorkLog(work)).toThrow()
    fs.unlinkSync(blocker)
    logs.appendWorkLog(workId, 'done', {})
    expect(logs.readWorkLog(work)).toContain('log_write_gap')
  })

  it('rejects IDs that could escape the log directory', () => {
    expect(logs.readWorkLog).toBeTypeOf('function')
    expect(() => logs.readWorkLog({ ...work, id: '../other' })).toThrow('Invalid work ID')
  })
})
