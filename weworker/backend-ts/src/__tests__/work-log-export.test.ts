import { describe, expect, it } from 'vitest'
import { buildSavedMessagesLog, summarizeMessage } from '../work-log-export.js'
import type { Message } from '../works-store.js'

const WORK_ID = '2215049d-1234-5678-9abc-def012345678'

function message(content: Message['content'], role = 'user'): Message {
  return { id: 'm1', work_id: WORK_ID, role, content, created_at: '2026-10-31T08:00:00.000Z' } as Message
}

describe('summarizeMessage legacy fallback', () => {
  it('preserves safe routing timings and IDs without exposing tool arguments or results', () => {
    const lines = summarizeMessage(message([
      { type: 'text', text: 'PRIVATE BODY IN TEXT' },
      { type: 'tool_use', id: 't1', name: 'private.example.com.lookup', status: 'success', execMs: 120,
        args: { token: 'PLACEHOLDER_TOKEN', command: 'PRIVATE ARGS' }, result: 'PRIVATE RESULT' },
      { type: 'timing', totalMs: 900, llmMs: 700, execMs: 200, steps: 2,
        routeTool: 'private.example.com.lookup', routeSource: 'pattern', routeArgs: 'PRIVATE ROUTE ARGS' },
    ]))
    expect(lines[0]).toBe('text: [content omitted]')
    expect(lines[1]).toContain('id=t1 status=success execMs=120 args=[omitted] result=[omitted]')
    expect(lines[2]).toContain('totalMs=900 llmMs=700 execMs=200 steps=2 route=tool_selected source=pattern args=[omitted]')
    for (const sensitive of ['PRIVATE BODY', 'private.example.com', 'PLACEHOLDER_TOKEN', 'PRIVATE ARGS', 'PRIVATE RESULT', 'PRIVATE ROUTE ARGS']) {
      expect(lines.join('\n')).not.toContain(sensitive)
    }
  })

  it('omits attachment names and paths, skill content, errors and unknown blocks', () => {
    const lines = summarizeMessage(message([
      { type: 'file_attachment', name: 'PRIVATE_REPORT.pdf', path: 'C:\\Users\\private\\report.pdf', size: 12345 },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE_IMAGE' } },
      { type: 'skill_context', tool_use_id: 't1', name: 'PRIVATE_SKILL', directory: '/home/private/skills', digest: 'PRIVATE_DIGEST', text: 'PRIVATE SKILL BODY' },
      { type: 'error', text: 'TimeoutError: /home/private/file?token=PLACEHOLDER_TOKEN' },
      { type: 'unknown', payload: 'PRIVATE UNKNOWN' } as unknown as Message['content'][number],
    ]))
    const output = lines.join('\n')
    expect(output).toContain('file_attachment: [name and path omitted] sizeBytes=12345')
    expect(output).toContain('image_attachment: [image omitted]')
    expect(output).toContain('skill_context: [content omitted] tool_use_id=t1')
    expect(output).toContain('error: category=TimeoutError')
    expect(output).toContain('block: [unsupported content omitted]')
    for (const sensitive of ['PRIVATE_REPORT', 'C:\\Users', 'PRIVATE_IMAGE', 'PRIVATE_SKILL', 'PRIVATE_DIGEST', 'PRIVATE SKILL BODY', '/home/private', 'PLACEHOLDER_TOKEN', 'PRIVATE UNKNOWN']) {
      expect(output).not.toContain(sensitive)
    }
  })

  it('does not echo untrusted metadata disguised as status, tool ID, route source or error class', () => {
    const output = summarizeMessage(message([
      { type: 'tool_use', id: 'C:\\Users\\private\\key', name: 'tool', args: null, status: 'PRIVATE_STATUS', execMs: -3 },
      { type: 'timing', totalMs: -5, llmMs: 0, execMs: 0, steps: 1, routeSource: 'PRIVATE_SOURCE' },
      { type: 'error', text: 'PrivateError: PRIVATE BODY' },
    ])).join('\n')
    for (const sensitive of ['C:\\Users', 'PRIVATE_STATUS', 'PRIVATE_SOURCE', 'PrivateError', 'PRIVATE BODY', 'execMs=-3', 'totalMs=-5']) {
      expect(output).not.toContain(sensitive)
    }
    expect(output).toContain('error: category=error')
  })

  it('emits a placeholder for empty messages', () => {
    expect(summarizeMessage(message([]))).toEqual(['(empty message)'])
  })
})

describe('saved message fallback', () => {
  it('explains missing execution history and retains work/message identifiers without private title or content', () => {
    const text = buildSavedMessagesLog({ id: WORK_ID, title: 'PRIVATE TITLE /home/private', messages: [message([{ type: 'text', text: 'PRIVATE USER CONTENT' }])] })
    expect(text).toContain('旧版存量消息')
    expect(text).toContain('无法恢复')
    expect(text).toContain('对话 ID: ' + WORK_ID)
    expect(text).toContain('message_id=m1')
    expect(text).toContain('标题: [omitted]')
    expect(text).not.toContain('PRIVATE TITLE')
    expect(text).not.toContain('/home/private')
    expect(text).not.toContain('PRIVATE USER CONTENT')
  })
})
