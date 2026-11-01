import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function PresetKeyDialog({ providerName, onSave, onClose }) {
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const panelRef = useRef(null)
  const inputRef = useRef(null)
  const titleId = useId()
  const inputId = useId()

  useEffect(() => {
    const previous = document.activeElement
    inputRef.current?.focus()
    return () => previous?.isConnected && previous.focus()
  }, [])

  const submit = async event => {
    event.preventDefault()
    if (savingRef.current) return
    if (!apiKey.trim()) {
      setError('请填写 API Key')
      inputRef.current?.focus()
      return
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      await onSave(apiKey.trim())
      setApiKey('')
      onClose()
    } catch (failure) {
      setError(failure.message || '保存或切换失败，请重试')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return createPortal(
    <div className="weworker-dialog-overlay" onMouseDown={event => {
      if (event.target === event.currentTarget && !savingRef.current) onClose()
    }}>
      <section ref={panelRef} className="weworker-dialog preset-key-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (!savingRef.current) onClose()
          }
          if (event.key === 'Tab') {
            const items = [...panelRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')]
            const first = items[0]
            const last = items[items.length - 1]
            if (!first) { event.preventDefault(); return }
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
          }
        }}>
        <h2 id={titleId}>配置 {providerName}</h2>
        <p>填写 API Key 后保存到模型配置并切换使用。</p>
        <form onSubmit={submit} aria-busy={saving}>
          <label htmlFor={inputId}>API Key</label>
          <input ref={inputRef} id={inputId} type="password" autoComplete="off" spellCheck={false}
            value={apiKey} disabled={saving} placeholder="请输入 API Key"
            onChange={event => { setApiKey(event.target.value); setError('') }} />
          {error && <div className="preset-key-dialog__error" role="alert">{error}</div>}
          <footer>
            <button data-app-button="action" type="button" className="weworker-dialog__button" disabled={saving} onClick={onClose}>取消</button>
            <button data-app-button="action" type="submit" className="weworker-dialog__button is-primary" disabled={saving || !apiKey.trim()}>
              {saving ? '保存并切换中…' : '保存并使用'}
            </button>
          </footer>
        </form>
      </section>
    </div>, document.body,
  )
}
