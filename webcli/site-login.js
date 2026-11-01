/**
 * Website login flow, owned by the Bridge.
 *
 * When a command reports AUTH_REQUIRED the Bridge (not the model) opens the
 * site's login page, shows WeWorker 浏览器, detects completion itself and
 * retries the command. The same flow serves the desktop app and standalone
 * webcli. Login methods do not matter: QR codes, SMS codes and passwords are
 * all completed by the user on the real login page; completion is detected
 * from the page and the Adapter's declared check, never from the method.
 *
 * Retry rules: reads are retried once after login. A write is retried only
 * when it was stopped before its code ran (phase "navigation"); otherwise the
 * caller gets AUTH_RETRY_REQUIRED and decides, so a write is never replayed.
 *
 * Optional auto-login (off by default, per site) types a saved password into
 * the login page over CDP; see credential-vault.js and site-autologin.js.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { autofillLogin } from './site-autologin.js';
import { adapterPagePatterns, hostMatchesPattern } from './host-scope.js';

export const DEFAULT_LOGIN_WAIT_MS = 75_000;
export const MAX_LOGIN_WAIT_MS = 15 * 60_000;
const FLOW_TIMEOUT_MS = 10 * 60_000;
const AUTOLOGIN_COOLDOWN_MS = 10 * 60_000;
const SCREENSHOT_REFRESH_MS = 15_000;
const STOPPED_CODES = new Set(['CONFIRMATION_REQUIRED', 'INVALID_ARGS', 'ADAPTER_COMMAND_UNAVAILABLE']);

const AUTOLOGIN_REASONS = {
  no_password_field: '登录页没有账号密码表单（可能只支持扫码或短信验证码）',
  fill_failed: '无法填写登录表单',
  still_on_login_page: '提交后仍停留在登录页（可能需要验证码、二次验证，或密码已更改）',
  unsafe_page: '登录页地址不在该网站声明的范围内',
  error: '自动登录出错',
};

function codedError(code, message, auth = null) {
  return Object.assign(new Error(message), { code, ...(auth ? { auth } : {}) });
}

function decodeQrImage(dataUrl) {
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { bytes, ext: 'png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, ext: 'jpg' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { bytes, ext: 'webp' };
  return null;
}

const hostMatches = hostMatchesPattern;

/** Auto-login types only into HTTPS pages (or local test pages) on the site's declared hosts. */
export function isAutologinPage(manifest, value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) return false;
  const auth = manifest?.auth || {};
  const hosts = [...adapterPagePatterns(manifest), ...(Array.isArray(auth.login_hosts) ? auth.login_hosts : [])];
  try { hosts.push(new URL(auth.login_url).hostname); } catch { /* No declared login URL. */ }
  return hosts.some((pattern) => hostMatches(url.hostname.toLowerCase(), pattern));
}

export function siteName(manifest) {
  return manifest?.auth?.display_name || manifest?.i18n?.zh?.name || manifest?.name || '';
}

/** Adapter capability policy; user preferences still default to disabled. */
export function siteAutologinMode(manifest) {
  return manifest?.auth?.autologin?.mode === 'off' ? 'off' : 'auto';
}

export class SiteLoginCoordinator {
  constructor({
    log = () => {},
    broadcast = () => {},
    extension,
    manifestFor,
    runCheckCommand = async () => null,
    browser,
    vault = null,
    screenshotDir = path.join(os.homedir(), '.webcli', 'login'),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs = 1_500,
    graceMs = 2_000,
    autologinWaitMs = 20_000,
    flowTimeoutMs = FLOW_TIMEOUT_MS,
    autofill = autofillLogin,
    fileSystem = fs,
  }) {
    this._log = log;
    this._broadcast = broadcast;
    this._extension = extension;
    this._manifestFor = manifestFor;
    this._runCheckCommand = runCheckCommand;
    this._browser = browser;
    this._vault = vault;
    this._screenshotDir = screenshotDir;
    this._now = now;
    this._sleep = sleep;
    this._pollMs = pollMs;
    this._graceMs = graceMs;
    this._autologinWaitMs = autologinWaitMs;
    this._flowTimeoutMs = flowTimeoutMs;
    this._autofill = autofill;
    this._fs = fileSystem;
    this._flows = new Map();
    this._states = new Map();
  }

