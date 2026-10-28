/**
 * WeWorker 浏览器: a Chrome instance owned by the Bridge.
 *
 * The Bridge starts the user's installed Chrome (or Edge) with its own profile
 * under ~/.weworker/browser/profile, loads the bundled extension, and keeps
 * the window off-screen so website automation never covers or focuses the
 * user's own windows. The user's everyday Chrome is never touched.
 *
 * The Bridge owns the browser in every setup: the desktop app and standalone
 * `webcli` are both clients of the Bridge, so whoever starts the Bridge on
 * port 3711 owns the browser and later clients reuse it.
 *
 * Chrome constraints this design follows:
 * - Chrome 137+ ignores --load-extension in branded builds, so the extension
 *   is loaded through CDP `Extensions.loadUnpacked`, which requires
 *   --remote-debugging-pipe and --enable-unsafe-extension-debugging.
 * - Chrome 136+ honours remote debugging only for a non-default
 *   --user-data-dir, which the dedicated profile is.
 * - In a persistent profile Chrome keeps running the service worker it first
 *   registered for an unpacked extension, across restarts and version changes.
 *   A changed extension build is therefore reinstalled once on start
 *   (`refreshChangedExtension`), carrying chrome.storage.local over.
 * - Management CDP runs over the inherited pipe (fd 3/4). Python clients use
 *   a loopback-only dynamic debugging port on the same browser.
 *   Chrome exits when that pipe closes, so a Bridge that dies (even when
 *   force-killed) leaves no browser behind.
 *
 * The extension learns that it runs here through a marker in its local
 * storage. It then avoids window focus changes, and the Bridge prefers it over
 * an extension that may also be installed in the user's own Chrome.
 *
 * Process rules: only the process started by this manager is stopped. A
 * profile already used by another process is reported and retried later,
 * never killed.
 */
import { spawn as nodeSpawn, spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';
import { BrowserLeases } from './browser-leases.js';
import { capturePage } from './page-screenshot.js';

export const BROWSER_INSTANCE_STORAGE_KEY = 'weworkerBrowserInstance';
export const BROWSER_MODES = Object.freeze(['dedicated', 'system']);
export const DEFAULT_BROWSER_MODE = 'dedicated';
export const OFFSCREEN_POSITION = -32000;
export const ONSCREEN_BOUNDS = Object.freeze({ left: 120, top: 80, width: 1280, height: 860 });
const SCREENSHOT_ATTACH_TIMEOUT_MS = 5000;
/** Standalone use stops an unused browser; a desktop client keeps it running. */
export const DEFAULT_IDLE_STOP_MS = 30 * 60_000;

const READY_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 15_000;
const EXTENSION_WORKER_TIMEOUT_MS = 15_000;
const EXTENSION_CONNECT_TIMEOUT_MS = 20_000;
const QUICK_EXIT_MS = 8_000;
const STABLE_RUN_MS = 60_000;
const PROFILE_IN_USE_RETRY_MS = 15_000;
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_FAILED_STARTS = RESTART_DELAYS_MS.length;

export function normalizeBrowserMode(value) {
  return BROWSER_MODES.includes(value) ? value : DEFAULT_BROWSER_MODE;
}

export function resolveBrowserHome({ env = process.env, home = os.homedir() } = {}) {
  return env.WEWORKER_BROWSER_HOME ? path.resolve(env.WEWORKER_BROWSER_HOME) : path.join(home, '.weworker', 'browser');
}

// ── Mode configuration (shared by the desktop settings and `webcli browser mode`) ──

/** `WEWORKER_BROWSER_MODE` fixes the mode (tests, managed setups); otherwise config.json decides. */
export function readBrowserMode({ env = process.env, browserHome = resolveBrowserHome({ env }), fileSystem = fs } = {}) {
  if (env.WEWORKER_BROWSER_MODE) return { mode: normalizeBrowserMode(env.WEWORKER_BROWSER_MODE), locked: true };
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(path.join(browserHome, 'config.json'), 'utf8'));
    return { mode: normalizeBrowserMode(parsed?.mode), locked: false };
  } catch {
    return { mode: DEFAULT_BROWSER_MODE, locked: false };
  }
}

export function writeBrowserMode(mode, { browserHome = resolveBrowserHome(), fileSystem = fs } = {}) {
  const normalized = normalizeBrowserMode(mode);
  fileSystem.mkdirSync(browserHome, { recursive: true });
  const file = path.join(browserHome, 'config.json');
  const temp = `${file}.${process.pid}.tmp`;
  fileSystem.writeFileSync(temp, `${JSON.stringify({ mode: normalized }, null, 2)}\n`);
  fileSystem.renameSync(temp, file);
  return normalized;
}

// ── Locating the browser ────────────────────────────────────────────────────

