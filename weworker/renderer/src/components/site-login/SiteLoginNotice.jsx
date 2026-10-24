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

/** Login progress from WeWorker's login flow, one card per website. */
export default function SiteLoginNotice() {
  const [notices, setNotices] = useState([])
  const [dialog, setDialog] = useState(null)
  const timers = useRef(new Map())
  const requestFill = useChatInputFillStore((state) => state.requestFill)

  const dismiss = useCallback((site) => {
    clearTimeout(timers.current.get(site))
    timers.current.delete(site)
    setNotices((current) => current.filter((entry) => entry.site !== site))
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onSiteAuthEvent) return undefined
    const unsubscribe = api.onSiteAuthEvent((event) => {
      const view = describeLoginEvent(event)
      if (!view) return
      setNotices((current) => [{ site: event.site, name: event.name, event, view }, ...current.filter((entry) => entry.site !== event.site)].slice(0, 3))
      clearTimeout(timers.current.get(event.site))
      if (view.autoDismissMs > 0) timers.current.set(event.site, setTimeout(() => dismiss(event.site), view.autoDismissMs))
    })
    const pending = timers.current
    return () => {
      unsubscribe?.()
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [dismiss])

  const control = (action, payload) => window.electronAPI.siteAuthControl(action, payload).catch(() => null)
  const run = (notice, action) => {
    const { site, name } = notice
    if (action === 'show') void window.electronAPI.showDedicatedBrowser?.()
    if (action === 'cancel') { void control('cancel', { site }); dismiss(site) }
    if (action === 'update_password' || action === 'enable_autologin') setDialog({ site, name })
    if (action === 'disable_autologin') { void control('set_autologin', { site, enabled: false }); dismiss(site) }
    if (action === 'dismiss_autologin') { void control('set_autologin', { site, enabled: false, dismissed: true }); dismiss(site) }
    if (action === 'continue') { requestFill(loginContinueText(name)); dismiss(site) }
  }

  if (!notices.length && !dialog) return null
  return (
    <>
      <div aria-live="polite" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1500, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(360px, calc(100vw - 32px))' }}>
        {notices.map((notice) => {
          const [background, border] = TONES[notice.view.tone] || TONES.pending
          return (
            <div key={notice.site} role="status" style={{ background: 'var(--bg-primary)', backgroundImage: `linear-gradient(${background}, ${background})`, border: `1px solid ${border}`, borderRadius: 10, padding: '10px 12px', boxShadow: '0 6px 24px rgba(0,0,0,0.12)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{notice.view.title}</div>
                  {notice.view.text && <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', marginTop: 4 }}>{notice.view.text}</div>}
                </div>
                <button type="button" aria-label="关闭提示" onClick={() => dismiss(notice.site)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, padding: 2 }}>×</button>
              </div>
              {notice.view.actions.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {notice.view.actions.map((action) => (
                    <button data-app-button="action" key={action} type="button" style={buttonStyle} onClick={() => run(notice, action)}>{LOGIN_ACTION_LABELS[action]}</button>
                  ))}
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
          onClose={() => setDialog(null)}
          onSaved={() => dismiss(dialog.site)}
        />
      )}
    </>
  )
}