  get vault() { return this._vault; }

  /** A login page is on screen and waiting for the user. */
  hasWaitingFlow() {
    return [...this._flows.values()].some((flow) => flow.status === 'waiting_user');
  }

  // ── Called by the Bridge for a failed command ─────────────────────────────

  /**
   * Turn a command failure into the login flow when it is a login problem.
   * Returns the retried result, or throws the (possibly structured) error.
   */
  async handleFailure(error, { site, command, retry, loginWaitMs = DEFAULT_LOGIN_WAIT_MS }) {
    const manifest = site ? this._manifestFor(site) : null;
    if (!manifest) throw error;
    let auth = error?.code === 'AUTH_REQUIRED' ? { site, phase: 'handler', ...(error.auth || {}) } : null;
    if (!auth && await this._failureIsLogin(error, manifest, command)) auth = { site, phase: 'handler' };
    if (!auth) throw error;
    auth.site = manifest.name;
    this._setState(manifest.name, 'logged_out');

    const flow = this._ensureFlow(manifest, { pageUrl: error?.auth?.pageUrl });
    const outcome = await this._waitFor(flow, loginWaitMs);
    const name = siteName(manifest);
    if (outcome === 'logged_in') {
      const safeToRetry = (command?.safety || 'read') === 'read' || auth.phase === 'navigation';
      if (!safeToRetry) {
        throw codedError('AUTH_RETRY_REQUIRED', `已完成 ${name} 登录。该命令是写操作且可能已开始执行，为避免重复执行没有自动重试；请确认后重新执行。`, { ...auth, status: 'logged_in' });
      }
      try {
        return await retry();
      } catch (retryError) {
        if (retryError?.code === 'AUTH_REQUIRED') {
          throw codedError('AUTH_REQUIRED', `${name} 登录后仍提示需要登录：${retryError.message}`, { ...auth, status: 'still_required' });
        }
        throw retryError;
      }
    }
    if (outcome === 'cancelled') throw codedError('AUTH_CANCELLED', `已取消 ${name} 登录。`, { ...auth, status: 'cancelled' });
    if (outcome === 'failed') {
      throw codedError('AUTH_REQUIRED', `需要登录 ${name}，但无法打开登录页（${flow.error || '未知原因'}）。请运行 webcli browser show，在 WeWorker 浏览器中手动登录后重试。`, { ...auth, status: 'failed' });
    }
    if (outcome === 'timeout') throw codedError('AUTH_REQUIRED', `${name} 登录等待超时。`, { ...auth, status: 'timeout' });
    // Still waiting: the caller's wait ended; the flow keeps running and reports completion as an event.
    const screenshot = flow.qr?.available && flow.screenshot ? { screenshot: flow.screenshot } : {};
    throw codedError('AUTH_REQUIRED',
      `需要登录 ${name}：登录页已在 WeWorker 浏览器中打开（支持扫码、短信验证码或账号密码），用户完成登录后重新执行此命令即可。`,
      { ...auth, status: 'waiting_user', ...screenshot });
  }

  /** A failure on a site with a declared check: ask the check whether the session is gone. */
  async _failureIsLogin(error, manifest, command) {
    const check = manifest.auth?.check;
    // Only failures reported by the page or background run; not local validation or timeouts.
    if (!check || error?.fromExtension !== true || STOPPED_CODES.has(error?.code) || command?.auth === 'none') return false;
    if (check.command && command?.id === check.command) return false;
    return (await this.check(manifest.name).catch(() => null))?.logged_in === false;
  }

  // ── Login state ───────────────────────────────────────────────────────────

