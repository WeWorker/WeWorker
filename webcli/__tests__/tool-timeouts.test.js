import { describe, it, expect } from 'vitest'
import {
  resolveToolCallTimeout,
  QQ_MAIL_TOOL_CALL_TIMEOUT_MS,
  QQ_MAIL_BATCH_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  interruptedCallResult,
} from '../tool-timeouts.js'

describe('resolveToolCallTimeout', () => {
  it('uses 10 minutes for mail.qq.com batch invoice download', () => {
    expect(resolveToolCallTimeout('mail.qq.com.download_invoices_by_invoice')).toBe(
      QQ_MAIL_BATCH_DOWNLOAD_TIMEOUT_MS,
    )
    expect(QQ_MAIL_BATCH_DOWNLOAD_TIMEOUT_MS).toBe(600000)
  })

  it('uses 3 minutes for other mail.qq.com tools', () => {
    expect(resolveToolCallTimeout('mail.qq.com.search_emails')).toBe(QQ_MAIL_TOOL_CALL_TIMEOUT_MS)
    expect(QQ_MAIL_TOOL_CALL_TIMEOUT_MS).toBe(180000)
  })

  it('uses default timeout for other tools', () => {
    expect(resolveToolCallTimeout('workflow.example.com.search_flow')).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS)
    expect(resolveToolCallTimeout('open_browser')).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS)
  })
})

describe('interrupted calls', () => {
  it('reports an unknown write outcome only after a request was sent', () => {
    expect(interruptedCallResult({ safety: 'write' }, true, true).code).toBe('WRITE_OUTCOME_UNKNOWN')
    expect(interruptedCallResult({ safety: 'write' }, true, false).code).toBe('WRITE_OUTCOME_UNKNOWN')
    expect(interruptedCallResult({ safety: 'write' }, false, true).code).toBeUndefined()
    expect(interruptedCallResult({ safety: 'read' }, true, true).code).toBeUndefined()
  })
})
