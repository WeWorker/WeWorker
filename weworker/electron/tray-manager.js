/**
 * System tray (Windows) / menu bar (macOS) entry for background mode.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { trayTooltip } from './background-mode.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REFRESH_INTERVAL_MS = 30_000

export function resolveTrayIconPath(platform = process.platform) {
  const file = platform === 'darwin'
    ? 'tray-icon-macTemplate.png'
    : platform === 'win32' ? 'tray-icon.ico' : 'tray-icon.png'
  const candidate = path.join(__dirname, 'assets', file)
  return fs.existsSync(candidate) ? candidate : null
}

/** Menu template, kept separate from Electron so it can be tested. */
export function buildTrayMenuTemplate({ summary, launchAtLogin, onOpen, onOpenAgents, onToggleLaunchAtLogin, onQuit, browser = null }) {
  const agentLine = !summary || summary.total === 0
    ? '暂无专属 Agent'
    : summary.source === 'backend'
      ? `专属 Agent：${summary.online}/${summary.total} 在线`
      : `专属 Agent：${summary.total} 个`
  const template = [
    { label: '打开 WeWorker', click: onOpen },
    { label: agentLine, click: onOpenAgents },
  ]
  // WeWorker 浏览器 runs off-screen; the tray is a direct way to bring it up for sign-in.
  if (browser?.available) template.push({ label: '显示 WeWorker 浏览器', click: browser.onShow })
  template.push({ type: 'separator' })
  if (launchAtLogin.supported) {
    template.push({ label: '开机自动启动', type: 'checkbox', checked: launchAtLogin.enabled, click: (item) => onToggleLaunchAtLogin(item.checked) })
    template.push({ type: 'separator' })
  }
  template.push({ label: '退出 WeWorker', click: onQuit })
  return template
}

export function createTrayManager({ Tray, Menu, nativeImage, platform = process.platform, getAgentSummary, getLaunchAtLogin, getBrowser = () => null, handlers, log = () => {} }) {
  let tray = null
  let timer = null
  let summary = null

  const render = () => {
    if (!tray) return
    tray.setToolTip(trayTooltip(summary))
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
      summary,
      launchAtLogin: getLaunchAtLogin(),
      browser: getBrowser(),
      ...handlers,
    })))
  }

  const refresh = async () => {
    try {
      summary = await getAgentSummary()
    } catch {
      // Keep the previous summary.
    }
    render()
  }

  return {
    create() {
      if (tray) return tray
      const iconPath = resolveTrayIconPath(platform)
      const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
      // The 18 pt template includes an @2x variant. Preserve both representations
      // and let macOS tint the transparent glyph for light/dark menu bars.
      if (platform === 'darwin' && !image.isEmpty()) image.setTemplateImage(true)
      tray = new Tray(image)
      if (platform === 'win32') {
        // Single click opens the window; right click shows the menu.
        tray.on('click', () => handlers.onOpen())
      }
      render()
      void refresh()
      timer = setInterval(() => { void refresh() }, REFRESH_INTERVAL_MS)
      timer.unref?.()
      log('[tray] created')
      return tray
    },
    refresh,
    render,
    notify(title, content) {
      if (!tray || platform !== 'win32') return
      try {
        tray.displayBalloon({ title, content, iconType: 'info' })
      } catch {
        // Balloons are best effort.
      }
    },
    destroy() {
      if (timer) clearInterval(timer)
      timer = null
      tray?.destroy()
      tray = null
    },
  }
}
