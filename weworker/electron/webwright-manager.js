import { spawn } from 'child_process'
import fs from 'fs'
import { Socket } from 'net'
import os from 'os'
import path from 'path'

export const WEBWRIGHT_PORT = 8766
export const WEBWRIGHT_URL = `http://127.0.0.1:${WEBWRIGHT_PORT}`

export function resolveWebwrightHome(homeDir = os.homedir()) {
  if (!path.isAbsolute(homeDir)) throw new Error('WeWorker home directory must be absolute')
  return path.join(homeDir, '.weworker', 'webwright')
}

export function resolveWeWorkerUserFilesDir(homeDir = os.homedir(), configured = '') {
  if (!path.isAbsolute(homeDir)) throw new Error('WeWorker home directory must be absolute')
  const raw = String(configured || '').trim()
  if (!raw) return path.join(homeDir, '.weworker', 'user-files')
  const expanded = raw === '~'
    ? homeDir
    : raw.startsWith(`~${path.sep}`)
      ? path.join(homeDir, raw.slice(2))
      : raw
  if (!path.isAbsolute(expanded)) throw new Error('WeWorker user directory must be absolute')
  return path.resolve(expanded)
}

export function buildWebwrightEnvironment(environment, webwrightHome) {
  if (!path.isAbsolute(webwrightHome)) throw new Error('WEBWRIGHT_HOME must be absolute')
  return {
    ...environment,
    WEBWRIGHT_HOME: webwrightHome,
  }
}

function platformArch() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  return process.arch
}

export function isPortOccupied(port = WEBWRIGHT_PORT) {
  return new Promise((resolve) => {
    const socket = new Socket()
    let settled = false
    const finish = (occupied) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(occupied)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, '127.0.0.1')
  })
}

export function readRuntimeManifest(runtimeRoot, expected = {}) {
  const manifestPath = path.join(runtimeRoot, 'webwright-runtime.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read runtime manifest ${manifestPath}: ${error.message}`)
  }
  const required = {
    platform: expected.platform || process.platform,
    arch: expected.arch || platformArch(),
    mode: 'embedded',
  }
  for (const [key, value] of Object.entries(required)) {
    if (manifest[key] !== value) throw new Error(`${key} mismatch: expected ${value}, got ${manifest[key]}`)
  }
  if (!manifest.webwright_version || !manifest.entrypoint) {
    throw new Error('runtime manifest is missing identity or entrypoint fields')
  }
  const entrypoint = path.join(runtimeRoot, manifest.entrypoint)
  if (!fs.existsSync(entrypoint)) throw new Error(`runtime entrypoint does not exist: ${entrypoint}`)
  return { manifest, entrypoint }
}

