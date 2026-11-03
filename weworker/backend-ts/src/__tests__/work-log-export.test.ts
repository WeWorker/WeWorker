import { describe, expect, it } from 'vitest'
import { buildSavedMessagesLog, summarizeMessage } from '../work-log-export.js'
import type { Message } from '../works-store.js'

const WORK_ID = '2215049d-1234-5678-9abc-def012345678'

function message(content: Message['content'], role = 'user'): Message {
  return { id: 'm1', work_id: WORK_ID, role, content, created_at: '2026-10-31T08:00:00.000Z' } as Message
}

describe('summarizeMessage', () => {
  it('preserves the full text, tool arguments, results and timing', () => {
    const lines = summarizeMessage(message([
      { type: 'text', text: 'x'.repeat(500) },
      { type: 'tool_use', id: 't1', name: 'weoa.example.com.list', status: 'success', execMs: 120,
        args: { mode: 'available' }, result: '{"ok":true}' },
      { type: 'timing', totalMs: 900, llmMs: 700, execMs: 200, steps: 2 },
    ]))
    expect(lines[0]).toBe(`text: ${'x'.repeat(500)}`)
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

  it('keeps long multiline arguments, results, errors and loaded skill content', () => {
    const command = 'webcli call example.com.list --query=' + 'q'.repeat(500)
    const result = 'first line\n' + 'r'.repeat(4_000) + '\nRESULT-END'
    const error = 'Error: fixture\n' + 'e'.repeat(500) + '\nERROR-END'
    const skill = '# Fixture skill\n' + 's'.repeat(2_000) + '\nSKILL-END'
    const output = summarizeMessage(message([
      { type: 'tool_use', id: 'fixture-call', name: 'weworker_powershell', args: { command }, result, status: 'done' },
      { type: 'error', text: error },
      { type: 'skill_context', tool_use_id: 'fixture-call', name: 'fixture-skill', directory: '/fixture/skill', digest: 'fixture-digest', text: skill },
    ])).join('\n')
    expect(output).toContain(command)
    expect(output).toContain(result)
    expect(output).toContain(error)
    expect(output).toContain(skill)
    expect(output).toContain('fixture-call')
  })

  it('redacts credentials in full messages, nested JSON results and command arguments without losing result tails', () => {
    const output = summarizeMessage(message([
      { type: 'text', text: 'Authorization: Bearer fixture-bearer-value\nCookie: session=fixture-cookie-value\nvisible tail' },
      { type: 'tool_use', id: 'fixture-call', name: 'example.com.list', args: { api_key: 'fixture-api-value', command: 'webcli call example.com.list --password="fixture password value"' },
        result: JSON.stringify({ secret: 'fixture-secret-value', nested: JSON.stringify({ token: 'fixture-nested-value', output: 'RESULT-END' }) }) },
    ])).join('\n')
    for (const secret of ['fixture-bearer-value', 'fixture-cookie-value', 'fixture-api-value', 'fixture password value', 'fixture-secret-value', 'fixture-nested-value']) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('visible tail')
    expect(output).toContain('RESULT-END')
  })
})


describe('saved message fallback', () => {
  it('preserves legacy messages while explicitly identifying missing execution history', () => {
    const text = buildSavedMessagesLog({ title: 'Fixture', messages: [message([{ type: 'text', text: 'x'.repeat(4_000) + 'END' }])] })
    expect(text).toContain('旧版存量消息')
    expect(text).toContain('无法恢复')
    expect(text).toContain('x'.repeat(4_000) + 'END')
  })
})
