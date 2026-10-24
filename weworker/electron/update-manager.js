import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import updater from 'electron-updater'
import deploymentRaw from '../deployment.json' with { type: 'json' }
import deploymentConfigModule from '../deployment-config.cjs'

const DEPLOYMENT = deploymentConfigModule.normalizeDeploymentConfig(deploymentRaw)

const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin'])
const UPDATE_SOURCES = [
  {
    id: 'github',
    label: 'GitHub latest',
    url: DEPLOYMENT.githubUrl,
  },
]
const DEFAULT_UPDATE_SETTINGS = {
  autoCheckEnabled: true,
  checkIntervalHours: 1,
}
const ALLOWED_CHECK_INTERVAL_HOURS = new Set([1, 3, 6, 9, 12, 15, 18, 21, 24])

function normalizeError(error) {
  if (!error) return ''
  return error.message || String(error)
}

function getErrorCode(error) {
  const message = normalizeError(error)
  const candidates = [
    error?.statusCode,
    error?.status,
    error?.code,
    message.match(/\b(\d{3})\b/)?.[1],
  ]
  const code = candidates.find((item) => item !== undefined && item !== null && String(item).trim())
  return code ? String(code).trim() : '未知'
}

function summarizeSourceError(source, error) {
  return `${source.label} 不可用（${getErrorCode(error)}）`
}

function normalizeProgress(progress = {}) {
  return {
    percent: Number.isFinite(progress.percent) ? progress.percent : 0,
    transferred: Number.isFinite(progress.transferred) ? progress.transferred : 0,
    total: Number.isFinite(progress.total) ? progress.total : 0,
    bytesPerSecond: Number.isFinite(progress.bytesPerSecond) ? progress.bytesPerSecond : 0,
  }
}

function getMetadataFile(platform = process.platform) {
  return platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
}

function getSourceDisplayUrl(source, platform = process.platform) {
  return `${source.url}${getMetadataFile(platform)}`
}

function getPublicUpdateSources(platform = process.platform) {
  return UPDATE_SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    url: source.url,
    metadataUrl: getSourceDisplayUrl(source, platform),
  }))
}

function normalizeSettings(settings = {}) {
  const legacyIntervalHours = Number(settings.checkIntervalMinutes) / 60
  const interval = Number.isFinite(Number(settings.checkIntervalHours))
    ? Number(settings.checkIntervalHours)
    : legacyIntervalHours
  const roundedInterval = Math.round(interval)
  const checkIntervalHours = ALLOWED_CHECK_INTERVAL_HOURS.has(roundedInterval)
    ? roundedInterval
    : DEFAULT_UPDATE_SETTINGS.checkIntervalHours
  return {
    autoCheckEnabled: settings.autoCheckEnabled !== false,
    checkIntervalHours,
  }
}

export class UpdateManager {
  constructor({ log, getWindow, beforeInstall } = {}) {
    this.log = typeof log === 'function' ? log : () => {}
    this.getWindow = typeof getWindow === 'function' ? getWindow : () => null
    this.beforeInstall = typeof beforeInstall === 'function' ? beforeInstall : async () => {}
    this.supported = app.isPackaged && SUPPORTED_PLATFORMS.has(process.platform)
    this.settingsPath = path.join(app.getPath('userData'), 'update-settings.json')
    this.settings = this.loadSettings()
    this.state = {
      status: this.supported ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      settings: this.settings,
      latestVersion: '',
      releaseName: '',
      releaseNotes: '',
      progress: null,
      error: this.supported ? '' : '当前平台或开发模式不支持在线更新',
      checkedAt: '',
      updateSources: getPublicUpdateSources(process.platform),
      activeUpdateSource: null,
      sourceErrors: [],
    }
    this.started = false
    this.autoUpdater = null
    this.checkTimer = null
    this.isCheckingUpdateSources = false
  }

