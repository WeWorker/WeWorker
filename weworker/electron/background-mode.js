/**
 * Background mode: keep WeWorker (and the dedicated agents served by its
 * backend) running after the window is closed, confirm real quits, and launch
 * at login.
 *
 * Everything Electron-specific is injected so the logic can be unit tested.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BACKEND_PORT } from './backend-availability.js'

export const HIDDEN_LAUNCH_ARG = '--hidden'
export const LOGIN_ITEM_NAME = 'WeWorker'

// ── Preferences (userData/app-settings.json) ────────────────────────────────

const DEFAULT_PREFERENCES = Object.freeze({
  /** Windows: closing the window hides it to the tray instead of quitting. */
  closeToTray: true,
  /** null = never decided; the first packaged launch turns it on by default. */
  launchAtLogin: null,
  /** The "still running in the background" hint is shown once. */
  backgroundHintShown: false,
})

export function normalizePreferences(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    closeToTray: source.closeToTray !== false,
    launchAtLogin: typeof source.launchAtLogin === 'boolean' ? source.launchAtLogin : null,
    backgroundHintShown: source.backgroundHintShown === true,
  }
}

export function createPreferenceStore(filePath, { log = () => {}, fileSystem = fs } = {}) {
  let current = { ...DEFAULT_PREFERENCES }
  try {
    current = normalizePreferences(JSON.parse(fileSystem.readFileSync(filePath, 'utf8')))
  } catch {
    // Missing or unreadable: defaults.
  }
  return {
    get: () => ({ ...current }),
    update(patch) {
      current = normalizePreferences({ ...current, ...patch })
      try {
        fileSystem.mkdirSync(path.dirname(filePath), { recursive: true })
        fileSystem.writeFileSync(filePath, JSON.stringify(current, null, 2), 'utf8')
      } catch (error) {
        log(`[background] failed to save preferences: ${error?.message || error}`)
      }
      return { ...current }
    },
  }
}

// ── Launch at login ─────────────────────────────────────────────────────────

/** Only packaged Windows/macOS builds register a login item (dev would register electron.exe). */
export function isLaunchAtLoginSupported({ isPackaged, platform, disabled = false }) {
  return !disabled && Boolean(isPackaged) && (platform === 'win32' || platform === 'darwin')
}

export function buildLoginItemSettings({ enabled, platform, execPath }) {
  if (platform === 'win32') {
    return { openAtLogin: enabled, path: execPath, args: [HIDDEN_LAUNCH_ARG], name: LOGIN_ITEM_NAME }
  }
  return { openAtLogin: enabled }
}

/**
 * Apply the stored preference to the OS. The first packaged launch records
 * `true`, which makes launch-at-login the default right after installation.
 */
export function syncLaunchAtLogin({ app, preferences, isPackaged, platform, execPath, disabled = false, log = () => {} }) {
  const supported = isLaunchAtLoginSupported({ isPackaged, platform, disabled })
  if (!supported) return { supported: false, enabled: false }
  let { launchAtLogin } = preferences.get()
  if (launchAtLogin === null) {
    launchAtLogin = true
    preferences.update({ launchAtLogin })
    log('[background] first launch: enabling launch at login by default')
  }
  try {
    app.setLoginItemSettings(buildLoginItemSettings({ enabled: launchAtLogin, platform, execPath }))
  } catch (error) {
    log(`[background] failed to update login item: ${error?.message || error}`)
  }
  return { supported: true, enabled: launchAtLogin }
}

/** Started by the OS at login: stay in the background instead of opening the window. */
export function isHiddenLaunch({ argv = [], platform, loginItemSettings }) {
  if (argv.includes(HIDDEN_LAUNCH_ARG)) return true
  return platform === 'darwin' && loginItemSettings?.wasOpenedAtLogin === true
}

// ── Dedicated agents summary ────────────────────────────────────────────────

export function summarizeAgents(agents) {
  const active = (Array.isArray(agents) ? agents : []).filter((agent) => agent && agent.enabled !== false)
  return {
    total: active.length,
    online: active.filter((agent) => agent.connection?.status === 'connected').length,
    names: active.map((agent) => String(agent.name || '')).filter(Boolean),
  }
}

function readAgentsFile(filePath, fileSystem) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed?.agents) ? parsed.agents : []
  } catch {
    return []
  }
}

