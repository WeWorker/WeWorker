import { describe, expect, it } from 'vitest'

import { classifyTestTitle, parseNodeTestOutput } from '../api-adapter-test-evidence.js'

describe('API Adapter executable test evidence', () => {
  it('classifies success, error, and safety titles conservatively', () => {
    expect(classifyTestTitle('example.read maps overview rows')).toBe('success')
    expect(classifyTestTitle('example.read maps authentication errors')).toBe('error')
    expect(classifyTestTitle('example.write requires confirmation before auth')).toBe('safety')
  })

  it('parses only completed Node test result lines', () => {
    expect(parseNodeTestOutput([
      '✔ example.read maps overview rows (2.5ms)',
      '✖ example.read maps authentication errors (3ms)',
      'ℹ tests 2',
    ].join('\n'), 'aiep.test.mjs')).toEqual([
      {
        file: 'aiep.test.mjs',
        title: 'example.read maps overview rows',
        category: 'success',
        status: 'PASS',
      },
      {
        file: 'aiep.test.mjs',
        title: 'example.read maps authentication errors',
        category: 'error',
        status: 'FAIL',
      },
    ])
  })

  it('uses certification filenames instead of keywords inside tool names', () => {
    expect(parseNodeTestOutput(
      '✔ tickets.example.com.confirm_ticket accepts mocked success response (2ms)',
      'api-adapter-success-smoke.test.mjs',
    )[0].category).toBe('success')
    expect(parseNodeTestOutput(
      '✔ tickets.example.com.reject_ticket handles mocked API failure (2ms)',
      'api-adapter-failure-smoke.test.mjs',
    )[0].category).toBe('error')
  })
})
