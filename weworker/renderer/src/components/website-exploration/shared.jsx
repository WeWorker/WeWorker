import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as api from '../../api/website-exploration-api.js'
import { useWebsiteExplorationStore as useStore } from '../../store/website-exploration.js'

export function RequiredMark() {
  return <span className="wx-required" aria-hidden="true" title="必填"> *</span>
}

export function Icon({ name }) {
  const paths = { plus: 'M12 5v14M5 12h14', chevron: 'm9 5 7 7-7 7', tool: 'm8 5-6 7 6 7m8-14 6 7-6 7', panel: 'M9 3v18M3 3h18v18H3z', more: 'M5 12h.01M12 12h.01M19 12h.01' }
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}

export function ActionMenu({ label, children, compact = false }) {
  const [position, setPosition] = useState(null)
  const trigger = useRef(null)
  const popup = useRef(null)
  const id = useId()
  useEffect(() => {
    if (!position) return
    popup.current?.querySelector('button:not(:disabled)')?.focus()
    const close = event => {
      if (!popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPosition(null)
    }
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); setPosition(null); trigger.current?.focus() }
    }
    const resize = () => setPosition(null)
    document.addEventListener('pointerdown', close)
    document.addEventListener('focusin', close)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('focusin', close); document.removeEventListener('keydown', key); window.removeEventListener('resize', resize) }
  }, [position])
  return <span className={'wx-menu-trigger ' + (compact ? 'wx-row-menu' : '')}>
    <button ref={trigger} className={compact ? 'wx-icon-button' : 'wx-quiet'} aria-label={label} title={label} aria-expanded={Boolean(position)} aria-controls={position ? id : undefined} onClick={() => {
      const rect = trigger.current.getBoundingClientRect()
      setPosition(position ? null : { left: Math.max(8, Math.min(rect.right - 210, window.innerWidth - 218)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 220)) })
    }}>{compact ? <Icon name="more" /> : <>{label}<span className="wx-menu-chevron"><Icon name="chevron" /></span></>}</button>
    {position && createPortal(<div className="website-exploration wx-action-menu" id={id} ref={popup} style={position} role="group" aria-label={label} onClick={event => { if (event.target.closest('button:not(:disabled)')) { setPosition(null); trigger.current?.focus() } }}>{children}</div>, document.body)}
  </span>
}

export function useSnapshot(load, dependencies, eventPath) {
  const [snapshot, setSnapshot] = useState({ data: null, error: '', loading: true })
  const refreshRef = useRef(() => {})
  useEffect(() => {
    let alive = true
    let pending = false
    let again = false
    let retry = 0
    let terminal = false
    let connected = false
    let timer
    const controller = new AbortController()
    const refresh = async () => {
      if (pending) { again = true; return }
      pending = true
      try {
        const data = await load()
        if (alive) setSnapshot({ data, error: '', loading: false })
      } catch (error) {
        if (alive) setSnapshot(s => ({ ...s, error: error.message, loading: false }))
      } finally {
        pending = false
        if (again && alive) { again = false; void refresh() }
      }
    }
    refreshRef.current = () => {
      if (eventPath && terminal && !connected) { terminal = false; void connect() }
      return refresh()
    }
    setSnapshot({ data: null, error: '', loading: true })
    void refresh()
    const connect = async () => {
      if (connected || !alive) return
      connected = true
      try {
        await api.watchEvents(eventPath, (event) => {
          if (/_(succeeded|failed|cancelled)$/.test(event)) terminal = true
          void refresh()
        }, controller.signal, () => { retry = 0; void refresh() })
      } catch { /* The snapshot request supplies the actionable connection error. */ }
      connected = false
      if (alive && !terminal) timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++))
    }
    if (eventPath) void connect()
    const poll = setInterval(refresh, 5000)
    return () => { alive = false; controller.abort(); clearTimeout(timer); clearInterval(poll) }
  }, [...dependencies, eventPath])
  return { ...snapshot, refresh: () => refreshRef.current() }
}

export function useAction(refresh) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const run = async (action) => {
    if (pending.current) return false
    pending.current = true; setBusy(true); setError('')
    try { await action(); await refresh?.(); return true }
    catch (e) { setError(e.message); await refresh?.(); return false }
    finally { pending.current = false; setBusy(false) }
  }
  return { busy, error, run, setError }
}

export function Modal({ title, children, onClose }) {
  const id = useId()
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    const panel = ref.current
    panel?.querySelector('input, textarea, button')?.focus()
    const trap = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
      if (event.key !== 'Tab') return
      const elements = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      if (!elements.length) return
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1).focus() }
      if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus() }
    }
    panel.addEventListener('keydown', trap)
    return () => { panel.removeEventListener('keydown', trap); previous?.focus?.() }
  }, [])
  return createPortal(<div className="website-exploration wx-overlay"><section className="wx-modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
    <header><h2 id={id}>{title}</h2><button data-app-button="action" type="button" onClick={onClose} aria-label="关闭">关闭</button></header>{children}
  </section></div>, document.body)
}

export function ErrorMessage({ children }) {
  return children ? <p className="wx-error" role="alert">{children}</p> : null
}
const labels = { queued: '排队中', running: '运行中', pending: '等待中', starting: '启动中', succeeded: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停', pause_requested: '正在暂停', cancel_requested: '正在取消', waiting_for_user: '等待补充', stopped: '已停止' }
export function Status({ value }) { return <span className={'wx-status wx-status-' + value}>{labels[value] || value || '暂无运行'}</span> }
export function JsonView({ value }) { return <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre> }
export function useDraft(key, initial = '') {
  const value = useStore(s => s.drafts[key] ?? initial)
  return [value, next => useStore.getState().setDraft(key, next)]
}
export function ResourceImage({ path, alt = '执行后页面' }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    let objectUrl
    setUrl(''); setError('')
    api.resourceBlob(path, controller.signal).then(blob => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path])
  if (!path) return null
  return <><ErrorMessage>{error}</ErrorMessage>{url && <button className="wx-image" onClick={() => setZoom(true)}><img src={url} alt={alt} loading="lazy" /></button>}{zoom && <Modal title={alt} onClose={() => setZoom(false)}><img className="wx-full-image" src={url} alt={alt} /></Modal>}</>
}

export function ScrollArea({ name, revision, children }) {
  const ref = useRef(null)
  const atBottom = useRef(true)
  const [newContent, setNewContent] = useState(false)
  const previousRevision = useRef(revision)
  useEffect(() => {
    const node = ref.current
    node.scrollTop = useStore.getState().scrolls[name] || 0
    atBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 60
  }, [name])
  useEffect(() => {
    if (previousRevision.current === revision) return
    previousRevision.current = revision
    if (atBottom.current) ref.current.scrollTop = ref.current.scrollHeight
    else setNewContent(true)
  }, [revision])
  return <div className="wx-scroll" ref={ref} onScroll={e => {
    const node = e.currentTarget
    atBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop < 60
    useStore.setState(s => ({ scrolls: { ...s.scrolls, [name]: node.scrollTop } }))
    if (atBottom.current) setNewContent(false)
  }}>{children}{newContent && <button className="wx-new" onClick={() => { ref.current.scrollTop = ref.current.scrollHeight; setNewContent(false) }}>查看最新内容</button>}</div>
}
