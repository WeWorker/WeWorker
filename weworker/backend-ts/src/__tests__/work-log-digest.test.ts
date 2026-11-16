import { describe, expect, it } from 'vitest'
import { digestWorkLog } from '../work-log-digest.js'

function envelope(time: string, type: string, data: unknown, turnId = 'turn0001'): string {
  return JSON.stringify({ time, type, turnId, data })
}

const BASE_HOUR = '2026-11-14T12:'
function at(second: number, ms = 0): string {
  // Seconds roll over into minutes so fixtures always hold valid timestamps.
  const minute = 48 + Math.floor(second / 60)
  return `${BASE_HOUR}${String(minute).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.${String(ms).padStart(3, '0')}Z`
}

describe('digestWorkLog (field-compact view)', () => {
  it('renders raw event types and field values without semantic rewriting', () => {
    const raw = [
      envelope(at(27), 'webcli.stage', { stage: 'received', traceId: 'ab12cd34ef56', toolName: 'mail.example.com.search-emails', loginWaitMs: 75000 }),
      envelope(at(28), 'webcli.stage', { stage: 'dispatched', traceId: 'ab12cd34ef56', toolName: 'mail.example.com.search-emails', timeoutMs: 120000 }),
      envelope(at(30), 'route_diagnostic', { phase: 'route_complete', engine: 'deterministic', status: 'miss', reason: 'no_eligible_candidate', fallback: 'llm' }),
    ].join('\n') + '\n'
    const out = digestWorkLog(raw, 'work-digest')
    // Field names and values appear verbatim — no translation layer to go stale.
    expect(out).toContain('| webcli.stage | stage=received traceId=ab12cd34ef56 toolName=mail.example.com.search-emails loginWaitMs=75000')
    expect(out).toContain('| webcli.stage | stage=dispatched traceId=ab12cd34ef56 toolName=mail.example.com.search-emails timeoutMs=120000')
    expect(out).toContain('| route_diagnostic | phase=route_complete engine=deterministic status=miss reason=no_eligible_candidate fallback=llm')
  })

  it('strips only the redundant prefix of diagnostic messages (both tag styles)', () => {
    const raw = [
      envelope(at(31), 'diagnostic', { source: 'chat', level: 'INFO', message: '2026-11-14 20:48:31.000 [chat] [INFO] [work:ab12cd34][turn:turn0001] request_received messageChars=14' }),
      envelope(at(32), 'diagnostic', { source: 'agent', level: 'INFO', message: '2026-11-14 20:48:32.000 [agent] [INFO] [turn:turn0001] [work:ab12cd34] turn_start model=glm-5.2' }),
    ].join('\n') + '\n'
    const out = digestWorkLog(raw, 'work-digest')
    expect(out).toContain('| diagnostic | source=chat level=INFO message=request_received messageChars=14')
    expect(out).toContain('| diagnostic | source=agent level=INFO message=turn_start model=glm-5.2')
    expect(out).not.toContain('[work:ab12cd34]')
  })

  it('drops the inner type twin, truncates long values, and lists ext_log lines verbatim', () => {
    const raw = [
      envelope(at(33), 'tool_call_start', { type: 'tool_call_start', id: 'call-1', name: 'PowerShell', args: { command: 'x'.repeat(400) } }),
      envelope(at(34), 'webcli.ext_log', {
        traceId: 'ab12cd34ef56', trigger: 'completion', count: 2,
        logs: [
          '[2026-11-14T13:38:38.126Z] [ab12cd34ef56] [ServiceWorker] call_tool 错误: Timeout waiting for element',
          '[2026-11-14T13:39:31.307Z] [ab12cd34ef56] [ServiceWorker] call_tool 内部耗时 3638ms',
        ],
      }),
      envelope(at(35), 'done', { type: 'done' }),
    ].join('\n') + '\n'
    const out = digestWorkLog(raw, 'work-digest')
    // Inner `type` twin is dropped (envelope already says it), long args truncated.
    expect(out).toContain('name=PowerShell args={"command":"xxxxx')
    expect(out).not.toContain('type=tool_call_start')
    expect(out).not.toContain('type=done')
    // Extension log lines stay verbatim (timestamps included), indented under the event.
    expect(out).toContain('| webcli.ext_log | traceId=ab12cd34ef56 trigger=completion count=2 新增2行')
    expect(out).toContain('    [2026-11-14T13:38:38.126Z] [ab12cd34ef56] [ServiceWorker] call_tool 错误: Timeout waiting for element')
  })

  it('shows repeated ext_log pulls for one traceId without repeating lines, and renders long tool results as blocks', () => {
    const shared = '[2026-11-15T02:43:07.718Z] [ab12cd34ef56] [ServiceWorker] 收到 call_tool: t'
    const fresh = '[2026-11-15T02:44:09.585Z] [ab12cd34ef56] [ContentScript] call_tool 完成: t'
    const raw = [
      envelope(at(40), 'webcli.ext_log', { traceId: 'ab12cd34ef56', trigger: 'stuck_60s', count: 1, logs: [shared] }),
      envelope(at(41), 'tool_call_result', {
        id: 'call-9', isError: false,
        result: '[WebCLI] 需要登录：登录页已打开\n{\n  "emails": [\n    {"id": "e1"}\n  ],\n  "trace_id": "ab12cd34ef56"\n}',
      }),
      envelope(at(42), 'webcli.ext_log', { traceId: 'ab12cd34ef56', trigger: 'completion', count: 2, logs: [shared, fresh] }),
    ].join('\n') + '\n'
    const out = digestWorkLog(raw, 'work-digest')
    // The completion pull repeats the stuck snapshot's line: only the new one is listed.
    expect(out).toContain('trigger=completion count=2 新增1行')
    expect((out.match(new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length).toBe(1)
    expect(out).toContain(`    ${fresh}`)
    // Tool results render as indented blocks: notices AND result JSON survive.
    expect(out).toContain('| tool_call_result | id=call-9 isError=false')
    expect(out).toContain('    [WebCLI] 需要登录：登录页已打开')
    expect(out).toContain('    "emails": [')
    expect(out).toContain('    "trace_id": "ab12cd34ef56"')
  })

  it('starts a section per turn and skips corrupt lines', () => {
    const raw = [
      '{"time":"2026-11-14T12:00:00.000Z","type":"route_diagnostic","turnId":"aaaa1111","ata":{"phase":"route_config"}}', // torn write
      envelope('2026-11-14T12:00:01.000Z', 'message_saved', { role: 'user', content: [{ type: 'text', text: '第一轮' }] }, 'aaaa1111'),
      envelope('2026-11-14T12:05:00.000Z', 'message_saved', { role: 'user', content: [{ type: 'text', text: '第二轮' }] }, 'bbbb2222'),
    ].join('\n') + '\n'
    const out = digestWorkLog(raw, 'work-digest')
    expect(out).toContain('── 第 1 轮 · aaaa1111 ──')
    expect(out).toContain('── 第 2 轮 · bbbb2222 ──')
    expect(out).toContain('| message_saved | id=') // envelope fields are gone; raw data fields stay
    expect(out).toContain('text=第一轮')
    expect(out).not.toContain('"ata"')
  })
})
