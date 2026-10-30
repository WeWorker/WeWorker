import { describe, expect, it } from 'vitest'
import { cancelWeixinQrSession } from '../weixin-qr-cancel.js'

describe('cancelWeixinQrSession', () => {
  it('clears only the matching active session', () => {
    const state = { sessionId: 'fixture-session', qrcode: 'fixture-qr' }
    expect(cancelWeixinQrSession(state, 'fixture-session')).toBeNull()
    expect(cancelWeixinQrSession(state, 'other-session')).toBe(state)
    expect(cancelWeixinQrSession(state, undefined)).toBe(state)
    expect(cancelWeixinQrSession(null, 'fixture-session')).toBeNull()
  })

  it('does not interrupt a session already saving confirmed credentials', () => {
    const state = { sessionId: 'fixture-session', completing: true }
    expect(cancelWeixinQrSession(state, 'fixture-session')).toBe(state)
  })
})