  start() {
    if (this.started) return
    this.started = true
    if (!this.supported) {
      this.log('[update] skipped: only packaged Windows/macOS builds support auto update')
      return
    }

    this.autoUpdater = updater.autoUpdater
    this.autoUpdater.autoDownload = false
    this.autoUpdater.autoInstallOnAppQuit = false
    this.applyUpdateSource(UPDATE_SOURCES[0])

    this.autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking', error: '', checkedAt: new Date().toISOString() })
    })

    this.autoUpdater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        latestVersion: info?.version || '',
        releaseName: info?.releaseName || '',
        releaseNotes: info?.releaseNotes || '',
        progress: null,
        error: '',
        checkedAt: new Date().toISOString(),
      })
    })

    this.autoUpdater.on('update-not-available', (info) => {
      this.setState({
        status: 'not-available',
        latestVersion: info?.version || '',
        releaseName: info?.releaseName || '',
        releaseNotes: '',
        progress: null,
        error: '',
        checkedAt: new Date().toISOString(),
      })
    })

    this.autoUpdater.on('download-progress', (progress) => {
      this.setState({
        status: 'downloading',
        progress: normalizeProgress(progress),
        error: '',
      })
    })

    this.autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        latestVersion: info?.version || this.state.latestVersion,
        releaseName: info?.releaseName || this.state.releaseName,
        releaseNotes: info?.releaseNotes || this.state.releaseNotes,
        progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: '',
      })
    })

    this.autoUpdater.on('error', (error) => {
      const message = normalizeError(error)
      this.log(`[update] error: ${message}`)
      if (this.isCheckingUpdateSources) return
      this.setState({ status: 'error', error: message })
    })

    this.scheduleAutoChecks({ runStartupCheck: this.settings.autoCheckEnabled })
  }

  getState() {
    return {
      ...this.state,
      progress: this.state.progress ? { ...this.state.progress } : null,
      updateSources: getPublicUpdateSources(process.platform),
      activeUpdateSource: this.state.activeUpdateSource ? { ...this.state.activeUpdateSource } : null,
      sourceErrors: Array.isArray(this.state.sourceErrors) ? [...this.state.sourceErrors] : [],
    }
  }

  getSettings() {
    return { ...this.settings }
  }

  setSettings(nextSettings = {}) {
    this.settings = normalizeSettings({ ...this.settings, ...nextSettings })
    this.saveSettings()
    this.setState({ settings: this.getSettings() })
    this.scheduleAutoChecks({ runStartupCheck: false })
    return this.getSettings()
  }

  loadSettings() {
    try {
      if (!fs.existsSync(this.settingsPath)) return normalizeSettings()
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'))
      return normalizeSettings(raw)
    } catch (error) {
      this.log(`[update] failed to load settings: ${normalizeError(error)}`)
      return normalizeSettings()
    }
  }

  saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true })
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8')
    } catch (error) {
      this.log(`[update] failed to save settings: ${normalizeError(error)}`)
    }
  }

  scheduleAutoChecks({ runStartupCheck = false } = {}) {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    if (!this.supported || !this.settings.autoCheckEnabled) return
    const intervalMs = this.settings.checkIntervalHours * 60 * 60 * 1000
    if (runStartupCheck) {
      setTimeout(() => this.runScheduledCheck('startup'), 8000)
    }
    this.checkTimer = setInterval(() => this.runScheduledCheck('interval'), intervalMs)
    if (typeof this.checkTimer.unref === 'function') this.checkTimer.unref()
  }

  async runScheduledCheck(reason) {
    try {
      await this.checkForUpdates({ silent: true, reason })
    } catch (error) {
      this.log(`[update] scheduled check failed: ${normalizeError(error)}`)
    }
  }

  async checkForUpdates({ silent = false, reason = 'manual' } = {}) {
    if (!this.supported) return this.getState()
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.getState()
    const sourceErrors = []
    try {
      this.log(`[update] checking for updates${silent ? ' (silent)' : ''} reason=${reason}`)
      for (const source of UPDATE_SOURCES) {
        this.applyUpdateSource(source)
        this.setState({
          status: 'checking',
          error: '',
          sourceErrors: [...sourceErrors],
          checkedAt: new Date().toISOString(),
        })
        try {
          this.log(`[update] trying source=${source.id} url=${getSourceDisplayUrl(source)}`)
          this.isCheckingUpdateSources = true
          await this.autoUpdater.checkForUpdates()
          this.isCheckingUpdateSources = false
          return this.getState()
        } catch (error) {
          this.isCheckingUpdateSources = false
          const message = normalizeError(error)
          sourceErrors.push(summarizeSourceError(source, error))
          this.log(`[update] source failed source=${source.id}: ${message}`)
        }
      }
      const message = sourceErrors.length
        ? `所有更新源均不可用：${sourceErrors.join('；')}`
        : '更新检查失败'
      this.log(`[update] check failed: ${message}`)
      this.setState({
        status: 'error',
        error: message,
        sourceErrors,
        checkedAt: new Date().toISOString(),
      })
    } finally {
      this.isCheckingUpdateSources = false
    }
    return this.getState()
  }

  async downloadUpdate() {
    if (!this.supported) return this.getState()
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return this.getState()
    if (this.state.status !== 'available') {
      await this.checkForUpdates()
      if (this.state.status !== 'available') return this.getState()
    }
    const firstSourceId = this.state.activeUpdateSource?.id || UPDATE_SOURCES[0].id
    const sourceErrors = []
    try {
      this.setState({ status: 'downloading', progress: normalizeProgress(), error: '' })
      await this.autoUpdater.downloadUpdate()
    } catch (error) {
      const message = normalizeError(error)
      this.log(`[update] download failed: ${message}`)
      sourceErrors.push(summarizeSourceError(this.state.activeUpdateSource || UPDATE_SOURCES[0], error))
      for (const source of UPDATE_SOURCES.filter((item) => item.id !== firstSourceId)) {
        try {
          this.log(`[update] retry download with source=${source.id} url=${getSourceDisplayUrl(source)}`)
          this.applyUpdateSource(source)
          this.isCheckingUpdateSources = true
          await this.autoUpdater.checkForUpdates()
          this.isCheckingUpdateSources = false
          if (this.state.status !== 'available') continue
          this.setState({
            status: 'downloading',
            progress: normalizeProgress(),
            error: '',
            sourceErrors: [...sourceErrors],
          })
          await this.autoUpdater.downloadUpdate()
          return this.getState()
        } catch (fallbackError) {
          this.isCheckingUpdateSources = false
          const fallbackMessage = normalizeError(fallbackError)
          sourceErrors.push(summarizeSourceError(source, fallbackError))
          this.log(`[update] fallback download failed source=${source.id}: ${fallbackMessage}`)
        }
      }
      this.setState({
        status: 'error',
        error: `所有更新源下载失败：${sourceErrors.join('；')}`,
        sourceErrors,
      })
    } finally {
      this.isCheckingUpdateSources = false
    }
    return this.getState()
  }

  async installUpdate() {
    if (!this.supported) return this.getState()
    if (this.state.status !== 'downloaded') return this.getState()
    this.log('[update] installing downloaded update')
    await this.beforeInstall()
    this.autoUpdater.quitAndInstall(false, true)
    return this.getState()
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      settings: this.getSettings(),
      updateSources: getPublicUpdateSources(process.platform),
    }
    this.emitState()
  }

  applyUpdateSource(source) {
    if (!this.autoUpdater || !source) return
    this.autoUpdater.setFeedURL({
      provider: 'generic',
      url: source.url,
    })
    this.state.activeUpdateSource = {
      id: source.id,
      label: source.label,
      url: source.url,
      metadataUrl: getSourceDisplayUrl(source),
    }
  }

  emitState() {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('updates:state', this.getState())
  }
}
