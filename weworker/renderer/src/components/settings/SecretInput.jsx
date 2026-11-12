import React, { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { backendFetch } from '../../api/http.js'
import './settings-secret-input.css'

export default function SecretInput({ value, onChange, onBlur, placeholder, ariaLabel = 'API Key', provider, target = 'weworker', hasSavedKey = false }) {
  const [visible, setVisible] = useState(false)
  const [revealed, setRevealed] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(null)
  const errorId = useId()
  useEffect(() => {
    request.current?.abort()
    setVisible(false)
    setRevealed('')
    setLoading(false)
    setError('')
    return () => request.current?.abort()
  }, [provider, target])

  const toggle = async () => {
    if (visible) { setVisible(false); setRevealed(''); return }
    setError('')
    if (value || !hasSavedKey) { setVisible(true); return }
    if (request.current && !request.current.signal.aborted) return
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    try {
      const response = await backendFetch('/settings/provider/reveal-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, target }), signal: controller.signal,
      })
      const data = await response.json()
      if (!response.ok || typeof data.api_key !== 'string' || !data.api_key) throw new Error('无法读取已保存的 API Key，请重试')
      if (!controller.signal.aborted) { setRevealed(data.api_key); setVisible(true) }
    } catch {
      if (!controller.signal.aborted) setError('无法读取已保存的 API Key，请重试')
    } finally {
      if (!controller.signal.aborted) { setLoading(false); request.current = null }
    }
  }

  return <div className="settings-secret-field">
    <div className="settings-secret-input">
      <input type={visible ? 'text' : 'password'} className="settings-input" value={value || (visible ? revealed : '')}
        onChange={event => {
          request.current?.abort()
          request.current = null
          setLoading(false)
          setRevealed('')
          setError('')
          onChange(event)
        }} onBlur={onBlur} placeholder={placeholder} aria-label={ariaLabel}
        aria-describedby={error ? errorId : undefined} autoComplete="off" spellCheck={false} />
      <button type="button" className="settings-secret-toggle" disabled={loading}
        aria-label={visible ? `隐藏 ${ariaLabel}` : `显示 ${ariaLabel}`} title={visible ? '隐藏' : '显示明文'}
        aria-pressed={visible} onClick={() => { void toggle() }}>
        {loading ? <LoaderCircle size={16} className="settings-secret-toggle__spin" /> : visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
    {error && <span id={errorId} className="settings-secret-error" role="alert">{error}</span>}
  </div>
}
