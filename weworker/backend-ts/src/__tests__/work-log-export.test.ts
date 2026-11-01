import { describe, expect, it } from 'vitest'
import { buildWorkLogExport, filterWorkLogLines, summarizeMessage } from '../work-log-export.js'
import type { Message } from '../works-store.js'

const WORK_ID = '2215049d-1234-5678-9abc-def012345678'

function message(content: Message['content'], role = 'user'): Message {
  return { id: 'm1', work_id: WORK_ID, role, content, created_at: '2026-10-31T08:00:00.000Z' } as Message
}

describe('summarizeMessage', () => {
  it('summarizes text, tool_use and timing blocks without full payloads', () => {
    const lines = summarizeMessage(message([
      { type: 'text', text: 'x'.repeat(500) },
      { type: 'tool_use', id: 't1', name: 'weoa.example.com.list', status: 'success', execMs: 120,
        args: { mode: 'available' }, result: '{"ok":true}' },
      { type: 'timing', totalMs: 900, llmMs: 700, execMs: 200, steps: 2 },
    ]))
    expect(lines[0]).toMatch(/^text: x{100}…$/)
    expect(lines[1]).toContain('tool_use: weoa.example.com.list')
    expect(lines[1]).toContain('status=success')
    expect(lines[1]).toContain('execMs=120')
    expect(lines[1]).toContain('args={"mode":"available"}')
    expect(lines[1]).toContain('result={"ok":true}')
    expect(lines[2]).toContain('timing: totalMs=900 llmMs=700 execMs=200 steps=2')
  })

  it('keeps file attachments by name only and omits image payloads', () => {
    const lines = summarizeMessage(message([
      { type: 'file_attachment', name: 'report.pdf', path: 'C:\\Users\\dev\\report.pdf', size: 12345 },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBB' } },
    ]))
    expect(lines).toContain('file_attachment: report.pdf (12345B)')
    expect(lines).toContain('image_attachment: [image omitted]')
  })

  it('emits a placeholder for empty messages', () => {
    expect(summarizeMessage(message([]))).toEqual(['(empty message)'])
  })
})

describe('filterWorkLogLines', () => {
  it('keeps lines tagged with the short work marker or the full id, redacted', () => {
    const lines = [
      '[2026-10-31T08:00:01Z] [node] [work:2215049d] turn_start model=claude',
      '[2026-10-31T08:00:02Z] [bridge] [Bridge] [work:2215049d] 收到调用: weoa.example.com.list',
      `[2026-10-31T08:00:03Z] [node] other work ${WORK_ID} inline`,
      '[2026-10-31T08:00:04Z] [bridge] [Bridge] [work:ffffffff] 收到调用: unrelated',
      '[2026-10-31T08:00:05Z] [node] [work:2215049d] token=superSecretValue',
    ]
    const kept = filterWorkLogLines(lines, WORK_ID)
    expect(kept).toHaveLength(4)
    expect(kept[0]).toContain('turn_start')
    expect(kept.some((l) => l.includes('unrelated'))).toBe(false)
    expect(kept.some((l) => l.includes('superSecretValue'))).toBe(false)
  })

  it('does not match a different work sharing the 8-char prefix boundary', () => {
    const lines = ['[work:2215049e] noise']
    expect(filterWorkLogLines(lines, WORK_ID)).toEqual([])
  })
})

describe('buildWorkLogExport', () => {
  it('renders header, timeline and tagged chain logs, with a fallback note when none match', () => {
    const text = buildWorkLogExport({
      work: { id: WORK_ID, title: '测试对话', created_at: '2026-10-31T07:59:00.000Z', updated_at: '2026-10-31T08:05:00.000Z' },
      messages: [message([{ type: 'text', text: 'hi' }], 'user')],
      logLines: ['[work:2215049d] tool_call Bash → allow cmd="webcli call x.y"'],
      meta: { exportedAt: '2026-10-31T08:10:00.000Z', runtimeMode: 'managed', backendInstanceId: 'inst-1',
        platform: 'win32', nodeVersion: 'v20.0.0', logFilePath: 'C:\\Users\\dev\\AppData\\userData\\logs\\main.log' },
    })
    expect(text).toContain('WeWorker 对话日志导出')
    expect(text).toContain('对话 ID: ' + WORK_ID)
    expect(text).toContain('[work:2215049d] tool_call Bash')
    expect(text).toContain('共 1 行')

    const empty = buildWorkLogExport({
      work: { id: WORK_ID, title: '', created_at: '2026-10-31T07:59:00.000Z', updated_at: '2026-10-31T08:05:00.000Z' },
      messages: [], logLines: ['unrelated'],
      meta: { exportedAt: '2026-10-31T08:10:00.000Z', runtimeMode: 'standalone', backendInstanceId: '',
        platform: 'win32', nodeVersion: 'v20.0.0', logFilePath: '' },
    })
    expect(empty).toContain('（空: 该对话期间没有带标记的日志')
  })
})
