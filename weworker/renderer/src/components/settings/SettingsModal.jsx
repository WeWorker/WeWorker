import deployment from '../../config/deployment.json'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useSettingsStore, PROVIDERS } from '../../store/settings.js'
import ChannelsTab from './ChannelsTab.jsx'
import ExplorationModelSettings from './ExplorationModelSettings.jsx'
import { connectionMessage } from '../../utils/model-connection.js'
import SkillsTab from './SkillsTab.jsx'
import LogsTab from './LogsTab.jsx'
import { useUserFilesStore } from '../../store/user-files.js'
import { normalizeZcfModeId, useZcfStore } from '../../store/zcf.js'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import StyleKindIcon from '../common/StyleKindIcon.jsx'
import { buildModelOptions, getVisibleModelRefreshDetail, selectModelAfterCatalogRefresh, shouldShowModelRefreshFailure } from '../../utils/model-selection.js'
import { normalizePreviewExtension } from '../../utils/resource-preview-extensions.js'
import { CONTEXT_LIMIT_PRESETS, formatContextLimitInput, parseContextLimitInput } from '../../utils/context-window.js'
import { DEFAULT_WELCOME_FEATURED_SITE_LIMIT } from '../welcome/welcome-utils.js'
import { DEFAULT_UPDATE_SETTINGS, UPDATE_CHECK_INTERVAL_HOURS } from '../../../../electron/update-settings.js'
import weworkerLogo from '../../../../asset/logo.png'
import './settings-theme.css'
import { backendFetch } from '../../api/http.js'

const API = 'http://127.0.0.1:8765'
const OFFICIAL_URL = deployment.officialUrl
const DOWNLOAD_URL = deployment.downloadUrl
const GITHUB_UPDATE_URL = 'https://github.com/WeWorker/WeWorker/releases/download/latest/'

const EXACT_PATH_PLACEHOLDER = '例如 folder-b/foo/.env 或 .env'
const REGEX_PATH_PLACEHOLDER = '例如 ^folder-b/.*\\.env$'

function validateBlacklistEntry(entry) {
  // Keep in sync with backend user-directory-blacklist.ts validateBlacklistEntry
  // and user-directory-blacklist.test.ts "validation contract matches settings UI expectations"
  const pattern = String(entry?.pattern || '').trim()
  if (!pattern) return '规则不能为空'
  if (entry?.type === 'exact_path') return null
  if (entry?.type === 'regex_path') {
    try {
      new RegExp(pattern)
      return null
    } catch {
      return '正则表达式无效'
    }
  }
  return '不支持的规则类型'
}

function normalizeBlacklistEntry(entry) {
  const type = entry?.type === 'regex_path' ? 'regex_path' : 'exact_path'
  const pattern = String(entry?.pattern || '').trim()
  if (!pattern || validateBlacklistEntry({ type, pattern })) return null
  return { type, pattern }
}

function sanitizeBlacklistEntries(entries) {
  return (entries || [])
    .map((entry) => normalizeBlacklistEntry(entry))
    .filter(Boolean)
}

function normalizeOriginInput(value) {
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

function hasInvalidBlacklistEntries(entries) {
  return (entries || []).some((entry) => validateBlacklistEntry(entry))
}

const LOGOS = {
  anthropic: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-3.654 0H6.57L0 20h3.603l1.357-3.415h6.175l-1.357-3.415H6.57l2.245-5.638 1.358 3.415z" fill="currentColor"/>
    </svg>
  ),
  glm: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect width="24" height="24" rx="5" fill="currentColor" fillOpacity="0.2"/>
      <text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="bold" fill="currentColor">GLM</text>
    </svg>
  ),
  builtin: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.18"/><path d="M7 12.5 10.2 15 17 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  deepseek: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
      <path d="M8 12c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="12" cy="12" r="2" fill="currentColor"/>
    </svg>
  ),
  custom: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
}

export default function SettingsModal({ onClose }) {
  const [tab, setTab] = useState('model')
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.electronAPI?.getVersion?.().then(v => setAppVersion(v || ''))
  }, [])

  const commitHash = typeof __BUILD_COMMIT_HASH__ !== 'undefined' ? __BUILD_COMMIT_HASH__ : 'dev'

  return (
    <div className="settings-overlay">
      <div className="settings-shell" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2 className="settings-title">设置</h2>
            <p className="settings-subtitle">配置模型、通道与应用偏好</p>
          </div>
          <button type="button" className="settings-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="settings-tabs">
          {[['model', '模型'], ['channels', '通道'], ['config', '配置'], ['logs', '日志'], ['about', '关于']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`settings-tab${tab === key ? ' is-active' : ''}`}
              aria-selected={tab === key}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`settings-tab${tab === 'permissions' ? ' is-active' : ''}`}
            aria-selected={tab === 'permissions'}
            onClick={() => setTab('permissions')}
          >
            权限
          </button>
        </div>

        <div className="settings-body">
          {tab === 'channels' && <ChannelsTab />}
          {tab === 'permissions' && <PermissionsTab />}
          {tab === 'config' && <ConfigTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'logs' && <LogsTab />}
          {tab === 'about' && <AboutTab appVersion={appVersion} commitHash={commitHash} />}
          {tab === 'model' && <ModelTab onClose={onClose} />}
        </div>

        <div className="settings-footer">
          {appVersion && <span>v{appVersion}</span>}
          {commitHash && <span style={{ opacity: 0.7 }}>({commitHash})</span>}
        </div>
      </div>
    </div>
  )
}