  _setState(site, state) {
    this._states.set(site, { state, checkedAt: new Date(this._now()).toISOString() });
  }

  /** `{ logged_in: true | false | null, method }` from the declared check, without opening login pages. */
  async check(site, { cookiesOnly = false } = {}) {
    const manifest = this._manifestFor(site);
    if (!manifest) throw new Error(`Adapter "${site}" is not available.`);
    const check = manifest.auth?.check || {};
    let loggedIn = null;
    let method = 'none';
    if (check.cookies) {
      method = 'cookies';
      const result = await this._extension('auth_check', { site }, 15_000);
      loggedIn = result?.cookies ?? null;
    }
    if (loggedIn !== false && check.command && !cookiesOnly) {
      method = check.cookies ? 'cookies+command' : 'command';
      loggedIn = await this._runCheckCommand(site, check.command);
    }
    if (loggedIn !== null) this._setState(site, loggedIn ? 'logged_in' : 'logged_out');
    return { logged_in: loggedIn, method };
  }

  /** Sites that declare `auth`, with cached state and auto-login preferences (no secrets). */
  async status({ sites = [], refresh = false } = {}) {
    const list = [];
    for (const manifest of sites) {
      if (!manifest?.auth) continue;
      if (refresh && manifest.auth.check?.cookies) await this.check(manifest.name, { cookiesOnly: true }).catch(() => {});
      const cached = this._states.get(manifest.name);
      const flow = this._flows.get(manifest.name);
      const mode = siteAutologinMode(manifest);
      const preferences = this._vault ? this._vault.site(manifest.name) : {};
      list.push({
        site: manifest.name,
        name: siteName(manifest),
        state: cached?.state || 'unknown',
        checkedAt: cached?.checkedAt || null,
        flow: flow ? flow.status : null,
        autologin: this._vault
          ? { supported: this._vault.supported, allowed: mode !== 'off', mode, ...preferences, ...(mode === 'off' ? { enabled: false } : {}) }
          : { supported: false, allowed: mode !== 'off', mode },
      });
    }
    return { sites: list, autologinSupported: !!this._vault?.supported };
  }

  // ── Explicit actions ──────────────────────────────────────────────────────

  /** `webcli login <site>` / the desktop "登录" button: check first, then run the flow. */
  async login(site, { waitMs = DEFAULT_LOGIN_WAIT_MS, skipCheck = false, targetTabId, pageUrl } = {}) {
    const manifest = this._manifestFor(site);
    if (!manifest) throw new Error(`Adapter "${site}" is not available.`);
    if (!this._flows.has(site) && !skipCheck && manifest.auth?.check) {
      const current = await this.check(site).catch(() => null);
      if (current?.logged_in === true) return { site, status: 'already_logged_in' };
    }
    const flow = this._ensureFlow(manifest, { manual: true, targetTabId, pageUrl });
    const outcome = await this._waitFor(flow, waitMs);
    return {
      site, status: outcome === 'pending' ? 'waiting_user' : outcome,
      ...(flow.qr?.available && flow.screenshot ? { screenshot: flow.screenshot } : {}),
      ...(flow.qr ? { qr: flow.qr } : {}),
    };
  }

  cancel(site) {
    const flow = this._flows.get(site);
    if (!flow) return false;
    flow.cancelled = true;
    return true;
  }

  /** Focus this site's current login page without exposing a URL to desktop clients. */
  async show(site) {
    const manifest = this._manifestFor(site);
    const flow = manifest ? this._flows.get(manifest.name) : null;
    if (!flow || flow.status !== 'waiting_user') return { shown: false, reason: 'NO_WAITING_LOGIN' };

    if (this._browser.mode() === 'dedicated' && flow.url) {
      try {
        await this._browser.showPage(flow.url);
        flow.shown = true;
        return { shown: true, site: manifest.name };
      } catch (error) {
        this._log(`[login] ${manifest.name} direct show failed, refreshing login tab: ${error.message}`);
      }
    }

    const opened = await this._extension('auth_open_login', {
      site: manifest.name, focus: this._browser.mode() !== 'dedicated',
    }, 20_000);
    if (opened?.url) flow.url = opened.url;
    if (!flow.url) return { shown: false, reason: 'LOGIN_TAB_UNAVAILABLE' };
    if (this._browser.mode() === 'dedicated') {
      await this._browser.showPage(flow.url);
      flow.shown = true;
    }
    return { shown: true, site: manifest.name };
  }

