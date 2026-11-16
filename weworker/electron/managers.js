import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import { Socket } from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { app, utilityProcess } from 'electron'
import { buildAdapterEnvironment } from './adapter-environment.js'
import {
  formatProcessExitCode,
  isPortOccupied,
  probeHttpJson,
  waitForHttpInstance,
} from './local-service.js'
import {
  ExternalBackendMonitor,
  PortInUseMonitor,
  resolveBackendAvailability,
} from './backend-availability.js'

import {
  buildWebwrightEnvironment,
  resolveWebwrightHome,
  resolveWeWorkerUserFilesDir,
} from './webwright-manager.js'
import { resolveClaudeCodePath } from './claude-runtime.js'

export {
  WebwrightManager,
  resolveWebwrightHome,
  resolveWeWorkerUserFilesDir,
} from './webwright-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function adapterEnvironment() {
  return buildAdapterEnvironment({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot: path.resolve(__dirname, '../..') })
}

function normalizeOpenBrowserAllowedOrigin(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.search = ''
    url.pathname = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function readOpenBrowserAllowedOriginsEnv() {
  try {
    const settingsPath = path.join(os.homedir(), '.weworker', 'settings.json')
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const origins = new Set()
    for (const item of Array.isArray(raw?.open_browser_allowed_origins) ? raw.open_browser_allowed_origins : []) {
      const origin = normalizeOpenBrowserAllowedOrigin(item)
      if (origin) origins.add(origin)
    }
    return [...origins].join(',')
  } catch {
    return ''
  }
}

export function readConfiguredUserFilesDir() {
  const homeDir = os.homedir()
  try {
    const settingsPath = path.join(homeDir, '.weworker', 'settings.json')
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return resolveWeWorkerUserFilesDir(homeDir, raw?.user_directory)
  } catch {
    return resolveWeWorkerUserFilesDir(homeDir)
  }
}

export class BridgeManager {
  constructor(log, reportDir = '', ports = { backend: 8765, exploration: 8766, bridge: 3711 }) {
    this._ports = ports
    this._process = null
    // 状态枚举：
    //   stopped       — 还没启动
    //   starting      — 启动中
    //   running       — 自己启动的 bridge 已就绪
    //   error         — 启动失败（非端口冲突）
    //   port_in_use   — 所选端口在启动前被占用，未启动自己的 bridge
    this._status = 'stopped'
    this._log = log || console.log
    this._reportDir = reportDir || os.tmpdir()
    this._stopping = false
    this._restartTimer = null
    this._restartAttempts = 0
  }

  async start() {
    if (this._process && (this._status === 'starting' || this._status === 'running')) return
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    this._stopping = false
    this._status = 'starting'

    // Recheck the selected port in case another process bound it during startup.
    const occupied = await isPortOccupied(this._ports.bridge)
    if (occupied) {
      this._status = 'port_in_use'
      this._log(`[bridge] port ${this._ports.bridge} already in use by another process — skipping bridge spawn`)
      return
    }

    let cmd, args
    const bridgeEnv = {
      ...adapterEnvironment(),
      WEBCLI_BRIDGE_PORT: String(this._ports.bridge),
      WEWORK_PORT: String(this._ports.backend),
      WEWORKER_WEBWRIGHT_URL: `http://127.0.0.1:${this._ports.exploration}`,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-old-space-size=4096'].filter(Boolean).join(' '),
      WEBCLI_AI_REPORT_DIR: this._reportDir,
      WEBCLI_GENERATION_REPORT_DIR: this._reportDir,
      WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: readOpenBrowserAllowedOriginsEnv(),
      ...(process.platform === 'win32' ? { NODE_USE_SYSTEM_CA: '1' } : {}),
    }
    fs.mkdirSync(this._reportDir, { recursive: true })
    const bridgeExecArgv = [
      '--max-old-space-size=4096',
      '--report-on-fatalerror',
      '--report-uncaught-exception',
      `--report-directory=${this._reportDir}`,
    ]
    if (!app.isPackaged) {
      cmd = 'node'
      args = [
        ...(process.platform === 'win32' ? ['--use-system-ca'] : []),
        ...bridgeExecArgv,
        path.resolve(__dirname, '../build/webcli-dist/webcli.cjs'),
        'service',
        'start',
      ]
      this._process = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: bridgeEnv,
      })
      this._process.stdout.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const t = line.trimEnd()
          if (t) this._log(`[bridge] ${t}`)
        }
      })
      this._process.stderr.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const t = line.trimEnd()
          if (t) this._log(`[bridge] ${t}`)
        }
      })
      this._process.on('exit', (code) => this._handleBridgeExit(code))
    } else if (process.platform === 'win32') {
      // Use the checksum-pinned runtime shipped in this Windows distribution.
      // Never fall back to PATH or Electron when installation is incomplete.
      const executable = path.join(process.resourcesPath, 'node-runtime', 'node.exe')
      if (!fs.existsSync(executable)) {
        this._status = 'error'
        throw new Error('Bundled Node runtime is missing; reinstall the application.')
      }
      const env = { ...bridgeEnv }
      delete env.ELECTRON_RUN_AS_NODE
      this._process = spawn(executable, [
        ...bridgeExecArgv, '--require', path.join(process.resourcesPath, 'bridge', 'bridge-parent.cjs'),
        path.join(process.resourcesPath, 'bridge', 'bridge.cjs'), 'service', 'start',
      ], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: false, windowsHide: true,
        env,
      })
      for (const stream of [this._process.stdout, this._process.stderr]) {
        stream?.on('data', d => {
          for (const line of d.toString().split('\n')) {
            const text = line.trimEnd()
            if (text) this._log(`[bridge] ${text}`)
          }
        })
      }
      this._process.on('exit', code => this._handleBridgeExit(code))
      this._process.on('error', error => {
        this._status = 'error'
        this._log(`[bridge] bundled Node startup failed: ${error.message}`)
      })
    } else {
      // Use Electron's utilityProcess to run bridge.cjs in a Node.js context
      const bridgeScript = path.join(process.resourcesPath, 'bridge', 'bridge.cjs')
      this._process = utilityProcess.fork(bridgeScript, ['service', 'start'], {
        stdio: 'pipe',
        execArgv: bridgeExecArgv,
        env: bridgeEnv,
      })
      this._process.stdout.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const t = line.trimEnd()
          if (t) this._log(`[bridge] ${t}`)
        }
      })
      this._process.stderr?.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const t = line.trimEnd()
          if (t) this._log(`[bridge] ${t}`)
        }
      })
      this._process.on('exit', (code) => this._handleBridgeExit(code))
    }

    try {
      await waitForPort(this._ports.bridge, 10000)
      this._status = 'running'
      this._restartAttempts = 0
      this._log(`[bridge] running on port ${this._ports.bridge}`)
    } catch {
      this._status = 'error'
      this._log(`[bridge] failed to start (port ${this._ports.bridge} not ready)`)
    }
  }

  async stop() {
    this._stopping = true
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    // 端口被外部进程占着时我们没启动 bridge，不要去动别人的进程
    if (this._status === 'port_in_use') {
      this._status = 'stopped'
      return
    }

    if (this._process) {
      // child_process.spawn 返回的 ChildProcess 接受信号；utilityProcess 的 kill() 无参数。
      // 用 try/catch 兼容两种 API，并等子进程实际退出再继续。
      const proc = this._process
      this._process = null
      const exited = new Promise((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        proc.once?.('exit', finish)
        // utilityProcess 也用 .once('exit'); ChildProcess 也是。两边都生效。
        setTimeout(finish, 3000) // 兜底超时，防止 kill 后子进程不退
      })
      try { proc.kill('SIGTERM') } catch { try { proc.kill() } catch {} }
      await exited
    }

    this._status = 'stopped'
  }

  getStatus() {
    return this._status
  }

  _handleBridgeExit(code) {
    const wasStopping = this._stopping
    this._process = null
    this._status = code === 0 ? 'stopped' : 'error'
    this._log(`[bridge] exited with code ${formatProcessExitCode(code)}`)
    if (!wasStopping && code !== 0) this._scheduleRestart()
  }

  _scheduleRestart() {
    if (this._restartTimer) return
    this._restartAttempts += 1
    const delay = Math.min(10000, 1000 * this._restartAttempts)
    this._log(`[bridge] exited unexpectedly; restarting in ${delay}ms`)
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      void this.start().catch((error) => {
        this._status = 'error'
        this._log(`[bridge] restart failed: ${error instanceof Error ? error.message : String(error)}`)
        this._scheduleRestart()
      })
    }, delay)
  }
}

