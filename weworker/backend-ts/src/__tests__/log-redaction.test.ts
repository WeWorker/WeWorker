import { describe, expect, it } from 'vitest'
import { redactLogText, redactLogValue } from '../log-redaction.js'

describe('diagnostic credential redaction', () => {
  it('preserves multiline JSON formatting when there is nothing to redact', () => {
    const text = '{\n  "output": "first",\n  "tail": "RESULT-END"\n}'
    expect(redactLogValue(text)).toBe(text)
  })

  it('identifies binary images and attachments explicitly without logging their data paths', () => {
    const output = redactLogValue([
      { type: 'tool_call_image', id: 'image-call', data: 'fixture-image-bytes' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture-image-bytes' } },
      { type: 'tool_use', id: 'image-call', image: 'fixture-image-bytes', result: 'RESULT-END' },
      { type: 'file_attachment', name: 'report.txt', path: '/fixture-private/reports/report.txt' },
    ])
    const text = JSON.stringify(output)
    expect(text).not.toContain('fixture-image-bytes')
    expect(text).not.toContain('/fixture-private')
    expect(text).toContain('[image omitted]')
    expect(text).toContain('report.txt')
    expect(text).toContain('RESULT-END')
  })
  it('redacts complete HTTP credential headers while retaining subsequent lines', () => {
    const output = redactLogText('Authorization: Basic fixture-basic-value\nCookie: first=fixture-first; second=fixture-second\nSet-Cookie: login=fixture-login; Path=/\nRESULT-END')
    for (const value of ['fixture-basic-value', 'fixture-first', 'fixture-second', 'fixture-login']) expect(output).not.toContain(value)
    expect(output).toContain('RESULT-END')
  })

  it('redacts credential switches with whitespace separators and nested JSON in log text', () => {
    const output = redactLogText('tool: webcli call example.com.list --token fixture-switch-value\nresult={"output":"{\\"api_key\\":\\"fixture-nested-value\\",\\"text\\":\\"RESULT-END\\"}"}')
    expect(output).not.toContain('fixture-switch-value')
    expect(output).not.toContain('fixture-nested-value')
    expect(output).toContain('RESULT-END')
  })

  it('retains useful metrics and full payloads while masking user home prefixes', () => {
    const text = 'a'.repeat(8_000) + '\nC:\\Users\\fixture-user\\reports\\sample.txt\n/home/fixture-user/reports/sample.txt\nEND'
    const output = String(redactLogValue(text))
    expect(output).toContain('a'.repeat(8_000))
    expect(output).not.toContain('fixture-user')
    expect(output).toContain('sample.txt')
    expect(output).toContain('END')
    expect(redactLogValue({ input_tokens: 120, cache_read_tokens: 240, status: 'done' })).toEqual({ input_tokens: 120, cache_read_tokens: 240, status: 'done' })
  })
})