export function browserExecutableCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const candidates = [];
  if (env.WEWORKER_BROWSER_EXECUTABLE) candidates.push({ path: env.WEWORKER_BROWSER_EXECUTABLE, name: 'Chrome' });
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) candidates.push({ path: path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Chrome' });
    for (const root of roots) candidates.push({ path: path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Microsoft Edge' });
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      candidates.push({ path: path.posix.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), name: 'Chrome' });
    }
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      candidates.push({ path: path.posix.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'), name: 'Microsoft Edge' });
    }
  } else {
    for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
      candidates.push({ path: path.posix.join('/usr/bin', bin), name: bin.startsWith('chromium') ? 'Chromium' : 'Chrome' });
    }
    candidates.push({ path: '/usr/bin/microsoft-edge', name: 'Microsoft Edge' });
  }
  return candidates;
}

export function findBrowserExecutable(options = {}) {
  const exists = options.exists ?? ((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
  return browserExecutableCandidates(options).find((candidate) => exists(candidate.path)) ?? null;
}

export function buildBrowserArgs({ userDataDir }) {
  return [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-pipe',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    // The pipe alone makes navigator.webdriver true, which sites such as jd.com treat as a bot.
    '--disable-blink-features=AutomationControlled',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    // No window at launch; the Bridge opens one off-screen, which later windows inherit.
    '--no-startup-window',
    `--window-position=${OFFSCREEN_POSITION},${OFFSCREEN_POSITION}`,
    '--window-size=1280,860',
    // An off-screen window counts as occluded; keep its pages running at full speed.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
}

/** Stable per-profile marker; it only tells the Bridge which extension runs in this browser. */
export function loadInstanceToken(browserHome, fileSystem = fs) {
  const file = path.join(browserHome, 'instance.json');
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
    if (typeof parsed?.token === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(parsed.token)) return parsed.token;
  } catch {
    // Created below.
  }
  const token = randomBytes(24).toString('base64url');
  fileSystem.mkdirSync(browserHome, { recursive: true });
  fileSystem.writeFileSync(file, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  return token;
}

/** Chrome clamps the parked position (about -18000 on Windows), so compare with a margin. */
export function isOffscreenBounds(bounds) {
  return !bounds || bounds.left < -10000 || bounds.top < -10000;
}

// ── CDP over the inherited pipe ─────────────────────────────────────────────

/** Chrome's pipe transport: one JSON message per NUL-terminated frame. */
export function createCdpPipe(writable, readable, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  let nextId = 0;
  let closed = false;
  let buffered = Buffer.alloc(0);
  const pending = new Map();
  const listeners = new Set();

  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  readable.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let end;
    while ((end = buffered.indexOf(0)) >= 0) {
      const frame = buffered.subarray(0, end).toString('utf8');
      buffered = buffered.subarray(end + 1);
      let message;
      try { message = JSON.parse(frame); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message || 'CDP error'), { code: message.error.code }));
        else entry.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    }
  });
  const onClose = () => {
    if (closed) return;
    closed = true;
    failAll(new Error('Browser connection closed'));
  };
  readable.on('close', onClose);
  readable.on('end', onClose);
  readable.on('error', onClose);
  writable.on?.('error', onClose);

  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('Browser connection closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        writable.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get closed() { return closed; },
    close: onClose,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, response => {
      let body = '';
      response.on('data', data => { body += data; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('CDP discovery timed out')));
    request.on('error', reject);
  });
}

/** Verify a target created through our inherited pipe; stale discovery files cannot match it. */
export async function discoverCdpEndpoint(userDataDir, targetId, { timeoutMs = READY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [portText, browserPath] = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      const port = Number(portText);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(browserPath)) throw new Error('Invalid discovery file');
      const pages = await localJson(port, '/json/list');
      const version = await localJson(port, '/json/version');
      if (pages.some(page => page.id === targetId) && new URL(version.webSocketDebuggerUrl).pathname === browserPath) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch { /* Startup and discovery can race; only return a verified endpoint. */ }
    await wait(100);
  }
  throw new Error('无法确认本次 WeWorker 浏览器的 CDP 地址');
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Evaluate in the extension's service worker; returns the value, or throws with `label`. */
const EXTENSION_STORAGE_NOT_READY = '__weworker_extension_storage_not_ready__';

