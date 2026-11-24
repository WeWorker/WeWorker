import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, Tray } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { randomBytes, randomUUID } from 'crypto'
import { stopManagedServices } from './managed-shutdown.js'
import { selectServicePorts } from './service-ports.js'
import {
  BridgeManager,
  NodeManager,
  WebwrightManager,
  readConfiguredUserFilesDir,
  resolveWebwrightHome,
} from './managers.js'
import { registerIpcHandlers } from './ipc-handlers.js'
import { UpdateManager } from './update-manager.js'
import {
  createBackgroundController,
  createPreferenceStore,
  fetchAgentSummary,
  isHiddenLaunch,
  isLaunchAtLoginSupported,
  syncLaunchAtLogin,
} from './background-mode.js'
import { createTrayManager } from './tray-manager.js'
import { BrowserControlClient, normalizeBrowserMode } from './dedicated-browser.js'
import { sanitizeSiteAuthRequest, siteAuthNotification } from './site-auth-ipc.js'
import { packagedMetricsEnvironment } from './metrics-environment.js'
import { TemplateSkillWriteError, writeTemplateSkillLocally } from './template-skill-writer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const devRendererUrl = process.env.WEWORKER_RENDERER_DEV_URL || process.env.WEWORKER_DEV_SERVER_URL || 'http://localhost:5173'
// Each platform's window artwork must also be included in the packaged app.
const appIconPath = path.join(__dirname, process.platform === 'darwin' ? 'assets/app-icon-mac.png' : process.platform === 'win32' ? '../asset/icon.ico' : '../asset/logo.png')

// ── Load metrics env (~/.webcli/metrics.env) ─────────────────────────────────
// 从固定路径读取埋点上报配置（KEY=VALUE），注入 process.env。
// Bridge 子进程（utilityProcess.fork）继承主进程 env，从而拿到三件套：
//   WEBCLI_METRICS_UPLOAD=on / WEBCLI_METRICS_ENDPOINT / WEBCLI_METRICS_TOKEN
// 文件不存在或读取失败则沿用包内默认（公开包默认关闭），不影响主流程。
function loadMetricsEnv() {
  try {
    const envFile = path.join(os.homedir(), '.webcli', 'metrics.env')
    const content = fs.readFileSync(envFile, 'utf8')
    for (const raw of content.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key.startsWith('WEBCLI_METRICS')) process.env[key] = val
    }
  } catch { /* 文件不存在或不可读：静默，不上报 */ }
}
Object.assign(process.env, packagedMetricsEnvironment({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }))
loadMetricsEnv()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'weworker-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: 'weworker-login-image',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

const LOCAL_FILE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}

