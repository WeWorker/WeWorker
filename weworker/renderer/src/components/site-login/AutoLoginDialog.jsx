import React, { useEffect, useRef, useState } from 'react'
import { AUTOLOGIN_NOTICE_LINES, validateCredentialForm } from '../../utils/site-login.js'

/**
 * Turn on auto-login for one site. The password goes once to the Bridge,
 * which encrypts it with the system key; this component forgets it right away.
 */
export default function AutoLoginDialog({ site, name, onClose, onSaved }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const firstFieldRef = useRef(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
    const onKey = (event) => { if (event.key === 'Escape' && !saving) onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const save = async (event) => {
    event.preventDefault()
    const problem = validateCredentialForm({ username, password, acknowledged })
    if (problem) { setError(problem); return }
    setSaving(true)
    setError('')
    try {
      const result = await window.electronAPI.siteAuthControl('save_credential', { site, username, password })
      setPassword('')
      onSaved?.(result)
      onClose?.()
    } catch (err) {
      setError(err?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'inherit' }
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '12px 0 4px' }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose?.() }}
      style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="autologin-dialog-title"
        onSubmit={save}
        style={{ width: 'min(440px, calc(100vw - 32px))', background: 'var(--bg-primary)', border: '1px solid var(--border-strong, var(--border))', borderRadius: 10, padding: 20, boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}
      >
        <h2 id="autologin-dialog-title" style={{ margin: 0, fontSize: 15, color: 'var(--text-primary)' }}>为 {name || site} 开启自动登录</h2>
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          {AUTOLOGIN_NOTICE_LINES.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <label htmlFor="autologin-username" style={labelStyle}>账号（手机号、邮箱或用户名）</label>
        <input id="autologin-username" ref={firstFieldRef} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" spellCheck={false} style={inputStyle} />
        <label htmlFor="autologin-password" style={labelStyle}>密码</label>
        <input id="autologin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" style={inputStyle} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} style={{ marginTop: 2 }} />
          我已了解：密码加密保存在本机，WeWorker 会在需要时替我登录这个网站。
        </label>
        {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--error, #ef4444)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button data-app-button="action" type="button" className="settings-btn settings-btn-secondary" disabled={saving} onClick={() => onClose?.()}>取消</button>
          <button data-app-button="action" type="submit" className="settings-btn settings-btn-primary" disabled={saving}>{saving ? '正在保存…' : '保存并开启'}</button>
        </div>
      </form>
    </div>
  )
}