async function evaluateInExtensionWorker(cdp, extensionId, expression, label, { timeoutMs = EXTENSION_WORKER_TIMEOUT_MS, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let worker;
  while (!worker) {
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    worker = targetInfos.find((target) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
    if (!worker) {
      if (Date.now() > deadline) throw new Error('Extension service worker did not start');
      await wait(pollMs);
    }
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  try {
    for (;;) {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      const value = response?.result?.value;
      if (!response?.exceptionDetails && value !== undefined && value !== EXTENSION_STORAGE_NOT_READY) return value;
      const description = value === EXTENSION_STORAGE_NOT_READY
        ? 'extension storage API did not become ready'
        : response?.exceptionDetails?.exception?.description || '';
      // The worker target appears before Chrome finishes binding extension APIs.
      const shouldRetry = value === EXTENSION_STORAGE_NOT_READY || description.includes('chrome is not defined');
      if (!shouldRetry || Date.now() > deadline) throw new Error(`${label}: ${description || 'no result'}`);
      await wait(pollMs);
    }
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

/** Write the instance marker from inside the extension's service worker (no browser-context CDP API needed). */
export async function markExtensionInstance(cdp, extensionId, marker, options = {}) {
  const storage = JSON.stringify({ [BROWSER_INSTANCE_STORAGE_KEY]: marker });
  const expression = `globalThis.chrome?.storage?.local?.set ? globalThis.chrome.storage.local.set(${storage}).then(() => 'ok') : ${JSON.stringify(EXTENSION_STORAGE_NOT_READY)}`;
  const value = await evaluateInExtensionWorker(cdp, extensionId, expression, 'Failed to mark the extension instance', options);
  if (value !== 'ok') throw new Error('Failed to mark the extension instance: no result');
}

/** Content digest of the extension directory (paths and bytes). */
export function extensionBuildDigest(extensionDir, fileSystem = fs) {
  const hash = createHash('sha256');
  const visit = (dir, prefix) => {
    for (const entry of fileSystem.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = prefix + entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, rel + '/');
      else if (entry.isFile()) {
        const bytes = fileSystem.readFileSync(full);
        hash.update(rel).update('\0').update(String(bytes.length)).update('\0').update(bytes);
      }
    }
  };
  visit(extensionDir, '');
  return hash.digest('hex');
}

const EXTENSION_BUILD_FILE = 'extension-build.json';

export function readLoadedExtensionBuild(browserHome, fileSystem = fs) {
  try {
    const digest = JSON.parse(fileSystem.readFileSync(path.join(browserHome, EXTENSION_BUILD_FILE), 'utf8'))?.digest;
    return typeof digest === 'string' ? digest : null;
  } catch {
    return null;
  }
}

export function writeLoadedExtensionBuild(browserHome, digest, fileSystem = fs) {
  fileSystem.mkdirSync(browserHome, { recursive: true });
  fileSystem.writeFileSync(path.join(browserHome, EXTENSION_BUILD_FILE), JSON.stringify({ digest }, null, 2));
}

/**
 * Chrome keeps running the service worker it first registered for an unpacked
 * extension in a persistent profile, across restarts and even after a version
 * change; only a reinstall picks up new files. When the extension build differs
 * from the one last loaded, reinstall it and carry chrome.storage.local over
 * (a reinstall clears it). Returns the extension id to use.
 */
export async function refreshChangedExtension(cdp, { extensionDir, extensionId, digest, loadedDigest, log = () => {}, workerOptions } = {}) {
  if (!digest || digest === loadedDigest) return { extensionId, refreshed: false };
  let saved = null;
  try {
    saved = await evaluateInExtensionWorker(cdp, extensionId, 'chrome.storage.local.get(null).then((items) => JSON.stringify(items))', 'Failed to read extension storage', workerOptions);
  } catch (error) {
    log(`[browser] extension storage not carried over: ${error.message}`);
  }
  await cdp.send('Extensions.uninstall', { id: extensionId });
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
  if (typeof saved === 'string' && saved !== '{}') {
    // `saved` is JSON produced by the worker itself, so it is a valid object literal.
    await evaluateInExtensionWorker(cdp, id, `chrome.storage.local.set(${saved}).then(() => 'ok')`, 'Failed to restore extension storage', workerOptions)
      .catch((error) => log(`[browser] ${error.message}`));
  }
  log('[browser] extension updated to the current build');
  return { extensionId: id, refreshed: true };
}

// ── Manager: one browser process ────────────────────────────────────────────

function hasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}

function killProcessTree(child, platform) {
  // An exited child's PID may already belong to another process.
  if (!child?.pid || hasExited(child)) return;
  if (platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

export class DedicatedBrowserManager {
  constructor({
    log = () => {},
    extensionDir,
    browserHome = resolveBrowserHome(),
    instanceToken,
    platform = process.platform,
    spawn = nodeSpawn,
    findExecutable = () => findBrowserExecutable({ platform }),
    killTree = (child) => killProcessTree(child, platform),
    restartDelaysMs = RESTART_DELAYS_MS,
    profileInUseRetryMs = PROFILE_IN_USE_RETRY_MS,
    now = () => Date.now(),
    onStatusChange = () => {},
    /** Tests: () => digest of the extension build (default: hash the directory). */
    extensionDigest = null,
    discoverEndpoint = discoverCdpEndpoint,
  } = {}) {
    this._log = log;
    this._extensionDir = extensionDir;
    this._extensionDigestOverride = extensionDigest;
    this._discoverEndpoint = discoverEndpoint;
    this._descriptor = null;
    this._browserHome = browserHome;
    this._userDataDir = path.join(browserHome, 'profile');
    this._instanceToken = instanceToken;
    this._platform = platform;
    this._spawn = spawn;
    this._findExecutable = findExecutable;
    this._killTree = killTree;
    this._restartDelaysMs = restartDelaysMs;
    this._profileInUseRetryMs = profileInUseRetryMs;
    this._now = now;
    this._onStatusChange = onStatusChange;
    this._status = 'stopped';
    this._detail = '';
    this._browserName = null;
    this._child = null;
    this._cdp = null;
    this._windowId = null;
    this._extensionId = null;
    this._starting = null;
    this._stopping = false;
    this._restartTimer = null;
    this._failedStarts = 0;
  }

  get userDataDir() { return this._userDataDir; }
  get isRunning() { return this._status === 'running' && !!this._cdp; }
  get descriptor() { return this.isRunning ? this._descriptor : null; }

  async pageIdentity(targetId) {
    const { targetInfo } = await this._cdp.send('Target.getTargetInfo', { targetId });
    if (targetInfo.type !== 'page') throw new Error('只能占用浏览器页面');
    const { targetInfos } = await this._cdp.send('Target.getTargets');
    const worker = targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${this._extensionId}/`));
    if (!worker) return { targetId, tabId: undefined };
    const { sessionId } = await this._cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    try {
      const { result } = await this._cdp.send('Runtime.evaluate', {
        expression: 'chrome.debugger.getTargets().then(items => items.map(({id, tabId}) => ({id, tabId})))',
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      return { targetId, tabId: result.value?.find(item => item.id === targetId)?.tabId };
    } finally { await this._cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
  }

  getStatus() {
    return {
      status: this._status,
      browser: this._browserName,
      extensionLoaded: !!this._extensionId,
      cdpReady: !!this.descriptor,
      ...(this._detail ? { detail: this._detail } : {}),
    };
  }

  start() {
    if (this._starting) return this._starting;
    if (this._child && this._status === 'running') return Promise.resolve(this.getStatus());
    this._stopping = false;
    this._clearRestartTimer();
    this._starting = this._startInternal().finally(() => { this._starting = null; });
    return this._starting;
  }

  /** Digest of the extension build on disk; null when it cannot be read (no refresh). */
  _extensionDigest() {
    try {
      return this._extensionDigestOverride ? this._extensionDigestOverride() : extensionBuildDigest(this._extensionDir);
    } catch {
      return null;
    }
  }

  async _startInternal() {
    if (!this._extensionDir) return this._setStatus('unavailable', '找不到 WeWorker 扩展文件');
    const executable = this._findExecutable();
    if (!executable) return this._setStatus('unavailable', '未找到 Chrome 或 Microsoft Edge');
    this._browserName = executable.name;
    this._setStatus('starting');
    fs.mkdirSync(this._userDataDir, { recursive: true });

    const run = { ready: false, startedAt: this._now() };
    const child = this._spawn(executable.path, buildBrowserArgs({ userDataDir: this._userDataDir }), {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: false,
      // Stays in the Bridge's process tree, so a tree kill of the host also covers it.
      detached: false,
    });
    this._child = child;
    child.stderr?.on('data', () => {});
    child.once('error', (error) => this._log(`[browser] failed to launch: ${error.message}`));
    child.once('exit', (code, signal) => this._handleExit(child, { code, signal, ...run }));
    const cdp = createCdpPipe(child.stdio[3], child.stdio[4]);
    this._cdp = cdp;

    try {
      const version = await withTimeout(cdp.send('Browser.getVersion'), READY_TIMEOUT_MS, 'Browser did not respond');
      let { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: this._extensionDir });
      let digest = this._extensionDigest();
      try {
        ({ extensionId } = await refreshChangedExtension(cdp, {
          extensionDir: this._extensionDir, extensionId, digest,
          loadedDigest: readLoadedExtensionBuild(this._browserHome), log: this._log,
        }));
      } catch (error) {
        // An older browser without Extensions.uninstall keeps the cached worker; retried next start.
        this._log(`[browser] could not update the extension: ${error.message}`);
        digest = null;
        ({ id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: this._extensionDir }));
      }
      this._extensionId = extensionId;
      // One off-screen window: tabs opened by the extension land here, later windows inherit its position.
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
      const cdpUrl = await this._discoverEndpoint(this._userDataDir, targetId);
      this._descriptor = { instanceId: randomBytes(16).toString('hex'), cdpUrl };
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
      this._windowId = windowId;
      await markExtensionInstance(cdp, extensionId, { kind: 'dedicated', token: this._instanceToken });
      if (digest) writeLoadedExtensionBuild(this._browserHome, digest);
      run.ready = true;
      this._readyAt = this._now();
      this._setStatus('running');
      this._log(`[browser] ${executable.name} ready (${version.product || 'unknown version'}), extension ${extensionId}`);
    } catch (error) {
      if (this._child === child && !this._stopping) {
        this._log(`[browser] startup failed: ${error.message}`);
        this._detail = error.message;
        // Exit handling decides between retry and "profile in use".
        cdp.close();
        if (!hasExited(child)) this._killTree(child);
      }
    }
    return this.getStatus();
  }

  _handleExit(child, { code, signal, ready, startedAt }) {
    if (this._child !== child) return;
    this._child = null;
    this._descriptor = null;
    this._cdp?.close();
    this._cdp = null;
    this._windowId = null;
    this._extensionId = null;
    if (this._stopping) {
      this._setStatus('stopped');
      return;
    }
    const ranFor = this._now() - startedAt;
    if (!ready && code === 0 && ranFor < QUICK_EXIT_MS) {
      // Chrome handed the launch over to a process that already owns this profile.
      this._setStatus('profile_in_use', 'WeWorker 浏览器的配置正被另一个浏览器进程使用');
      this._log('[browser] profile is already in use by another process; will retry');
      this._scheduleRestart(this._profileInUseRetryMs);
      return;
    }
    const stableRun = ready && this._readyAt && this._now() - this._readyAt >= STABLE_RUN_MS;
    if (ready && (code === 0 || stableRun)) {
      // Closed by the user (last window) or ran fine for a while: bring it back quietly.
      this._failedStarts = 0;
      this._log(`[browser] exited (code ${code ?? signal}); restarting`);
      this._setStatus('starting');
      this._scheduleRestart(this._restartDelaysMs[0]);
      return;
    }
    this._failedStarts += 1;
    if (this._failedStarts >= MAX_FAILED_STARTS) {
      this._setStatus('error', this._detail || `浏览器退出（${code ?? signal}）`);
      this._log('[browser] giving up after repeated failures');
      return;
    }
    const delay = this._restartDelaysMs[Math.min(this._failedStarts - 1, this._restartDelaysMs.length - 1)];
    this._setStatus('starting', this._detail);
    this._log(`[browser] exited unexpectedly (code ${code ?? signal}); restarting in ${delay}ms`);
    this._scheduleRestart(delay);
  }

  _scheduleRestart(delay) {
    this._clearRestartTimer();
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      void this.start();
    }, delay);
    this._restartTimer.unref?.();
  }

  _clearRestartTimer() {
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = null;
  }

  _setStatus(status, detail = '') {
    const changed = status !== this._status || detail !== this._detail;
    this._status = status;
    this._detail = detail;
    if (status === 'running') this._failedStarts = 0;
    const snapshot = this.getStatus();
    if (changed) {
      try { this._onStatusChange(snapshot); } catch {}
    }
    return snapshot;
  }

  /** User-requested restart, for example after repeated failures. */
  async restart() {
    this._failedStarts = 0;
    await this.stop();
    return this.start();
  }

  async stop() {
    this._stopping = true;
    this._clearRestartTimer();
    // A start in progress has already spawned its child, so stopping covers it.
    const child = this._child;
    if (!child) {
      if (this._status !== 'unavailable') this._setStatus('stopped');
      return this.getStatus();
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await withTimeout(this._cdp?.send('Browser.close') ?? Promise.resolve(), 3_000, 'close timeout');
    } catch {
      // Fall through to the forced stop below.
    }
    const closed = await Promise.race([exited.then(() => true), wait(5_000).then(() => false)]);
    if (!closed && !hasExited(child)) this._killTree(child);
    await Promise.race([exited, wait(2_000)]);
    if (this._child === child) this._child = null;
    this._cdp = null;
    this._windowId = null;
    this._extensionId = null;
    return this._setStatus('stopped');
  }

  async _pageWindows() {
    const cdp = this._cdp;
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const windows = new Map();
    for (const target of targetInfos.filter((item) => item.type === 'page')) {
      try {
        const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: target.targetId });
        if (!windows.has(windowId)) windows.set(windowId, { windowId, bounds, targetId: target.targetId });
      } catch {
        // Target closed meanwhile.
      }
    }
    return [...windows.values()];
  }

  /** True when a browser window is on-screen and not minimized, i.e. the user may be using it. */
  async hasVisibleWindow() {
    if (!this.isRunning) return false;
    try {
      const windows = await this._pageWindows();
      return windows.some(({ bounds }) => bounds?.windowState !== 'minimized' && !isOffscreenBounds(bounds));
    } catch {
      return false;
    }
  }

  /** The page target showing `url`: same URL, else same origin and path. */
  async findPageTarget(url) {
    if (!this.isRunning || !url) return null;
    let wanted;
    try { wanted = new URL(url); } catch { return null; }
    const { targetInfos = [] } = await this._cdp.send('Target.getTargets');
    const pages = targetInfos.filter((target) => target.type === 'page');
    const samePath = (target) => {
      try {
        const actual = new URL(target.url);
        return actual.origin === wanted.origin && actual.pathname === wanted.pathname;
      } catch { return false; }
    };
    return pages.find((target) => target.url === wanted.href) || pages.find(samePath) || null;
  }

  /** CDP session on one page (login autofill, screenshots). Caller must `detach()`. */
  async attachPage(url) {
    const target = await this.findPageTarget(url);
    if (!target) return null;
    const cdp = this._cdp;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    return {
      targetId: target.targetId,
      url: target.url,
      send: (method, params = {}) => cdp.send(method, params, sessionId),
      detach: () => cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}),
    };
  }

  /** JPEG of a page, for example a login QR code for a user who is not at this screen. */
  async screenshot(url) {
    const page = await this.attachPage(url).catch(() => null);
    if (!page) return null;
    try {
      const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
      return typeof data === 'string' && data ? data : null;
    } catch {
      return null;
    } finally {
      await page.detach();
    }
  }

  /**
   * Screenshot of one page target (capture_screenshot). Uses a session on the
   * browser pipe, never chrome.debugger, and always detaches it.
   */
  async captureTarget(targetId, options = {}) {
    if (!this.isRunning) throw new Error('WeWorker 浏览器未运行');
    if (typeof targetId !== 'string' || !targetId) throw new Error('缺少截图目标');
    const cdp = this._cdp;
    const attaching = cdp.send('Target.attachToTarget', { targetId, flatten: true });
    let sessionId;
    try {
      ({ sessionId } = await withTimeout(attaching, SCREENSHOT_ATTACH_TIMEOUT_MS, `Target.attachToTarget 超时（${SCREENSHOT_ATTACH_TIMEOUT_MS} ms）`));
    } catch (error) {
      // A session that arrives after the timeout is released too.
      attaching.then(({ sessionId: late }) => cdp.send('Target.detachFromTarget', { sessionId: late })).catch(() => {});
      throw error;
    }
    try {
      return await capturePage((method, params = {}) => cdp.send(method, params, sessionId), options);
    } finally {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  /** Bring the browser on-screen, for example so the user can sign in to a website. */
  async show({ url } = {}) {
    if (!this.isRunning) {
      await this.start();
      if (!this.isRunning) return this.getStatus();
    }
    const cdp = this._cdp;
    const preferred = url ? await this.findPageTarget(url).catch(() => null) : null;
    let target = null;
    if (preferred) {
      const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: preferred.targetId });
      target = { windowId, bounds, targetId: preferred.targetId };
    }
    if (!target) [target] = await this._pageWindows();
    if (!target) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
      const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget', { targetId });
      target = { windowId, bounds, targetId };
    }
    const { windowId, bounds, targetId } = target;
    if (bounds?.windowState && bounds.windowState !== 'normal') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    }
    if (isOffscreenBounds(bounds)) {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...ONSCREEN_BOUNDS } });
    }
    await cdp.send('Target.activateTarget', { targetId });
    return this.getStatus();
  }

  /**
   * Move on-screen browser windows off-screen again. Windows that are already
   * off-screen or minimized stay as they are: restoring a minimized window
   * would bring it to the front.
   */
  async hide() {
    if (!this.isRunning) return this.getStatus();
    const cdp = this._cdp;
    for (const { windowId, bounds } of await this._pageWindows()) {
      if (isOffscreenBounds(bounds) || bounds?.windowState === 'minimized') continue;
      if (bounds?.windowState && bounds.windowState !== 'normal') {
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      }
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: OFFSCREEN_POSITION, top: OFFSCREEN_POSITION } }).catch(() => {});
    }
    return this.getStatus();
  }
}

// ── Host: what the Bridge exposes ───────────────────────────────────────────

/**
 * Mode, lazy start, idle stop and control actions for the Bridge.
 *
 * - Requests that need a browser call `ensureReady()`: in dedicated mode it
 *   starts the browser on demand and waits for its extension.
 * - Clients that `attach` (the desktop app) keep the browser running; without
 *   them an unused browser stops after `idleStopMs` unless a window is
 *   on-screen.
 */
export class BrowserHost {
  constructor({
    log = () => {},
    env = process.env,
    browserHome = resolveBrowserHome({ env }),
    resolveExtensionDir = () => null,
    isDedicatedConnected = () => false,
    createManager = (options) => new DedicatedBrowserManager(options),
    idleStopMs = Number.isFinite(Number(env.WEWORKER_BROWSER_IDLE_MS)) && env.WEWORKER_BROWSER_IDLE_MS !== ''
      ? Number(env.WEWORKER_BROWSER_IDLE_MS)
      : DEFAULT_IDLE_STOP_MS,
    extensionConnectTimeoutMs = EXTENSION_CONNECT_TIMEOUT_MS,
    pollMs = 200,
  } = {}) {
    this._log = log;
    this._env = env;
    this._browserHome = browserHome;
    this._resolveExtensionDir = resolveExtensionDir;
    this._isDedicatedConnected = isDedicatedConnected;
    this._createManager = createManager;
    this._idleStopMs = idleStopMs;
    this._extensionConnectTimeoutMs = extensionConnectTimeoutMs;
    this._pollMs = pollMs;
    this._token = null;
    this._manager = null;
    this._modeState = readBrowserMode({ env, browserHome });
    this._attached = new Set();
    this._idleTimer = null;
    this._listeners = new Set();
    this.leases = new BrowserLeases();
    this._acquiring = 0;
    this._manualVisible = false;
    this._changing = false;
    this._shuttingDown = false;
  }

  get mode() { return this._modeState.mode; }
  get browserHome() { return this._browserHome; }
  get token() {
    if (!this._token) this._token = loadInstanceToken(this._browserHome);
    return this._token;
  }

  get manager() {
    if (!this._manager) {
      let extensionDir = null;
      try { extensionDir = this._resolveExtensionDir(); } catch (error) { this._log(`[browser] extension unavailable: ${error.message}`); }
      this._manager = this._createManager({
        log: this._log,
        browserHome: this._browserHome,
        instanceToken: this.token,
        extensionDir,
        onStatusChange: () => this.notify(),
      });
    }
    return this._manager;
  }

  status() {
    const browser = this._manager ? this._manager.getStatus() : { status: 'stopped', browser: null, extensionLoaded: false };
    return {
      mode: this.mode,
      ...(this._modeState.locked ? { modeLocked: true } : {}),
      ...browser,
      extensionConnected: !!this._isDedicatedConnected(),
      activeTasks: this.leases.size,
    };
  }

  onStatus(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  notify() {
    const instanceId = this._manager?.descriptor?.instanceId;
    for (const [id, entry] of this.leases.entries) {
      if (entry.instanceId !== instanceId) {
        try { entry.client.send?.(JSON.stringify({ type: 'browser_lease_lost', leaseId: id })); } catch {}
        this.leases.release(entry.client, id);
      }
    }
    const snapshot = this.status();
    for (const listener of this._listeners) {
      try { listener(snapshot); } catch {}
    }
  }

  /** Make the WeWorker 浏览器 extension available; a no-op (false) in system mode. */
  async ensureReady() {
    this.assertStable();
    if (this.mode !== 'dedicated') return false;
    this.touch();
    if (this._isDedicatedConnected()) return true;
    const status = await this.manager.start();
    if (status.status !== 'running') {
      throw new Error(`WeWorker 浏览器未就绪：${status.detail || describeState(status.status)}`);
    }
    const deadline = Date.now() + this._extensionConnectTimeoutMs;
    while (!this._isDedicatedConnected()) {
      if (Date.now() > deadline) throw new Error('WeWorker 浏览器已启动，但其中的扩展未连接，请稍后重试');
      await wait(this._pollMs);
    }
    this.touch();
    return true;
  }

  /** Record use; restarts the idle countdown. */
  touch() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (!(this._idleStopMs > 0) || this._attached.size > 0 || this.leases.size > 0 || this._acquiring) return;
    this._idleTimer = setTimeout(() => { void this._stopWhenIdle(); }, this._idleStopMs);
    this._idleTimer.unref?.();
  }

  async _stopWhenIdle() {
    this._idleTimer = null;
    if (this._attached.size > 0 || this.leases.size > 0 || this._acquiring || !this._manager?.isRunning) return;
    // The user may be signing in or reading a page.
    if (await this._manager.hasVisibleWindow()) {
      this.touch();
      return;
    }
    if (this._attached.size || this.leases.size || this._acquiring || this._changing || this._shuttingDown) return;
    this._log('[browser] idle; stopping WeWorker browser');
    await this.changeBrowser(() => this._manager.stop());
  }

  /** A client that keeps the browser running while connected (the desktop app). */
  attach(client) {
    this._attached.add(client);
    this.touch();
    if (this.mode === 'dedicated' && !this._changing && !this._shuttingDown) void this.manager.start();
  }

  detach(client) {
    this.leases.detach(client);
    this.touch();
    if (!this._attached.delete(client)) return;
    if (this._attached.size === 0) this.touch();
  }

  async setMode(mode) {
    if (this._modeState.locked) throw new Error('浏览器模式由环境变量 WEWORKER_BROWSER_MODE 固定，无法修改');
    await this.changeBrowser(async () => {
      const next = writeBrowserMode(mode, { browserHome: this._browserHome });
      this._modeState = { mode: next, locked: false };
      if (next === 'system') await this._manager?.stop();
      else if (this._attached.size > 0) await this.manager.start();
      this.notify();
    });
  }

  /** Fixed control actions; no paths, URLs or executables are accepted from clients. */
  async control(action, params = {}, client = null) {
    switch (action) {
      case 'status':
        break;
      case 'attach':
        if (client) this.attach(client);
        break;
      case 'set_mode':
        await this.setMode(params.mode);
        break;
      case 'start':
        this.assertStable();
        if (this.mode !== 'dedicated') throw new Error('当前为「我自己的 Chrome」模式，不使用 WeWorker 浏览器');
        this.touch();
        await this.manager.start();
        break;
      case 'stop':
        await this.changeBrowser(() => this._manager?.stop());
        break;
      case 'restart':
        if (this.mode !== 'dedicated') throw new Error('当前为「我自己的 Chrome」模式，不使用 WeWorker 浏览器');
        this.touch();
        await this.changeBrowser(() => this.manager.restart());
        break;
      case 'show':
        this.assertStable();
        if (this.mode !== 'dedicated') throw new Error('当前为「我自己的 Chrome」模式，不使用 WeWorker 浏览器');
        this.touch();
        await this.manager.show();
        this._manualVisible = true;
        break;
      case 'hide':
        if (this.leases.visible || (params.soft && this._manualVisible)) break;
        this._manualVisible = false;
        // Never starts a browser just to hide it.
        if (this._manager?.isRunning) await this._manager.hide();
        break;
      default:
        throw new Error(`Unknown browser action: ${action}`);
    }
    return this.status();
  }

  async shutdown() {
    this._shuttingDown = true;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    await this._manager?.stop();
  }

  // Page-level helpers for the login flow; all are no-ops outside a running WeWorker 浏览器.

  get pageControl() {
    return this.mode === 'dedicated' && !!this._manager?.isRunning;
  }

  async showPage(url) {
    if (this.mode !== 'dedicated') return false;
    this.touch();
    await this.manager.show({ url });
    return true;
  }

  async hideWindows() {
    if (this.leases.visible || this._manualVisible) return;
    if (this._manager?.isRunning) await this._manager.hide();
  }

  assertIdle() {
    if (this.leases.size || this._acquiring) throw Object.assign(new Error('浏览器有正在执行的任务，请等待任务结束'), { code: 'BROWSER_BUSY' });
  }

  assertStable() {
    if (this._changing || this._shuttingDown) throw Object.assign(new Error('浏览器正在停止或切换，请稍后重新发起任务'), { code: 'BROWSER_BUSY' });
  }

  async changeBrowser(operation) {
    this.assertStable();
    this.assertIdle();
    this._changing = true;
    try { return await operation(); }
    finally { this._changing = false; }
  }

  async acquire(client, params = {}) {
    this.assertStable();
    if (this.mode !== 'dedicated') throw Object.assign(new Error('此操作需要 CDP，请切换到「WeWorker 浏览器」模式'), { code: 'BROWSER_MODE_REQUIRED' });
    this._acquiring++;
    let lease;
    try {
      await this.manager.start();
      const descriptor = this.manager.descriptor;
      if (!descriptor) throw new Error('WeWorker 浏览器 CDP 未就绪');
      lease = this.leases.acquire(client, descriptor, params);
      if (params.visible) { await this.manager.show(); this._manualVisible = true; }
      return lease;
    } catch (error) {
      if (lease) this.leases.release(client, lease.leaseId);
      throw error;
    } finally { this._acquiring--; this.touch(); }
  }

  async screenshot(url) {
    return this.pageControl ? this._manager.screenshot(url) : null;
  }

  async attachPage(url) {
    return this.pageControl ? this._manager.attachPage(url) : null;
  }

  /** capture_screenshot through the browser pipe; only for a running WeWorker 浏览器. */
  async captureTarget(targetId, options = {}) {
    if (!this.pageControl) throw new Error('WeWorker 浏览器未运行');
    this.touch();
    return this._manager.captureTarget(targetId, options);
  }
}

function describeState(state) {
  switch (state) {
    case 'profile_in_use': return 'WeWorker 浏览器的配置正被另一个浏览器进程使用';
    case 'error': return '浏览器多次启动失败';
    case 'unavailable': return '未找到 Chrome 或 Microsoft Edge';
    default: return '浏览器未能启动';
  }
}