  // ── The flow ──────────────────────────────────────────────────────────────

  _ensureFlow(manifest, options = {}) {
    const existing = this._flows.get(manifest.name);
    if (existing) return existing;
    let resolve;
    const flow = {
      site: manifest.name, status: 'login_required', cancelled: false, shown: false,
      screenshot: null, screenshotVersion: 0, qr: null,
      done: new Promise((r) => { resolve = r; }),
    };
    this._flows.set(manifest.name, flow);
    this._runFlow(manifest, flow, options)
      .catch((error) => {
        this._log(`[login] ${manifest.name} flow failed: ${error.message}`);
        flow.error = error.message;
        this._emit(manifest, flow, 'failed', { message: error.message });
        return 'failed';
      })
      .then((outcome) => {
        if (this._flows.get(manifest.name) === flow) this._flows.delete(manifest.name);
        resolve(outcome);
      });
    return flow;
  }

  async _waitFor(flow, waitMs) {
    const limit = Math.max(0, Math.min(MAX_LOGIN_WAIT_MS, Number(waitMs) || 0));
    let timer;
    const pending = new Promise((resolve) => { timer = setTimeout(() => resolve('pending'), limit); timer.unref?.(); });
    try { return await Promise.race([flow.done, pending]); } finally { clearTimeout(timer); }
  }

  _emit(manifest, flow, status, extra = {}) {
    flow.status = status;
    this._broadcast({
      type: 'auth_event', site: manifest.name, name: siteName(manifest), status,
      autologinMode: siteAutologinMode(manifest), at: new Date(this._now()).toISOString(), ...extra,
    });
  }

  async _runFlow(manifest, flow, { pageUrl, manual = false, targetTabId } = {}) {
    const site = manifest.name;
    const deadline = this._now() + this._flowTimeoutMs;
    this._emit(manifest, flow, 'login_required');
    const opened = await this._extension('auth_open_login', {
      site,
      ...(pageUrl ? { url: pageUrl } : {}),
      ...(Number.isInteger(targetTabId) ? { tabId: targetTabId } : {}),
    }, 20_000);
    flow.url = opened?.url || '';
    const finish = async (outcome, extra = {}) => {
      if (flow.shown && outcome !== 'timeout') await this._browser.hideWindows().catch(() => {});
      if (outcome === 'logged_in') this._setState(site, 'logged_in');
      this._emit(manifest, flow, outcome, extra);
      return outcome;
    };

    // Grace period: a session that is still valid redirects away from the login page by itself.
    const graceEnd = this._now() + (manual ? 0 : this._graceMs);
    for (;;) {
      const state = await this._evaluate(manifest, flow);
      if (state !== 'waiting') return finish(state === 'done' ? 'logged_in' : 'cancelled');
      if (this._now() >= graceEnd) break;
      await this._sleep(Math.min(500, this._pollMs));
    }

    const autologin = await this._tryAutologin(manifest, flow);
    if (autologin === 'logged_in') return finish('logged_in', { autologin: true });

    flow.qr = await this._prepareQrLogin(manifest, flow);

    // Keep the prepared login page in the background. The user can open the
    // exact login tab from the desktop notice when convenient.
    await this._refreshScreenshot(manifest, flow);
    this._emit(manifest, flow, 'waiting_user', {
      ...(flow.qr?.available && flow.screenshot ? { screenshot: flow.screenshot, screenshotVersion: flow.screenshotVersion } : {}),
      ...(flow.qr ? { qr: flow.qr } : {}),
    });
    let lastShot = this._now();
    while (this._now() < deadline) {
      if (flow.cancelled) return finish('cancelled');
      const state = await this._evaluate(manifest, flow);
      if (state === 'done') {
        this._recordManualLogin(manifest);
        return finish('logged_in', this._offerAutologin(manifest));
      }
      if (state === 'closed') return finish('cancelled');
      if (this._now() - lastShot >= SCREENSHOT_REFRESH_MS) {
        // QR codes expire and refresh on the page; keep the copy for remote users current.
        await this._refreshScreenshot(manifest, flow);
        const refreshedQr = flow.qr?.available ? await this._prepareQrLogin(manifest, flow) : null;
        if (refreshedQr?.available) flow.qr = refreshedQr;
        lastShot = this._now();
        if (flow.qr?.available && flow.screenshot) {
          this._emit(manifest, flow, 'waiting_user', {
            screenshot: flow.screenshot, screenshotVersion: flow.screenshotVersion, screenshotUpdated: true,
            ...(flow.qr ? { qr: flow.qr } : {}),
          });
        }
      }
      await this._sleep(this._pollMs);
    }
    if (flow.shown) await this._browser.hideWindows().catch(() => {});
    return finish('timeout');
  }