export class NodeManager {
  constructor(log, logFile, httpAuthToken, webwrightHome = resolveWebwrightHome(), modelConfigToken = '', explorationInstanceId = '', ports = { backend: 8765, exploration: 8766, bridge: 3711 }) {
    this._ports = ports
    this._process = null
    this._status = 'stopped'
    this._log = log || console.log
    this._logFile = logFile || ''
    this._httpAuthToken = httpAuthToken || ''
    this._webwrightHome = webwrightHome
    this._modelConfigToken = modelConfigToken
    this._explorationInstanceId = explorationInstanceId
    this._stopping = false
    this._restartTimer = null
    this._restartAttempts = 0
    this._externalMonitor = null
    this._portInUseMonitor = null
    this._starting = false
  }

  async start() {
    if (this._starting) return
    if (this._process && (this._status === 'starting' || this._status === 'running')) return
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    if (this._externalMonitor) {
      this._externalMonitor.stop()
      this._externalMonitor = null
    }
    if (this._portInUseMonitor) {
      this._portInUseMonitor.stop()
      this._portInUseMonitor = null
    }
    this._stopping = false
    this._starting = true
    try {
      await this._startInternal()
    } catch (error) {
      this._status = 'error'
      this._log(`[node] startup failed: ${error?.message || error}`)
      throw error
    } finally {
      this._starting = false
    }
  }

