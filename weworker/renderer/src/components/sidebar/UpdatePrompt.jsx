import React, { useEffect, useMemo, useState } from 'react'
import Tooltip from '../Tooltip.jsx'

const INITIAL_STATE = {
  status: 'idle',
  currentVersion: '',
  latestVersion: '',
  releaseName: '',
  releaseNotes: '',
  progress: null,
  error: '',
  checkedAt: '',
}

function percent(progress) {
  const value = Number(progress?.percent || 0)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function normalizeReleaseNotes(notes) {
  if (Array.isArray(notes)) {
    return notes.map((item) => item?.note || item).filter(Boolean).join('\n')
  }
  return String(notes || '').trim()
}

function getButtonLabel(state) {
  if (state.status === 'checking') return '检查中'
  if (state.status === 'downloading') return `${Math.round(percent(state.progress))}%`
  if (state.status === 'downloaded') return '重启'
  return '更新'
}

function getTitle(state) {
  switch (state.status) {
    case 'checking':
      return '正在检查更新'
    case 'available':
      return `发现新版本${state.latestVersion ? ` v${state.latestVersion}` : ''}`
    case 'downloading':
      return '正在下载更新'
    case 'downloaded':
      return '更新已下载'
    case 'not-available':
      return '当前已是最新版本'
    case 'error':
      return '更新检查失败'
    case 'unsupported':
      return '当前环境不支持在线更新'
    default:
      return '检查 WeWorker 更新'
  }
}

export default function UpdatePrompt() {
  const [state, setState] = useState(INITIAL_STATE)
  const [open, setOpen] = useState(false)
  const [acting, setActing] = useState('')

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getUpdateState?.().then((next) => {
      if (!cancelled && next) setState((prev) => ({ ...prev, ...next }))
    })
    const unsubscribe = window.electronAPI?.onUpdateState?.((next) => {
      if (next) setState((prev) => ({ ...prev, ...next }))
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  const releaseNotes = useMemo(() => normalizeReleaseNotes(state.releaseNotes), [state.releaseNotes])
  const progress = percent(state.progress)
  const total = formatBytes(state.progress?.total)
  const transferred = formatBytes(state.progress?.transferred)
  const busy = state.status === 'checking' || state.status === 'downloading' || Boolean(acting)
  const primaryDisabled = Boolean(acting) || state.status === 'checking' || state.status === 'downloading'
  const visible = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded'

  const run = async (action, fn) => {
    setActing(action)
    try {
      const next = await fn?.()
      if (next) setState((prev) => ({ ...prev, ...next }))
    } finally {
      setActing('')
    }
  }

  const handleOpen = () => {
    setOpen(true)
    if (state.status === 'idle') {
      run('check', () => window.electronAPI?.checkForUpdates?.())
    }
  }

  const primaryAction = (() => {
    if (state.status === 'available') {
      return { label: acting === 'download' ? '准备下载...' : '下载更新', onClick: () => run('download', () => window.electronAPI?.downloadUpdate?.()) }
    }
    if (state.status === 'downloaded') {
      return { label: '重启安装', onClick: () => run('install', () => window.electronAPI?.installUpdate?.()) }
    }
    if (state.status === 'idle' || state.status === 'not-available' || state.status === 'error') {
      return { label: acting === 'check' ? '检查中...' : '检查更新', onClick: () => run('check', () => window.electronAPI?.checkForUpdates?.()) }
    }
    return null
  })()

  if (!visible) return null

  return (
    <>
      <Tooltip text={getTitle(state)}>
        <button
          type="button"
          onClick={handleOpen}
          className="weworker-update-pill"
          style={updateButtonStyle}
          aria-label="检查更新"
        >
          {getButtonLabel(state)}
        </button>
      </Tooltip>

      {open && (
        <div style={overlayStyle} onMouseDown={() => setOpen(false)}>
          <div style={modalStyle} onMouseDown={(event) => event.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <div>
                <div style={modalTitleStyle}>{getTitle(state)}</div>
                <div style={modalSubtitleStyle}>
                  当前版本 v{state.currentVersion || '未知'}
                  {state.latestVersion ? ` · 最新版本 v${state.latestVersion}` : ''}
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} style={closeButtonStyle} aria-label="关闭">
                ×
              </button>
            </div>

            {state.status === 'downloading' && (
              <div style={{ marginTop: 16 }}>
                <div style={progressTrackStyle}>
                  <div style={{ ...progressBarStyle, width: `${progress}%` }} />
                </div>
                <div style={hintStyle}>
                  {Math.round(progress)}%
                  {transferred && total ? ` · ${transferred} / ${total}` : ''}
                </div>
              </div>
            )}

            {state.status === 'available' && (
              <div style={messageStyle}>下载完成后，WeWorker 会提示你重启并安装新版本。</div>
            )}

            {state.status === 'downloaded' && (
              <div style={messageStyle}>更新包已准备好，重启后会自动完成安装。</div>
            )}

            {state.status === 'unsupported' && (
              <div style={messageStyle}>在线更新仅在打包后的 Windows 客户端中启用。</div>
            )}

            {state.status === 'error' && (
              <div style={{ ...messageStyle, color: 'var(--error)' }}>
                {state.error || '请稍后重试，或检查更新源是否可访问。'}
              </div>
            )}

            {releaseNotes && (
              <pre style={releaseNotesStyle}>{releaseNotes}</pre>
            )}

            <div style={actionsStyle}>
              <button data-app-button="action" type="button" onClick={() => setOpen(false)} style={secondaryButtonStyle}>稍后</button>
              {primaryAction && (
                <button data-app-button="action"
                  type="button"
                  onClick={primaryAction.onClick}
                  disabled={primaryDisabled}
                  style={{
                    ...primaryButtonStyle,
                    opacity: primaryDisabled ? 0.65 : 1,
                    cursor: primaryDisabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {primaryAction.label}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const updateButtonStyle = {
  border: 'none',
  borderRadius: 7,
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11,
  fontWeight: 700,
  lineHeight: '22px',
  minWidth: 40,
  height: 24,
  padding: '0 8px',
  boxShadow: 'none',
  WebkitAppRegion: 'no-drag',
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 1200,
  background: 'rgba(0, 0, 0, 0.28)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  WebkitAppRegion: 'no-drag',
}

const modalStyle = {
  width: 380,
  maxWidth: 'calc(100vw - 36px)',
  background: 'var(--bg-primary, #fff)',
  border: '1px solid var(--border, #e8e8e8)',
  borderRadius: 14,
  boxShadow: 'none',
  padding: 18,
  color: 'var(--text-primary)',
}

const modalHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
}

const modalTitleStyle = {
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1.35,
}

const modalSubtitleStyle = {
  marginTop: 4,
  fontSize: 12,
  color: 'var(--text-muted)',
}

const closeButtonStyle = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: 20,
  lineHeight: 1,
  padding: '0 4px',
}

const progressTrackStyle = {
  height: 8,
  borderRadius: 999,
  background: 'var(--bg-secondary, #f1f5f9)',
  overflow: 'hidden',
}

const progressBarStyle = {
  height: '100%',
  borderRadius: 999,
  background: 'var(--accent)',
  transition: 'width 160ms ease',
}

const hintStyle = {
  marginTop: 8,
  fontSize: 12,
  color: 'var(--text-muted)',
}

const messageStyle = {
  marginTop: 16,
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--text-secondary)',
}

const releaseNotesStyle = {
  margin: '14px 0 0',
  maxHeight: 140,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  background: 'var(--bg-secondary, #f7f8fa)',
  border: '1px solid var(--border, #e8e8e8)',
  borderRadius: 10,
  padding: 10,
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 1.55,
  color: 'var(--text-secondary)',
}

const actionsStyle = {
  marginTop: 18,
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
}

const secondaryButtonStyle = {
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  padding: '7px 12px',
  borderRadius: 8,
}

const primaryButtonStyle = {
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 700,
  padding: '7px 14px',
  borderRadius: 8,
}
