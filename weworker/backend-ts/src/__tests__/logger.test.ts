import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../logger.js'
import { runWithTurnExecutionContext } from '../memory/turn-execution-context.js'

describe('logger turn context', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tags every log level inside an async turn and leaves outside logs untagged', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger('fixture')

    await runWithTurnExecutionContext({ workId: '12345678-work', turnId: 'turn-1' }, async () => {
      await Promise.resolve()
      log.debug('received')
      log.info('started')
      log.warn('retrying')
      log.error('failed')
    })
    log.info('outside')

    const lines = [...output.mock.calls, ...warning.mock.calls, ...error.mock.calls].map(([line]) => String(line))
    expect(lines).toHaveLength(5)
    for (const level of ['DEBUG', 'INFO', 'WARN', 'ERROR']) {
      expect(lines.some((line) => line.includes(`[${level}]`) && line.includes('[work:12345678][turn:turn-1]'))).toBe(true)
    }
    expect(lines.find((line) => line.includes('outside'))).not.toContain('[work:')
  })

  it('retains the complete stack when an Error is attached to a log entry', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('fixture failure')
    error.stack = 'Error: fixture failure\n    at fixtureOperation (example.js:42:5)\n    at fixtureCaller (example.js:8:2)'
    runWithTurnExecutionContext({ workId: '12345678-work', turnId: 'fixture-turn' }, () => {
      createLogger('fixture').error('tool failed', error)
    })
    const lines = String(output.mock.calls[0][0]).split('\n')
    expect(lines).toHaveLength(3)
    for (const [index, detail] of error.stack.split('\n').entries()) {
      expect(lines[index]).toContain(detail)
      expect(lines[index]).toContain('[work:12345678][turn:fixture-turn]')
    }
  })

  it('tags continuation lines even when the caller already tagged the first line', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    runWithTurnExecutionContext({ workId: '12345678-work', turnId: 'fixture-turn' }, () => {
      createLogger('fixture').error('[work:12345678] first\nsecond\nlast')
    })
    const lines = String(output.mock.calls[0][0]).split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line.match(/\[work:12345678\]/g)).toHaveLength(1)
  })
})
