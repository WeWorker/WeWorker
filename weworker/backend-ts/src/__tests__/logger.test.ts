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
})