/**
 * Ask the local backend which dedicated agents are running. When the backend
 * is unreachable, fall back to the agent records on disk (no secrets read).
 */
export async function fetchAgentSummary({
  token = '',
  fetchImpl = fetch,
  timeoutMs = 1500,
  agentsFile = process.env.WEWORKER_DEDICATED_AGENTS_FILE || path.join(os.homedir(), '.weworker', 'dedicated-agents.json'),
  fileSystem = fs,
} = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${BACKEND_PORT}/dedicated-agents`, {
      headers: token ? { 'X-WeWorker-Auth': token } : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      const payload = await response.json()
      return { ...summarizeAgents(payload?.agents), source: 'backend' }
    }
  } catch {
    // Backend not reachable: use the file below.
  }
  const fromFile = summarizeAgents(readAgentsFile(agentsFile, fileSystem))
  return { ...fromFile, online: 0, source: 'file' }
}

export function buildQuitDialog(summary) {
  const listed = summary.names.slice(0, 5).map((name) => `· ${name}`).join('\n')
  const more = summary.names.length > 5 ? `\n· 等 ${summary.names.length} 个` : ''
  return {
    type: 'warning',
    title: '退出 WeWorker',
    message: `你已绑定 ${summary.total} 个专属 Agent，退出后它们将停止回复企业微信和微信消息。`,
    detail: `${listed}${more}\n\n保持 WeWorker 在后台运行，专属 Agent 才能随时为你工作。`,
    buttons: ['留在后台运行', '仍然退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
}

export function trayTooltip(summary) {
  if (!summary || summary.total === 0) return 'WeWorker'
  return summary.source === 'backend'
    ? `WeWorker · 专属 Agent ${summary.online}/${summary.total} 在线`
    : `WeWorker · ${summary.total} 个专属 Agent`
}

// ── Close / quit controller ─────────────────────────────────────────────────

/**
 * Decides what closing the window and quitting the app mean.
 *
 * - Closing the window hides it (Windows: to the tray; macOS: Dock stays, as before).
 *   On Windows the user can turn this off, then closing the window means quitting.
 * - A real quit (tray menu, Cmd+Q, Dock menu) first warns when dedicated agents are bound.
 * - System shutdown/logoff and update installation never prompt.
 */
export function createBackgroundController({
  platform,
  preferences,
  getWindow,
  getAgentSummary,
  showQuitDialog,
  quitApp,
  onHidden = () => {},
  log = () => {},
}) {
  let quitConfirmed = false
  let bypass = false
  let pendingQuit = null

  const hideWindow = () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.hide()
    onHidden()
  }

  const showWindow = () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  }

  /** Returns true when the app is going to quit. */
  const requestQuit = () => {
    if (quitConfirmed || bypass) {
      quitApp()
      return Promise.resolve(true)
    }
    if (pendingQuit) return pendingQuit
    pendingQuit = (async () => {
      try {
        const summary = await getAgentSummary()
        if (summary.total > 0) {
          const choice = await showQuitDialog(buildQuitDialog(summary))
          if (choice === 0) {
            hideWindow()
            return false
          }
          if (choice !== 1) return false
        }
        quitConfirmed = true
        log('[background] quit confirmed')
        quitApp()
        return true
      } finally {
        pendingQuit = null
      }
    })()
    return pendingQuit
  }

  return {
    showWindow,
    hideWindow,
    requestQuit,
    isQuitting: () => quitConfirmed || bypass,
    /** System shutdown/logoff or update install: quit without asking. */
    allowQuitWithoutPrompt(reason) {
      if (!bypass) log(`[background] quitting without prompt (${reason})`)
      bypass = true
    },
    /** Window 'close' handler. */
    handleWindowClose(event) {
      if (quitConfirmed || bypass) return 'close'
      event.preventDefault()
      if (platform === 'darwin' || preferences.get().closeToTray) {
        hideWindow()
        return 'hidden'
      }
      void requestQuit()
      return 'quit-requested'
    },
    /** App 'before-quit' handler. Returns 'proceed' when cleanup should run. */
    handleBeforeQuit(event) {
      if (quitConfirmed || bypass) return 'proceed'
      event.preventDefault()
      void requestQuit()
      return 'intercepted'
    },
  }
}
