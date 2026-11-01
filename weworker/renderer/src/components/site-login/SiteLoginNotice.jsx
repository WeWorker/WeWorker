import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useChatInputFillStore } from '../../store/chat-input-fill.js'
import { describeLoginEvent, LOGIN_ACTION_LABELS, loginContinueText } from '../../utils/site-login.js'
import AutoLoginDialog from './AutoLoginDialog.jsx'

const TONES = {
  ok: ['rgba(34,197,94,0.12)', 'rgba(34,197,94,0.35)'],
  warn: ['rgba(245,158,11,0.12)', 'rgba(245,158,11,0.4)'],
  error: ['rgba(248,113,113,0.12)', 'rgba(248,113,113,0.4)'],
  pending: ['var(--bg-secondary)', 'var(--border)'],
  muted: ['var(--bg-secondary)', 'var(--border)'],
}

const buttonStyle = {
  background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit',
}

function loginImageUrl(screenshot, version = 0) {
  if (typeof screenshot !== 'string' || !screenshot) return null
  return `weworker-login-image://login?path=${encodeURIComponent(screenshot)}&v=${encodeURIComponent(String(version))}`
}

function noticeKey(site, contextId) {
  return `${contextId || 'default'}:${site || ''}`
}

/** Login progress from WeWorker's login flow, one card per website and browser profile. */
export default function SiteLoginNotice() {
  const [notices, setNotices] = useState([])
  const [dialog, setDialog] = useState(null)
  const [showing, setShowing] = useState('')
  const timers = useRef(new Map())
  const requestFill = useChatInputFillStore((state) => state.requestFill)

  const dismiss = useCallback((key) => {
    clearTimeout(timers.current.get(key))
    timers.current.delete(key)
    setNotices((current) => current.filter((entry) => entry.key !== key))
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onSiteAuthEvent) return undefined
    const unsubscribe = api.onSiteAuthEvent((event) => {
      const view = describeLoginEvent(event)
      if (!view) return
      const key = noticeKey(event.site, event.contextId)
      setNotices((current) => [{ key, site: event.site, name: event.name, event, view }, ...current.filter((entry) => entry.key !== key)].slice(0, 3))
      clearTimeout(timers.current.get(key))
      if (view.autoDismissMs > 0) timers.current.set(key, setTimeout(() => dismiss(key), view.autoDismissMs))
    })
    const pending = timers.current
    return () => {
      unsubscribe?.()
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [dismiss])

  const control = (action, payload) => window.electronAPI.siteAuthControl(action, payload).catch(() => null)
  const run = async (notice, action) => {
    const { site, name, event } = notice
    const scoped = { site, ...(event.contextId ? { contextId: event.contextId } : {}) }
    if (action === 'show') {
      setShowing(notice.key)
      try { await control('show_login', scoped) } finally { setShowing((current) => current === notice.key ? '' : current) }
    }
    if (action === 'cancel') { void control('cancel', scoped); dismiss(notice.key) }
    if ((action === 'update_password' || action === 'enable_autologin') && event.autologinMode !== 'off') {
      setDialog({ site, name, contextId: event.contextId, autologinMode: event.autologinMode })
    }
    if (action === 'disable_autologin') { void control('set_autologin', { ...scoped, enabled: false }); dismiss(notice.key) }
    if (action === 'dismiss_autologin') { void control('set_autologin', { ...scoped, enabled: false, dismissed: true }); dismiss(notice.key) }
    if (action === 'continue') { requestFill(loginContinueText(name)); dismiss(notice.key) }
  }

  if (!notices.length && !dialog) return null
  return (
    <>
      <div aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1500, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(360px, calc(100vw - 32px))' }}>
        {notices.map((notice) => {
          const [background, border] = TONES[notice.view.tone] || TONES.pending
          const loginImage = notice.event.qr?.image || notice.event.screenshot
          const loginImageVersion = notice.event.qr?.image ? notice.event.qr.imageVersion : notice.event.screenshotVersion
          const loginImageAlt = notice.event.qr?.image
            ? `${notice.name || notice.site} 登录二维码`
            : `${notice.name || notice.site} 登录页`
          return (
            <div key={notice.key} role="status" style={{ background: 'var(--bg-primary)', backgroundImage: `linear-gradient(${background}, ${background})`, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 12px', boxShadow: '0 6px 24px rgba(0,0,0,0.12)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{notice.view.title}</div>
                  {notice.view.text && <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 4 }}>{notice.view.text}</div>}
                </div>
                <button type="button" aria-label="关闭提示" onClick={() => dismiss(notice.key)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, padding: 2 }}>×</button>
              </div>
              {loginImage && (
                <img
                  src={loginImageUrl(loginImage, loginImageVersion)}
                  alt={loginImageAlt}
                  style={{ display: 'block', width: '100%', maxHeight: 280, objectFit: 'contain', marginTop: 10, borderRadius: 6, background: 'white' }}
                />
              )}
              {notice.view.actions.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {notice.view.actions.map((action) => {
                    const opening = action === 'show' && showing === notice.key
                    return (
                      <button data-app-button="action" key={action} type="button" style={buttonStyle} disabled={opening}
                        onClick={() => { void run(notice, action) }}>
                        {opening ? '正在打开…' : LOGIN_ACTION_LABELS[action]}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {dialog && (
        <AutoLoginDialog
          site={dialog.site}
          name={dialog.name}
          autologinMode={dialog.autologinMode}
          contextId={dialog.contextId}
          onClose={() => setDialog(null)}
          onSaved={() => dismiss(noticeKey(dialog.site, dialog.contextId))}
        />
      )}
    </>
  )
}