function registerLocalFileProtocol() {
  protocol.handle('weworker-file', async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = url.searchParams.get('path')
      if (!filePath) return new Response('missing path', { status: 400 })
      const resolved = path.resolve(filePath)
      const stat = await fs.promises.stat(resolved)
      if (!stat.isFile()) return new Response('not found', { status: 404 })
      const ext = path.extname(resolved).toLowerCase()
      const body = await fs.promises.readFile(resolved)
      return new Response(body, {
        headers: {
          'Content-Type': LOCAL_FILE_MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  protocol.handle('weworker-login-image', async (request) => {
    try {
      const url = new URL(request.url)
      const requested = url.searchParams.get('path')
      if (!requested) return new Response('missing path', { status: 400 })
      const root = path.resolve(os.homedir(), '.webcli', 'login')
      const resolved = path.resolve(requested)
      const relative = path.relative(root, resolved)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('not found', { status: 404 })
      const ext = path.extname(resolved).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return new Response('not found', { status: 404 })
      const stat = await fs.promises.stat(resolved)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return new Response('not found', { status: 404 })
      const body = await fs.promises.readFile(resolved)
      return new Response(body, { headers: { 'Content-Type': LOCAL_FILE_MIME[ext], 'Cache-Control': 'no-store' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

// ── Logging setup ────────────────────────────────────────────────────────────
const logDir = process.platform === 'darwin'
  ? path.join(app.getPath('home'), 'Library', 'Logs', 'WeWorker')
  : path.join(app.getPath('userData'), 'logs')
fs.mkdirSync(logDir, { recursive: true })
export const logFile = path.join(logDir, 'main.log')
// Overwrite on each launch — keeps the log fresh and bounded
const logStream = fs.createWriteStream(logFile, { flags: 'w' })
let stdoutWritable = true
let logFileWritable = true

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') {
    stdoutWritable = false
    return
  }
  stdoutWritable = false
})

logStream.on('error', () => {
  logFileWritable = false
})

function safeWrite(stream, msg, onError) {
  try {
    stream.write(msg)
  } catch {
    onError?.()
  }
}

function log(line) {
  // If the line already starts with our logger timestamp format (YYYY-MM-DD HH:MM:SS),
  // write it directly without adding another timestamp (avoids double-timestamp from backend logger)
  const hasTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(line)
  if (hasTimestamp) {
    const msg = line + '\n'
    if (stdoutWritable) safeWrite(process.stdout, msg, () => { stdoutWritable = false })
    if (logFileWritable) safeWrite(logStream, msg, () => { logFileWritable = false })
    return
  }
  const d = new Date()
  const pad2 = (n) => String(n).padStart(2, '0')
  const pad3 = (n) => String(n).padStart(3, '0')
  const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
  const msg = `${ts} ${line}\n`
  if (stdoutWritable) safeWrite(process.stdout, msg, () => { stdoutWritable = false })
  if (logFileWritable) safeWrite(logStream, msg, () => { logFileWritable = false })
}

// Capture uncaught errors in main process
process.on('uncaughtException', (err) => log(`[main] uncaughtException: ${err.stack || err}`))
process.on('unhandledRejection', (reason) => log(`[main] unhandledRejection: ${reason}`))

let mainWindow
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Also brings the window back from the tray / background.
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}
const servicePorts = { backend: 8765, exploration: 8766, bridge: 3711 }
const httpAuthToken = randomBytes(32).toString('base64url')
const webwrightModelToken = randomBytes(32).toString('base64url')
const explorationInstanceId = randomUUID()
const webwrightHome = resolveWebwrightHome()
const userFilesDir = readConfiguredUserFilesDir()
const bridgeManager = new BridgeManager(log, path.dirname(logFile), servicePorts)
// WeWorker 浏览器 is owned by the Bridge; the desktop attaches as a client and only sends fixed actions.
const browserClient = new BrowserControlClient({ log, url: () => `ws://127.0.0.1:${servicePorts.bridge}` })
const pythonManager = new NodeManager(log, logFile, httpAuthToken, webwrightHome, webwrightModelToken, explorationInstanceId, servicePorts)
const webwrightManager = new WebwrightManager({
  log,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: path.resolve(__dirname, '../..'),
  webwrightHome,
  userFilesDir,
  modelConfigToken: webwrightModelToken,
  explorationInstanceId,
  ports: servicePorts,
})
let isInstallingUpdate = false
const updateManager = new UpdateManager({
  log,
  getWindow: () => mainWindow,
  beforeInstall: async () => {
    isInstallingUpdate = true
    background.allowQuitWithoutPrompt('update install')
    await stopManagedServices({ stopExploration: () => webwrightManager.stop(), stopBackend: () => pythonManager.stop(), stopBrowser: stopBridgeAndBrowser })
  },
})

/**
 * Only the Bridge this app started is stopped, after it closed its browser.
 * A Bridge found running on 3711 (for example standalone webcli) keeps its browser;
 * detaching lets it stop the browser on its own once unused.
 */
async function stopBridgeAndBrowser() {
  if (bridgeManager.getStatus() === 'running' && browserClient.connected) {
    await browserClient.request('stop', {}, { timeoutMs: 10_000 }).catch((error) => log(`[browser] stop failed: ${error.message}`))
  }
  browserClient.stop()
  await bridgeManager.stop()
}

// ── Background mode: keep dedicated agents online after the window closes ──
const preferences = createPreferenceStore(path.join(app.getPath('userData'), 'app-settings.json'), { log })
const disableLoginItemIntegration = process.env.WEWORKER_DISABLE_LOGIN_ITEM === '1'
let launchAtLoginState = { supported: isLaunchAtLoginSupported({ isPackaged: app.isPackaged, platform: process.platform, disabled: disableLoginItemIntegration }), enabled: false }
const getAgentSummary = () => fetchAgentSummary({ token: httpAuthToken, backendUrl: pythonManager.getUrl() })
const background = createBackgroundController({
  platform: process.platform,
  preferences,
  getWindow: () => mainWindow,
  getAgentSummary,
  showQuitDialog: async (options) => {
    const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return result.response
  },
  quitApp: () => app.quit(),
  onHidden: () => {
    if (process.platform !== 'win32' || preferences.get().backgroundHintShown) return
    preferences.update({ backgroundHintShown: true })
    trayManager.notify('WeWorker 仍在后台运行', 'WeWorker Bot 会继续工作。点击托盘图标打开，右键可退出。')
  },
  log,
})

function applyLaunchAtLogin() {
  launchAtLoginState = syncLaunchAtLogin({
    app,
    preferences,
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    disabled: disableLoginItemIntegration,
    log,
  })
  return launchAtLoginState
}

function showDedicatedAgentsFromTray() {
  if (!background.showWindow()) return
  mainWindow.webContents.send('app:open-dedicated-agents')
}

const trayManager = createTrayManager({
  Tray,
  Menu,
  nativeImage,
  getAgentSummary,
  getLaunchAtLogin: () => launchAtLoginState,
  getBrowser: () => (browserClient.getStatus().mode === 'dedicated'
    ? {
        available: browserClient.getStatus().status === 'running',
        onShow: () => { void browserClient.request('show').catch((error) => log(`[browser] show failed: ${error.message}`)) },
      }
    : null),
  handlers: {
    onOpen: () => { background.showWindow() },
    onOpenAgents: showDedicatedAgentsFromTray,
    onToggleLaunchAtLogin: (enabled) => {
      if (disableLoginItemIntegration) return
      preferences.update({ launchAtLogin: enabled })
      applyLaunchAtLogin()
      trayManager.render()
    },
    onQuit: () => { void background.requestQuit() },
  },
  log,
})

function getAppSettings() {
  return {
    platform: process.platform,
    closeToTray: preferences.get().closeToTray,
    closeToTraySupported: process.platform === 'win32',
    launchAtLogin: launchAtLoginState.enabled,
    launchAtLoginSupported: launchAtLoginState.supported,
    // The mode lives with the Bridge (~/.weworker/browser/config.json), shared with webcli.
    browserMode: browserClient.getStatus().mode,
  }
}

// The Bridge starts the browser off-screen and without focus. Windows keeps focus (verified);
// on other platforms a launching browser may activate itself, so give focus back once.
let refocusUntil = 0
function keepFocusWhileBrowserStarts() {
  refocusUntil = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() ? Date.now() + 30_000 : 0
}
browserClient.onStatus((status) => {
  if (status.status === 'running' && refocusUntil > Date.now()) {
    refocusUntil = 0
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.focus()
  }
  trayManager.render()
})

/** IPC results keep their shape when the Bridge is unreachable. */
async function browserAction(action, extra = {}) {
  try {
    if (action === 'restart') keepFocusWhileBrowserStarts()
    return await browserClient.request(action, extra)
  } catch (error) {
    log(`[browser] ${action} failed: ${error.message}`)
    return { ...browserClient.getStatus(), error: error.message }
  }
}

ipcMain.handle('app-settings:get', () => getAppSettings())

/**
 * 临时本地通道：仅用于内置模板快速创建专属 Bot。
 *
 * 个别受管 Windows 环境会拒绝 WeWorker/Electron 发往 loopback 的大请求体，
 * 因此这里绕过 HTTP，将 private Skill 原子写入固定的本地 Skill library。
 * Renderer 不能传目标路径或 scope，其他 Skill 创建与编辑流程不得使用此入口。
 * TODO: 后续由统一的 Backend IPC 替代。
 */
ipcMain.handle('dedicated-agents:create-template-skill-local', (event, payload) => {
  const trustedMainFrame = mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === event.sender.mainFrame
  if (!trustedMainFrame) return { ok: false, code: 'FORBIDDEN', detail: '不允许的 Skill 创建来源' }
  try {
    const result = writeTemplateSkillLocally(payload)
    log(`[template-skill-local] created name=${result.name} scope=${result.scope} bytes=${Buffer.byteLength(result.markdown, 'utf8')}`)
    return { ok: true, name: result.name, scope: result.scope }
  } catch (error) {
    const code = error instanceof TemplateSkillWriteError ? error.code : 'WRITE_FAILED'
    const detail = error instanceof Error ? error.message : String(error)
    log(`[template-skill-local] failed code=${code} detail=${detail}`)
    return { ok: false, code, detail }
  }
})

// 后端不可用时设置-日志的兜底：直接读主进程日志文件，保证故障现场也能看日志。
ipcMain.handle('read-main-log', (_event, requestedLines = 500) => {
  const maxLines = Math.min(Math.max(Number(requestedLines) || 500, 1), 5000)
  try {
    if (!fs.existsSync(logFile)) return { lines: [], path: logFile, total: 0 }
    const allLines = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim())
    return { lines: allLines.slice(-maxLines), path: logFile, total: allLines.length }
  } catch (error) {
    return { lines: [], path: logFile, total: 0, error: error instanceof Error ? error.message : String(error) }
  }
})
ipcMain.handle('app-settings:set', async (_event, patch = {}) => {
  const next = {}
  if (typeof patch.closeToTray === 'boolean') next.closeToTray = patch.closeToTray
  if (!disableLoginItemIntegration && typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin
  preferences.update(next)
  if ('launchAtLogin' in next) applyLaunchAtLogin()
  if (typeof patch.browserMode === 'string') {
    const mode = normalizeBrowserMode(patch.browserMode)
    if (mode !== browserClient.getStatus().mode) {
      if (mode === 'dedicated') keepFocusWhileBrowserStarts()
      // No Bridge restart: the Bridge switches modes itself.
      await browserClient.request('set_mode', { mode })
    }
  }
  trayManager.render()
  return getAppSettings()
})

// Fixed actions only: the Renderer never passes URLs or paths to the browser.
ipcMain.handle('dedicated-browser:get-status', () => browserClient.getStatus())
ipcMain.handle('dedicated-browser:show', () => browserAction('show'))
// `soft`: the per-turn hide, which leaves a login page that waits for the user on screen.
ipcMain.handle('dedicated-browser:hide', (_event, options) => browserAction('hide', options?.soft === true ? { soft: true } : {}))
ipcMain.handle('dedicated-browser:restart', () => browserAction('restart'))

// Website login: fixed actions for the Bridge's login flow; events go to the Renderer.
ipcMain.handle('site-auth:control', async (_event, action, payload) => {
  const request = sanitizeSiteAuthRequest(action, payload)
  return browserClient.authRequest(request.action, request.extra, { timeoutMs: 60_000 })
})
let lastAuthNotification = null
browserClient.onAuthEvent((event) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('site-auth:event', event)
  const notice = siteAuthNotification(event)
  const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()
  if (!notice || focused || !Notification.isSupported()) return
  try {
    lastAuthNotification?.close()
    lastAuthNotification = new Notification({ title: notice.title, body: notice.body })
    lastAuthNotification.on('click', () => {
      const extra = event.contextId ? { browserProfile: event.contextId } : {}
      void browserClient.authRequest('show_login', { site: event.site, ...extra }).catch((error) => log(`[login] show failed: ${error.message}`))
    })
    lastAuthNotification.show()
  } catch (error) {
    log(`[login] notification failed: ${error.message}`)
  }
})

async function createWindow({ show = true } = {}) {
  // Keep native editing accelerators even when the frameless window hides its menu.
  // macOS keeps the default system menu.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]))
  }

  mainWindow = new BrowserWindow({
    show,
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    title: isDev ? 'WeWorker (开发版)' : 'WeWorker',
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: false, autoHideMenuBar: true }),
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    const { editFlags } = params
    Menu.buildFromTemplate([
      { label: '撤销', role: 'undo', accelerator: 'CmdOrCtrl+Z', enabled: editFlags.canUndo },
      { label: '重做', role: 'redo', accelerator: process.platform === 'win32' ? 'Ctrl+Y' : 'CmdOrCtrl+Shift+Z', enabled: editFlags.canRedo },
      { type: 'separator' },
      { label: '剪切', role: 'cut', accelerator: 'CmdOrCtrl+X', enabled: editFlags.canCut },
      { label: '复制', role: 'copy', accelerator: 'CmdOrCtrl+C', enabled: editFlags.canCopy },
      { label: '粘贴', role: 'paste', accelerator: 'CmdOrCtrl+V', enabled: editFlags.canPaste },
      { label: '删除', role: 'delete', accelerator: process.platform === 'darwin' ? 'Backspace' : 'Delete', enabled: editFlags.canDelete },
      { type: 'separator' },
      { label: '全选', role: 'selectAll', accelerator: 'CmdOrCtrl+A', enabled: editFlags.canSelectAll },
    ]).popup({ window: mainWindow, frame: params.frame ?? undefined })
  })

  if (process.platform !== 'darwin') {
    const syncMaximizedState = () => mainWindow?.webContents.send('window:maximized-state', mainWindow.isMaximized())
    mainWindow.on('maximize', syncMaximizedState)
    mainWindow.on('unmaximize', syncMaximizedState)
  }

  // 把 renderer 的控制台错误转进 main.log（设置-日志可见），否则「后端连接失败 net-error」这类
  // 卡点错误只留在 DevTools 里，用户侧无从排查。只转发 error 级别，避免刷屏。
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    try {
      if (level === 3 || level === 'error') log(String(message).slice(0, 2000))
    } catch { /* 日志失败不影响页面 */ }
  })

  // Closing the window keeps WeWorker running in the background (see background-mode.js).
  mainWindow.on('close', (event) => {
    if (isInstallingUpdate) return
    background.handleWindowClose(event)
  })
  // Windows shutdown / logoff must not be blocked by the quit confirmation.
  mainWindow.on('query-session-end', () => background.allowQuitWithoutPrompt('session end'))
  mainWindow.on('session-end', () => background.allowQuitWithoutPrompt('session end'))

  if (isDev) {
    mainWindow.loadURL(devRendererUrl)
    // UI E2E attaches over CDP; auto DevTools steals the only page handle puppeteer sees.
    if (!process.env.WEWORKER_E2E) {
      mainWindow.webContents.openDevTools()
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'))
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  log('[main] app ready')
  Object.assign(servicePorts, await selectServicePorts())
  log(`[main] service ports: backend=${servicePorts.backend}, exploration=${servicePorts.exploration}, bridge=${servicePorts.bridge}`)

  // Use the same rounded artwork as the macOS bundle icon, including in dev.
  if (process.platform === 'darwin' && app.dock && fs.existsSync(appIconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath))
  }

  registerIpcHandlers(bridgeManager, pythonManager, webwrightManager, httpAuthToken, updateManager, {
    // "Open Chrome" in dedicated mode means showing WeWorker 浏览器, not the user's Chrome.
    openBrowser: async () => {
      if (browserClient.getStatus().mode !== 'dedicated') return false
      await browserClient.request('show')
      return true
    },
  })
  registerLocalFileProtocol()

  // Webwright health checks must not delay the main window. Its status remains
  // independently observable through IPC while the existing services start.
  void webwrightManager.start().catch((error) => log(`[webwright] startup failed: ${error.message}`))

  // Start bridge and backend in parallel.
  await Promise.allSettled([bridgeManager.start(), pythonManager.start()])
  // Attaching keeps WeWorker 浏览器 running while the app runs (also with a Bridge started by webcli).
  browserClient.start()

  // Launched by the OS at login: stay in the tray / background.
  const startHidden = isHiddenLaunch({
    argv: process.argv,
    platform: process.platform,
    loginItemSettings: app.getLoginItemSettings?.(),
  })
  applyLaunchAtLogin()
  await createWindow({ show: !startHidden })
  if (startHidden) log('[main] started hidden (launched at login)')
  if (browserClient.getStatus().status !== 'running') keepFocusWhileBrowserStarts()
  trayManager.create()
  updateManager.start()

  // macOS/Linux shutdown or logout must not wait for the quit confirmation.
  powerMonitor.on('shutdown', () => background.allowQuitWithoutPrompt('system shutdown'))

  app.on('activate', () => {
    // Dock click: bring back the hidden window, or re-create it if it was destroyed.
    if (background.showWindow()) return
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Electron's `before-quit` does NOT await the async handler — the app proceeds to
// quit while cleanup is still pending, leaving utilityProcess children (bridge,
// backend-ts) orphaned and the port 3711 still bound. Pattern: on the first
// before-quit, prevent the default quit, await cleanup, then call app.exit() to
// actually terminate after subprocesses are reaped.
let isCleaningUp = false
app.on('before-quit', async (event) => {
  if (isInstallingUpdate) return
  // A real quit (tray, Cmd+Q, Dock) first warns when dedicated agents are bound.
  if (background.handleBeforeQuit(event) !== 'proceed') return
  if (isCleaningUp) return
  isCleaningUp = true
  event.preventDefault()
  log('[main] before-quit — stopping subprocesses')
  try {
    await stopManagedServices({ stopExploration: () => webwrightManager.stop(), stopBackend: () => pythonManager.stop(), stopBrowser: stopBridgeAndBrowser })
  } catch (err) {
    log(`[main] cleanup error: ${err?.message || err}`)
  }
  trayManager.destroy()
  log('[main] cleanup done — exiting')
  app.exit(0)
})
