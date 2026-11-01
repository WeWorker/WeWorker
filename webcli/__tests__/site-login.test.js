import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SiteLoginCoordinator, isAutologinPage } from '../site-login.js'

const manifest = {
  name: 'fixture.example.com', match: ['www.example.com'],
  auth: { login_url: 'https://passport.example.com/login', login_hosts: ['passport.example.com'], check: { cookies: { url: 'https://www.example.com/', all: ['sid'] } } },
  i18n: { zh: { name: '示例站' } },
}
const commandManifest = { ...manifest, name: 'cmd.example.com', auth: { login_url: 'https://www.example.com/signin', check: { command: 'whoami' } } }
const bare = { name: 'bare.example.com', match: ['bare.example.com'] }
const MANIFESTS = { [manifest.name]: manifest, [commandManifest.name]: commandManifest, [bare.name]: bare }

const authError = (extra = {}) => Object.assign(new Error('Session expired'), { code: 'AUTH_REQUIRED', fromExtension: true, auth: { site: manifest.name, phase: 'handler', ...extra } })
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Fake extension + browser. `script` is a list of auth_check states returned in order
 * (the last one repeats): { cookies, open, onLoginPage, url }.
 */
function setup({ script = [{ cookies: false }], mode = 'dedicated', check = async () => null, vault = null, autofill, graceMs = 0 } = {}) {
  const events = []
  const calls = []
  let step = 0
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-login-test-'))
  const browser = {
    mode: () => mode,
    showPage: vi.fn(async () => true),
    hideWindows: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('fixture-jpeg').toString('base64')),
    attachPage: vi.fn(async (url) => ({ url, send: vi.fn(), detach: vi.fn(async () => {}) })),
  }
  const extension = vi.fn(async (type, payload) => {
    calls.push([type, payload])
    if (type === 'auth_open_login') return { tabId: 1, url: 'https://passport.example.com/login' }
    if (type === 'auth_check') {
      const state = script[Math.min(step, script.length - 1)]
      step += 1
      return {
        cookies: state.cookies ?? null, ...(state.fingerprint ? { fingerprint: state.fingerprint } : {}),
        loginTab: { open: state.open !== false, onLoginPage: state.onLoginPage !== false, url: state.url || 'https://passport.example.com/login' },
      }
    }
    throw new Error('unexpected ' + type)
  })
  const coordinator = new SiteLoginCoordinator({
    broadcast: (event) => events.push(event), extension, manifestFor: (site) => MANIFESTS[site] || null,
    runCheckCommand: check, browser, vault, screenshotDir, graceMs, pollMs: 1, autologinWaitMs: 50,
    sleep: () => tick(), ...(autofill ? { autofill } : {}),
  })
  return { coordinator, events, calls, browser, extension, statuses: () => events.map((event) => event.status), screenshotDir }
}

