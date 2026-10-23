import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, protocol, Tray } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { randomBytes, randomUUID } from 'crypto'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const devRendererUrl = process.env.WEWORKER_RENDERER_DEV_URL || process.env.WEWORKER_DEV_SERVER_URL || 'http://localhost:5173'

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
const httpAuthToken = randomBytes(32).toString('base64url')
const webwrightModelToken = randomBytes(32).toString('base64url')
const explorationInstanceId = randomUUID()
const webwrightHome = resolveWebwrightHome()
const userFilesDir = readConfiguredUserFilesDir()
const bridgeManager = new BridgeManager(log, path.dirname(logFile))
// WeWorker 浏览器 is owned by the Bridge; the desktop attaches as a client and only sends fixed actions.
const browserClient = new BrowserControlClient({ log })
const pythonManager = new NodeManager(log, logFile, httpAuthToken, webwrightHome, webwrightModelToken, explorationInstanceId)
const webwrightManager = new WebwrightManager({
  log,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repoRoot: path.resolve(__dirname, '../..'),
  webwrightHome,
  userFilesDir,
  modelConfigToken: webwrightModelToken,
  explorationInstanceId,
})
let isInstallingUpdate = false
const updateManager = new UpdateManager({
  log,
  getWindow: () => mainWindow,
  beforeInstall: async () => {
    isInstallingUpdate = true
    background.allowQuitWithoutPrompt('update install')
    await Promise.allSettled([webwrightManager.stop(), pythonManager.stop(), stopBridgeAndBrowser()])
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
let launchAtLoginState = { supported: isLaunchAtLoginSupported({ isPackaged: app.isPackaged, platform: process.platform }), enabled: false }
const getAgentSummary = () => fetchAgentSummary({ token: httpAuthToken })
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
    trayManager.notify('WeWorker 仍在后台运行', '专属 Agent 会继续工作。点击托盘图标打开，右键可退出。')
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
ipcMain.handle('app-settings:set', async (_event, patch = {}) => {
  const next = {}
  if (typeof patch.closeToTray === 'boolean') next.closeToTray = patch.closeToTray
  if (typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin
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
    lastAuthNotification.on('click', () => { void browserAction('show') })
    lastAuthNotification.show()
  } catch (error) {
    log(`[login] notification failed: ${error.message}`)
  }
})

async function createWindow({ show = true } = {}) {
  // Hide the default menu bar on Windows/Linux (macOS uses system menu bar)
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  const iconPath = path.join(__dirname, '../asset/logo.png')
  mainWindow = new BrowserWindow({
    show,
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    title: isDev ? 'WeWorker (开发版)' : 'WeWorker',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : { frame: false }),
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.platform !== 'darwin') {
    const syncMaximizedState = () => mainWindow?.webContents.send('window:maximized-state', mainWindow.isMaximized())
    mainWindow.on('maximize', syncMaximizedState)
    mainWindow.on('unmaximize', syncMaximizedState)
  }

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

  // Set app icon from logo.png (dev + production fallback)
  const logoPath = path.join(__dirname, '../asset/logo.png')
  if (fs.existsSync(logoPath)) {
    const icon = nativeImage.createFromPath(logoPath)
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(icon)
    }
    // mainWindow icon set below after creation
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
    await Promise.allSettled([webwrightManager.stop(), pythonManager.stop(), stopBridgeAndBrowser()])
  } catch (err) {
    log(`[main] cleanup error: ${err?.message || err}`)
  }
  trayManager.destroy()
  log('[main] cleanup done — exiting')
  app.exit(0)
})
