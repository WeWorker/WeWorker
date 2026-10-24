import React, { useEffect, useRef, useState } from 'react'
import { EXTENSION_PATH, useExtensionSteps, StepList } from './ExtensionSteps.jsx'
import { useStatusStore } from '../store/status.js'
import { describeDedicatedBrowserStatus } from '../utils/dedicated-browser.js'

function BrowserIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>
}

/** Polls WeWorker 浏览器 status while the panel is open; null outside the desktop app. */
function useDedicatedBrowserStatus() {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.getDedicatedBrowserStatus) return undefined
    let cancelled = false
    const refresh = () => api.getDedicatedBrowserStatus().then((value) => { if (!cancelled) setStatus(value || null) }).catch(() => {})
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  return [status, setStatus]
}

function DedicatedBrowserCard({ status, onStatus }) {
  const [busy, setBusy] = useState(false)
  const view = describeDedicatedBrowserStatus(status)
  const run = async (action) => {
    setBusy(true)
    try {
      const next = await action()
      if (next) onStatus(next)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={`extension-guide-card extension-guide-card--${view.tone}`}>
      <div className="extension-guide-card-heading">
        <h3>WeWorker 浏览器</h3>
        <span className={`extension-guide-status extension-guide-status--${view.tone}`}>
          <span aria-hidden="true" />
          {view.tone === 'ok' ? '运行中' : view.tone === 'error' ? '启动失败' : view.tone === 'warn' ? '需要处理' : '未就绪'}
        </span>
      </div>
      <p className="extension-guide-status-text">{view.text}</p>
      <p className="extension-guide-description">
        网站操作在独立浏览器中后台进行，登录状态与你自己的 Chrome 分开保存。需要登录时显示浏览器，完成后隐藏即可。
      </p>
      <div className="extension-guide-actions">
        {view.canShow && (
          <button data-app-button="action" type="button" disabled={busy} className="extension-guide-button extension-guide-button--primary" onClick={() => run(() => window.electronAPI.showDedicatedBrowser())}>
            显示 WeWorker 浏览器
          </button>
        )}
        {view.canShow && (
          <button data-app-button="action" type="button" disabled={busy} className="extension-guide-button" onClick={() => run(() => window.electronAPI.hideDedicatedBrowser())}>
            隐藏
          </button>
        )}
        {view.canRestart && (
          <button data-app-button="action" type="button" disabled={busy} className="extension-guide-button" onClick={() => run(() => window.electronAPI.restartDedicatedBrowser())}>
            重新启动
          </button>
        )}
      </div>
    </section>
  )
}

export default function ExtensionGuide({ onClose }) {
  const [copied, setCopied] = useState(false)
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef(null)
  const steps = useExtensionSteps()
  const extension = useStatusStore((state) => state.extension)
  const extensionInstance = useStatusStore((state) => state.extensionInstance)
  const connected = extension === 'connected'
  const [browserStatus, setBrowserStatus] = useDedicatedBrowserStatus()
  const dedicatedMode = browserStatus?.mode === 'dedicated'
  // In WeWorker 浏览器 the extension is installed automatically; manual steps only help when it cannot start.
  const showInstallSteps = !connected && (!dedicatedMode || browserStatus?.status === 'unavailable')

  const requestClose = () => {
    if (closing) return
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => onClose?.(), 150)
  }

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    }
  }, [])

  const handleCopy = () => {
    navigator.clipboard.writeText(EXTENSION_PATH).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const connectedText = extensionInstance === 'dedicated'
    ? '扩展已连接（WeWorker 浏览器），可以使用浏览器自动化能力。'
    : dedicatedMode
      ? '扩展已连接（你自己的 Chrome）。WeWorker 浏览器就绪后会优先使用它。'
      : '扩展已连接，可以使用浏览器自动化能力。'

  return (
    <div
      className={`extension-guide-overlay ${closing ? 'extension-guide-overlay--closing' : ''}`}
      onClick={requestClose}
    >
      <div
        className={`extension-guide-panel ${closing ? 'extension-guide-panel--closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-guide-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="extension-guide-header">
          <span className="extension-guide-header-icon"><BrowserIcon /></span>
          <div className="extension-guide-heading">
            <h2 id="extension-guide-title">浏览器与扩展</h2>
            <p>管理网站操作使用的浏览器与连接状态</p>
          </div>
          <button type="button" className="extension-guide-close" aria-label="关闭浏览器与扩展" onClick={requestClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>

        <div className="extension-guide-body">
          {dedicatedMode && <DedicatedBrowserCard status={browserStatus} onStatus={setBrowserStatus} />}

          <section className="extension-guide-card">
            <div className="extension-guide-card-heading">
              <h3>浏览器扩展</h3>
              <span className={`extension-guide-status extension-guide-status--${connected ? 'ok' : 'warn'}`}>
                <span aria-hidden="true" />{connected ? '已连接' : '未连接'}
              </span>
            </div>
            <p className="extension-guide-description">
              {connected
                ? connectedText
                : dedicatedMode
                  ? 'WeWorker 浏览器启动后，扩展会自动安装并连接，无需手动操作。'
                  : '未检测到扩展。安装完成后打开 Chrome，可在此查看连接状态。'}
            </p>
            {!connected && !dedicatedMode && <div className="extension-guide-actions"><button data-app-button="action"
              type="button"
              onClick={() => window.electronAPI?.openChrome()}
              className="extension-guide-button"
            >
              打开 Chrome
            </button></div>}
          </section>

          {showInstallSteps && <div className="extension-guide-install">
            <p className="extension-guide-description">
              {dedicatedMode ? '也可以把扩展安装到你自己的 Chrome（需在设置中改用“我自己的 Chrome”）：' : '按以下步骤安装扩展：'}
            </p>
            <StepList steps={steps} onCopy={handleCopy} copied={copied} />
          </div>}
        </div>

        <footer className="extension-guide-footer">
          <button data-app-button="action" type="button" className="extension-guide-button extension-guide-button--primary" onClick={requestClose}>知道了</button>
        </footer>
      </div>
    </div>
  )
}