  /** 'done' | 'waiting' | 'closed' */
  async _evaluate(manifest, flow) {
    if (flow.cancelled) return 'closed';
    const check = manifest.auth?.check || {};
    let status;
    try {
      status = await this._extension('auth_check', { site: manifest.name }, 15_000);
    } catch (error) {
      this._log(`[login] ${manifest.name} check failed: ${error.message}`);
      return 'waiting';
    }
    const tabOpen = status?.loginTab?.open !== false;
    const onLoginPage = tabOpen && status?.loginTab?.onLoginPage === true;
    if (status?.loginTab?.url) flow.url = status.loginTab.url;
    // The session cookies as they were when login was found to be needed. An expired
    // session may leave its cookie behind: only a changed value proves a new login.
    if (flow.baseline === undefined) flow.baseline = status?.fingerprint ?? null;
    const freshCookies = !!status?.fingerprint && status.fingerprint !== flow.baseline;
    if (status?.cookies === false) return tabOpen ? 'waiting' : 'closed';
    if (status?.cookies === true && !check.command && (freshCookies || !onLoginPage)) return tabOpen || freshCookies ? 'done' : 'closed';
    if (onLoginPage) return 'waiting';
    if (check.command) {
      const verified = await this._runCheckCommand(manifest.name, check.command);
      if (verified === true) return 'done';
      if (verified === false) return tabOpen ? 'waiting' : 'closed';
      // The check itself failed. After leaving the login page this counts as signed in
      // (the retried command reports AUTH_REQUIRED again if not); a closed tab is a cancel.
      return tabOpen ? 'done' : 'closed';
    }
    // No declared check: leaving the login page means signed in; closing it means cancelled.
    return tabOpen ? 'done' : 'closed';
  }

  async _prepareQrLogin(manifest, flow) {
    // QR discovery is a host default. Adapters only opt out when the site has no
    // QR login or automatic probing is inappropriate.
    if (manifest.auth?.qr?.mode === 'off') return null;
    try {
      const result = await this._extension('auth_prepare_qr', { site: manifest.name }, 10_000);
      if (!result || typeof result !== 'object') return { available: false, method: 'heuristic' };
      this._log(`[login] ${manifest.name} QR preparation: available=${result.available === true} clicked=${result.clicked === true} image=${typeof result.imageDataUrl === 'string' && result.imageDataUrl.length > 0} reason=${result.reason || 'none'}`);
      const qr = {
        available: result.available === true,
        method: 'heuristic',
        ...(result.clicked === true ? { clicked: true } : {}),
      };
      const image = decodeQrImage(result.imageDataUrl);
      if (image) {
        this._fs.mkdirSync(this._screenshotDir, { recursive: true });
        const file = path.join(this._screenshotDir, `${manifest.name}.qr.${image.ext}`);
        this._fs.writeFileSync(file, image.bytes);
        qr.image = file;
        qr.imageVersion = (flow?.qr?.imageVersion || 0) + 1;
      }
      return qr;
    } catch (error) {
      this._log(`[login] ${manifest.name} QR preparation failed: ${error.message}`);
      return { available: false, method: 'heuristic' };
    }
  }

