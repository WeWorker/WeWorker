import ModelConfigurationName from './ModelConfigurationName.jsx'
import AppSwitch from '../common/AppSwitch.jsx'
import AppDropdownInput from '../common/AppDropdownInput.jsx'
import React, { useState, useEffect, useMemo, useRef, useId } from 'react'
import { createPortal } from 'react-dom'
import { ApiOutlined, AppstoreAddOutlined, CheckCircleFilled, CheckOutlined, CloseOutlined, CopyOutlined, DeleteOutlined, DisconnectOutlined, DownOutlined, EditOutlined, LinkOutlined, LoadingOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons'
import { useSettingsStore, PROVIDERS } from '../../store/settings.js'
import { isBuiltinProvider, hasFixedModel } from '../../store/settings.js'
import ChannelsTab from './ChannelsTab.jsx'
import SkillsTab from './SkillsTab.jsx'
import LogsTab from './LogsTab.jsx'
import MemoryTab from './MemoryTab.jsx'
import { useUserFilesStore } from '../../store/user-files.js'
import { listSelectableStyles, isCustomStyleId, DEFAULT_STYLE_ID as DEFAULT_STYLE } from '../../store/styles.js'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { DropdownMenuPortal, useDropdownDismiss } from '../common/DropdownMenuPortal.jsx'
import StyleKindIcon from '../common/StyleKindIcon.jsx'
import { selectModelAfterCatalogRefresh, buildModelOptions, buildModelCatalogAccess, getModelCatalogIssue, getModelCatalogStatus, buildProbeResultRows, buildProviderProbeTargets, buildSettingsProviderLists, isFixedProvider } from '../../utils/model-selection.js'
import { normalizePreviewExtension } from '../../utils/resource-preview-extensions.js'
import {
  STYLE_DELETE_CONFIRM_TITLE,
  STYLE_DELETE_LABEL,
  STYLE_EDIT_LABEL,
  STYLE_NAME_PLACEHOLDER,
  STYLE_PROMPT_PLACEHOLDER,
  buildStyleDraft,
  customStyleDialogTitle,
  isEditableStyleRole,
  removeStyleDraft,
  resolveSavedSnapshotSync,
  resolveSelectedStyleAfterRemove,
  savedSnapshotSignature,
  styleDeleteConfirmMessage,
  upsertStyleDraft,
  validateStyleName,
} from '../../utils/style-draft.js'
import { CONTEXT_LIMIT_PRESETS, formatContextLimitInput, parseContextLimitInput } from '../../utils/context-window.js'
import { DEFAULT_WELCOME_FEATURED_SITE_LIMIT } from '../welcome/welcome-utils.js'
import weworkerLogo from '../../../../asset/logo.png'
import './settings-theme.css'
import { backendFetch } from '../../api/http.js'
import { fetchProviderModels } from '../../api/provider-models.js'
import { getAnthropicUrlHint, getOpenAiUrlHint } from '../../utils/provider-url.js'
import { showConfirm } from '../../store/dialog.js'
import { BROWSER_MODE_OPTIONS, describeBrowserMode } from '../../utils/dedicated-browser.js'
import SiteLoginSettings from '../site-login/SiteLoginSettings.jsx'
import { deploymentConfig } from '../../config/deployment.js'

const API = 'http://127.0.0.1:8765'
const OFFICIAL_URL = deploymentConfig.officialUrl
const DOWNLOAD_URL = deploymentConfig.downloadUrl
const GITHUB_UPDATE_URL = deploymentConfig.githubUrl

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
  bank_coding: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5" fill="currentColor" fillOpacity="0.2"/><text x="12" y="16" textAnchor="middle" fontSize="9" fontWeight="bold" fill="currentColor">GLM</text></svg>
  ),
  builtin: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.18"/><path d="M7 12.5 10.2 15 17 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  builtin_dev: (
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

export default function SettingsPage({ onClose }) {
  const [tab, setTab] = useState('model')
  const [appVersion, setAppVersion] = useState('')
  // 「配置」页签的未保存编辑（自定义风格草稿、用户目录、黑名单等）都存在面板本地 state，
  // 而下面各页签是条件渲染：切走即卸载，切回来会用「已保存设置」重新初始化，草稿因此丢失。
  // 所以「配置」首次进入后就保持挂载，切走只隐藏（ConfigTab 的 hidden）+ 关闭编辑弹窗，不再卸载。
  // 首次进入前不挂载，保持「设置页打开时不触发配置页加载」的既有行为。
  const [configMounted, setConfigMounted] = useState(false)
  if (tab === 'config' && !configMounted) setConfigMounted(true)

  useEffect(() => {
    window.electronAPI?.getVersion?.().then(v => setAppVersion(v || ''))
  }, [])

  const commitHash = typeof __BUILD_COMMIT_HASH__ !== 'undefined' ? __BUILD_COMMIT_HASH__ : 'dev'

  return (
    <section className="settings-page" aria-label="设置">
      <div className="settings-shell settings-shell--sidebar">
        <aside className="settings-sidebar">
          <div className="settings-sidebar__brand">
            <h2>设置</h2>
            <p>配置模型、通道与应用偏好</p>
          </div>
          <nav className="settings-sidebar__nav" aria-label="设置分类">
            {[
              ['model', '模型'],
              ['channels', '通道'],
              ['config', '配置'],
              ['memory', '记忆'],
              ['permissions', '权限'],
              ['logs', '日志'],
              ['about', '关于'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`settings-side-nav${tab === key ? ' is-active' : ''}`}
                aria-current={tab === key ? 'page' : undefined}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <div className="settings-panel-frame">
          <div className="settings-panel-top">
            <h3>{[
              ['model', '模型'],
              ['channels', '通道'],
              ['config', '配置'],
              ['memory', '记忆'],
              ['permissions', '权限'],
              ['logs', '日志'],
              ['about', '关于'],
            ].find(([key]) => key === tab)?.[1] || '设置'}</h3>
          </div>
          <div className={`settings-body${tab === 'model' || tab === 'channels' ? ' settings-body--model' : ''}`}>
            {tab === 'channels' && <ChannelsTab />}
            {tab === 'permissions' && <PermissionsTab />}
            {configMounted && <ConfigTab active={tab === 'config'} />}
            {tab === 'memory' && <MemoryTab />}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'logs' && <LogsTab />}
            {tab === 'about' && <AboutTab appVersion={appVersion} commitHash={commitHash} />}
            {tab === 'model' && <ModelTab />}
          </div>
          <div className="settings-footer">
            {appVersion && <span>v{appVersion}</span>}
            {commitHash && <span style={{ opacity: 0.7 }}>({commitHash})</span>}
          </div>
        </div>
      </div>
    </section>
  )
}

function SwitchField({ checked, disabled, onChange, label }) {
  return (
    <label className="settings-switch-row" style={disabled ? { opacity: 0.55 } : undefined}>
      <AppSwitch checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="settings-switch-label">{label}</span>
    </label>
  )
}

/** Keep WeWorker running so dedicated agents stay online. Saved immediately. */
function BackgroundSettingsGroup() {
  const [settings, setSettings] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getAppSettings?.().then((value) => { if (!cancelled) setSettings(value || null) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!settings) return null
  const update = async (patch) => {
    setError('')
    try {
      const saved = await window.electronAPI?.setAppSettings?.(patch)
      if (saved) setSettings(saved)
    } catch (err) {
      setError(err?.message || '保存失败')
    }
  }

  return (
    <div className="settings-group">
      <SettingRow
        title="后台运行"
        description="专属 Agent 由 WeWorker 在本机提供服务，WeWorker 退出后它们会停止回复企业微信和微信消息"
        stacked
      >
        <div className="settings-update-settings">
          {settings.closeToTraySupported && (
            <SwitchField
              checked={settings.closeToTray}
              onChange={(closeToTray) => update({ closeToTray })}
              label="关闭窗口时最小化到系统托盘，保持后台运行"
            />
          )}
          <SwitchField
            checked={settings.launchAtLogin}
            disabled={!settings.launchAtLoginSupported}
            onChange={(launchAtLogin) => update({ launchAtLogin })}
            label="开机自动启动 WeWorker（在后台启动，不弹出窗口）"
          />
          {!settings.launchAtLoginSupported && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>开发模式下不可用，安装后的客户端默认开启。</div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {settings.platform === 'darwin'
              ? '关闭窗口后 WeWorker 仍在运行，可通过菜单栏图标或程序坞打开；按 ⌘Q 或在菜单栏图标中退出。'
              : '真正退出请右键系统托盘中的 WeWorker 图标，选择「退出 WeWorker」。'}
          </div>
          {error && <div style={{ fontSize: 12, color: 'var(--error, #ef4444)' }}>{error}</div>}
        </div>
      </SettingRow>
    </div>
  )
}

/** Which browser runs website operations. Saved immediately; the desktop switches right away. */
function BrowserSettingsGroup() {
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getAppSettings?.().then((value) => { if (!cancelled) setSettings(value || null) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!settings?.browserMode) return null
  const change = async (browserMode) => {
    if (browserMode === settings.browserMode) return
    setError('')
    setSaving(true)
    try {
      const saved = await window.electronAPI?.setAppSettings?.({ browserMode })
      if (saved) setSettings(saved)
    } catch (err) {
      setError(err?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-group">
      <SettingRow title="网站操作浏览器" description={describeBrowserMode(settings.browserMode)} stacked>
        <div className="settings-update-settings">
          <div className="settings-pill settings-pill--wide">
            <AppDropdownSelect
              value={settings.browserMode}
              options={BROWSER_MODE_OPTIONS}
              disabled={saving}
              onChange={change}
              matchAnchorWidth
              ariaLabel="网站操作浏览器"
            />
          </div>
          {saving && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>正在切换…</div>}
          {error && <div style={{ fontSize: 12, color: 'var(--error, #ef4444)' }}>{error}</div>}
        </div>
      </SettingRow>
    </div>
  )
}

function AboutTab({ appVersion, commitHash }) {
  const [updateState, setUpdateState] = useState(null)
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [savingUpdateSettings, setSavingUpdateSettings] = useState(false)
  const [updateSettings, setUpdateSettings] = useState({
    autoCheckEnabled: true,
    checkIntervalHours: 1,
  })

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
  const checkIntervalValue = Number(updateSettings.checkIntervalHours || 1)
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
      checkIntervalHours: [1, 3, 6, 9, 12, 15, 18, 21, 24].includes(Number(updateSettings.checkIntervalHours))
        ? Number(updateSettings.checkIntervalHours)
        : 1,
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

      <BackgroundSettingsGroup />

      <BrowserSettingsGroup />

      <SiteLoginSettings />

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
              <AppSwitch
                checked={updateSettings.autoCheckEnabled !== false}
                onChange={(event) => setUpdateSettings((current) => ({
                  ...current,
                  autoCheckEnabled: event.target.checked,
                }))}
              />
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
                options={[1, 3, 6, 9, 12, 15, 18, 21, 24].map((hours) => ({
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
                className="settings-btn settings-btn-secondary"
                onClick={checkUpdate}
                disabled={!canCheck || checking}
              >
                {checking || status === 'checking' ? '检查中...' : '检查更新'}
              </button>
              {canDownload && (
                <button
                  type="button"
                  className="settings-btn settings-btn-primary"
                  onClick={downloadUpdate}
                  disabled={downloading}
                >
                  {downloading ? '准备下载...' : '下载更新'}
                </button>
              )}
              {canInstall && (
                <button
                  type="button"
                  className="settings-btn settings-btn-primary"
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

// active=false 表示「配置」已不是当前页签：面板保持挂载（未保存编辑不丢），仅由 hidden 隐藏。
function ConfigTab({ active = true }) {
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
    <div className="settings-stack" hidden={!active}>
      <StyleSettingsPanel active={active} />

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
              <AppDropdownSelect
                value={draftMatchMode}
                options={[{ value: 'exact_path', label: '路径精确匹配' }, { value: 'regex_path', label: '路径正则匹配' }]}
                onChange={(value) => { setDraftMatchMode(value); setBlacklistMessage(null) }}
                ariaLabel="黑名单匹配方式"
                className="settings-blacklist-dropdown"
                minMenuWidth={148}
                matchAnchorWidth
              />
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
                      <AppDropdownSelect
                        value={entry.type === 'regex_path' ? 'regex_path' : 'exact_path'}
                        options={[{ value: 'exact_path', label: '路径精确匹配' }, { value: 'regex_path', label: '路径正则匹配' }]}
                        onChange={(value) => handleUpdateBlacklistEntry(index, 'type', value)}
                        ariaLabel="黑名单匹配方式"
                        className="settings-blacklist-dropdown"
                        minMenuWidth={148}
                        matchAnchorWidth
                      />
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

function ModelTab() {
  const { activeProvider, providers, addProvider, deleteProvider, saveProvider, activateProvider } = useSettingsStore()
  const [selectedProvider, setSelectedProvider] = useState(activeProvider || null)
  const [providerSearch, setProviderSearch] = useState('')
  const [addPickerOpen, setAddPickerOpen] = useState(false)
  const [addingProvider, setAddingProvider] = useState(null)
  const [deletingProvider, setDeletingProvider] = useState(null)
  const addTriggerRef = useRef(null)
  const addMenuRef = useRef(null)
  const closeAddPicker = () => setAddPickerOpen(false)
  useDropdownDismiss(addPickerOpen, closeAddPicker, addTriggerRef, addMenuRef)

  useEffect(() => {
    if (!addPickerOpen) return undefined
    const frame = requestAnimationFrame(() => addMenuRef.current?.querySelector('button')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [addPickerOpen])

  const handleAddMenuKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAddPicker()
      addTriggerRef.current?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = [...(addMenuRef.current?.querySelectorAll('button:not(:disabled)') || [])]
      const index = items.indexOf(document.activeElement)
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
  }
  const [advancedProviders, setAdvancedProviders] = useState({})
  const [catalogAddressExpanded, setCatalogAddressExpanded] = useState({})
  const [forms, setForms] = useState({})
  const formNameTouched = useRef({})
  const [catalogs, setCatalogs] = useState({})
  const [catalogLoading, setCatalogLoading] = useState({})
  const [probeResults, setProbeResults] = useState({})
  const [probeChecks, setProbeChecks] = useState({})
  const [probeExpanded, setProbeExpanded] = useState({})
  const [probeLogsVisible, setProbeLogsVisible] = useState({})
  const catalogRequestIds = useRef({})
  const probeRequestIds = useRef({})
  const [saving, setSaving] = useState(null)
  const [saved, setSaved] = useState(null)
  const [activating, setActivating] = useState(null)
  const [testing, setTesting] = useState({})
  const testingProviders = useRef(new Set())
  const [testResult, setTestResult] = useState(null)

  const singleProvider = PROVIDERS.length === 1
  const { visible: visibleProviders, addable: addableProviders } = useMemo(
    () => buildSettingsProviderLists(PROVIDERS, providers),
    [providers],
  )
  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLocaleLowerCase()
    if (!query) return visibleProviders
    return visibleProviders.filter((provider) => provider.name.toLocaleLowerCase().includes(query))
  }, [visibleProviders, providerSearch])
  const providerType = (id) => providers[id]?.provider_id || id
  const providerDefinition = (id) => PROVIDERS.find(provider => provider.id === providerType(id))
  const catalogKey = (id, target = 'weworker') => `${id}:${target}`

  useEffect(() => {
    setSelectedProvider((current) => {
      if (visibleProviders.some((provider) => provider.id === current)) return current
      return visibleProviders.find((provider) => provider.id === activeProvider)?.id
        || visibleProviders[0]?.id
        || null
    })
  }, [visibleProviders, activeProvider])

  // The first render can create a form from the build-time supplier name before
  // settings load supplies the persisted/generated configuration name. Update
  // only untouched defaults so an in-progress edit is never overwritten.
  useEffect(() => {
    setForms((current) => {
      let changed = false
      const next = { ...current }
      for (const provider of visibleProviders) {
        if (formNameTouched.current[provider.id] || !next[provider.id] || next[provider.id].name === provider.name) continue
        next[provider.id] = { ...next[provider.id], name: provider.name }
        changed = true
      }
      return changed ? next : current
    })
  }, [visibleProviders])

  const getForm = (pid) => {
    if (forms[pid]) return forms[pid]
    const p = providerDefinition(pid)
    const stored = providers[pid] ?? {}
    const name = visibleProviders.find(provider => provider.id === pid)?.name || p?.name || ''
    return {
      name,
      api_key: '',
      openai_api_key: '',
      model: hasFixedModel(providerType(pid)) ? p.defaultModel : stored.model || p?.defaultModel || '',
      openai_model: hasFixedModel(providerType(pid)) ? p.defaultModel : stored.openai_model ?? (stored.model || p?.defaultModel || ''),
      context_limit: formatContextLimitInput(stored.context_limit),
      base_url: stored.base_url || '',
      base_url_is_full: stored.base_url_is_full === true,
      openai_base_url: stored.openai_base_url || '',
      openai_base_url_is_full: stored.openai_base_url_is_full === true,
      auth_type: stored.auth_type === 'api_key' ? 'api_key' : 'auth_token',
      models_url: stored.models_url || '',
      models_url_is_full: stored.models_url_is_full ?? Boolean(stored.models_url),
      models_auth_type: stored.models_auth_type || 'inherit',
      openai_models_url: stored.openai_models_url || '',
      openai_models_url_is_full: stored.openai_models_url_is_full ?? Boolean(stored.openai_models_url),
    }
  }

  const setFormField = (pid, k, v) => {
    if (k === 'name') formNameTouched.current[pid] = true
    setForms((f) => ({ ...f, [pid]: {
      ...getForm(pid),
      [k]: v,
    } }))
    setTestResult(null)
    probeRequestIds.current[pid] = (probeRequestIds.current[pid] || 0) + 1
    testingProviders.current.delete(pid)
    setTesting((current) => ({ ...current, [pid]: false }))
    setProbeResults((results) => {
      const next = { ...results }
      delete next[pid]
      return next
    })
    setProbeChecks((checks) => {
      const next = { ...checks }
      delete next[pid]
      return next
    })
    setProbeExpanded((expanded) => ({ ...expanded, [pid]: false }))
    setProbeLogsVisible((visible) => ({ ...visible, [pid]: false }))
    if (['api_key', 'openai_api_key', 'base_url', 'base_url_is_full', 'openai_base_url', 'openai_base_url_is_full', 'auth_type', 'models_url', 'models_url_is_full', 'models_auth_type', 'openai_models_url', 'openai_models_url_is_full'].includes(k)) {
      const key = catalogKey(pid, k.startsWith('openai_') ? 'webwright' : 'weworker')
      catalogRequestIds.current[key] = (catalogRequestIds.current[key] || 0) + 1
      setCatalogLoading((current) => ({ ...current, [key]: false }))
      setCatalogs((current) => {
        const next = { ...current }
        delete next[key]
        return next
      })
    }
  }

  const providerRequestBody = (pid) => {
    const f = getForm(pid)
    return {
      provider: pid,
      api_key: f.api_key,
      openai_api_key: f.openai_api_key,
      model: f.model,
      openai_model: f.openai_model,
      ...(providerType(pid) === 'custom' ? { base_url: f.base_url, base_url_is_full: f.base_url_is_full, openai_base_url: f.openai_base_url, openai_base_url_is_full: f.openai_base_url_is_full, auth_type: f.auth_type } : {}),
    }
  }

  const loadModels = async (pid, explicitRefresh = false, target = 'weworker') => {
    if (hasFixedModel(providerType(pid))) return
    const key = catalogKey(pid, target)
    const requestId = (catalogRequestIds.current[key] || 0) + 1
    catalogRequestIds.current[key] = requestId
    const form = getForm(pid)
    if (getModelCatalogIssue(providerType(pid), form, providers[pid], target)) return
    setCatalogLoading((current) => ({ ...current, [key]: true }))
    try {
      const data = await fetchProviderModels(buildModelCatalogAccess(pid, providerType(pid), form, target))
      if (catalogRequestIds.current[key] !== requestId) return
      setCatalogs((current) => ({ ...current, [key]: { ...data, explicitRefresh } }))
      setForms((current) => {
        const latestForm = current[pid] || getForm(pid)
        const field = target === 'webwright' ? 'openai_model' : 'model'
        const nextModel = selectModelAfterCatalogRefresh(latestForm[field], data)
        return nextModel === latestForm[field] ? current : { ...current, [pid]: { ...latestForm, [field]: nextModel } }
      })
    } catch (error) {
      if (catalogRequestIds.current[key] !== requestId) return
      setCatalogs((current) => ({
        ...current,
        [key]: { models: [], source: 'fallback', warning: error.message || '模型列表获取失败', explicitRefresh },
      }))
    } finally {
      if (catalogRequestIds.current[key] === requestId) {
        setCatalogLoading((current) => ({ ...current, [key]: false }))
      }
    }
  }

  const handleAddProvider = async (pid) => {
    setAddingProvider(pid)
    setTestResult(null)
    try {
      const configurationId = await addProvider(pid)
      setAddPickerOpen(false)
      setProviderSearch('')
      setSelectedProvider(configurationId)
    } catch (error) {
      setTestResult({ ok: false, message: error.message || '添加模型失败' })
    } finally {
      setAddingProvider(null)
    }
  }

  useEffect(() => {
    if (!selectedProvider || isBuiltinProvider(selectedProvider)) return
    void loadModels(selectedProvider)
    if (providerType(selectedProvider) === 'custom') void loadModels(selectedProvider, false, 'webwright')
  }, [selectedProvider])

  const handleSave = async (pid) => {
    setSaving(pid)
    setTestResult(null)
    const f = getForm(pid)
    const name = isFixedProvider(pid) ? providerDefinition(pid).name : f.name.trim()
    if (!name || name.length > 80) {
      setTestResult({ ok: false, message: '配置名称请输入 1 到 80 个字符' })
      setSaving(null)
      return
    }
    const contextLimit = parseContextLimitInput(f.context_limit)
    if (!isBuiltinProvider(pid) && contextLimit === null) {
      setTestResult({ ok: false, message: '上下文窗口请输入 1K 到 100M 之间的整数，可使用 K/M 单位' })
      setSaving(null)
      return
    }
    const updates = isBuiltinProvider(pid) ? { name } : { name, model: f.model, context_limit: contextLimit }
    if (f.api_key) updates.api_key = f.api_key
    if (f.openai_api_key) updates.openai_api_key = f.openai_api_key
    if (providerType(pid) === 'custom') {
      updates.base_url = f.base_url
      updates.base_url_is_full = f.base_url_is_full
      updates.openai_base_url = f.openai_base_url
      updates.openai_base_url_is_full = f.openai_base_url_is_full
      updates.auth_type = f.auth_type
      updates.models_url = f.models_url
      updates.models_url_is_full = f.models_url_is_full
      updates.models_auth_type = f.models_auth_type
      updates.openai_models_url = f.openai_models_url
      updates.openai_models_url_is_full = f.openai_models_url_is_full
      if (f.openai_model) updates.openai_model = f.openai_model
    }
    try {
      await saveProvider(pid, updates)
      // Clear the api_key field after save
      formNameTouched.current[pid] = false
      setForms((prev) => ({ ...prev, [pid]: { ...getForm(pid), name, api_key: '', openai_api_key: '' } }))
      setSaved(pid)
      setTestResult({ ok: true, message: '配置已保存' })
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

  const handleDelete = async (pid) => {
    const provider = visibleProviders.find(item => item.id === pid)
    if (!provider || isBuiltinProvider(pid) || isFixedProvider(pid) || activeProvider === pid) return
    if (!await showConfirm(`确定删除“${provider.name}”吗？此配置中的设置将被移除。`, '删除模型配置')) return
    setDeletingProvider(pid)
    setTestResult(null)
    try {
      await deleteProvider(pid)
      setForms((current) => {
        const next = { ...current }
        delete next[pid]
        return next
      })
      setSelectedProvider((current) => current === pid ? null : current)
    } catch (error) {
      setTestResult({ ok: false, message: error.message || '删除失败' })
    } finally {
      setDeletingProvider(null)
    }
  }

  const renderProbeChecklist = (pid) => {
    const checks = probeChecks[pid]
    if (!checks?.length) return null
    const expanded = probeExpanded[pid] === true
    const logsVisible = probeLogsVisible[pid] === true
    const allPassed = checks.every((check) => check.status === 'success')
    const hasFailure = checks.some((check) => check.status === 'failure')
    return (
      <section className="model-probe-checklist" aria-label="连通性检查">
        <button
          type="button"
          className="model-probe-checklist__toggle"
          aria-expanded={expanded}
          onClick={() => setProbeExpanded((current) => ({ ...current, [pid]: !expanded }))}
        >
          <span>
            <strong>连通性检查</strong>
            <span className={`model-probe-checklist__summary${allPassed ? ' is-success' : hasFailure ? ' is-error' : ''}`}>
              {testing[pid] ? '正在检查…' : allPassed ? '全部通过' : hasFailure ? '检查未通过' : '检查完成'}
            </span>
          </span>
          <span>{expanded ? '收起' : '展开'}</span>
        </button>
        {expanded && (
          <div className="model-probe-checklist__items" role="list">
            {checks.map((check) => (
              <div key={check.target} className={`model-probe-checklist__item is-${check.status}`} role="listitem">
                <span className="model-probe-checklist__status" aria-hidden="true">
                  {check.status === 'running' ? <LoadingOutlined spin /> : check.status === 'success' ? <CheckOutlined /> : check.status === 'failure' ? <CloseOutlined /> : '—'}
                </span>
                <span className="model-probe-checklist__content">
                  <span className="model-probe-checklist__label">{check.label}</span>
                  {check.message && (
                    <span
                      className={`model-probe-checklist__message${logsVisible ? ' is-expanded' : ''}`}
                      title={check.message}
                    >
                      {check.message}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {expanded && (
          <div className="model-probe-checklist__footer">
            <button
              type="button"
              className="model-probe-checklist__copy"
              aria-label="复制检查日志"
              title="复制检查日志"
              onClick={() => {
                const text = checks
                  .map((check) => `${check.label}: ${check.message || check.status}`)
                  .join('\n')
                void navigator.clipboard?.writeText(text)
              }}
            >
              <CopyOutlined />
            </button>
            <button
              type="button"
              className="model-probe-checklist__logs-toggle"
              aria-expanded={logsVisible}
              onClick={() => setProbeLogsVisible((current) => ({ ...current, [pid]: !logsVisible }))}
            >
              {logsVisible ? <UpOutlined /> : <DownOutlined />}
              {logsVisible ? '隐藏日志' : '显示日志'}
            </button>
          </div>
        )}
      </section>
    )
  }

  const handleTest = async (pid) => {
    if (testingProviders.current.has(pid)) return
    testingProviders.current.add(pid)
    const requestId = (probeRequestIds.current[pid] || 0) + 1
    probeRequestIds.current[pid] = requestId
    setTesting((current) => ({ ...current, [pid]: true }))
    setProbeResults((results) => ({ ...results, [pid]: null }))
    setProbeExpanded((current) => ({ ...current, [pid]: true }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const provider = providerDefinition(pid)
      const probe = async (target) => {
        const fallbackProtocol = target === 'weworker'
          ? 'anthropic_messages'
          : provider?.webwright?.protocol || (providerType(pid) === 'anthropic' ? 'anthropic_messages' : 'openai_chat_completions')
        try {
          const res = await backendFetch(`${API}/settings/provider/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...providerRequestBody(pid), target }),
            signal: controller.signal,
          })
          const data = await res.json()
          return res.ok && data.ok
            ? { ok: true, protocol: data.protocol || fallbackProtocol, message: `连接成功 · ${data.model}` }
            : { ok: false, protocol: data.protocol || fallbackProtocol, message: data.detail || '连接失败' }
        } catch (error) {
          return {
            ok: false,
            protocol: fallbackProtocol,
            message: error.name === 'AbortError' ? '连接超时（30s）' : `无法连接：${error.message}`,
          }
        }
      }
      const targets = buildProviderProbeTargets(providerType(pid), getForm(pid).openai_base_url)
      const checks = targets.map((target) => ({
        target,
        label: target === 'weworker' ? 'WeWorker 对话接口（Claude Code 接口）' : '网站探索agent 接口（OpenAI 接口）',
        status: 'running',
        message: '',
      }))
      setProbeChecks((current) => ({ ...current, [pid]: checks }))
      const results = []
      for (const target of targets) {
        const result = await probe(target)
        results.push(result)
        if (probeRequestIds.current[pid] !== requestId) return
        setProbeChecks((current) => ({
          ...current,
          [pid]: (current[pid] || []).map((check) => check.target === target
            ? { ...check, status: result.ok ? 'success' : 'failure', message: result.message }
            : check),
        }))
      }
      if (providerType(pid) === 'custom' && !targets.includes('webwright')) {
        results.push({
          ok: null,
          protocol: 'openai_chat_completions',
          message: '未配置，仅影响网站探索 agent',
        })
        setProbeChecks((current) => ({
          ...current,
          [pid]: [...(current[pid] || []), { target: 'webwright', label: '网站探索agent 接口（OpenAI 接口）', status: 'skipped', message: '未配置地址，跳过检查' }],
        }))
      }
      if (probeRequestIds.current[pid] !== requestId) return
      setProbeResults((current) => ({ ...current, [pid]: buildProbeResultRows(results) }))
    } finally {
      clearTimeout(timer)
      if (probeRequestIds.current[pid] === requestId) {
        testingProviders.current.delete(pid)
        setTesting((current) => ({ ...current, [pid]: false }))
      }
    }
  }

  return (
    <>
      <div className="model-settings-layout">
        <aside className="model-settings-sidebar">
          <div className="model-settings-sidebar__header">
            <div>
              <div className="model-settings-sidebar__title">模型列表</div>
              <div className="model-settings-sidebar__count">
                {filteredProviders.length === visibleProviders.length
                  ? `${visibleProviders.length} 个配置`
                  : `${filteredProviders.length} / ${visibleProviders.length} 个配置`}
              </div>
            </div>
            <label className="model-settings-search">
              <SearchOutlined aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索模型配置名称"
                placeholder="搜索配置名称"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
              />
            </label>
            {addableProviders.length > 0 && (
              <button
                ref={addTriggerRef}
                type="button"
                className="settings-btn settings-btn-primary model-settings-add"
                disabled={Boolean(addingProvider)}
                onClick={() => setAddPickerOpen((open) => !open)}
                onKeyDown={handleAddMenuKeyDown}
                aria-haspopup="menu"
                aria-controls={addPickerOpen ? 'model-provider-add-menu' : undefined}
                aria-expanded={addPickerOpen}
                aria-label={addPickerOpen ? '收起添加模型' : '添加模型'}
                title={addPickerOpen ? '收起' : '添加模型'}
              >
                {addPickerOpen ? <CloseOutlined aria-hidden="true" /> : <AppstoreAddOutlined aria-hidden="true" />}
              </button>
            )}
          </div>
          <div className="model-settings-provider-list">
            {filteredProviders.map((provider) => {
              const templateId = provider.providerId || provider.id
              const stored = providers[provider.id] ?? {}
              const isSelected = selectedProvider === provider.id
              const isActive = activeProvider === provider.id
              const checks = probeChecks[provider.id] || []
              const connectivityPassed = checks.length > 0 && checks.every((check) => check.status === 'success')
              const connectivityFailed = checks.some((check) => check.status === 'failure')
              const providerColor = templateId === 'custom' ? 'var(--provider-custom)' : provider.color
              return (
                <div key={provider.id} data-model-configuration={provider.id} className={`model-settings-provider-row${isSelected ? ' is-selected' : ''}`}>
                  <button
                    type="button"
                    className={`model-settings-provider${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                    onClick={() => { setSelectedProvider(provider.id); setTestResult(null) }}
                    aria-selected={isSelected}
                  >
                    <span className="model-settings-provider__icon" style={{ color: providerColor }}>{LOGOS[templateId]}</span>
                    <span className="model-settings-provider__text">
                      <span className="model-settings-provider__name" title={provider.name}>{provider.name}</span>
                    </span>
                  </button>
                  <span className="model-settings-provider__actions" aria-label={`${provider.name}快捷操作`}>
                    <button
                      type="button"
                      className={`model-settings-provider__action${isActive ? ' is-active' : ''}`}
                      aria-label={isActive ? '当前使用' : '选择并使用'}
                      title={isActive ? '当前使用' : stored.has_key ? '选择并使用' : '请先配置 API Key'}
                      disabled={isActive || !stored.has_key || Boolean(activating)}
                      onClick={(event) => { event.stopPropagation(); setSelectedProvider(provider.id); if (!isActive) void handleActivate(provider.id) }}
                    >
                      {activating === provider.id ? <LoadingOutlined spin /> : isActive ? <CheckCircleFilled /> : <CheckOutlined />}
                    </button>
                    <button
                      type="button"
                      className={`model-settings-provider__action${testing[provider.id] ? ' is-loading' : ''}${connectivityPassed ? ' is-connected' : connectivityFailed ? ' is-failed' : ''}`}
                      aria-label="测试连通性"
                      title={stored.has_key ? '测试连通性' : '请先配置 API Key'}
                      disabled={!stored.has_key || Boolean(testing[provider.id])}
                      onClick={(event) => { event.stopPropagation(); setSelectedProvider(provider.id); void handleTest(provider.id) }}
                    >
                      {testing[provider.id] ? <LoadingOutlined spin /> : connectivityPassed ? <LinkOutlined /> : connectivityFailed ? <DisconnectOutlined /> : <ApiOutlined />}
                    </button>
                    <button
                      type="button"
                      className="model-settings-provider__action is-danger"
                      aria-label="删除配置"
                      title={isBuiltinProvider(provider.id) ? '内置模型不能删除' : isFixedProvider(provider.id) ? '固定供应商不能删除' : isActive ? '当前使用中的配置不能删除' : '删除配置'}
                      disabled={isBuiltinProvider(provider.id) || isFixedProvider(provider.id) || isActive || deletingProvider === provider.id}
                      onClick={(event) => { event.stopPropagation(); void handleDelete(provider.id) }}
                    >
                      {deletingProvider === provider.id ? <LoadingOutlined spin /> : <DeleteOutlined />}
                    </button>
                  </span>
                </div>
              )
            })}
            {filteredProviders.length === 0 && (
              <div className="model-settings-provider-empty">
                {providerSearch.trim() ? '没有匹配的模型配置' : '还没有模型配置，点击左侧 + 添加。'}
              </div>
            )}
          </div>
          <DropdownMenuPortal
            ref={addMenuRef}
            open={addPickerOpen && addableProviders.length > 0}
            anchorRef={addTriggerRef}
            align="end"
            minWidth={180}
            className="app-dropdown-menu model-settings-add-menu"
          >
            <div id="model-provider-add-menu" role="menu" aria-label="选择供应商" onKeyDown={handleAddMenuKeyDown}>
              {addableProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="menuitem"
                  className="app-dropdown-menu-item"
                  onClick={() => handleAddProvider(provider.id)}
                  disabled={Boolean(addingProvider)}
                >
                  {addingProvider === provider.id ? '添加中…' : provider.id === 'custom' ? '自定义供应商' : provider.name}
                </button>
              ))}
            </div>
          </DropdownMenuPortal>
        </aside>

        <section className="model-settings-detail" aria-label="模型配置详情">
        {visibleProviders.filter((provider) => provider.id === selectedProvider).map((p) => {
          const isActive = singleProvider || activeProvider === p.id
          const stored = providers[p.id] ?? {}
          const f = getForm(p.id)
          const templateId = p.providerId || p.id
          const catalog = catalogs[catalogKey(p.id)]
          const openAiCatalog = catalogs[catalogKey(p.id, 'webwright')]
          const loadingModels = catalogLoading[catalogKey(p.id)]
          const loadingOpenAiModels = catalogLoading[catalogKey(p.id, 'webwright')]
          const catalogIssue = getModelCatalogIssue(templateId, f, stored)
          const openAiCatalogIssue = getModelCatalogIssue(templateId, f, stored, 'webwright')
          const { hint: catalogHint, failed: catalogRefreshFailed, detail: catalogErrorDetail } = getModelCatalogStatus(catalog, loadingModels, catalogIssue)
          const openAiCatalogStatus = getModelCatalogStatus(openAiCatalog, loadingOpenAiModels, openAiCatalogIssue)
          const modelOptions = buildModelOptions(!catalogIssue && catalog?.source === 'remote' ? catalog.models : [], f.model)
          const openAiModelOptions = buildModelOptions(!openAiCatalogIssue && openAiCatalog?.source === 'remote' ? openAiCatalog.models : [], f.openai_model)
          const providerColor = templateId === 'custom' ? 'var(--provider-custom)' : p.color
          const detailActions = (
            <div className="settings-btn-group model-settings-header-actions">
              <button type="button" onClick={() => handleTest(p.id)} disabled={!!testing[p.id] || (isBuiltinProvider(p.id) && !stored.has_key)} className="settings-btn settings-btn-secondary">
                {testing[p.id] ? '检测中…' : isBuiltinProvider(p.id) ? '测试连通性' : '测试模型可用性'}
              </button>
              {!singleProvider && !isActive && (
                <button type="button" onClick={() => handleActivate(p.id)} disabled={!!activating || !stored.has_key} title={!stored.has_key ? '请先保存 API Key' : ''} className="settings-btn settings-btn-provider" style={{ '--provider-color': providerColor }}>
                  {activating === p.id ? '切换中...' : '切换使用'}
                </button>
              )}
              <button type="button" onClick={() => handleSave(p.id)} disabled={saving === p.id} className={`settings-btn ${saved === p.id ? 'settings-btn-success' : 'settings-btn-primary'}`}>
                {saving === p.id ? '保存中...' : saved === p.id ? '已保存 ✓' : '保存'}
              </button>
            </div>
          )
          const actionFeedback = testResult && (
            <div className={`settings-action-hint model-settings-feedback${testResult.ok ? ' is-success' : ' is-error'}`} role="status">
              {testResult.message}
            </div>
          )
          const configurationName = <ModelConfigurationName key={p.id} name={p.name} readOnly={isFixedProvider(p.id)}
            disabled={saving === p.id || activating === p.id || deletingProvider === p.id}
            onSave={async name => {
              await saveProvider(p.id, { name })
              formNameTouched.current[p.id] = false
              setForms(current => current[p.id] ? { ...current, [p.id]: { ...current[p.id], name } } : current)
            }} />
          const identityFields = (
            <div className="model-settings-grid" role="group" aria-label="基本信息">
              <Field label="供应商">
                <input aria-label="供应商" className="settings-input" value={p.supplierName} readOnly />
              </Field>
            </div>
          )
          const catalogAddressFields = (openai = false) => {
            const field = openai ? 'openai_models_url' : 'models_url'
            const mode = openai ? 'openai_models_url_is_full' : 'models_url_is_full'
            const target = openai ? 'webwright' : 'weworker'
            const key = catalogKey(p.id, target)
            const expanded = catalogAddressExpanded[key] ?? Boolean(f[field])
            return (
              <details className="settings-catalog-address" open={expanded}
                onToggle={(event) => { const open = event.currentTarget.open; if (open !== expanded) setCatalogAddressExpanded(current => ({ ...current, [key]: open })) }}>
                <summary>单独设置模型列表地址（可选）</summary>
                <Field label="模型列表地址" hint={f[mode] ? '原样使用完整 URL；留空自动推导' : '默认补全 /v1/models，已有后缀不重复追加；留空自动推导'}>
                  <label className="settings-url-mode">
                    <AppSwitch aria-label={openai ? 'OpenAI 模型列表使用完整 URL' : 'Claude Code 模型列表使用完整 URL'}
                      checked={f[mode]} onChange={(e) => setFormField(p.id, mode, e.target.checked)} />
                    使用完整 URL
                  </label>
                  <input className="settings-input" aria-label={openai ? 'OpenAI 模型列表地址' : 'Claude Code 模型列表地址'}
                    value={f[field]} onChange={(e) => { setCatalogAddressExpanded(current => ({ ...current, [key]: true })); setFormField(p.id, field, e.target.value) }}
                    onBlur={() => { void loadModels(p.id, false, target) }} placeholder={f[mode] ? 'https://example.com/v1/models' : 'https://example.com/v1'} />
                </Field>
                {!openai && <Field label="列表认证方式" hint="使用本接口 API Key">
                  <AppDropdownSelect value={f.models_auth_type} ariaLabel="模型列表认证方式"
                    options={[{ value: 'inherit', label: '跟随对话接口' }, { value: 'auth_token', label: 'Bearer Token' }, { value: 'api_key', label: 'API Key（x-api-key）' }]}
                    onChange={(value) => setFormField(p.id, 'models_auth_type', value)} matchAnchorWidth />
                </Field>}
              </details>
            )
          }

          if (isBuiltinProvider(p.id)) {
            const builtinActive = activeProvider === p.id
            return (
            <div key={p.id} className={`settings-card settings-card-builtin model-settings-detail-card${builtinActive ? ' is-active' : ''}`}>
                <div className="settings-card-header">
                  <span style={{ color: p.color, flexShrink: 0 }}>{LOGOS[p.id] || LOGOS.builtin}</span>
                  <div className="model-settings-header-info">
                    <div className="settings-card-title" style={{ color: builtinActive ? p.color : 'var(--text-primary)' }}>
                      {configurationName}{builtinActive && <span className="settings-badge-active">使用中</span>}
                      <span className="settings-card-inline-subtitle"> · {stored.model || p.defaultModel} · {stored.has_key
                        ? (builtinActive ? '当前使用' : '服务已配置，可直接使用')
                        : '服务尚未配置，请联系应用提供方或使用其他模型'}</span>
                    </div>
                  </div>
                  {detailActions}
                </div>
                <div className="settings-card-body">
                  {actionFeedback}
                  {identityFields}
                  {renderProbeChecklist(p.id)}
                </div>
              </div>
            )
          }

          return (
            <div key={p.id} data-model-configuration={p.id} className={`settings-card model-settings-detail-card${isActive ? ' is-active' : ''}`}>
              <div className="settings-card-header">
                <span style={{ color: p.color, flexShrink: 0 }}>{LOGOS[templateId]}</span>
                <div className="model-settings-header-info">
                  <div className="settings-card-title" style={{ color: isActive ? p.color : 'var(--text-primary)' }}>
                    {configurationName}
                    {isActive && !singleProvider && <span className="settings-badge-active">使用中</span>}
                    {stored.has_key
                      ? <span className="settings-card-inline-status is-configured"> · 已配置 {stored.model || p.subtitle}</span>
                      : <span className="settings-card-inline-status"> · 未配置</span>}
                  </div>
                </div>
                {detailActions}
              </div>

              <div className="settings-card-body">
                  {actionFeedback}
                  {identityFields}
                  {templateId !== 'custom' && <div className="model-settings-grid" role="group" aria-label="接口配置">
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

                  <Field label="模型" hint={catalogHint} hintError={catalogRefreshFailed || Boolean(catalogErrorDetail)} errorDetail={catalogErrorDetail}>
                    <div style={{ width: '100%' }}>
                      <div className="settings-model-input-row">
                        <AppDropdownSelect
                          value={f.model}
                          options={modelOptions}
                          disabled={hasFixedModel(templateId)}
                          onChange={(value) => setFormField(p.id, 'model', value)}
                          ariaLabel="模型"
                          minMenuWidth={280}
                          matchAnchorWidth
                          className="settings-model-dropdown"
                          searchable
                          allowCustom
                          searchPlaceholder="搜索或输入模型名"
                        />
                        <button type="button" onClick={() => loadModels(p.id, true)} disabled={hasFixedModel(templateId) || loadingModels || Boolean(catalogIssue)} className="settings-btn settings-btn-secondary">
                          {loadingModels ? '获取中…' : '刷新模型'}
                        </button>
                      </div>
                    </div>
                  </Field>

                  <Field label="上下文窗口" hint="用于估算上下文占用率，可选择或直接输入">
                    <AppDropdownInput
                      className="settings-input"
                      ariaLabel="上下文窗口" options={CONTEXT_LIMIT_PRESETS.map(value => ({ value, label: value }))}
                      value={f.context_limit}
                      onChange={(e) => setFormField(p.id, 'context_limit', e.target.value)}
                      onBlur={() => {
                        const parsed = parseContextLimitInput(f.context_limit)
                        if (parsed !== null) setFormField(p.id, 'context_limit', formatContextLimitInput(parsed))
                      }}
                      placeholder="例如 200K、1M 或 1000000"
                      inputMode="text"
                    />

                  </Field>
                  </div>}

                  {templateId === 'custom' && (
                    <section className="settings-interface-section" aria-label="Claude Code 接口（WeWorker 对话）">
                      <div className="settings-interface-section__title">Claude Code 接口（WeWorker 对话）</div>
                      <div className="model-settings-grid">
                      <Field label="接口地址" hint={getAnthropicUrlHint(f.base_url_is_full)}>
                        <label className="settings-url-mode">
                          <AppSwitch checked={f.base_url_is_full} onChange={(e) => setFormField(p.id, 'base_url_is_full', e.target.checked)} />
                          使用完整 URL
                        </label>
                        <input aria-label="Claude Code 接口地址" className="settings-input" value={f.base_url} onChange={(e) => setFormField(p.id, 'base_url', e.target.value)} onBlur={() => { if (f.base_url) void loadModels(p.id, false, 'weworker') }} placeholder={f.base_url_is_full ? 'https://gateway.example/custom/messages' : 'https://gateway.example/anthropic'} />
                      </Field>
                      <Field label="API Key 类型">
                        <AppDropdownSelect
                          value={f.auth_type}
                          options={[
                            { value: 'auth_token', label: 'Bearer Token（ANTHROPIC_AUTH_TOKEN）' },
                            { value: 'api_key', label: 'API Key（ANTHROPIC_API_KEY）' },
                          ]}
                          onChange={(value) => setFormField(p.id, 'auth_type', value)}
                          ariaLabel="API Key 类型"
                          minMenuWidth={320}
                          matchAnchorWidth
                          className="settings-provider-auth-select"
                        />
                      </Field>
                      <Field label="API Key" hint={stored.has_key ? '已设置（留空保持不变）' : '未设置'}>
                        <input type="password" className="settings-input" value={f.api_key} onChange={(e) => setFormField(p.id, 'api_key', e.target.value)} onBlur={() => { if (f.api_key) void loadModels(p.id, false, 'weworker') }} placeholder={stored.has_key ? '••••••••••••' : 'sk-...'} />
                      </Field>
                      <Field label="模型" hint={catalogHint} hintError={catalogRefreshFailed || Boolean(catalogErrorDetail)} errorDetail={catalogErrorDetail}>
                        <div className="settings-model-input-row">
                          <AppDropdownSelect
                            value={f.model}
                            options={modelOptions}
                            disabled={hasFixedModel(templateId)}
                            onChange={(value) => setFormField(p.id, 'model', value)}
                            ariaLabel="Claude Code 模型"
                            minMenuWidth={280}
                            matchAnchorWidth
                            className="settings-model-dropdown"
                            searchable
                            allowCustom
                            searchPlaceholder="搜索或输入模型名"
                          />
                          <button type="button" onClick={() => loadModels(p.id, true, 'weworker')} disabled={hasFixedModel(templateId) || loadingModels || Boolean(catalogIssue)} className="settings-btn settings-btn-secondary">
                            {loadingModels ? '获取中…' : '刷新模型'}
                          </button>
                        </div>
                      </Field>
                      {catalogAddressFields()}
                      <Field label="上下文窗口" hint="用于估算上下文占用率，可选择或直接输入">
                        <AppDropdownInput className="settings-input" ariaLabel="上下文窗口" options={CONTEXT_LIMIT_PRESETS.map(value => ({ value, label: value }))} value={f.context_limit} onChange={(e) => setFormField(p.id, 'context_limit', e.target.value)} onBlur={() => { const parsed = parseContextLimitInput(f.context_limit); if (parsed !== null) setFormField(p.id, 'context_limit', formatContextLimitInput(parsed)) }} placeholder="例如 200K、1M 或 1000000" inputMode="text" />

                      </Field>
                      </div>
                    </section>
                  )}

                  {templateId === 'custom' && (
                    <>
                      {(() => {
                        const advancedExpanded = advancedProviders[p.id] ?? false
                        return (
                          <div className="settings-field">
                            <button
                              type="button"
                              className="settings-btn settings-btn-secondary"
                              onClick={() => setAdvancedProviders((current) => ({ ...current, [p.id]: !advancedExpanded }))}
                              aria-expanded={advancedExpanded}
                            >
                              <span>{advancedExpanded ? '收起高级配置' : '高级配置'}</span>
                              <span className="settings-advanced-toggle__icon" aria-hidden="true">
                                {advancedExpanded ? <UpOutlined /> : <DownOutlined />}
                              </span>
                            </button>
                            {advancedExpanded && (
                              <section className="settings-interface-section settings-interface-section--advanced" aria-label="OpenAI 接口（网站探索agent）">
                                <div className="settings-interface-section__title">OpenAI 接口（网站探索agent）</div>
                                <div className="model-settings-grid">
                                <Field label="接口地址" hint={getOpenAiUrlHint(f.openai_base_url_is_full)}>
                                  <label className="settings-url-mode">
                                    <AppSwitch checked={f.openai_base_url_is_full} onChange={(e) => setFormField(p.id, 'openai_base_url_is_full', e.target.checked)} />
                                    使用完整 URL
                                  </label>
                                  <input aria-label="OpenAI 接口地址" className="settings-input" value={f.openai_base_url} onChange={(e) => setFormField(p.id, 'openai_base_url', e.target.value)} onBlur={() => { if (f.openai_base_url) void loadModels(p.id, false, 'webwright') }} placeholder={f.openai_base_url_is_full ? 'https://gateway.example/custom/completions' : 'https://gateway.example/openai/v1'} />
                                </Field>
                                <Field label="API Key" hint={(stored.has_openai_key || stored.openai_has_key) ? '已设置（留空保持不变）' : '未设置'}>
                                  <input type="password" className="settings-input" value={f.openai_api_key} onChange={(e) => setFormField(p.id, 'openai_api_key', e.target.value)} onBlur={() => { if (f.openai_api_key) void loadModels(p.id, false, 'webwright') }} placeholder={(stored.has_openai_key || stored.openai_has_key) ? '••••••••••••' : 'sk-...'} />
                                </Field>
                                <Field label="模型" hint={openAiCatalogStatus.hint} hintError={openAiCatalogStatus.failed || Boolean(openAiCatalogStatus.detail)} errorDetail={openAiCatalogStatus.detail}>
                                  <div className="settings-model-input-row">
                                    <AppDropdownSelect
                                      value={f.openai_model}
                                      options={openAiModelOptions}
                                      disabled={hasFixedModel(templateId)}
                                      onChange={(value) => setFormField(p.id, 'openai_model', value)}
                                      ariaLabel="网站探索agent模型"
                                      minMenuWidth={280}
                                      matchAnchorWidth
                                      className="settings-model-dropdown"
                                    />
                                    <button type="button" onClick={() => loadModels(p.id, true, 'webwright')} disabled={hasFixedModel(templateId) || loadingOpenAiModels || Boolean(openAiCatalogIssue)} className="settings-btn settings-btn-secondary">
                                      {loadingOpenAiModels ? '获取中…' : '刷新模型'}
                                    </button>
                                  </div>
                                </Field>
                                {catalogAddressFields(true)}
                                </div>
                              </section>
                            )}
                          </div>
                        )
                      })()}
                    </>
                  )}

                  {renderProbeChecklist(p.id)}
              </div>
            </div>
          )
        })}
        {visibleProviders.length === 0 && <div className="model-settings-empty">还没有模型配置，点击左侧 + 添加。</div>}
        </section>
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

function Field({ label, hint, hintError = false, errorDetail, children }) {
  return (
    <div className="settings-field settings-field--row">
      <div className="settings-field-label">
        {label}
        {hint && <span className={`settings-field-hint${hintError ? ' is-error' : ''}`}>{hint}</span>}
        {errorDetail && <details className="settings-catalog-error" key={errorDetail}>
          <summary>查看错误详情</summary>
          <div className="settings-remote-detail is-error" tabIndex={0} role="region" aria-label={`${label}错误详情`}>{errorDetail}</div>
        </details>}
      </div>
      <div className="settings-field-control">{children}</div>
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
          <span className="settings-style-option__title-text">{title}</span>
          {badge ? <span className="settings-style-option__badge">{badge}</span> : null}
        </span>
        {description ? <span className="settings-style-option__desc">{description}</span> : null}
      </span>
      <span className="settings-style-option__radio" aria-hidden="true" />
    </button>
  )
}

// 自定义风格卡片：复用 StyleOptionCard 作为卡片本体（选中/切换行为不变），
// 再在卡片右侧补一个明确的「编辑」入口（铅笔图标 + 文字），点击打开编辑弹窗。
// 该入口在 CSS 里绝对定位（垂直居中、位于蓝色选择圆点左侧），脱离文档流，
// 不参与卡片高度计算（卡片高度与内置卡片一致）。
function EditableStyleOptionCard({
  selected = false,
  roleId,
  title,
  description,
  badge,
  kind = 'custom',
  onSelect,
  onEdit,
}) {
  return (
    <div className={`settings-style-option-wrap${selected ? ' is-selected' : ''}`}>
      <StyleOptionCard
        selected={selected}
        title={title}
        description={description}
        badge={badge}
        kind={kind}
        onSelect={onSelect}
      />
      <div className="settings-style-option-actions">
        <button
          type="button"
          className="settings-style-option-edit"
          onClick={() => onEdit(roleId)}
          title={`${STYLE_EDIT_LABEL}自定义风格`}
          aria-label={`${STYLE_EDIT_LABEL}自定义风格 ${title}`}
        >
          <EditOutlined aria-hidden="true" />
          <span>{STYLE_EDIT_LABEL}</span>
        </button>
      </div>
    </div>
  )
}

// 自定义风格编辑弹窗：沿用设置页既有弹窗约定（PresetKeyDialog 的 portal + 遮罩 + Esc/Tab 处理，
// .weworker-dialog-overlay / .weworker-dialog 外壳，settings-theme.css 的 .settings-* 表单控件）。
// 草稿只存在弹窗内部：保存时通过 onSave 写回父级，取消不做任何写入。
// canDelete 只在编辑已存在的自定义风格时为 true（「新增」场景不显示删除）；
// 删除同样不写后端，交给「保存配置」统一落盘（沿用旧常驻编辑区块的行为）。
function CustomStyleDialog({ draft: initialDraft, canDelete, onSave, onDelete, onClose }) {
  const [draft, setDraft] = useState(() => buildStyleDraft(initialDraft))
  const [error, setError] = useState('')
  // 二次确认期间：确认弹窗自己处理 Esc，这里要让位，避免连编辑弹窗一起关掉。
  const [confirming, setConfirming] = useState(false)
  const panelRef = useRef(null)
  const nameRef = useRef(null)
  const titleId = useId()
  const nameId = useId()
  const promptId = useId()

  useEffect(() => {
    const previous = document.activeElement
    // 只有「当前无名称」时自动聚焦名称输入框；已有名称时聚焦弹窗本身，保证键盘能进入弹窗。
    if (String(initialDraft?.label ?? '').trim()) panelRef.current?.focus()
    else nameRef.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      // 弹窗上层的全局确认弹窗可见时，Esc 归确认弹窗（取消删除），不关闭编辑弹窗。
      if (confirming) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, confirming])

  const submit = (event) => {
    event.preventDefault()
    const result = validateStyleName(draft.label)
    if (!result.ok) {
      setError(result.error)
      nameRef.current?.focus()
      return
    }
    onSave({ label: result.label, prompt: draft.prompt })
  }

  // 复用全局确认弹窗（showConfirm），不自己造确认框；确认后才回调父级删除。
  const requestDelete = async () => {
    if (confirming) return
    setConfirming(true)
    const confirmed = await showConfirm(styleDeleteConfirmMessage(initialDraft?.label), STYLE_DELETE_CONFIRM_TITLE)
    if (confirmed) {
      // 父级删除后会关闭本弹窗，这里不再回写状态。
      onDelete()
      return
    }
    setConfirming(false)
  }

  const title = customStyleDialogTitle(initialDraft)

  return createPortal(
    <div
      className="weworker-dialog-overlay settings-style-dialog-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        className="weworker-dialog settings-style-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const items = [...(panelRef.current?.querySelectorAll('input, textarea, button') || [])]
            .filter((item) => !item.disabled)
          const first = items[0]
          const last = items[items.length - 1]
          if (!first) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
            event.preventDefault()
            last.focus()
          }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p>填写名称与提示词，保存后可在聊天中切换</p>
        <form onSubmit={submit}>
          <div className="settings-style-dialog__field">
            <label htmlFor={nameId}>风格名称</label>
            <input
              ref={nameRef}
              id={nameId}
              className="settings-input"
              type="text"
              autoComplete="off"
              placeholder={STYLE_NAME_PLACEHOLDER}
              value={draft.label}
              onChange={(event) => { setDraft((current) => ({ ...current, label: event.target.value })); setError('') }}
            />
          </div>
          <div className="settings-style-dialog__field">
            <label htmlFor={promptId}>风格提示词</label>
            <textarea
              id={promptId}
              className="settings-input settings-style-dialog__prompt"
              placeholder={STYLE_PROMPT_PLACEHOLDER}
              value={draft.prompt}
              onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
            />
          </div>
          <span className={`settings-action-hint settings-style-dialog__hint${error ? ' is-error' : ''}`} role={error ? 'alert' : undefined}>
            {error}
          </span>
          <footer>
            {canDelete && (
              <button
                type="button"
                className="weworker-dialog__button settings-style-dialog__delete"
                onClick={requestDelete}
                disabled={confirming}
              >
                {STYLE_DELETE_LABEL}
              </button>
            )}
            <button type="button" className="weworker-dialog__button" onClick={onClose}>取消</button>
            <button type="submit" className="weworker-dialog__button is-primary">保存</button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
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
// 把「已保存设置」单向同步进面板本地草稿：只有已保存内容签名变化时才覆盖本地草稿。
// 设置页保存任何一项都会让后端回传整份 settings（自定义风格等字段是内容相同的新引用），
// 若按引用变化就刷新，未点「保存配置」的新增/编辑风格会被已保存设置冲掉。
function useSyncSavedSnapshotToDraft(savedSnapshot, applySavedSnapshot) {
  const signatureRef = useRef(savedSnapshotSignature(savedSnapshot))
  const { sync, signature } = resolveSavedSnapshotSync(signatureRef.current, savedSnapshot)
  useEffect(() => {
    if (!sync) return
    signatureRef.current = signature
    applySavedSnapshot()
  }, [sync, signature])
}

// active=false 表示「配置」页签已切走（面板被隐藏但未卸载）：草稿 state 保留，
// 只把编辑弹窗关掉，避免弹窗浮在其它页签上（与旧的「切页签即卸载」观感一致）。
function StyleSettingsPanel({ active = true }) {
  const zcfDefaultRole = useSettingsStore((s) => s.zcfDefaultRole)
  const zcfEnabledRoles = useSettingsStore((s) => s.zcfEnabledRoles)
  const zcfCustomRoles = useSettingsStore((s) => s.zcfCustomRoles)
  const saveStyleSettings = useSettingsStore((s) => s.saveStyleSettings)
  const [selectedStyleId, setSelectedStyleId] = useState(zcfDefaultRole || zcfEnabledRoles?.[0] || DEFAULT_STYLE)
  const [customRoles, setCustomRoles] = useState(zcfCustomRoles || [])
  const [customEditor, setCustomEditor] = useState(null)
  const [rolesMessage, setRolesMessage] = useState(null)
  const [savingRoles, setSavingRoles] = useState(false)

  // 风格清单 = 应用内置风格（默认 / 专业严谨简单明确 / 工程师专业版）+ 自定义风格。
  // 全部是纯提示词：没有模板语言、没有扩展目录、没有「更新扩展」入口。
  const savedSelectableStyles = useMemo(() => listSelectableStyles(zcfCustomRoles), [zcfCustomRoles])

  const selectableStyles = useMemo(() => {
    const custom = (customRoles || []).map((role) => {
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
    return [...listSelectableStyles([]), ...custom]
  }, [customRoles])

  // 已保存设置 → 本地草稿：只在内容真正变化时刷新，避免其它保存动作新建的等价引用冲掉草稿。
  // 已删除风格的残留 id（历史 auto-plan 等）在写回草稿前回落到默认，避免卡片列表里没有选中项。
  useSyncSavedSnapshotToDraft(
    [zcfDefaultRole, zcfEnabledRoles],
    () => {
      const saved = zcfDefaultRole || zcfEnabledRoles?.[0] || DEFAULT_STYLE
      setSelectedStyleId(savedSelectableStyles.some((role) => role.id === saved) ? saved : DEFAULT_STYLE)
    },
  )

  useSyncSavedSnapshotToDraft(
    zcfCustomRoles,
    () => setCustomRoles(zcfCustomRoles || []),
  )

  // 切走「配置」时关闭编辑弹窗（不改动 customRoles/selectedStyleId 等草稿）。
  useEffect(() => {
    if (active) return
    setCustomEditor(null)
  }, [active])

  const selectStyle = (roleId) => {
    setSelectedStyleId(roleId)
    setRolesMessage(null)
  }

  // 「新增自定义」与卡片上的「编辑」都走同一个弹窗；弹窗状态为空即不渲染任何常驻表单。
  // 传 roleId 时按 id 取当前自定义风格，传条目本身时直接用它（新增场景该条目还没进 state）。
  const openCustomEditor = (roleOrId, { isNew = false } = {}) => {
    const role = typeof roleOrId === 'string'
      ? (customRoles || []).find((item) => item.id === roleOrId)
      : roleOrId
    if (!role?.id) return
    setCustomEditor({ roleId: role.id, draft: buildStyleDraft(role), isNew })
    setRolesMessage(null)
  }

  const closeCustomEditor = () => {
    // 取消不做任何写入：草稿只存在于弹窗内部，这里仅关闭。
    setCustomEditor(null)
  }

  const saveCustomEditor = (draft) => {
    const roleId = customEditor?.roleId
    if (!roleId) {
      setCustomEditor(null)
      return
    }
    setCustomRoles((items) => upsertStyleDraft(items, roleId, draft))
    // 新增保存后沿用既有行为：新风格成为当前默认风格。
    if (customEditor.isNew) setSelectedStyleId(roleId)
    setRolesMessage(null)
    setCustomEditor(null)
  }

  const addCustomRole = () => {
    // 不预先写入 customRoles：点「新增自定义」直接进同一个弹窗，保存时才落条目。
    openCustomEditor({ id: `custom-${Date.now().toString(36)}`, label: '', prompt: '' }, { isNew: true })
  }

  // 弹窗「删除」：只删本地草稿（旧常驻编辑区块的 removeCustomRole 同样不写后端），
  // 由「保存配置」统一落盘。删掉的若正是当前选中风格，回落到内置默认风格（沿用旧行为）。
  const deleteCustomStyle = () => {
    const roleId = customEditor?.roleId
    if (!roleId) {
      setCustomEditor(null)
      return
    }
    setCustomRoles((items) => removeStyleDraft(items, roleId))
    setSelectedStyleId((current) => resolveSelectedStyleAfterRemove(current, roleId))
    setRolesMessage(null)
    setCustomEditor(null)
  }

  const rolesDirty = JSON.stringify({
    style: selectedStyleId,
    custom: (customRoles || []).map((r) => ({ id: r.id, label: r.label, prompt: r.prompt })),
  }) !== JSON.stringify({
    style: zcfDefaultRole || zcfEnabledRoles?.[0] || DEFAULT_STYLE,
    custom: (zcfCustomRoles || []).map((r) => ({ id: r.id, label: r.label, prompt: r.prompt })),
  })

  const handleSaveRoles = async () => {
    setSavingRoles(true)
    setRolesMessage(null)
    try {
      const sanitizedCustom = (customRoles || [])
        .map((role) => ({
          id: role.id,
          label: String(role.label || '').trim(),
          prompt: String(role.prompt || '').trim(),
        }))
        .filter((role) => role.label && role.prompt)
      if (isCustomStyleId(selectedStyleId) && !sanitizedCustom.some((role) => role.id === selectedStyleId)) {
        setRolesMessage({ ok: false, text: '请先填写当前选中的自定义风格名称与提示词' })
        setSavingRoles(false)
        return
      }
      const availableIds = new Set([
        ...listSelectableStyles([]).map((r) => r.id),
        ...sanitizedCustom.map((r) => r.id),
      ])
      const activeStyle = availableIds.has(selectedStyleId) ? selectedStyleId : DEFAULT_STYLE
      await saveStyleSettings({
        zcfDefaultRole: activeStyle,
        zcfEnabledRoles: [activeStyle],
        zcfCustomRoles: sanitizedCustom,
      })
      // 保存成功后本地草稿与已保存内容对齐（trim、丢弃空条目），沿用旧行为：
      // 保存前后端回传会顺带刷新面板；现在只有「内容变化」才刷新，所以这里显式对齐一次，
      // 避免保存成功但草稿残留空白时「保存配置」按钮仍然亮着。
      setCustomRoles(sanitizedCustom)
      setSelectedStyleId(activeStyle)
      setRolesMessage({ ok: true, text: '风格设置已保存' })
    } catch (e) {
      setRolesMessage({ ok: false, text: e.message || '保存失败' })
    } finally {
      setSavingRoles(false)
    }
  }

  const selectedStyleLabel = [...selectableStyles]
    .find((role) => role.id === selectedStyleId)?.label || '默认'

  return (
    <div className="settings-group">
      <SettingRow
        title="风格"
        description="内置与自定义风格都是应用内的提示词；风格互斥，新会话默认使用当前选中的风格"
        message={rolesMessage}
        fallback={`当前默认：${selectedStyleLabel}`}
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
            <div className="settings-card-subtitle">风格互斥，只能选择一个；自定义风格可编辑提示词</div>
          </div>
          <div className="settings-style-option-grid">
            {selectableStyles.map((role) => (
              isEditableStyleRole(role) ? (
                <EditableStyleOptionCard
                  key={role.id}
                  selected={selectedStyleId === role.id}
                  roleId={role.id}
                  title={role.label}
                  description={getStyleOptionDescription(role, role.kind)}
                  badge={role.badge}
                  kind={role.kind}
                  onSelect={() => selectStyle(role.id)}
                  onEdit={openCustomEditor}
                />
              ) : (
                <StyleOptionCard
                  key={role.id}
                  selected={selectedStyleId === role.id}
                  title={role.label}
                  description={getStyleOptionDescription(role, role.kind)}
                  badge={role.badge}
                  kind={role.kind}
                  onSelect={() => selectStyle(role.id)}
                />
              )
            ))}
            <StyleAddCard onSelect={addCustomRole} />
          </div>
        </div>
      </SettingRow>

      {customEditor && (
        <CustomStyleDialog
          draft={customEditor.draft}
          canDelete={customEditor.isNew !== true}
          onSave={saveCustomEditor}
          onDelete={deleteCustomStyle}
          onClose={closeCustomEditor}
        />
      )}
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