describe('login flow for a failed command', () => {
  it('rethrows failures that are not about login', async () => {
    const { coordinator, extension } = setup()
    const error = Object.assign(new Error('Bad input'), { code: 'INVALID_ARGS', fromExtension: true })
    await expect(coordinator.handleFailure(error, { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: vi.fn() })).rejects.toBe(error)
    const local = new Error('Explicit confirmation is required')
    await expect(coordinator.handleFailure(local, { site: bare.name, command: { id: 'x' }, retry: vi.fn() })).rejects.toBe(local)
    expect(extension).not.toHaveBeenCalled()
  })

  it('opens the login page in the background, waits for the user and retries the read', async () => {
    const { coordinator, browser, statuses, calls } = setup({ script: [{ cookies: false }, { cookies: false }, { cookies: false }, { cookies: true, onLoginPage: false, url: 'https://www.example.com/' }] })
    const retry = vi.fn(async () => ({ rows: 3 }))
    await expect(coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry, loginWaitMs: 5_000 })).resolves.toEqual({ rows: 3 })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(browser.showPage).not.toHaveBeenCalled()
    expect(browser.hideWindows).not.toHaveBeenCalled()
    expect(statuses()).toEqual(['login_required', 'waiting_user', 'logged_in'])
    expect(calls[0]).toEqual(['auth_open_login', { site: manifest.name }])
    expect((await coordinator.status({ sites: [manifest, bare] })).sites).toEqual([
      expect.objectContaining({ site: manifest.name, name: '示例站', state: 'logged_in', flow: null }),
    ])
  })

  it('continues silently when the session is still valid (no browser shown)', async () => {
    const { coordinator, browser, statuses } = setup({ script: [{ cookies: true, onLoginPage: false }], graceMs: 50 })
    await coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'ok' })
    expect(browser.showPage).not.toHaveBeenCalled()
    expect(statuses()).toEqual(['login_required', 'logged_in'])
  })

  it('never replays a write that already started, but retries one stopped before its code ran', async () => {
    const started = setup({ script: [{ cookies: true, onLoginPage: false }] })
    const retry = vi.fn()
    await expect(started.coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'post', safety: 'write' }, retry }))
      .rejects.toMatchObject({ code: 'AUTH_RETRY_REQUIRED', auth: { status: 'logged_in' } })
    expect(retry).not.toHaveBeenCalled()

    const stopped = setup({ script: [{ cookies: true, onLoginPage: false }] })
    await expect(stopped.coordinator.handleFailure(authError({ phase: 'navigation' }), { site: manifest.name, command: { id: 'post', safety: 'write' }, retry: async () => 'posted' }))
      .resolves.toBe('posted')
  })

  it('returns waiting_user without presenting a full-page image when no QR code was found', async () => {
    const { coordinator, events, screenshotDir } = setup({ script: [{ cookies: false }] })
    const error = await coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: vi.fn(), loginWaitMs: 30 }).catch((e) => e)
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED', auth: { status: 'waiting_user', site: manifest.name } })
    expect(error.auth).not.toHaveProperty('screenshot')
    expect(fs.readFileSync(path.join(screenshotDir, `${manifest.name}.jpg`), 'utf8')).toBe('fixture-jpeg')
    expect(coordinator.hasWaitingFlow()).toBe(true)
    // A second call joins the same flow instead of opening another login page.
    const second = coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'second' , loginWaitMs: 5_000 })
    coordinator.cancel(manifest.name)
    await expect(second).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    expect(events.filter((event) => event.status === 'login_required')).toHaveLength(1)
    expect(coordinator.hasWaitingFlow()).toBe(false)
  })

  it('treats a closed login tab as cancelled', async () => {
    const { coordinator } = setup({ script: [{ cookies: false }, { cookies: false, open: false }] })
    await expect(coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: vi.fn(), loginWaitMs: 5_000 }))
      .rejects.toMatchObject({ code: 'AUTH_CANCELLED', auth: { status: 'cancelled' } })
  })

  it('runs the declared check command only after the user left the login page', async () => {
    const check = vi.fn(async () => true)
    const { coordinator } = setup({ check, script: [{ onLoginPage: true }, { onLoginPage: true }, { onLoginPage: false, url: 'https://www.example.com/' }] })
    const error = Object.assign(new Error('Login required'), { code: 'AUTH_REQUIRED', fromExtension: true, auth: { site: commandManifest.name, phase: 'navigation' } })
    await expect(coordinator.handleFailure(error, { site: commandManifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'done', loginWaitMs: 5_000 })).resolves.toBe('done')
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith(commandManifest.name, 'whoami')
  })

  it('asks the declared check whether an ordinary failure was a lost session', async () => {
    const loggedOut = setup({ check: async () => false, script: [{ onLoginPage: false, url: 'https://www.example.com/' }] })
    const failure = Object.assign(new Error('Unexpected page'), { fromExtension: true })
    // The check says "not logged in": the flow starts (and here the user never finishes).
    await expect(loggedOut.coordinator.handleFailure(failure, { site: commandManifest.name, command: { id: 'list', safety: 'read' }, retry: vi.fn(), loginWaitMs: 20 }))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', auth: { status: 'waiting_user' } })
    loggedOut.coordinator.cancel(commandManifest.name)

    const loggedIn = setup({ check: async () => true })
    await expect(loggedIn.coordinator.handleFailure(failure, { site: commandManifest.name, command: { id: 'list', safety: 'read' }, retry: vi.fn() })).rejects.toBe(failure)
    // The check command itself never recurses into a check.
    const self = setup({ check: vi.fn(async () => false) })
    await expect(self.coordinator.handleFailure(failure, { site: commandManifest.name, command: { id: 'whoami', safety: 'read' }, retry: vi.fn() })).rejects.toBe(failure)
  })

  it('opens the generic start page for Adapters without an auth declaration', async () => {
    const { coordinator, calls } = setup({ script: [{ open: true, onLoginPage: false, url: 'https://bare.example.com/' }] })
    const error = Object.assign(new Error('Login'), { code: 'AUTH_REQUIRED', auth: { site: bare.name, phase: 'navigation', pageUrl: 'https://sso.example.org/login' } })
    await expect(coordinator.handleFailure(error, { site: bare.name, command: { id: 'list', safety: 'read' }, retry: async () => 'ok' })).resolves.toBe('ok')
    expect(calls[0]).toEqual(['auth_open_login', { site: bare.name, url: 'https://sso.example.org/login' }])
  })
})