  async _refreshScreenshot(manifest, flow) {
    if (this._browser.mode() !== 'dedicated' || !flow.url) return false;
    try {
      const data = await this._browser.screenshot(flow.url);
      if (!data) return false;
      this._fs.mkdirSync(this._screenshotDir, { recursive: true });
      const file = path.join(this._screenshotDir, `${manifest.name}.jpg`);
      this._fs.writeFileSync(file, Buffer.from(data, 'base64'));
      flow.screenshot = file;
      flow.screenshotVersion += 1;
      return true;
    } catch (error) {
      this._log(`[login] screenshot failed: ${error.message}`);
      return false;
    }
  }

  // ── Auto-login ────────────────────────────────────────────────────────────

  _recordManualLogin(manifest) {
    if (!this._vault || siteAutologinMode(manifest) === 'off') return;
    const site = manifest.name;
    try {
      const current = this._vault.site(site);
      this._vault.updateSite(site, { manual_logins: current.logins + 1 });
    } catch { /* Preferences are best effort. */ }
  }

  /** Offer auto-login after the second manual login, unless the Adapter forbids it or the user declined it. */
  _offerAutologin(manifest) {
    if (!this._vault?.supported || siteAutologinMode(manifest) === 'off') return {};
    const prefs = this._vault.site(manifest.name);
    return !prefs.enabled && !prefs.dismissed && prefs.logins >= 2 ? { offerAutologin: true } : {};
  }

  async _tryAutologin(manifest, flow) {
    const site = manifest.name;
    if (siteAutologinMode(manifest) === 'off') return 'skipped';
    if (!this._vault?.supported || this._browser.mode() !== 'dedicated') return 'skipped';
    const prefs = this._vault.site(site);
    if (!prefs.enabled) return 'skipped';
    const last = Date.parse(prefs.lastAttemptAt || '') || 0;
    if (prefs.lastResult !== 'success' && this._now() - last < AUTOLOGIN_COOLDOWN_MS) return 'skipped';
    const fail = (reason) => {
      this._vault.updateSite(site, { last_result: 'failed', last_attempt_at: new Date(this._now()).toISOString() });
      this._emit(manifest, flow, 'autologin_failed', { reason, message: AUTOLOGIN_REASONS[reason] || AUTOLOGIN_REASONS.error });
      return 'failed';
    };
    if (!isAutologinPage(manifest, flow.url)) return fail('unsafe_page');
    this._emit(manifest, flow, 'autologin_started');
    let page = null;
    try {
      const credential = await this._vault.load(site);
      if (!credential) return 'skipped';
      page = await this._browser.attachPage(flow.url);
      if (!page || !isAutologinPage(manifest, page.url)) return fail('unsafe_page');
      const filled = await this._autofill(page, credential, manifest.auth?.autologin || {});
      if (!filled.ok) return fail(filled.reason);
    } catch (error) {
      this._log(`[login] ${site} auto-login error: ${error.message}`);
      return fail('error');
    } finally {
      await page?.detach();
    }
    const deadline = this._now() + this._autologinWaitMs;
    while (this._now() < deadline) {
      await this._sleep(this._pollMs);
      if (await this._evaluate(manifest, flow) === 'done') {
        this._vault.updateSite(site, { last_result: 'success', last_attempt_at: new Date(this._now()).toISOString() });
        return 'logged_in';
      }
    }
    return fail('still_on_login_page');
  }
}
