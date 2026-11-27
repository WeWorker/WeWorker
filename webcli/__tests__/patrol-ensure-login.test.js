import { describe, expect, it } from 'vitest'
import { createDefaultEnsureLogin, createEnsureLogin } from '../patrol/ensure-login.js'

describe('ensureLogin', () => {
  it('登录态可用时走 session，不碰账号', async () => {
    const calls = []
    const ensureLogin = createEnsureLogin({
      probeSession: async () => { calls.push('session'); return true },
      tryAccounts: async () => { calls.push('accounts'); return null },
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: true, source: 'session' })
    expect(calls).toEqual(['session'])
  })

  it('session 失效则尝试账号', async () => {
    const ensureLogin = createEnsureLogin({
      probeSession: async () => false,
      tryAccounts: async () => ({ account: 'patrol-read' }),
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: true, source: 'account', account: 'patrol-read' })
  })

  it('没有账号时返回 no-account', async () => {
    const ensureLogin = createEnsureLogin({
      probeSession: async () => false,
      tryAccounts: async () => ({ reason: 'no-account' }),
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: false, reason: 'no-account' })
  })

  it('账号都失败返回 login-failed，全 suspect 返回 login-blocked', async () => {
    const failed = createEnsureLogin({ probeSession: async () => false, tryAccounts: async () => ({ reason: 'login-failed' }) })
    expect(await failed('a.com')).toEqual({ ok: false, reason: 'login-failed' })

    const blocked = createEnsureLogin({ probeSession: async () => false, tryAccounts: async () => ({ reason: 'login-blocked' }) })
    expect(await blocked('a.com')).toEqual({ ok: false, reason: 'login-blocked' })
  })

  it('探测自身抛错时降级为 login-failed，不炸整轮巡检', async () => {
    const ensureLogin = createEnsureLogin({
      probeSession: async () => { throw new Error('bridge down') },
      tryAccounts: async () => ({ reason: 'no-account' }),
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: false, reason: 'login-failed' })
  })
})

describe('createDefaultEnsureLogin', () => {
  it('注入 probeStatus 时真实探测登录态', async () => {
    const probes = []
    const ensureLogin = createDefaultEnsureLogin({
      sessionStore: { peek: true },
      probeStatus: async (adapterId, store) => { probes.push([adapterId, store]); return true },
    })
    expect(await ensureLogin('a.com')).toEqual({ ok: true, source: 'session' })
    expect(probes).toEqual([['a.com', { peek: true }]])

    const absent = createDefaultEnsureLogin({ sessionStore: {}, probeStatus: async () => false })
    expect(await absent('a.com')).toEqual({ ok: false, reason: 'no-account' })
  })

  it('未注入 probeStatus 时假定登录态可用（连通层兜底），不误报 no-account', async () => {
    const ensureLogin = createDefaultEnsureLogin({})
    expect(await ensureLogin('a.com')).toEqual({ ok: true, source: 'session' })
  })
})
