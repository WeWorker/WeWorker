import React, { useCallback, useEffect, useState } from 'react'
import AppSwitch from '../common/AppSwitch.jsx'
import { showConfirm } from '../../store/dialog.js'
import { describeAutologin, describeLoginState } from '../../utils/site-login.js'
import AutoLoginDialog from './AutoLoginDialog.jsx'

const STATE_COLORS = { ok: 'var(--success, #22c55e)', warn: 'var(--warning, #f59e0b)', pending: 'var(--text-muted)', muted: 'var(--text-muted)' }

/** Settings → 网站登录: state per website, manual login, and auto-login preferences. */
export default function SiteLoginSettings() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [dialog, setDialog] = useState(null)
  const api = typeof window === 'undefined' ? null : window.electronAPI

  const refresh = useCallback(async (refreshChecks = false) => {
    if (!api?.siteAuthControl) return
    try {
      setStatus(await api.siteAuthControl('status', { refresh: refreshChecks }))
      setError('')
    } catch (err) {
      setError(err?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || '无法读取登录状态')
    }
  }, [api])

  useEffect(() => {
    void refresh(true)
    const unsubscribe = api?.onSiteAuthEvent?.(() => { void refresh(false) })
    return () => unsubscribe?.()
  }, [api, refresh])

  if (!api?.siteAuthControl) return null
  const act = async (key, work) => {
    setBusy(key)
    try { await work(); await refresh(false) } catch (err) {
      setError(err?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || '操作失败')
    } finally { setBusy('') }
  }
  const toggleAutologin = (entry, enabled) => {
    if (enabled && !entry.autologin?.configured) { setDialog({ site: entry.site, name: entry.name }); return }
    void act(entry.site, () => api.siteAuthControl('set_autologin', { site: entry.site, enabled }))
  }
  const forget = async (entry) => {
    if (!await showConfirm(`删除为 ${entry.name} 保存的账号密码？删除后需要时会改为手动登录。`, '删除保存的密码', { danger: true })) return
    void act(entry.site, () => api.siteAuthControl('forget_credential', { site: entry.site }))
  }

  const sites = status?.sites || []
  return (
    <div className="settings-group">
      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-text">
            <div className="settings-row-title">网站登录</div>
            <div className="settings-row-desc">
              网站操作遇到未登录时，WeWorker 会自动打开登录页并在你完成后继续任务，支持扫码、短信验证码和账号密码。
              {status && !status.autologinSupported && ' 当前系统暂不支持保存密码，自动登录不可用。'}
            </div>
          </div>
          <div className="settings-row-control">
            <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" disabled={!!busy} onClick={() => act('refresh', () => refresh(true))}>刷新状态</button>
          </div>
        </div>
        {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--error, #ef4444)' }}>{error}</div>}
      </div>
      {sites.map((entry) => {
        const state = describeLoginState(entry)
        const auto = entry.autologin || {}
        return (
          <div key={entry.site} className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-text">
                <div className="settings-row-title">
                  {entry.name}
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 500, color: STATE_COLORS[state.tone] }}>{state.text}</span>
                </div>
                <div className="settings-row-desc">{entry.site} · {describeAutologin(entry)}</div>
              </div>
              <div className="settings-row-control" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" disabled={busy === entry.site || !!entry.flow}
                  onClick={() => act(entry.site, () => api.siteAuthControl('login', { site: entry.site }))}>登录</button>
                {auto.supported && auto.configured && (
                  <button data-app-button="action" type="button" className="settings-btn settings-btn-ghost" disabled={busy === entry.site}
                    onClick={() => setDialog({ site: entry.site, name: entry.name })}>更新密码</button>
                )}
                {auto.supported && auto.configured && (
                  <button data-app-button="action" data-variant="danger" type="button" className="settings-btn settings-btn-ghost" disabled={busy === entry.site} onClick={() => forget(entry)}>删除密码</button>
                )}
                {auto.supported && (
                  <AppSwitch aria-label={`${entry.name} 自动登录`} checked={auto.enabled === true} disabled={busy === entry.site}
                    onChange={(event) => toggleAutologin(entry, event.target.checked)} />
                )}
              </div>
            </div>
          </div>
        )
      })}
      {dialog && (
        <AutoLoginDialog site={dialog.site} name={dialog.name} onClose={() => setDialog(null)} onSaved={() => { void refresh(false) }} />
      )}
    </div>
  )
}