function prefixOutput(stream, log) {
  if (!stream?.on) return
  let remainder = ''
  stream.on('data', (chunk) => {
    const lines = `${remainder}${chunk.toString()}`.split(/\r?\n/)
    remainder = lines.pop() || ''
    for (const line of lines) if (line) log(`[webwright] ${line}`)
  })
  stream.on('end', () => {
    if (remainder) log(`[webwright] ${remainder}`)
    remainder = ''
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener?.('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    child.once('exit', onExit)
  })
}

export class WebwrightManager {
  constructor({
    log = console.log,
    isPackaged = false,
    resourcesPath = '',
    repoRoot,
    spawnProcess = spawn,
    fetchHealth = globalThis.fetch,
    checkPort = isPortOccupied,
    loadRuntime = readRuntimeManifest,
    startTimeoutMs = 20000,
    stopTimeoutMs = 10000,
    maxRestartAttempts = 3,
    webwrightHome = resolveWebwrightHome(),
    userFilesDir = resolveWeWorkerUserFilesDir(),
    modelConfigToken = '',
    explorationInstanceId = '',
    instanceId = '',
  } = {}) {
    if (!repoRoot) throw new Error('WebwrightManager requires repoRoot')
    this._log = log
    this._isPackaged = isPackaged
    this._resourcesPath = resourcesPath
    this._repoRoot = repoRoot
    this._spawn = spawnProcess
    this._fetch = fetchHealth
    this._checkPort = checkPort
    this._loadRuntime = loadRuntime
    this._startTimeoutMs = startTimeoutMs
    this._stopTimeoutMs = stopTimeoutMs
    this._maxRestartAttempts = maxRestartAttempts
    this._webwrightHome = webwrightHome
    this._userFilesDir = userFilesDir
    this._modelConfigToken = modelConfigToken
    this._explorationInstanceId = explorationInstanceId || instanceId
    this._status = 'stopped'
    this._process = null
    this._identity = null
    this._stopping = false
    this._startPromise = null
    this._restartTimer = null
    this._restartAttempts = 0
  }

  start() {
    if (this._startPromise) return this._startPromise
    if (this._process && (this._status === 'starting' || this._status === 'running')) return Promise.resolve()
    this._startPromise = this._start().finally(() => { this._startPromise = null })
    return this._startPromise
  }

  async _start() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    this._stopping = false
    this._status = 'starting'

    if (await this._checkPort(WEBWRIGHT_PORT)) {
      this._status = 'port_in_use'
      this._log('[webwright] port 8766 is already in use; skipping spawn')
      return
    }

    let command
    let args
    let cwd
    let expectedIdentity = null
    if (this._isPackaged) {
      const runtimeRoot = path.join(this._resourcesPath, 'webwright')
      let runtime
      try {
        runtime = this._loadRuntime(runtimeRoot)
      } catch (error) {
        this._status = 'version_mismatch'
        this._log(`[webwright] ${error.message}`)
        return
      }
      command = runtime.entrypoint
      args = []
      cwd = runtimeRoot
      expectedIdentity = {
        version: runtime.manifest.webwright_version,
        platform: runtime.manifest.platform,
        arch: runtime.manifest.arch,
        mode: runtime.manifest.mode,
      }
    } else {
      const projectRoot = path.join(this._repoRoot, 'components', 'webwright')
      command = 'uv'
      args = ['run', '--project', projectRoot, 'webwright-server']
      cwd = this._repoRoot
    }
    args.push(
      '--host', '127.0.0.1',
      '--port', String(WEBWRIGHT_PORT),
      '--parent-pid', String(process.pid),
      '--exit-on-stdin-close',
    )

    this._log(`[webwright] starting ${this._isPackaged ? 'embedded runtime' : 'from source'}`)
    const child = this._spawn(command, args, {
      cwd,
      env: {
        ...buildWebwrightEnvironment(process.env, this._webwrightHome),
        WEWORKER_USER_FILES_DIR: this._userFilesDir,
        WEWORKER_WEBCLI_NODE: process.execPath,
      WEWORKER_BROWSER_MANAGED: '1',
        WEWORKER_WEBCLI_ENTRY: this._isPackaged
          ? path.join(this._resourcesPath, 'webcli', 'webcli.cjs')
          : path.join(this._repoRoot, 'webcli', 'index.js'),
        WEWORKER_MODEL_CONFIG_URL: 'http://127.0.0.1:8765/internal/webwright/model-config',
        WEWORKER_MODEL_CONFIG_TOKEN: this._modelConfigToken,
        WEWORKER_EXPLORATION_INSTANCE_ID: this._explorationInstanceId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    })
    this._process = child
    prefixOutput(child.stdout, this._log)
    prefixOutput(child.stderr, this._log)
    child.once('error', (error) => {
      if (this._process !== child || this._stopping) return
      this._process = null
      this._identity = null
      this._status = 'error'
      this._log(`[webwright] spawn error: ${error.message}`)
      this._scheduleRestart()
    })
    child.once('exit', (code, signal) => this._handleExit(child, code, signal))

    try {
      const health = await this._waitForHealth(child)
      if (expectedIdentity && !this._matchesIdentity(health, expectedIdentity)) {
        this._status = 'version_mismatch'
        this._log('[webwright] health identity does not match packaged runtime manifest')
        this._process = null
        await this._stopChild(child)
        return
      }
      this._identity = health
      this._status = 'running'
      this._restartAttempts = 0
      this._log('[webwright] running on http://127.0.0.1:8766')
    } catch (error) {
      if (this._stopping || this._process !== child) return
      this._status = 'error'
      this._log(`[webwright] failed to start: ${error.message}`)
      await this._stopChild(child)
    }
  }

  async _waitForHealth(child) {
    const deadline = Date.now() + this._startTimeoutMs
    let lastError = null
    while (Date.now() < deadline) {
      if (this._process !== child) throw new Error('process exited before health check passed')
      try {
        const response = await this._fetch(`${WEBWRIGHT_URL}/api/health`)
        if (response.ok) {
          const health = await response.json()
          if (health.ok && health.bind === '127.0.0.1' && String(health.port) === String(WEBWRIGHT_PORT)
            && (!this._explorationInstanceId || health.instance_id === this._explorationInstanceId)) return health
          lastError = new Error('health response has an invalid bind identity')
        } else {
          lastError = new Error(`health returned HTTP ${response.status}`)
        }
      } catch (error) {
        lastError = error
      }
      await delay(300)
    }
    throw new Error(lastError?.message || 'health check timed out')
  }

  _matchesIdentity(health, expected) {
    return Object.entries(expected).every(([key, value]) => health[key] === value)
  }

  _handleExit(child, code, signal) {
    if (this._process !== child) return
    this._process = null
    this._identity = null
    if (this._stopping) {
      this._status = 'stopped'
      return
    }
    this._status = 'error'
    this._log(`[webwright] exited unexpectedly code=${code ?? 'null'} signal=${signal || 'none'}`)
    this._scheduleRestart()
  }

  _scheduleRestart() {
    if (this._restartTimer || this._stopping || this._restartAttempts >= this._maxRestartAttempts) return
    this._restartAttempts += 1
    const delayMs = Math.min(10000, 1000 * this._restartAttempts)
    this._log(`[webwright] restarting in ${delayMs}ms (${this._restartAttempts}/${this._maxRestartAttempts})`)
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      void this.start().catch((error) => {
        this._status = 'error'
        this._log(`[webwright] restart failed: ${error.message}`)
        this._scheduleRestart()
      })
    }, delayMs)
  }

  async _stopChild(child) {
    if (!child) return
    const gracefulExit = waitForExit(child, this._stopTimeoutMs)
    try { child.stdin?.end() } catch {}
    const graceful = await gracefulExit
    if (!graceful) {
      this._log('[webwright] graceful stop timed out; terminating owned process')
      const forcedExit = waitForExit(child, 3000)
      try { child.kill('SIGTERM') } catch {}
      await forcedExit
    }
    if (this._process === child) this._process = null
  }

  async stop() {
    this._stopping = true
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    const child = this._process
    if (child) await this._stopChild(child)
    this._process = null
    this._identity = null
    this._status = 'stopped'
  }

  getStatus() {
    return this._status
  }

  getIdentity() {
    return this._identity ? { ...this._identity } : null
  }
}