function AboutTab({ appVersion, commitHash }) {
  const [updateState, setUpdateState] = useState(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [savingUpdateSettings, setSavingUpdateSettings] = useState(false)
  const [updateSettings, setUpdateSettings] = useState(DEFAULT_UPDATE_SETTINGS)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getUpdateState?.().then((state) => {
      if (!cancelled) {
        setUpdateState(state)
        if (state?.settings) setUpdateSettings(state.settings)
      }
    })
    window.electronAPI?.getUpdateSettings?.().then((settings) => {
      if (!cancelled && settings) setUpdateSettings(settings)
    })
    const unsubscribe = window.electronAPI?.onUpdateState?.((state) => {
      if (state) {
        setUpdateState(state)
        if (state.settings) setUpdateSettings(state.settings)
      }
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const status = updateState?.status || 'idle'
  const progress = Math.max(0, Math.min(100, Number(updateState?.progress?.percent || 0)))
  const latestVersion = updateState?.latestVersion || ''
  const updateMetadataFile = updateState?.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const updateSources = Array.isArray(updateState?.updateSources) && updateState.updateSources.length > 0
    ? updateState.updateSources
    : [
        { id: 'official', label: '官网', metadataUrl: `${DOWNLOAD_URL}${updateMetadataFile}` },
        { id: 'github', label: 'GitHub latest', metadataUrl: `${GITHUB_UPDATE_URL}${updateMetadataFile}` },
      ]
  const activeUpdateSourceId = updateState?.activeUpdateSource?.id || ''
  const checkIntervalValue = Number(updateSettings.checkIntervalHours || 12)
  const canCheck = status !== 'checking' && status !== 'downloading'
  const canDownload = status === 'available'
  const canInstall = status === 'downloaded'

  const checkUpdate = async () => {
    if (!canCheck) return
    setChecking(true)
    try {
      const state = await window.electronAPI?.checkForUpdates?.()
      if (state) setUpdateState(state)
    } finally {
      setChecking(false)
    }
  }

  const downloadUpdate = async () => {
    if (!canDownload) return
    setDownloading(true)
    try {
      const state = await window.electronAPI?.downloadUpdate?.()
      if (state) setUpdateState(state)
    } finally {
      setDownloading(false)
    }
  }

  const installUpdate = async () => {
    if (!canInstall) return
    setInstalling(true)
    try {
      const state = await window.electronAPI?.installUpdate?.()
      if (state) setUpdateState(state)
    } finally {
      setInstalling(false)
    }
  }

  const saveUpdateSettings = async () => {
    const nextSettings = {
      autoCheckEnabled: updateSettings.autoCheckEnabled !== false,
      checkIntervalHours: UPDATE_CHECK_INTERVAL_HOURS.includes(Number(updateSettings.checkIntervalHours))
        ? Number(updateSettings.checkIntervalHours)
        : DEFAULT_UPDATE_SETTINGS.checkIntervalHours,
    }
    setSavingUpdateSettings(true)
    try {
      const saved = await window.electronAPI?.setUpdateSettings?.(nextSettings)
      if (saved) setUpdateSettings(saved)
    } finally {
      setSavingUpdateSettings(false)
    }
  }

  const updateMessage = (() => {
    if (status === 'checking') return '正在检查最新版本...'
    if (status === 'available') return latestVersion ? `发现新版本 v${latestVersion}` : '发现新版本'
    if (status === 'downloading') return `正在下载更新 ${Math.round(progress)}%`
    if (status === 'downloaded') return latestVersion ? `v${latestVersion} 已下载，重启后安装` : '更新已下载，重启后安装'
    if (status === 'not-available') return '当前已是最新版本'
    if (status === 'unsupported') return '当前环境不支持在线更新，打包后的 Windows/macOS 客户端可用'
    if (status === 'error') return updateState?.error || '更新检查失败'
    return '尚未检查更新'
  })()

  return (
    <div className="settings-stack">
      <div className="settings-about-card">
        <div className="settings-about-logo" aria-hidden="true">
          <img src={weworkerLogo} alt="" />
        </div>
        <div className="settings-about-name">WeWorker</div>
        <div className="settings-about-version">
          版本 {appVersion || updateState?.currentVersion || '未知'} · 构建 {commitHash || 'dev'}
        </div>
        <div className="settings-about-links">
          <InfoLine label="官网" value={OFFICIAL_URL} href={OFFICIAL_URL} />
          <InfoLine label="下载" value={DOWNLOAD_URL} href={DOWNLOAD_URL} />
        </div>
      </div>

      <div className="settings-group">
        <SettingRow
          title="自动检测更新"
          description="启动时检查一次；开启后按设定间隔在后台检测新版本"
          stacked
          footer={(
            <button
              type="button"
              className="settings-btn settings-btn-primary"
              onClick={saveUpdateSettings}
              disabled={savingUpdateSettings}
            >
              {savingUpdateSettings ? '保存中...' : '保存设置'}
            </button>
          )}
        >
          <div className="settings-update-settings">
            <label className="settings-switch-row">
              <input
                type="checkbox"
                role="switch"
                checked={updateSettings.autoCheckEnabled !== false}
                onChange={(event) => setUpdateSettings((current) => ({
                  ...current,
                  autoCheckEnabled: event.target.checked,
                }))}
              />
              <span className="settings-switch-track" aria-hidden="true">
                <span className="settings-switch-thumb" />
              </span>
              <span className="settings-switch-label">启动自动检测更新</span>
            </label>
            <div className="settings-update-interval">
              <span className="settings-update-interval__label">检测间隔</span>
              <AppDropdownSelect
                value={checkIntervalValue}
                disabled={updateSettings.autoCheckEnabled === false}
                onChange={(hours) => setUpdateSettings((current) => ({
                  ...current,
                  checkIntervalHours: Number(hours),
                }))}
                options={UPDATE_CHECK_INTERVAL_HOURS.map((hours) => ({
                  value: hours,
                  label: `${hours} 小时`,
                }))}
                className="settings-update-interval__dropdown"
                menuClassName="app-dropdown-menu settings-update-interval-menu"
                minMenuWidth={116}
                matchAnchorWidth
                ariaLabel="检测间隔"
              />
            </div>
          </div>
        </SettingRow>

        <SettingRow
          title="软件更新"
          description="检查 WeWorker 最新版本，下载完成后可重启安装"
          message={{ ok: status !== 'error', text: updateMessage }}
          stacked
          footer={(
            <div className="settings-inline-actions">
              <button
                type="button"
                className="settings-btn settings-btn-secondary settings-update-action"
                onClick={checkUpdate}
                disabled={!canCheck || checking}
              >
                {checking || status === 'checking' ? '检查中...' : '检查更新'}
              </button>
              {canDownload && (
                <button
                  type="button"
                  className="settings-btn settings-btn-primary settings-update-action"
                  onClick={downloadUpdate}
                  disabled={downloading}
                >
                  {downloading ? '准备下载...' : '下载更新'}
                </button>
              )}
              {canInstall && (
                <button
                  type="button"
                  className="settings-btn settings-btn-primary settings-update-action"
                  onClick={installUpdate}
                  disabled={installing}
                >
                  {installing ? '正在重启...' : '重启安装'}
                </button>
              )}
            </div>
          )}
        >
          {status === 'downloading' ? (
            <div className="settings-update-progress">
              <div className="settings-update-progress__bar" style={{ width: `${progress}%` }} />
            </div>
          ) : (
            <div className="settings-action-hint">
              <div className="settings-update-sources">
                {updateSources.map((source) => {
                  const isActive = activeUpdateSourceId && source.id === activeUpdateSourceId
                  return (
                    <div key={source.id || source.metadataUrl} className={`settings-update-source${isActive ? ' is-active' : ''}`}>
                      <span className="settings-update-source__label">
                        <span>{source.label || source.id || '更新源'}</span>
                        {isActive && <span className="settings-update-source__badge">当前</span>}
                      </span>
                      <button
                        type="button"
                        className="settings-update-source__url"
                        onClick={() => window.electronAPI?.openExternal?.(source.metadataUrl || source.url)}
                        title={source.metadataUrl || source.url}
                      >
                        {source.metadataUrl || source.url}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </SettingRow>
      </div>
    </div>
  )
}

function InfoLine({ label, value, href }) {
  return (
    <div className="settings-info-line">
      <span className="settings-info-line__label">{label}</span>
      {href ? (
        <button
          type="button"
          className="settings-info-line__link"
          onClick={() => window.electronAPI?.openExternal?.(href)}
          title={value}
        >
          {value}
        </button>
      ) : (
        <span className="settings-info-line__value">{value}</span>
      )}
    </div>
  )
}

function PermissionsTab() {
  const loaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const defaultOpenBrowserAllowedOrigins = useSettingsStore((s) => s.defaultOpenBrowserAllowedOrigins)
  const openBrowserAllowedOrigins = useSettingsStore((s) => s.openBrowserAllowedOrigins)
  const savePermissions = useSettingsStore((s) => s.savePermissions)

  const [origins, setOrigins] = useState(openBrowserAllowedOrigins || [])
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    if (!loaded) loadSettings()
  }, [loaded, loadSettings])

  useEffect(() => {
    setOrigins(openBrowserAllowedOrigins || [])
  }, [openBrowserAllowedOrigins])

  const addOrigin = () => {
    const normalized = normalizeOriginInput(draft)
    if (!normalized) {
      setMessage({ ok: false, text: '请输入 http/https 地址，例如 http://127.0.0.1:8765' })
      return
    }
    setOrigins((items) => items.includes(normalized) ? items : [normalized, ...items])
    setDraft('')
    setMessage(null)
  }

  const removeOrigin = (origin) => {
    setOrigins((items) => items.filter((item) => item !== origin))
    setMessage(null)
  }

  const handleDraftKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addOrigin()
    }
  }

  const handleSave = async () => {
    let next = origins
    const pending = draft.trim()
    if (pending) {
      const normalized = normalizeOriginInput(pending)
      if (!normalized) {
        setMessage({ ok: false, text: '请输入 http/https 地址，例如 http://127.0.0.1:8765' })
        return
      }
      next = origins.includes(normalized) ? origins : [normalized, ...origins]
      setDraft('')
      setOrigins(next)
    }

    setSaving(true)
    setMessage(null)
    try {
      const saved = await savePermissions({ openBrowserAllowedOrigins: next })
      setOrigins(saved)
      setMessage({ ok: true, text: '已保存，将在下一次 open_browser 调用时生效' })
    } catch (e) {
      setMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  const dirty = JSON.stringify([...(origins || [])].sort()) !== JSON.stringify([...(openBrowserAllowedOrigins || [])].sort()) || Boolean(draft.trim())

  return (
    <div className="settings-stack">
      <div className="settings-group">
        <SettingRow
          title="open_browser 默认白名单"
          description="由当前启用的站点适配器自动生成，无法在这里手动删除"
          fallback={defaultOpenBrowserAllowedOrigins?.length ? `共 ${defaultOpenBrowserAllowedOrigins.length} 个默认 origin` : '当前没有可用的默认站点 origin'}
          stacked
        >
          <OriginList
            origins={defaultOpenBrowserAllowedOrigins || []}
            emptyText="暂无默认白名单。启用站点适配器后会自动出现在这里。"
            readOnly
          />
        </SettingRow>

        <SettingRow
          title="open_browser URL 白名单"
          description="允许 AI 通过 open_browser 打开的额外本地或业务系统地址"
          message={message}
          fallback="默认只允许已安装站点适配器中的地址；新增地址保存后会用于下一次 open_browser 调用"
          stacked
          footer={(
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !dirty}
              className="settings-btn settings-btn-primary"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            <div className="settings-pill settings-pill--wide" style={{ maxWidth: '100%' }}>
              <input
                className="settings-pill-input"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setMessage(null) }}
                onKeyDown={handleDraftKeyDown}
                placeholder="例如 http://127.0.0.1:8765"
                style={{ fontFamily: 'Consolas, monospace' }}
              />
              <button type="button" onClick={addOrigin} className="settings-pill-btn">添加</button>
            </div>

            {origins.length === 0 ? (
              <div className="settings-action-hint">暂无额外白名单。需要允许本地开发服务时，可添加类似 http://127.0.0.1:8765 的 origin。</div>
            ) : (
              <div className="settings-origin-list">
                {origins.map((origin) => (
                  <div key={origin} className="settings-pill settings-pill--wide" style={{ maxWidth: '100%' }}>
                    <input
                      className="settings-pill-input"
                      value={origin}
                      readOnly
                      style={{ fontFamily: 'Consolas, monospace' }}
                    />
                    <button type="button" onClick={() => removeOrigin(origin)} className="settings-pill-btn" style={{ color: 'var(--error)' }}>删除</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SettingRow>
      </div>
    </div>
  )
}

function OriginList({ origins = [], emptyText, onRemove, readOnly = false }) {
  if (!origins.length) {
    return <div className="settings-action-hint">{emptyText}</div>
  }

  return (
    <div className="settings-origin-list">
      {origins.map((origin) => (
        <div key={origin} className="settings-pill settings-pill--wide" style={{ maxWidth: '100%' }}>
          <input
            className="settings-pill-input"
            value={origin}
            readOnly
            style={{ fontFamily: 'Consolas, monospace' }}
          />
          {!readOnly && (
            <button type="button" onClick={() => onRemove?.(origin)} className="settings-pill-btn" style={{ color: 'var(--error)' }}>删除</button>
          )}
        </div>
      ))}
    </div>
  )
}

function ConfigTab() {
  const userDirectory = useSettingsStore((s) => s.userDirectory)
  const downloadSubdirectory = useSettingsStore((s) => s.downloadSubdirectory)
  const downloadDirectory = useSettingsStore((s) => s.downloadDirectory)
  const maxChatAttachments = useSettingsStore((s) => s.maxChatAttachments)
  const pasteTextAttachmentThreshold = useSettingsStore((s) => s.pasteTextAttachmentThreshold)
  const welcomeFeaturedSiteLimit = useSettingsStore((s) => s.welcomeFeaturedSiteLimit)
  const resourcePreviewExtensions = useSettingsStore((s) => s.resourcePreviewExtensions)
  const resourcePreviewExtensionsCustomized = useSettingsStore((s) => s.resourcePreviewExtensionsCustomized)
  const defaultResourcePreviewExtensions = useSettingsStore((s) => s.defaultResourcePreviewExtensions)
  const userDirectoryBlacklist = useSettingsStore((s) => s.userDirectoryBlacklist)
  const loaded = useSettingsStore((s) => s.loaded)
  const loadSettings = useSettingsStore((s) => s.load)
  const saveUserDirectory = useSettingsStore((s) => s.saveUserDirectory)
  const saveDownloadDirectory = useSettingsStore((s) => s.saveDownloadDirectory)
  const saveMaxChatAttachments = useSettingsStore((s) => s.saveMaxChatAttachments)
  const savePasteTextAttachmentThreshold = useSettingsStore((s) => s.savePasteTextAttachmentThreshold)
  const saveWelcomeFeaturedSiteLimit = useSettingsStore((s) => s.saveWelcomeFeaturedSiteLimit)
  const saveResourcePreviewExtensions = useSettingsStore((s) => s.saveResourcePreviewExtensions)
  const resetResourcePreviewExtensions = useSettingsStore((s) => s.resetResourcePreviewExtensions)
  const saveUserDirectoryBlacklist = useSettingsStore((s) => s.saveUserDirectoryBlacklist)
  const reloadFiles = useUserFilesStore((s) => s.load)

  const [userValue, setUserValue] = useState(userDirectory || '')
  const [downloadValue, setDownloadValue] = useState(downloadSubdirectory || 'download')
  const [maxValue, setMaxValue] = useState(String(maxChatAttachments || 60))
  const [pasteThresholdValue, setPasteThresholdValue] = useState(String(pasteTextAttachmentThreshold || 20000))
  const [welcomeLimitValue, setWelcomeLimitValue] = useState(String(welcomeFeaturedSiteLimit || DEFAULT_WELCOME_FEATURED_SITE_LIMIT))
  const [previewExtensions, setPreviewExtensions] = useState(resourcePreviewExtensions || [])
  const [previewExtensionInput, setPreviewExtensionInput] = useState('')
  const [previewExtensionsExpanded, setPreviewExtensionsExpanded] = useState(false)
  const [blacklist, setBlacklist] = useState(userDirectoryBlacklist || [])
  const [draftPattern, setDraftPattern] = useState('')
  const [draftMatchMode, setDraftMatchMode] = useState('exact_path')
  const [savingUser, setSavingUser] = useState(false)
  const [savingDownload, setSavingDownload] = useState(false)
  const [savingMax, setSavingMax] = useState(false)
  const [savingPasteThreshold, setSavingPasteThreshold] = useState(false)
  const [savingWelcomeLimit, setSavingWelcomeLimit] = useState(false)
  const [savingPreviewExtensions, setSavingPreviewExtensions] = useState(false)
  const [resettingPreviewExtensions, setResettingPreviewExtensions] = useState(false)
  const [savingBlacklist, setSavingBlacklist] = useState(false)
  const [userMessage, setUserMessage] = useState(null)
  const [downloadMessage, setDownloadMessage] = useState(null)
  const [maxMessage, setMaxMessage] = useState(null)
  const [pasteThresholdMessage, setPasteThresholdMessage] = useState(null)
  const [welcomeLimitMessage, setWelcomeLimitMessage] = useState(null)
  const [previewExtensionsMessage, setPreviewExtensionsMessage] = useState(null)
  const [blacklistMessage, setBlacklistMessage] = useState(null)

  useEffect(() => {
    if (!loaded) loadSettings()
  }, [loaded, loadSettings])

  useEffect(() => setUserValue(userDirectory || ''), [userDirectory])
  useEffect(() => setDownloadValue(downloadSubdirectory || 'download'), [downloadSubdirectory])
  useEffect(() => setMaxValue(String(maxChatAttachments || 60)), [maxChatAttachments])
  useEffect(() => setPasteThresholdValue(String(pasteTextAttachmentThreshold || 20000)), [pasteTextAttachmentThreshold])
  useEffect(() => setWelcomeLimitValue(String(welcomeFeaturedSiteLimit || DEFAULT_WELCOME_FEATURED_SITE_LIMIT)), [welcomeFeaturedSiteLimit])
  useEffect(() => setPreviewExtensions(resourcePreviewExtensions || []), [resourcePreviewExtensions])
  useEffect(() => {
    const next = sanitizeBlacklistEntries(userDirectoryBlacklist)
    setBlacklist(next)
  }, [userDirectoryBlacklist])

  const previewExtensionsDirty = JSON.stringify([...(previewExtensions || [])].sort())
    !== JSON.stringify([...(resourcePreviewExtensions || [])].sort())

  const normalizeSlashes = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')

  const isInsideUserDirectory = (selected, userRoot) => {
    const selectedNorm = normalizeSlashes(selected).toLowerCase()
    const rootNorm = normalizeSlashes(userRoot).toLowerCase()
    return selectedNorm === rootNorm || selectedNorm.startsWith(`${rootNorm}/`)
  }

  const toDownloadSubdirectory = (selected, userRoot) => {
    const rootNorm = normalizeSlashes(userRoot)
    const selectedNorm = normalizeSlashes(selected)
    if (!isInsideUserDirectory(selected, userRoot)) return null
    if (selectedNorm.toLowerCase() === rootNorm.toLowerCase()) return null
    return selectedNorm.slice(rootNorm.length).replace(/^\/+/, '')
  }

  const normalizeDownloadInputValue = (value, userRoot) => {
    const trimmed = String(value || '').trim()
    if (!trimmed) return ''
    if (userRoot && isInsideUserDirectory(trimmed, userRoot)) {
      return toDownloadSubdirectory(trimmed, userRoot) || ''
    }
    return trimmed.replace(/\\/g, '/').replace(/^\/+/, '')
  }

  const resolvedDownloadDirectory = (() => {
    const root = userValue.trim() || userDirectory
    const sub = normalizeDownloadInputValue(downloadValue, root) || 'download'
    if (!root) return downloadDirectory || ''
    return `${normalizeSlashes(root)}/${sub.replace(/^\/+/, '')}`
  })()

  const chooseUserDirectory = async () => {
    const paths = await window.electronAPI?.selectDirectory?.()
    if (paths?.[0]) setUserValue(paths[0])
  }

  const chooseDownloadDirectory = async () => {
    const userRoot = userValue.trim() || userDirectory
    if (!userRoot) {
      setDownloadMessage({ ok: false, text: '请先设置用户目录' })
      return
    }
    const paths = await window.electronAPI?.selectDirectory?.({ defaultPath: userRoot })
    if (!paths?.[0]) return
    const subpath = toDownloadSubdirectory(paths[0], userRoot)
    if (!subpath) {
      setDownloadMessage({ ok: false, text: '只能选择用户目录内的子文件夹' })
      return
    }
    setDownloadValue(subpath)
    setDownloadMessage(null)
  }

  const handleSaveUserDirectory = async () => {
    const next = userValue.trim()
    if (!next) {
      setUserMessage({ ok: false, text: '请填写用户目录' })
      return
    }
    setSavingUser(true)
    setUserMessage(null)
    try {
      const savedPath = await saveUserDirectory(next)
      setUserValue(savedPath)
      await reloadFiles()
      setUserMessage({ ok: true, text: '已保存' })
    } catch (e) {
      setUserMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingUser(false)
    }
  }

  const handleSaveDownloadDirectory = async () => {
    const next = normalizeDownloadInputValue(downloadValue, userValue.trim() || userDirectory)
    if (!next) {
      setDownloadMessage({ ok: false, text: '请填写下载子目录' })
      return
    }
    setSavingDownload(true)
    setDownloadMessage(null)
    try {
      const saved = await saveDownloadDirectory(next)
      setDownloadValue(saved.downloadSubdirectory)
      setDownloadMessage({ ok: true, text: `完整路径：${saved.downloadDirectory || resolvedDownloadDirectory}` })
    } catch (e) {
      setDownloadMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingDownload(false)
    }
  }

  const handleSaveMaxAttachments = async () => {
    const next = Number(maxValue)
    if (!Number.isFinite(next) || next < 1 || next > 200) {
      setMaxMessage({ ok: false, text: '请输入 1-200 之间的整数' })
      return
    }
    setSavingMax(true)
    setMaxMessage(null)
    try {
      const saved = await saveMaxChatAttachments(Math.floor(next))
      setMaxValue(String(saved))
      setMaxMessage({ ok: true, text: '已保存' })
    } catch (e) {
      setMaxMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingMax(false)
    }
  }

  const handleSavePasteThreshold = async () => {
    const next = Number(pasteThresholdValue)
    if (!Number.isFinite(next) || next < 1000 || next > 200000) {
      setPasteThresholdMessage({ ok: false, text: '请输入 1000-200000 之间的整数' })
      return
    }
    setSavingPasteThreshold(true)
    setPasteThresholdMessage(null)
    try {
      const saved = await savePasteTextAttachmentThreshold(Math.floor(next))
      setPasteThresholdValue(String(saved))
      setPasteThresholdMessage({ ok: true, text: '已保存' })
    } catch (e) {
      setPasteThresholdMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingPasteThreshold(false)
    }
  }

  const handleSaveWelcomeLimit = async () => {
    const next = Number(welcomeLimitValue)
    if (!Number.isFinite(next) || next < 1 || next > 50) {
      setWelcomeLimitMessage({ ok: false, text: '请输入 1-50 之间的整数' })
      return
    }
    setSavingWelcomeLimit(true)
    setWelcomeLimitMessage(null)
    try {
      const saved = await saveWelcomeFeaturedSiteLimit(Math.floor(next))
      setWelcomeLimitValue(String(saved))
      setWelcomeLimitMessage({ ok: true, text: '已保存' })
    } catch (e) {
      setWelcomeLimitMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingWelcomeLimit(false)
    }
  }

  const addPreviewExtension = () => {
    const normalized = normalizePreviewExtension(previewExtensionInput)
    if (!normalized) {
      setPreviewExtensionsMessage({ ok: false, text: '请输入有效的后缀，例如 .rs' })
      return
    }
    if (previewExtensions.includes(normalized)) {
      setPreviewExtensionInput('')
      return
    }
    setPreviewExtensions((current) => [normalized, ...current])
    setPreviewExtensionInput('')
    setPreviewExtensionsMessage(null)
  }

  const removePreviewExtension = (ext) => {
    setPreviewExtensions((current) => current.filter((item) => item !== ext))
    setPreviewExtensionsMessage(null)
  }

  const handlePreviewExtensionInputKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addPreviewExtension()
    }
  }

  const handleSavePreviewExtensions = async () => {
    setSavingPreviewExtensions(true)
    setPreviewExtensionsMessage(null)
    try {
      const saved = await saveResourcePreviewExtensions(previewExtensions)
      setPreviewExtensions(saved)
      setPreviewExtensionsExpanded(false)
      setPreviewExtensionsMessage({ ok: true, text: '已保存' })
    } catch (e) {
      setPreviewExtensionsMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingPreviewExtensions(false)
    }
  }

  const handleResetPreviewExtensions = async () => {
    setResettingPreviewExtensions(true)
    setPreviewExtensionsMessage(null)
    try {
      const saved = await resetResourcePreviewExtensions()
      setPreviewExtensions(saved)
      setPreviewExtensionInput('')
      setPreviewExtensionsExpanded(false)
      setPreviewExtensionsMessage({ ok: true, text: '已恢复默认' })
    } catch (e) {
      setPreviewExtensionsMessage({ ok: false, text: e.message || '恢复默认失败' })
    } finally {
      setResettingPreviewExtensions(false)
    }
  }

  const handleAddBlacklistEntry = () => {
    const pattern = draftPattern.trim()
    if (!pattern) {
      setBlacklistMessage({ ok: false, text: '请填写路径或正则规则' })
      return
    }
    const entry = { type: draftMatchMode, pattern }
    const error = validateBlacklistEntry(entry)
    if (error) {
      setBlacklistMessage({ ok: false, text: error })
      return
    }
    setBlacklist((items) => [entry, ...items])
    setDraftPattern('')
    setBlacklistMessage(null)
  }

  const handleRemoveBlacklistEntry = (index) => {
    setBlacklist((items) => items.filter((_, i) => i !== index))
    setBlacklistMessage(null)
  }

  const handleUpdateBlacklistEntry = (index, field, value) => {
    setBlacklist((items) => items.map((item, i) => (i === index ? { ...item, [field]: value } : item)))
    setBlacklistMessage(null)
  }

  const handleSaveBlacklist = async () => {
    setSavingBlacklist(true)
    setBlacklistMessage(null)
    try {
      if (hasInvalidBlacklistEntries(blacklist)) {
        setBlacklistMessage({ ok: false, text: '请先修正或删除无效规则后再保存' })
        return
      }
      let next = blacklist
      const pendingPattern = draftPattern.trim()
      if (pendingPattern) {
        const pendingEntry = { type: draftMatchMode, pattern: pendingPattern }
        const error = validateBlacklistEntry(pendingEntry)
        if (error) {
          setBlacklistMessage({ ok: false, text: error })
          return
        }
        next = [pendingEntry, ...blacklist]
        setDraftPattern('')
        setBlacklist(next)
      }
      const sanitized = sanitizeBlacklistEntries(next)
      const localDropped = next.length - sanitized.length
      if (sanitized.length === 0 && (next.length > 0 || pendingPattern)) {
        setBlacklistMessage({ ok: false, text: '没有可保存的有效规则，请检查输入' })
        return
      }
      const result = await saveUserDirectoryBlacklist(sanitized)
      if (result.entries.length === 0 && sanitized.length > 0) {
        setBlacklistMessage({ ok: false, text: '规则未能写入配置，请重启 WeWorker 后重试' })
        return
      }
      setBlacklist(result.entries)
      await reloadFiles()
      const dropped = localDropped + result.dropped
      if (dropped > 0) {
        setBlacklistMessage({ ok: true, text: `已保存 ${result.entries.length} 条，移除了 ${dropped} 条无效规则` })
      } else {
        setBlacklistMessage({ ok: true, text: `已保存 ${result.entries.length} 条规则` })
      }
    } catch (e) {
      setBlacklistMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingBlacklist(false)
    }
  }

  const draftPatternError = draftPattern.trim()
    ? validateBlacklistEntry({ type: draftMatchMode, pattern: draftPattern.trim() })
    : null
  const blacklistHasInvalidEntries = hasInvalidBlacklistEntries(blacklist)
  const canSaveBlacklist = !blacklistHasInvalidEntries && !draftPatternError

  return (
    <div className="settings-stack">
      <ZcfSettingsPanel />

      <div className="settings-group">
        <SettingRow
          title="用户目录"
          description="文件面板和上传文件使用"
          message={userMessage}
          fallback="文件面板会从这个位置读取和导入文件"
          onSave={handleSaveUserDirectory}
          saving={savingUser}
        >
          <div className="settings-pill settings-pill--wide">
            <input
              className="settings-pill-input"
              value={userValue}
              onChange={(e) => { setUserValue(e.target.value); setUserMessage(null) }}
              placeholder="选择用户目录"
            />
            <button type="button" onClick={chooseUserDirectory} className="settings-pill-btn">选择</button>
          </div>
        </SettingRow>

        <SettingRow
          title="下载子目录"
          description="位于用户目录下，文件工具默认下载位置"
          message={downloadMessage}
          fallback={`完整路径：${resolvedDownloadDirectory || '保存后显示'}`}
          onSave={handleSaveDownloadDirectory}
          saving={savingDownload}
        >
          <div className="settings-pill settings-pill--wide">
            <input
              className="settings-pill-input"
              value={downloadValue}
              onChange={(e) => { setDownloadValue(e.target.value); setDownloadMessage(null) }}
              placeholder="download"
            />
            <button type="button" onClick={chooseDownloadDirectory} className="settings-pill-btn">选择</button>
          </div>
        </SettingRow>

        <SettingRow
          title="文件访问黑名单"
          description="限制 Agent 访问用户目录中的特定路径"
          message={blacklistMessage}
          fallback={blacklistHasInvalidEntries || draftPatternError ? '存在无效规则时无法保存，请先修正输入' : '精确匹配按完整路径段/文件名；正则匹配按 JavaScript 正则解析'}
          stacked
          footer={(
            <button
              type="button"
              onClick={handleSaveBlacklist}
              disabled={savingBlacklist || !canSaveBlacklist}
              className="settings-btn settings-btn-primary"
            >
              {savingBlacklist ? '保存中...' : '保存'}
            </button>
          )}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            <div className="settings-pill settings-pill--wide">
              <select
                className="settings-select"
                value={draftMatchMode}
                onChange={(e) => { setDraftMatchMode(e.target.value); setBlacklistMessage(null) }}
                style={{ width: 148, flexShrink: 0 }}
              >
                <option value="exact_path">路径精确匹配</option>
                <option value="regex_path">路径正则匹配</option>
              </select>
              <input
                className="settings-pill-input"
                value={draftPattern}
                onChange={(e) => { setDraftPattern(e.target.value); setBlacklistMessage(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddBlacklistEntry() } }}
                placeholder={draftMatchMode === 'regex_path' ? REGEX_PATH_PLACEHOLDER : EXACT_PATH_PLACEHOLDER}
                style={{ fontFamily: 'Consolas, monospace' }}
              />
              <button type="button" onClick={handleAddBlacklistEntry} className="settings-pill-btn">添加</button>
            </div>
            {blacklist.length === 0 ? (
              <div className="settings-action-hint">暂无规则。精确匹配可直接粘贴路径或文件名；正则匹配需手写 JavaScript 正则。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {blacklist.map((entry, index) => {
                  const invalid = validateBlacklistEntry(entry)
                  return (
                    <div key={`${entry.type}-${entry.pattern}-${index}`} className="settings-pill settings-pill--wide">
                      <select
                        className="settings-select"
                        value={entry.type === 'regex_path' ? 'regex_path' : 'exact_path'}
                        onChange={(e) => handleUpdateBlacklistEntry(index, 'type', e.target.value)}
                        style={{ width: 148, flexShrink: 0 }}
                      >
                        <option value="exact_path">路径精确匹配</option>
                        <option value="regex_path">路径正则匹配</option>
                      </select>
                      <input
                        className="settings-pill-input"
                        value={entry.pattern}
                        onChange={(e) => handleUpdateBlacklistEntry(index, 'pattern', e.target.value)}
                        style={{ fontFamily: 'Consolas, monospace', borderColor: invalid ? 'var(--error)' : undefined }}
                        title={invalid || ''}
                      />
                      <button type="button" onClick={() => handleRemoveBlacklistEntry(index)} className="settings-pill-btn" style={{ color: 'var(--error)' }}>删除</button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </SettingRow>

        <SettingRow
          title="聊天附件上限"
          description="发送消息时可附加的最大文件数量（1-200）"
          message={maxMessage}
          fallback="当前上限会在发送附件时生效"
          onSave={handleSaveMaxAttachments}
          saving={savingMax}
        >
          <div className="settings-pill">
            <input
              type="number"
              min="1"
              max="200"
              className="settings-pill-input"
              value={maxValue}
              onChange={(e) => { setMaxValue(e.target.value); setMaxMessage(null) }}
            />
          </div>
        </SettingRow>

        <SettingRow
          title="长文本转附件阈值"
          description="粘贴文本超过该字符数时，自动保存为临时 txt 附件"
          message={pasteThresholdMessage}
          fallback="默认 20000 字符，保存后立即用于输入框粘贴"
          onSave={handleSavePasteThreshold}
          saving={savingPasteThreshold}
        >
          <div className="settings-pill">
            <input
              type="number"
              min="1000"
              max="200000"
              step="1000"
              className="settings-pill-input"
              value={pasteThresholdValue}
              onChange={(e) => { setPasteThresholdValue(e.target.value); setPasteThresholdMessage(null) }}
            />
          </div>
        </SettingRow>

        <SettingRow
          title="欢迎页常用场景网站上限"
          description="控制欢迎页常用场景最多可展示的网站数（1-50）"
          message={welcomeLimitMessage}
          fallback="超出上限的网站不会出现在欢迎页"
          onSave={handleSaveWelcomeLimit}
          saving={savingWelcomeLimit}
        >
          <div className="settings-pill">
            <input
              type="number"
              min="1"
              max="50"
              className="settings-pill-input"
              value={welcomeLimitValue}
              onChange={(e) => { setWelcomeLimitValue(e.target.value); setWelcomeLimitMessage(null) }}
            />
          </div>
        </SettingRow>

        <SettingRow
          title="资源预览后缀"
          description={resourcePreviewExtensionsCustomized ? '已自定义后缀列表' : '使用系统默认后缀列表'}
          message={previewExtensionsMessage}
          fallback={`匹配这些后缀的资源文件将自动预览（默认 ${defaultResourcePreviewExtensions.length} 项）`}
          stacked
          footer={(
            <div className="settings-btn-group">
              <button
                type="button"
                onClick={handleResetPreviewExtensions}
                disabled={resettingPreviewExtensions || (!resourcePreviewExtensionsCustomized && !previewExtensionsDirty)}
                className="settings-btn settings-btn-secondary"
              >
                {resettingPreviewExtensions ? '恢复中...' : '恢复默认'}
              </button>
              <button
                type="button"
                onClick={handleSavePreviewExtensions}
                disabled={savingPreviewExtensions || !previewExtensionsDirty}
                className="settings-btn settings-btn-primary"
              >
                {savingPreviewExtensions ? '保存中...' : '保存'}
              </button>
            </div>
          )}
        >
          <div className={`settings-chip-wrap${previewExtensionsExpanded ? ' is-expanded' : ''}`}>
            {previewExtensions.length === 0 ? (
              <span className="settings-action-hint">暂无后缀，仅可通过强制预览查看文件</span>
            ) : (
              <>
                <div
                  className="settings-chip-scroll"
                  onClick={!previewExtensionsExpanded ? () => setPreviewExtensionsExpanded(true) : undefined}
                  onKeyDown={!previewExtensionsExpanded ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setPreviewExtensionsExpanded(true)
                    }
                  } : undefined}
                  role={!previewExtensionsExpanded ? 'button' : undefined}
                  tabIndex={!previewExtensionsExpanded ? 0 : undefined}
                  aria-expanded={previewExtensionsExpanded}
                  aria-label={!previewExtensionsExpanded ? `展开全部 ${previewExtensions.length} 个后缀` : undefined}
                >
                  {previewExtensions.map((ext) => (
                    <span key={ext} className="settings-chip">
                      {ext}
                      <button
                        type="button"
                        aria-label={`移除 ${ext}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          removePreviewExtension(ext)
                        }}
                        className="settings-chip-remove"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="settings-chip-expand"
                  onClick={() => setPreviewExtensionsExpanded((expanded) => !expanded)}
                >
                  {previewExtensionsExpanded ? '收起' : `展开 ${previewExtensions.length} 项`}
                </button>
              </>
            )}
          </div>
          <div className="settings-pill settings-pill--wide" style={{ marginTop: 10 }}>
            <input
              className="settings-pill-input"
              value={previewExtensionInput}
              onChange={(e) => { setPreviewExtensionInput(e.target.value); setPreviewExtensionsMessage(null) }}
              onKeyDown={handlePreviewExtensionInputKeyDown}
              placeholder="添加后缀，例如 rs 或 .java"
            />
            <button type="button" onClick={addPreviewExtension} className="settings-pill-btn">添加</button>
          </div>
        </SettingRow>
      </div>
    </div>
  )
}

function ModelTab({ onClose }) {
  const { activeProvider, model, hasApiKey, providers, saveProvider, activateProvider } = useSettingsStore()
  const [expandedProvider, setExpandedProvider] = useState(null)
  const [forms, setForms] = useState({})
  const [catalogs, setCatalogs] = useState({})
  const [catalogLoading, setCatalogLoading] = useState(null)
  const [probeResults, setProbeResults] = useState({})
  const catalogRequestIds = useRef({})
  const probeRequestIds = useRef({})
  const [saving, setSaving] = useState(null)
  const [saved, setSaved] = useState(null)
  const [activating, setActivating] = useState(null)
  const [testing, setTesting] = useState(null)
  const [testResult, setTestResult] = useState(null)

  const singleProvider = PROVIDERS.length === 1

  const getForm = (pid) => {
    if (forms[pid]) return forms[pid]
    const p = PROVIDERS.find((x) => x.id === pid)
    const stored = providers[pid] ?? {}
    return {
      api_key: '',
      model: stored.model || p?.models[0] || '',
      context_limit: formatContextLimitInput(stored.context_limit),
      base_url: stored.base_url || '',
      auth_type: stored.auth_type === 'api_key' ? 'api_key' : 'auth_token',
      auto_auth: true,
    }
  }

  const setFormField = (pid, k, v) => {
    setForms((f) => ({ ...f, [pid]: { ...getForm(pid), [k]: v } }))
    setTestResult(null)
    probeRequestIds.current[pid] = (probeRequestIds.current[pid] || 0) + 1
    setTesting((current) => current === pid ? null : current)
    setProbeResults((results) => {
      const next = { ...results }
      delete next[pid]
      return next
    })
    if (k === 'api_key' || k === 'base_url' || k === 'auth_type') {
      catalogRequestIds.current[pid] = (catalogRequestIds.current[pid] || 0) + 1
      setCatalogLoading((current) => current === pid ? null : current)
      setCatalogs((current) => {
        const next = { ...current }
        delete next[pid]
        return next
      })
    }
  }

  const providerRequestBody = (pid) => {
    const f = getForm(pid)
    return {
      provider: pid,
      api_key: f.api_key,
      model: f.model,
      ...(pid === 'custom' ? { base_url: f.base_url, openai_base_url: '', auth_type: f.auth_type, auto_auth: f.auto_auth } : {}),
    }
  }

  const providerAccessBody = (pid) => {
    const f = getForm(pid)
    return {
      provider: pid,
      api_key: f.api_key,
      ...(pid === 'custom' ? { base_url: f.base_url, openai_base_url: '', auth_type: f.auth_type } : {}),
    }
  }

  const loadModels = async (pid, explicitRefresh = false) => {
    const requestId = (catalogRequestIds.current[pid] || 0) + 1
    catalogRequestIds.current[pid] = requestId
    setCatalogLoading(pid)
    try {
      const res = await backendFetch(`${API}/settings/provider/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(providerAccessBody(pid)),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || '模型列表获取失败')
      if (catalogRequestIds.current[pid] !== requestId) return
      setCatalogs((current) => ({ ...current, [pid]: { ...data, explicitRefresh } }))
      setForms((current) => {
        const form = current[pid] || getForm(pid)
        const nextModel = selectModelAfterCatalogRefresh(form.model, data)
        return nextModel === form.model ? current : { ...current, [pid]: { ...form, model: nextModel } }
      })
    } catch (error) {
      if (catalogRequestIds.current[pid] !== requestId) return
      const provider = PROVIDERS.find((item) => item.id === pid)
      setCatalogs((current) => ({
        ...current,
        [pid]: { models: provider?.models || [], source: 'fallback', warning: error.message || '模型列表获取失败', explicitRefresh },
      }))
    } finally {
      if (catalogRequestIds.current[pid] === requestId) {
        setCatalogLoading((current) => current === pid ? null : current)
      }
    }
  }

  const handleToggleExpand = (pid) => {
    const willExpand = expandedProvider !== pid
    setExpandedProvider(willExpand ? pid : null)
    setTestResult(null)
    if (willExpand) void loadModels(pid)
  }

  useEffect(() => {
    if (singleProvider) void loadModels(PROVIDERS[0].id)
  }, [])

  const handleSave = async (pid) => {
    setSaving(pid)
    setTestResult(null)
    const f = getForm(pid)
    const contextLimit = parseContextLimitInput(f.context_limit)
    if (contextLimit === null) {
      setTestResult({ ok: false, message: '上下文窗口请输入 1K 到 100M 之间的整数，可使用 K/M 单位' })
      setSaving(null)
      return
    }
    const updates = { model: f.model, context_limit: contextLimit }
    if (f.api_key) updates.api_key = f.api_key
    if (pid === 'custom') {
      updates.base_url = f.base_url
      updates.auth_type = f.auth_type
    }
    try {
      const result = await handleTest(pid)
      if (!result?.ok) return
      if (result.auth_type) updates.auth_type = result.auth_type
      await saveProvider(pid, updates)
      await activateProvider(pid)
      // Clear the api_key field after save
      setForms((prev) => ({ ...prev, [pid]: { ...getForm(pid), api_key: '', auth_type: result.auth_type || f.auth_type } }))
      setSaved(pid)
      setTestResult({ ok: true, message: '验证通过，已开始使用' })
      setTimeout(() => setSaved(null), 2000)
    } catch (e) {
      setTestResult({ ok: false, message: e.message || '保存失败' })
    } finally {
      setSaving(null)
    }
  }

  const handleActivate = async (pid) => {
    setActivating(pid)
    setTestResult(null)
    try {
      await activateProvider(pid)
    } catch (e) {
      setTestResult({ ok: false, message: e.message || '切换失败' })
    } finally {
      setActivating(null)
    }
  }

  const handleTest = async (pid) => {
    const requestId = (probeRequestIds.current[pid] || 0) + 1
    probeRequestIds.current[pid] = requestId
    setTesting(pid)
    setProbeResults((results) => ({ ...results, [pid]: null }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 35000)
    try {
      const res = await backendFetch(`${API}/settings/provider/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...providerRequestBody(pid), target: 'weworker' }),
        signal: controller.signal,
      })
      const data = await res.json()
      if (probeRequestIds.current[pid] !== requestId) return null
      const result = { ...data, ok: res.ok && data.ok }
      setProbeResults(current => ({ ...current, [pid]: [{ ...result, label: '模型连接', message: connectionMessage(result) }] }))
      if (result.ok && result.auth_type) {
        setForms(current => ({ ...current, [pid]: { ...getForm(pid), auth_type: result.auth_type } }))
      }
      return result
    } catch (error) {
      if (probeRequestIds.current[pid] !== requestId) return null
      setProbeResults(current => ({ ...current, [pid]: [{ label: '模型连接', ok: false, message: error.name === 'AbortError' ? '连接超时，请重试' : '无法连接，请检查网络后重试' }] }))
      return null
    } finally {
      clearTimeout(timer)
      if (probeRequestIds.current[pid] === requestId) {
        setTesting((current) => current === pid ? null : current)
      }
    }
  }

  return (
    <>
      <div className="settings-banner">
        <span className="settings-banner-label">当前使用</span>
        {(() => {
          const p = PROVIDERS.find((x) => x.id === activeProvider)
          return p ? (
            <span style={{ color: p.color, display: 'flex', alignItems: 'center', gap: 6 }}>
              {LOGOS[p.id]}
              <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
            </span>
          ) : null
        })()}
        <span className="settings-banner-model">
          {hasApiKey ? model : '⚠ 未配置 API Key'}
        </span>
        <div className="settings-btn-group" style={{ marginLeft: 'auto' }}>
          {testResult && (
            <span className={`settings-action-hint${testResult.ok ? ' is-success' : ' is-error'}`}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
            </span>
          )}
        </div>
      </div>

      <div className="settings-card-list">
        {PROVIDERS.map((p) => {
          const isActive = singleProvider || activeProvider === p.id
          const isExpanded = singleProvider || expandedProvider === p.id
          const stored = providers[p.id] ?? {}
          const f = getForm(p.id)
          const catalog = catalogs[p.id]
          const modelOptions = buildModelOptions(catalog?.models ?? p.models, f.model)
          const catalogRefreshFailed = shouldShowModelRefreshFailure(catalog)
          const catalogErrorDetail = getVisibleModelRefreshDetail(catalog)
          const catalogHint = catalogLoading === p.id
            ? '正在获取厂商模型列表…'
            : catalog
              ? catalogRefreshFailed
                ? '刷新模型失败'
                : catalog.source === 'remote' && catalog.models.length > 0
                  ? `已获取 ${catalog.models.length} 个模型`
                  : '内置模型列表'
              : '展开后自动获取厂商模型列表'
          const providerColor = p.id === 'custom' ? 'var(--provider-custom)' : p.color

          if (p.id === 'builtin') {
            const builtinActive = activeProvider === p.id
            return (
              <div key={p.id} className={`settings-card settings-card-builtin${builtinActive ? ' is-active' : ''}`}>
                <div className="settings-card-header">
                  <span style={{ color: p.color, flexShrink: 0 }}>{LOGOS[p.id]}</span>
                  <div style={{ flex: 1 }}>
                    <div className="settings-card-title" style={{ color: builtinActive ? p.color : 'var(--text-primary)' }}>
                      {p.name}{builtinActive && <span className="settings-badge-active">使用中</span>}
                    </div>
                    <div className="settings-card-subtitle">火山方舟 Coding Plan · {builtinActive ? '当前使用 ark-code-latest' : '无需配置，下载即可使用'}</div>
                  </div>
                  <div className="settings-btn-group">
                    {!builtinActive && <button type="button" onClick={() => handleActivate(p.id)} disabled={!!activating} className="settings-btn settings-btn-provider" style={{ background: providerColor }}>{activating === p.id ? '切换中...' : '使用'}</button>}
                    <button type="button" onClick={() => handleTest(p.id)} disabled={!!testing} className="settings-btn settings-btn-secondary">{testing === p.id ? '检测中…' : '测试连通性'}</button>
                  </div>
                </div>
                {probeResults[p.id] && <div className="settings-builtin-probe">{probeResults[p.id].map((result) => <div key={`${result.target}-${result.protocol}`} className={result.ok ? 'is-success' : 'is-error'}>{result.ok ? '✓' : '✗'} {result.label}：{result.message}</div>)}</div>}
              </div>
            )
          }

          return (
            <div key={p.id} className={`settings-card${isActive ? ' is-active' : ''}`}>
              <div className="settings-card-header">
                <span style={{ color: p.color, flexShrink: 0 }}>{LOGOS[p.id]}</span>
                <div style={{ flex: 1 }}>
                  <div className="settings-card-title" style={{ color: isActive ? p.color : 'var(--text-primary)' }}>
                    {p.name}
                    {isActive && !singleProvider && <span className="settings-badge-active">使用中</span>}
                  </div>
                  <div className="settings-card-subtitle">
                    {stored.has_key
                      ? <span style={{ color: 'var(--success)' }}>● 已配置 · {stored.model || p.subtitle}</span>
                      : <span>{p.subtitle} · 未配置</span>}
                  </div>
                </div>
                {!singleProvider && (
                  <div className="settings-btn-group">
                    {!isActive && stored.has_key && (
                      <button
                        type="button"
                        onClick={() => handleActivate(p.id)}
                        disabled={!!activating}
                        className="settings-btn settings-btn-provider"
                        style={{ background: providerColor }}
                      >
                        {activating === p.id ? '切换中...' : '切换使用'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleToggleExpand(p.id)}
                      className="settings-btn settings-btn-secondary"
                    >
                      {isExpanded ? '收起' : '配置'}
                    </button>
                  </div>
                )}
              </div>

              {isExpanded && (
                <fieldset className="settings-card-body settings-model-form" disabled={saving === p.id}>
                  {p.id === 'custom' && <Field label="服务地址" hint="填写 Claude Code 使用的 Base URL">
                    <input className="settings-input" value={f.base_url} onChange={e => setFormField(p.id, 'base_url', e.target.value)} onBlur={() => { if (f.base_url) void loadModels(p.id) }} placeholder="https://example.com/anthropic" />
                  </Field>}
                  <Field label="API Key" hint={stored.has_key ? '已设置（留空保持不变）' : '未设置'}>
                    <input
                      type="password"
                      className="settings-input"
                      value={f.api_key}
                      onChange={(e) => setFormField(p.id, 'api_key', e.target.value)}
                      onBlur={() => { if (f.api_key) void loadModels(p.id) }}
                      placeholder={stored.has_key ? '••••••••••••' : 'sk-...'}
                    />
                  </Field>

                  <Field label="模型" hint={catalogHint} hintError={catalogRefreshFailed || Boolean(catalogErrorDetail)}>
                    <div style={{ width: '100%' }}>
                      <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                        {p.id === 'custom' ? (
                          <>
                            <input className="settings-input" list={`provider-models-${p.id}`} value={f.model} onChange={(e) => setFormField(p.id, 'model', e.target.value)} placeholder="输入或选择模型名称" />
                            <datalist id={`provider-models-${p.id}`}>
                              {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </datalist>
                          </>
                        ) : (
                          <select className="settings-select" value={f.model} onChange={(e) => setFormField(p.id, 'model', e.target.value)}>
                            {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                        )}
                        <button type="button" onClick={() => loadModels(p.id, true)} disabled={catalogLoading === p.id} className="settings-btn settings-btn-secondary">
                          {catalogLoading === p.id ? '获取中…' : '刷新模型'}
                        </button>
                      </div>
                      {catalogErrorDetail && (
                        <div className="settings-remote-detail is-error">
                          {catalogRefreshFailed ? catalogErrorDetail : `部分接口刷新失败：\n${catalogErrorDetail}`}
                        </div>
                      )}
                    </div>
                  </Field>

                  <details className="settings-model-advanced"><summary>高级设置</summary>
                  <Field label="上下文窗口" hint="用于估算上下文占用率，可选择或直接输入">
                    <input
                      className="settings-input"
                      list={`provider-context-limits-${p.id}`}
                      value={f.context_limit}
                      onChange={(e) => setFormField(p.id, 'context_limit', e.target.value)}
                      onBlur={() => {
                        const parsed = parseContextLimitInput(f.context_limit)
                        if (parsed !== null) setFormField(p.id, 'context_limit', formatContextLimitInput(parsed))
                      }}
                      placeholder="例如 200K、1M 或 1000000"
                      inputMode="text"
                    />
                    <datalist id={`provider-context-limits-${p.id}`}>
                      {CONTEXT_LIMIT_PRESETS.map((preset) => <option key={preset} value={preset} />)}
                    </datalist>
                  </Field>

                  {p.id === 'custom' && (
                    <>
                      <Field label="API Key 类型">
                        <AppDropdownSelect
                          value={f.auto_auth ? 'auto' : f.auth_type}
                          options={[
                            { value: 'auto', label: '自动检测（推荐）' },
                            { value: 'auth_token', label: 'Bearer Token' },
                            { value: 'api_key', label: 'API Key' },
                          ]}
                          onChange={value => {
                            if (value === 'auto') setFormField(p.id, 'auto_auth', true)
                            else {
                              setFormField(p.id, 'auth_type', value)
                              setForms(current => ({ ...current, [p.id]: { ...current[p.id], auto_auth: false } }))
                            }
                          }}
                          ariaLabel="API Key 类型"
                          minMenuWidth={320}
                          matchAnchorWidth
                          className="settings-provider-auth-select"
                        />
                      </Field>
                    </>
                  )}

                  </details>

                  <div className="settings-btn-group" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
                    <button type="button" onClick={() => handleTest(p.id)} disabled={!!testing} className="settings-btn settings-btn-secondary">
                      {testing === p.id ? '检测中…' : '测试模型可用性'}
                    </button>
                    {!singleProvider && !isActive && (
                      <button
                        type="button"
                        onClick={() => handleActivate(p.id)}
                        disabled={!!activating || !stored.has_key}
                        title={!stored.has_key ? '请先保存 API Key' : ''}
                        className="settings-btn settings-btn-provider"
                        style={{ background: stored.has_key ? providerColor : undefined, opacity: stored.has_key ? 1 : 0.5 }}
                      >
                        {activating === p.id ? '切换中...' : '切换使用'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSave(p.id)}
                      disabled={saving === p.id}
                      className={`settings-btn ${saved === p.id ? 'settings-btn-success' : 'settings-btn-primary'}`}
                    >
                      {saving === p.id ? '验证并保存中…' : saved === p.id ? '已启用' : '验证并开始使用'}
                    </button>
                  </div>
                  {(probeResults[p.id] || []).map((result) => (
                    <div key={result.label} className={`settings-action-hint settings-remote-detail${result.ok === true ? ' is-success' : result.ok === false ? ' is-error' : ''}`} style={{ textAlign: 'right' }}>
                      {result.message}
                      {!result.ok && result.detail && <details><summary>查看详情</summary><pre>{result.detail}</pre></details>}
                    </div>
                  ))}
                </fieldset>
              )}
            </div>
          )
        })}
      </div>

      <ExplorationModelSettings />

      <div className="settings-actions">
        <button type="button" onClick={onClose} className="settings-btn settings-btn-ghost">关闭</button>
      </div>
    </>
  )
}

function SettingRow({
  title,
  description,
  message,
  fallback,
  onSave,
  saving = false,
  stacked = false,
  footer,
  children,
}) {
  const hintClass = message
    ? `settings-action-hint${message.ok ? ' is-success' : ' is-error'}`
    : 'settings-action-hint'

  return (
    <div className={`settings-row${stacked ? ' settings-row--stacked' : ''}`}>
      <div className="settings-row-main">
        <div className="settings-row-text">
          <div className="settings-row-title">{title}</div>
          <div className="settings-row-desc">{description}</div>
        </div>
        {!stacked && (
          <div className="settings-row-control">
            {children}
          </div>
        )}
      </div>
      {stacked && (
        <div className="settings-row-control">
          {children}
        </div>
      )}
      {(message || fallback || onSave || footer) && (
        <div className="settings-row-footer">
          <span className={hintClass}>{message?.text || fallback}</span>
          {footer || (onSave ? (
            <button type="button" onClick={onSave} disabled={saving} className="settings-btn settings-btn-primary">
              {saving ? '保存中...' : '保存'}
            </button>
          ) : null)}
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, hintError = false, children }) {
  return (
    <div className="settings-field">
      <label className="settings-field-label">
        {label}
        {hint && <span className={`settings-field-hint${hintError ? ' is-error' : ''}`}>{hint}</span>}
      </label>
      {children}
    </div>
  )
}

function StyleOptionIcon({ kind = 'core' }) {
  return <StyleKindIcon kind={kind} size={18} />
}

function StyleAddCard({ onSelect }) {
  return (
    <button
      type="button"
      className="settings-style-option settings-style-option--add"
      onClick={onSelect}
      aria-label="新增自定义风格"
    >
      <span className="settings-style-option__icon settings-style-option__icon--add">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      <span className="settings-style-option__text">
        <span className="settings-style-option__title">新增自定义</span>
        <span className="settings-style-option__desc">点击添加新的自定义风格</span>
      </span>
    </button>
  )
}
function StyleOptionCard({
  selected = false,
  title,
  description,
  badge,
  kind = 'core',
  disabled = false,
  onSelect,
}) {
  return (
    <button
      type="button"
      className={`settings-style-option${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
    >
      <span className={`settings-style-option__icon settings-style-option__icon--${kind}`}>
        <StyleOptionIcon kind={kind} />
      </span>
      <span className="settings-style-option__text">
        <span className="settings-style-option__title">
          {title}
          {badge ? <span className="settings-style-option__badge">{badge}</span> : null}
        </span>
        {description ? <span className="settings-style-option__desc">{description}</span> : null}
      </span>
      <span className="settings-style-option__radio" aria-hidden="true" />
    </button>
  )
}

function getStyleOptionDescription(role, kind) {
  if (role.id === 'default') {
    return '原生模式，不注入任何风格提示词'
  }
  if (role.id === 'weworker-clear') {
    return '简洁直接；禁止 emoji、大标题与无意义措辞'
  }
  if (role.id === 'engineer-professional') {
    return role.description || '专业的软件工程师，严格遵循 SOLID、KISS、DRY、YAGNI 原则'
  }
  if (kind === 'custom') {
    if (role.draft) return '请填写名称与提示词，保存后生效'
    return '使用自定义提示词作为默认风格'
  }
  return role.description || ''
}

function ZcfSettingsPanel() {
  const zcfLang = useSettingsStore((s) => s.zcfLang)
  const zcfPackageVersion = useSettingsStore((s) => s.zcfPackageVersion)
  const zcfSync = useSettingsStore((s) => s.zcfSync)
  const zcfDefaultRole = useSettingsStore((s) => s.zcfDefaultRole)
  const zcfDefaultMode = useSettingsStore((s) => s.zcfDefaultMode)
  const zcfEnabledRoles = useSettingsStore((s) => s.zcfEnabledRoles)
  const zcfCustomRoles = useSettingsStore((s) => s.zcfCustomRoles)
  const saveZcfRoles = useSettingsStore((s) => s.saveZcfRoles)
  const saveZcfDefaults = useSettingsStore((s) => s.saveZcfDefaults)
  const syncMeta = useZcfStore((s) => s.syncMeta)
  const packageVersion = useZcfStore((s) => s.packageVersion)
  const extensionStyles = useZcfStore((s) => s.extensionStyles)
  const coreStyles = useZcfStore((s) => s.coreStyles)
  const zcfModes = useZcfStore((s) => s.modes)
  const syncing = useZcfStore((s) => s.syncing)
  const syncTemplates = useZcfStore((s) => s.syncTemplates)
  const loadCatalog = useZcfStore((s) => s.loadCatalog)
  const loadSettings = useSettingsStore((s) => s.load)
  const [lang, setLang] = useState(zcfLang || 'zh-CN')
  const [message, setMessage] = useState(null)
  const [selectedStyleId, setSelectedStyleId] = useState(zcfDefaultRole || zcfEnabledRoles?.[0] || 'default')
  const [selectedModeId, setSelectedModeId] = useState(normalizeZcfModeId(zcfDefaultMode))
  const [customRoles, setCustomRoles] = useState(zcfCustomRoles || [])
  const [rolesMessage, setRolesMessage] = useState(null)
  const [savingRoles, setSavingRoles] = useState(false)

  const selectableStyles = useMemo(() => {
    const core = (coreStyles.length ? coreStyles : [
      { id: 'default', label: '默认' },
      { id: 'weworker-clear', label: '专业严谨简单明确' },
    ]).map((role) => ({
      ...role,
      kind: role.id === 'default' ? 'default' : 'core',
      badge: '内置',
    }))
    const ext = extensionStyles.map((role) => ({ ...role, kind: 'zcf', badge: 'ZCF' }))
    const custom = customRoles.map((role) => {
      const label = String(role.label || '').trim()
      const prompt = String(role.prompt || '').trim()
      return {
        ...role,
        label: label || '未命名风格',
        kind: 'custom',
        badge: '自定义',
        draft: !label || !prompt,
      }
    })
    return [...core, ...ext, ...custom]
  }, [coreStyles, extensionStyles, customRoles])

  const selectableModes = useMemo(() => {
    const baseModes = zcfModes.length ? zcfModes : [
      { id: 'direct', label: '默认', description: '直接执行，不额外注入规划工作流' },
      { id: 'auto-plan', label: '自动规划', description: '自动判断任务复杂度，必要时先规划再执行' },
    ]
    const seen = new Set()
    return baseModes
      .map((mode) => ({
        ...mode,
        id: normalizeZcfModeId(mode.id),
      }))
      .filter((mode) => {
        if (!mode.id || seen.has(mode.id)) return false
        seen.add(mode.id)
        return true
      })
  }, [zcfModes])

  useEffect(() => {
    setLang(zcfLang || 'zh-CN')
  }, [zcfLang])

  useEffect(() => {
    setSelectedStyleId(zcfDefaultRole || zcfEnabledRoles?.[0] || 'default')
  }, [zcfDefaultRole, zcfEnabledRoles])

  useEffect(() => {
    setSelectedModeId(normalizeZcfModeId(zcfDefaultMode))
  }, [zcfDefaultMode])

  useEffect(() => {
    setCustomRoles(zcfCustomRoles || [])
  }, [zcfCustomRoles])

  useEffect(() => {
    if (!coreStyles.length) loadCatalog()
  }, [coreStyles.length, loadCatalog])

  const syncedAt = syncMeta?.lastExtensionSyncAt || syncMeta?.syncedAt || zcfSync?.lastExtensionSyncAt || zcfSync?.syncedAt
  const version = packageVersion || zcfPackageVersion
  const syncedLabel = syncedAt
    ? new Date(syncedAt).toLocaleString()
    : '尚未手动更新扩展'

  const editingCustomIndex = customRoles.findIndex((role) => role.id === selectedStyleId)
  const showCustomEditor = editingCustomIndex >= 0

  const handleLangChange = async (nextLang) => {
    setLang(nextLang)
    setMessage(null)
    try {
      await saveZcfDefaults({ zcfLang: nextLang })
      await loadSettings()
      await loadCatalog()
      setMessage({ ok: true, text: '模板语言已保存' })
    } catch (e) {
      setMessage({ ok: false, text: e.message || '保存失败' })
    }
  }

  const handleSync = async () => {
    setMessage(null)
    try {
      await syncTemplates(lang)
      await loadSettings()
      setMessage({ ok: true, text: '已更新扩展风格与工作流模板' })
    } catch (e) {
      setMessage({ ok: false, text: e.message || '更新失败' })
    }
  }

  const selectStyle = (roleId) => {
    setSelectedStyleId(roleId)
    setRolesMessage(null)
  }

  const addCustomRole = () => {
    const id = `custom-${Date.now().toString(36)}`
    setCustomRoles((items) => [
      ...items,
      { id, label: '', prompt: '' },
    ])
    setSelectedStyleId(id)
    setRolesMessage(null)
  }

  const updateCustomRole = (index, field, value) => {
    setCustomRoles((items) => items.map((item, i) => (
      i === index ? { ...item, [field]: value } : item
    )))
    setRolesMessage(null)
  }

  const removeCustomRole = (index) => {
    const roleId = customRoles[index]?.id
    setCustomRoles((items) => items.filter((_, i) => i !== index))
    if (roleId && selectedStyleId === roleId) {
      setSelectedStyleId('default')
    }
    setRolesMessage(null)
  }

  const rolesDirty = JSON.stringify({
    style: selectedStyleId,
    mode: selectedModeId,
    custom: (customRoles || []).map((r) => ({ id: r.id, label: r.label, prompt: r.prompt })),
  }) !== JSON.stringify({
    style: zcfDefaultRole || zcfEnabledRoles?.[0] || 'default',
    mode: normalizeZcfModeId(zcfDefaultMode),
    custom: (zcfCustomRoles || []).map((r) => ({ id: r.id, label: r.label, prompt: r.prompt })),
  })

  const handleSaveRoles = async () => {
    setSavingRoles(true)
    setRolesMessage(null)
    try {
      const sanitizedCustom = customRoles
        .map((role) => ({
          id: role.id,
          label: String(role.label || '').trim(),
          prompt: String(role.prompt || '').trim(),
        }))
        .filter((role) => role.label && role.prompt)
      if (selectedStyleId.startsWith('custom-') && !sanitizedCustom.some((role) => role.id === selectedStyleId)) {
        setRolesMessage({ ok: false, text: '请先填写当前选中的自定义风格名称与提示词' })
        setSavingRoles(false)
        return
      }
      const availableIds = new Set([
        ...(coreStyles.length ? coreStyles : [{ id: 'default', label: '默认' }, { id: 'weworker-clear', label: '专业严谨简单明确' }]).map((r) => r.id),
        ...extensionStyles.map((r) => r.id),
        ...sanitizedCustom.map((r) => r.id),
      ])
      const activeStyle = availableIds.has(selectedStyleId) ? selectedStyleId : 'default'
      await saveZcfRoles({
        zcfDefaultRole: activeStyle,
        zcfEnabledRoles: [activeStyle],
        zcfCustomRoles: sanitizedCustom,
      })
      await saveZcfDefaults({ zcfDefaultMode: selectedModeId })
      await loadCatalog()
      setRolesMessage({ ok: true, text: '风格与工作流设置已保存' })
    } catch (e) {
      setRolesMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingRoles(false)
    }
  }

  return (
    <div className="settings-group">
      <SettingRow
        title="风格与工作流"
        description="内置专业工程师风格与工作流模板；扩展风格需手动从 ZCF 更新（同名覆盖）"
        message={message}
        fallback={`ZCF 包版本 ${version || '未知'} · 上次扩展更新 ${syncedLabel}`}
        stacked
        footer={(
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="settings-btn settings-btn-primary"
          >
            {syncing ? '更新中...' : '从 ZCF 更新扩展'}
          </button>
        )}
      >
        <div className="settings-pill settings-pill--wide">
          <span className="settings-pill-prefix">模板语言</span>
          <AppDropdownSelect
            value={lang}
            options={[
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
            onChange={handleLangChange}
            disabled={syncing}
            ariaLabel="ZCF 模板语言"
            minMenuWidth={140}
            className="settings-dropdown-select"
          />
        </div>
      </SettingRow>

      <SettingRow
        title="高级 · 风格与工作流"
        description="风格与工作流作为新会话默认配置；聊天输入框不再展示切换入口"
        message={rolesMessage}
        fallback={`当前默认：${
          [...(coreStyles.length ? coreStyles : [{ id: 'default', label: '默认' }, { id: 'weworker-clear', label: '专业严谨简单明确' }]),
            ...extensionStyles,
            ...(customRoles || []).map((r) => ({ id: r.id, label: r.label }))]
            .find((r) => r.id === selectedStyleId)?.label || '默认'
        }`}
        stacked
        footer={(
          <button
            type="button"
            onClick={handleSaveRoles}
            disabled={savingRoles || !rolesDirty}
            className="settings-btn settings-btn-primary"
          >
            {savingRoles ? '保存中...' : '保存配置'}
          </button>
        )}
      >
        <div className="settings-style-section">
          <div className="settings-style-section__header">
            <div className="settings-card-title">默认风格</div>
            <div className="settings-card-subtitle">风格互斥，只能选择一个；更多 ZCF 风格需手动「从 ZCF 更新扩展」</div>
          </div>
          <div className="settings-style-option-grid">
            {selectableStyles.map((role) => (
              <StyleOptionCard
                key={role.id}
                selected={selectedStyleId === role.id}
                title={role.label}
                description={getStyleOptionDescription(role, role.kind)}
                badge={role.badge}
                kind={role.kind}
                onSelect={() => selectStyle(role.id)}
              />
            ))}
            <StyleAddCard onSelect={addCustomRole} />
          </div>
        </div>

        <div className="settings-style-section">
          <div className="settings-style-section__header">
            <div className="settings-card-title">默认工作流</div>
            <div className="settings-card-subtitle">作为新会话的默认执行模式；聊天中不再单独展示切换入口</div>
          </div>
          <div className="settings-style-option-grid">
            {selectableModes.map((mode) => (
              <StyleOptionCard
                key={mode.id}
                selected={selectedModeId === mode.id}
                title={mode.label || (mode.id === 'auto-plan' ? '自动规划' : '默认')}
                description={mode.description || (mode.id === 'auto-plan' ? '自动判断任务复杂度，必要时先规划再执行' : '直接执行，不额外注入规划工作流')}
                badge="内置"
                kind={mode.id === 'auto-plan' ? 'zcf' : 'default'}
                onSelect={() => {
                  setSelectedModeId(mode.id)
                  setRolesMessage(null)
                }}
              />
            ))}
          </div>
        </div>

        {showCustomEditor && (
          <div className="settings-card settings-custom-styles" style={{ padding: 12, marginTop: 10 }}>
            <div className="settings-card-header">
              <div>
                <div className="settings-card-title">编辑自定义风格</div>
                <div className="settings-card-subtitle">填写名称与提示词，保存后可在聊天中切换</div>
              </div>
              <button
                type="button"
                className="settings-btn"
                onClick={() => removeCustomRole(editingCustomIndex)}
              >
                删除
              </button>
            </div>
            <div className="settings-custom-style-editor">
              <input
                className="settings-pill-input"
                style={{ width: '100%', marginBottom: 8 }}
                placeholder="风格名称"
                value={customRoles[editingCustomIndex]?.label || ''}
                onChange={(e) => updateCustomRole(editingCustomIndex, 'label', e.target.value)}
              />
              <textarea
                className="settings-pill-input"
                style={{ width: '100%', minHeight: 96, resize: 'vertical' }}
                placeholder="风格提示词（语气、表达习惯；建议禁止 emoji）"
                value={customRoles[editingCustomIndex]?.prompt || ''}
                onChange={(e) => updateCustomRole(editingCustomIndex, 'prompt', e.target.value)}
              />
            </div>
          </div>
        )}
      </SettingRow>
    </div>
  )
}

function SettingBlock({ children }) {
  return (
    <div className="settings-card" style={{ padding: 14 }}>
      {children}
    </div>
  )
}

function SettingActionRow({ message, fallback, children }) {
  const hintClass = message
    ? `settings-action-hint${message.ok ? ' is-success' : ' is-error'}`
    : 'settings-action-hint'
  return (
    <div className="settings-action-row">
      <span className={hintClass}>
        {message?.text || fallback}
      </span>
      <div style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
        {children}
      </div>
    </div>
  )
}
