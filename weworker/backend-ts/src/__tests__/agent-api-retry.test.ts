import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mapSdkMessage } from '../agent.js'

describe('model API retry progress', () => {
  it.each([
    [400, 'invalid_request'], [401, 'authentication_failed'], [429, 'rate_limit'],
    [500, 'server_error'], [503, 'overloaded'], [null, 'unknown'],
  ] as const)('immediately forwards HTTP %s / %s without waiting for a result', (status, error) => {
    const message = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
      retry_delay_ms: 1200, error_status: status, error, uuid: '00000000-0000-0000-0000-000000000001', session_id: 'fixture-session' } as unknown as SDKMessage
    const events = [...mapSdkMessage(message, true, [])]
    expect(events).toEqual([expect.objectContaining({ type: 'api_retry', attempt: 1, maxRetries: 3,
      retryDelayMs: 1200, errorStatus: status, errorType: error, content: expect.stringContaining('第 1/3 次') })])
    expect(events[0].content).toContain(status === null ? '网络连接错误' : `HTTP ${status}`)
  })

  it('forwards every retry count, including subsequent failures', () => {
    const events = [1, 2, 3].flatMap(attempt => [...mapSdkMessage({ type: 'system', subtype: 'api_retry',
      attempt, max_retries: 3, retry_delay_ms: 1000, error_status: 500, error: 'server_error',
      uuid: `00000000-0000-0000-0000-00000000000${attempt}`, session_id: 'fixture-session' } as unknown as SDKMessage, false, [])])
    expect(events.map(event => event.attempt)).toEqual([1, 2, 3])
  })

  it('continues to surface non-retryable assistant errors before the final result', () => {
    const events = [...mapSdkMessage({ type: 'assistant', error: 'billing_error',
      message: { content: [{ type: 'text', text: 'HTTP 402: fixture billing error' }] },
      parent_tool_use_id: null, uuid: '00000000-0000-0000-0000-000000000010', session_id: 'fixture-session' } as unknown as SDKMessage, true, [])]
    expect(events).toEqual([{ type: 'error', content: 'HTTP 402: fixture billing error' }])
  })
})