  async _startInternal() {
    this._status = 'starting'

    // Do not spawn a second backend into an occupied port. Previously the
    // readiness probe could hit the old process, report "running", and then
    // restart forever when the newly spawned process exited with EADDRINUSE.
    // The startup probe budget tolerates a busy-but-healthy standalone
    // backend; only a foreign or truly unresponsive holder leads to
    // port_in_use, and that state self-heals via _monitorPortInUse.
    const availability = await resolveBackendAvailability({
      port: this._ports.backend,
      checkPort: isPortOccupied,
      probeStatus: (timeout) => probeHttpJson(
        `${this.getUrl()}/status`,
        timeout,
        this._httpAuthToken,
      ),
      allowExternal: !app.isPackaged,
    })
    if (availability === 'external') {
      this._status = 'external_running'
      this._restartAttempts = 0
      this._log(`[node] using standalone backend already running on port ${this._ports.backend}`)
      this._monitorExternalBackend()
      return
    }
    if (availability === 'port_in_use') {
      this._status = 'port_in_use'
      this._log(`[node] port ${this._ports.backend} already in use by another process — skipping backend spawn`)
      this._monitorPortInUse(!app.isPackaged)
      return
    }

    const backendDir = path.resolve(__dirname, '../backend-ts')
    const backendInstanceId = randomUUID()
    const claudeCodePath = resolveClaudeCodePath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: path.resolve(__dirname, '..') })
    if (app.isPackaged) {
      // Packaged: use utilityProcess (Electron's embedded Node.js) — NOT process.execPath
      // which would re-launch Electron itself causing an infinite loop.
      const serverScript = path.join(process.resourcesPath, 'backend-ts', 'server.cjs')
      this._process = utilityProcess.fork(serverScript, [], {
        stdio: 'pipe',
        execArgv: ['--experimental-sqlite'],
        env: {
          ...buildWebwrightEnvironment(adapterEnvironment(), this._webwrightHome),
          WEWORK_PORT: String(this._ports.backend),
          WEWORKER_WEBWRIGHT_URL: `http://127.0.0.1:${this._ports.exploration}`,
          WEBCLI_BRIDGE_PORT: String(this._ports.bridge),
          WEWORK_LOG_FILE: this._logFile,
          WEWORKER_HTTP_TOKEN: this._httpAuthToken,
          WEWORKER_BACKEND_INSTANCE_ID: backendInstanceId,
          WEWORKER_EXPLORATION_INSTANCE_ID: this._explorationInstanceId,
          WEWORKER_CLAUDE_CODE_PATH: claudeCodePath,
          WEWORKER_MODEL_CONFIG_TOKEN: this._modelConfigToken,
          WEWORKER_PACKAGED: '1',
          WEWORKER_RESOURCES_PATH: process.resourcesPath,
          WEWORKER_EXEC_PATH: process.execPath,
        },
      })
      this._process.stdout.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const text = line.trimEnd()
          if (!text) continue
          this._log(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? text : `[node] ${text}`)
        }
      })
      this._process.stderr?.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const text = line.trimEnd()
          if (!text) continue
          this._log(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? text : `[node] ${text}`)
        }
      })
      this._process.on('exit', (code) => this._handleBackendExit(code))
    } else {
      // Dev: use tsx from backend-ts/node_modules to run TypeScript directly
      const cmd = process.execPath
      const args = [path.resolve(backendDir, 'node_modules/tsx/dist/cli.mjs'), '--experimental-sqlite', 'src/server.ts']
      this._log(`[node] starting: ${cmd} ${args.join(' ')}`)
      this._process = spawn(cmd, args, {
        cwd: backendDir,
        env: {
          ...buildWebwrightEnvironment(adapterEnvironment(), this._webwrightHome),
          ELECTRON_RUN_AS_NODE: '1',
          WEWORK_PORT: String(this._ports.backend),
          WEWORKER_WEBWRIGHT_URL: `http://127.0.0.1:${this._ports.exploration}`,
          WEBCLI_BRIDGE_PORT: String(this._ports.bridge),
          WEWORK_LOG_FILE: this._logFile,
          WEWORKER_HTTP_TOKEN: this._httpAuthToken,
          WEWORKER_BACKEND_INSTANCE_ID: backendInstanceId,
          WEWORKER_EXPLORATION_INSTANCE_ID: this._explorationInstanceId,
          WEWORKER_CLAUDE_CODE_PATH: claudeCodePath,
          WEWORKER_MODEL_CONFIG_TOKEN: this._modelConfigToken,
          WEWORKER_RENDERER_ORIGIN: new URL(process.env.WEWORKER_RENDERER_DEV_URL || process.env.WEWORKER_DEV_SERVER_URL || 'http://localhost:5173').origin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      this._process.on('error', (err) => this._log(`[node] spawn error: ${err.message}`))
      this._process.stdout.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const text = line.trimEnd()
          if (!text) continue
          this._log(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? text : `[node] ${text}`)
        }
      })
      this._process.stderr.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          const text = line.trimEnd()
          if (!text) continue
          this._log(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? text : `[node] ${text}`)
        }
      })
      this._process.on('exit', (code) => this._handleBackendExit(code))
    }

    try {
      await waitForHttpInstance(
        `${this.getUrl()}/status`,
        20000,
        this._httpAuthToken,
        backendInstanceId,
      )
      this._status = 'running'
      this._restartAttempts = 0
      this._log(`[node] backend running on port ${this._ports.backend}`)
    } catch {
      this._status = 'error'
      this._log(`[node] failed to start (${this.getUrl()}/status not ready)`)
    }
  }

  async stop() {
    this._stopping = true
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    if (this._externalMonitor) {
      this._externalMonitor.stop()
      this._externalMonitor = null
    }
    if (this._portInUseMonitor) {
      this._portInUseMonitor.stop()
      this._portInUseMonitor = null
    }
    // A standalone development backend was started by the developer, not by
    // Electron. Never terminate it when the desktop app exits.
    if (this._status === 'external_running') {
      this._status = 'stopped'
      return
    }
    if (this._process) {
      this._process.kill('SIGTERM')
      this._process = null
    }
    this._status = 'stopped'
  }

  getStatus() {
    return this._status
  }

  _handleBackendExit(code) {
    const wasStopping = this._stopping
    this._process = null
    this._status = code === 0 ? 'stopped' : 'error'
    this._log(`[node] exited with code ${code}`)
    if (!wasStopping && code !== 0) this._scheduleRestart()
  }

  getUrl() {
    return `http://127.0.0.1:${this._ports.backend}`
  }

  _scheduleRestart() {
    if (this._restartTimer) return
    this._restartAttempts += 1
    const delay = Math.min(10000, 1000 * this._restartAttempts)
    this._log(`[node] backend exited unexpectedly; restarting in ${delay}ms`)
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      void this.start().catch((e) => {
        this._status = 'error'
        this._log(`[node] restart failed: ${e instanceof Error ? e.message : String(e)}`)
        this._scheduleRestart()
      })
    }, delay)
  }

  _monitorExternalBackend() {
    if (this._externalMonitor) return
    this._externalMonitor = new ExternalBackendMonitor({
      probeStatus: (timeout) => probeHttpJson(
        `${this.getUrl()}/status`,
        timeout,
        this._httpAuthToken,
      ),
      onUnavailable: () => {
        this._externalMonitor = null
        this._status = 'stopped'
        this._log('[node] standalone backend is no longer available; starting managed backend')
        void this.start()
      },
    })
    this._externalMonitor.start()
  }

  _monitorPortInUse(allowExternal) {
    if (this._portInUseMonitor) return
    this._portInUseMonitor = new PortInUseMonitor({
      port: this._ports.backend,
      checkPort: isPortOccupied,
      probeStatus: (timeout) => probeHttpJson(
        `${this.getUrl()}/status`,
        timeout,
        this._httpAuthToken,
      ),
      allowExternal,
      onRecovered: (availability) => {
        this._portInUseMonitor = null
        if (this._stopping) return
        this._log(availability === 'free'
          ? `[node] port ${this._ports.backend} is now free; starting managed backend`
          : `[node] standalone backend on port ${this._ports.backend} is reachable again; using it`)
        void this.start()
      },
    })
    this._portInUseMonitor.start()
  }
}

function waitForPort(port, timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    const attempt = () => {
      const sock = new Socket()
      sock.once('connect', () => { sock.destroy(); resolve() })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) return reject(new Error('timeout'))
        setTimeout(attempt, 300)
      })
      sock.connect(port, '127.0.0.1')
    }
    attempt()
  })
}