describe('auto-login', () => {
  function fakeVault(overrides = {}) {
    const prefs = { enabled: true, configured: true, username: 'fi****', lastResult: null, lastAttemptAt: null, dismissed: false, logins: 0, ...overrides }
    return {
      supported: true,
      prefs,
      updates: [],
      site: () => ({ ...prefs }),
      updateSite(site, patch) {
        this.updates.push(patch)
        if ('last_result' in patch) prefs.lastResult = patch.last_result
        if ('last_attempt_at' in patch) prefs.lastAttemptAt = patch.last_attempt_at
        if ('manual_logins' in patch) prefs.logins = patch.manual_logins
        return { ...prefs }
      },
      load: vi.fn(async () => ({ username: 'fixture-user', password: 'fixture-password' })),
    }
  }

  it('fills the saved password without showing the browser when the login succeeds', async () => {
    const vault = fakeVault()
    const autofill = vi.fn(async () => ({ ok: true }))
    const { coordinator, browser, statuses, events } = setup({ vault, autofill, script: [{ cookies: false }, { cookies: false }, { cookies: true, onLoginPage: false }] })
    await expect(coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'ok' })).resolves.toBe('ok')
    expect(autofill).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://passport.example.com/login' }), { username: 'fixture-user', password: 'fixture-password' }, {})
    expect(browser.showPage).not.toHaveBeenCalled()
    expect(statuses()).toEqual(['login_required', 'autologin_started', 'logged_in'])
    expect(events.at(-1).autologin).toBe(true)
    expect(JSON.stringify(events)).not.toContain('fixture-password')
    expect(vault.prefs.lastResult).toBe('success')
  })

  it('hands over to the user when the page offers no password form, then waits 10 minutes before trying again', async () => {
    const vault = fakeVault()
    const autofill = vi.fn(async () => ({ ok: false, reason: 'no_password_field' }))
    const first = setup({ vault, autofill, script: [{ cookies: false }, { cookies: false }, { cookies: true, onLoginPage: false }] })
    await first.coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'ok' })
    expect(first.statuses()).toEqual(['login_required', 'autologin_started', 'autologin_failed', 'waiting_user', 'logged_in'])
    expect(first.events[2].message).toMatch(/扫码或短信验证码/)
    expect(first.browser.showPage).not.toHaveBeenCalled()

    const again = setup({ vault, autofill, script: [{ cookies: false }, { cookies: true, onLoginPage: false }] })
    await again.coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'ok' })
    expect(autofill).toHaveBeenCalledTimes(1)
    expect(again.statuses()).toEqual(['login_required', 'waiting_user', 'logged_in'])
  })

  it('offers auto-login after the second manual login', async () => {
    const vault = fakeVault({ enabled: false, configured: false, logins: 1 })
    const { coordinator, events } = setup({ vault, script: [{ cookies: false }, { cookies: true, onLoginPage: false }] })
    await coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry: async () => 'ok' })
    expect(events.at(-1)).toMatchObject({ status: 'logged_in', offerAutologin: true })
  })

  it('types only into HTTPS (or local test) pages on hosts the site declares', () => {
    expect(isAutologinPage(manifest, 'https://passport.example.com/login')).toBe(true)
    expect(isAutologinPage(manifest, 'https://www.example.com/signin')).toBe(true)
    expect(isAutologinPage(manifest, 'http://passport.example.com/login')).toBe(false)
    expect(isAutologinPage(manifest, 'https://passport.example.com.evil.example.net/login')).toBe(false)
    expect(isAutologinPage({ name: 'local', match: ['localhost'], auth: { login_url: 'http://localhost:8080/login' } }, 'http://localhost:8080/login')).toBe(true)
  })
})

describe('explicit login', () => {
  it('reports already_logged_in without opening anything', async () => {
    const { coordinator, calls } = setup({ script: [{ cookies: true }] })
    await expect(coordinator.login(manifest.name)).resolves.toEqual({ site: manifest.name, status: 'already_logged_in' })
    expect(calls.map(([type]) => type)).toEqual(['auth_check'])
  })

  it('binds an observed login tab and shows that exact page only on request', async () => {
    const { coordinator, browser, calls } = setup({ script: [{ cookies: false }] })
    const result = await coordinator.login(manifest.name, {
      waitMs: 0, skipCheck: true, targetTabId: 42, pageUrl: 'https://passport.example.com/login',
    })
    expect(result).toMatchObject({ site: manifest.name, status: 'waiting_user' })
    expect(calls[0]).toEqual(['auth_open_login', {
      site: manifest.name, url: 'https://passport.example.com/login', tabId: 42,
    }])
    expect(browser.showPage).not.toHaveBeenCalled()
    await expect(coordinator.show(manifest.name)).resolves.toMatchObject({ shown: true, site: manifest.name })
    expect(browser.showPage).toHaveBeenCalledWith('https://passport.example.com/login')
    coordinator.cancel(manifest.name)
  })
})

describe('stale session cookies', () => {
  it('waits for a changed session cookie when an expired session left its cookie behind', async () => {
    const stale = { cookies: true, fingerprint: 'aaaaaaaa' }
    const { coordinator, statuses } = setup({ script: [
      { ...stale, onLoginPage: true }, { ...stale, onLoginPage: true }, { ...stale, onLoginPage: true },
      { cookies: true, fingerprint: 'bbbbbbbb', onLoginPage: true },
    ] })
    const retry = vi.fn(async () => 'ok')
    await expect(coordinator.handleFailure(authError(), { site: manifest.name, command: { id: 'list', safety: 'read' }, retry, loginWaitMs: 5_000 })).resolves.toBe('ok')
    expect(statuses()).toEqual(['login_required', 'waiting_user', 'logged_in'])
  })
})
