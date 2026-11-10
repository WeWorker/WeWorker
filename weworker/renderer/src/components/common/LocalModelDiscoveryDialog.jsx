import React, { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Download, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useSettingsStore } from '../../store/settings.js'
import './local-model-discovery.css'

const protocolNames = {
  anthropic_messages: 'Anthropic',
  openai_responses: 'OpenAI Responses',
  openai_chat_completions: 'OpenAI Chat Completions',
}

export default function LocalModelDiscoveryDialog({ onClose, onImported }) {
  const detect = useSettingsStore(state => state.detectProviders)
  const importProvider = useSettingsStore(state => state.importLocalProvider)
  const revealProviderKey = useSettingsStore(state => state.revealProviderKey)
  const providers = useSettingsStore(state => state.providers)
  const [candidates, setCandidates] = useState([])
  const [revealedKeys, setRevealedKeys] = useState({})
  const [revealing, setRevealing] = useState('')
  const [issues, setIssues] = useState([])
  const [scanning, setScanning] = useState(true)
  const [importing, setImporting] = useState('')
  const [error, setError] = useState('')
  const titleId = useId()
  const panelRef = useRef(null)
  const scanRef = useRef(null)
  const importingRef = useRef(false)
  const mountedRef = useRef(false)

  const scan = async () => {
    if (importingRef.current) return
    scanRef.current?.abort()
    const controller = new AbortController()
    scanRef.current = controller
    setScanning(true)
    setError('')
    setCandidates([])
    setIssues([])
    try {
      const data = await detect(controller.signal)
      if (controller.signal.aborted) return
      setCandidates(data.candidates || [])
      setIssues(data.issues || [])
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || '识别失败，请重试')
    } finally {
      if (!controller.signal.aborted) setScanning(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    const previous = document.activeElement
    panelRef.current?.focus()
    void scan()
    return () => {
      mountedRef.current = false
      scanRef.current?.abort()
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  // 列表里始终打码；只有用户点「显示」时才向本机后端取一次明文。
  const toggleKey = async candidate => {
    if (revealedKeys[candidate.source_id]) {
      setRevealedKeys(current => {
        const next = { ...current }
        delete next[candidate.source_id]
        return next
      })
      return
    }
    setRevealing(candidate.source_id)
    try {
      const key = await revealProviderKey(candidate.source_id)
      if (mountedRef.current) setRevealedKeys(current => ({ ...current, [candidate.source_id]: key }))
    } catch (failure) {
      if (mountedRef.current) setError(failure.message || '读取 API Key 失败')
    } finally {
      if (mountedRef.current) setRevealing('')
    }
  }

  const importCandidate = async candidate => {    if (importingRef.current) return
    importingRef.current = true
    setImporting(candidate.source_id)
    setError('')
    try {
      const id = await importProvider(candidate.source_id)
      if (!mountedRef.current) return
      setCandidates(current => current.map(item => item.source_id === candidate.source_id
        ? { ...item, imported: true, configuration_id: id } : item))
      onImported?.(id)
    } catch (failure) {
      if (mountedRef.current) setError(failure.message || '导入失败，请重试')
    } finally {
      importingRef.current = false
      if (mountedRef.current) setImporting('')
    }
  }

  return createPortal(
    <div className="weworker-dialog-overlay" onMouseDown={event => {
      if (event.target === event.currentTarget && !importingRef.current) onClose()
    }}>
      <section ref={panelRef} className="weworker-dialog local-model-discovery" role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1} onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (!importingRef.current) onClose()
          }
          if (event.key !== 'Tab') return
          const items = [...panelRef.current.querySelectorAll('button:not(:disabled)')]
          const first = items[0]
          const last = items.at(-1)
          if (!first) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus()
          }
        }}>
        <header className="local-model-discovery__header">
          <h2 id={titleId}>识别本地模型</h2>
          <button type="button" className="local-model-discovery__icon" aria-label="重新识别" title="重新识别"
            disabled={scanning || Boolean(importing)} onClick={() => { void scan() }}><RefreshCw size={17} /></button>
          <button type="button" className="local-model-discovery__icon" aria-label="关闭" title="关闭"
            disabled={Boolean(importing)} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="local-model-discovery__results" aria-busy={scanning || Boolean(importing)}>
          {scanning ? <div className="local-model-discovery__status" role="status"><LoaderCircle className="local-model-discovery__spin" size={18} />正在识别…</div>
            : candidates.length ? <ul className="local-model-discovery__list" aria-label="本地模型配置">
              {candidates.map(candidate => {
                const imported = candidate.imported || Object.values(providers).some(provider => provider.external_source_id === candidate.source_id)
                const busy = importing === candidate.source_id
                const validation = candidate.validation || { ok: true, detail: '' }
                const revealed = revealedKeys[candidate.source_id]
                return <li key={candidate.source_id}>
                  <div className="local-model-discovery__row">
                    <button type="button" className="local-model-discovery__candidate" disabled={imported || !validation.ok || Boolean(importing)}
                      aria-label={`${imported ? '已导入' : validation.ok ? '导入' : '不可导入'} ${candidate.name}${candidate.model ? ` ${candidate.model}` : ''}`}
                      onClick={() => { void importCandidate(candidate) }}>
                      <span className="local-model-discovery__details">
                        <span className="local-model-discovery__name">{candidate.name}<span>{candidate.model || '未指定模型'}</span></span>
                        <span className="local-model-discovery__endpoint">{protocolNames[candidate.weworker_protocol] || candidate.weworker_protocol} · {candidate.base_url}</span>
                        <span className="local-model-discovery__key">
                          API Key：<code>{revealed || `••••••••${candidate.api_key_hint || ''}`}</code>
                        </span>
                        {!validation.ok && <span className="local-model-discovery__invalid">不可用：{validation.detail || '校验未通过'}</span>}
                      </span>
                      <span className={`local-model-discovery__import${imported ? ' is-imported' : ''}`}>
                        {busy ? <LoaderCircle className="local-model-discovery__spin" size={16} /> : imported ? <Check size={16} /> : <Download size={16} />}
                        {busy ? '导入中' : imported ? '已导入' : validation.ok ? '导入' : '不可导入'}
                      </span>
                    </button>
                    <button type="button" className="local-model-discovery__eye" disabled={Boolean(importing) || revealing === candidate.source_id}
                      aria-label={revealed ? '隐藏 API Key' : '显示 API Key'} title={revealed ? '隐藏' : '显示明文'}
                      onClick={() => { void toggleKey(candidate) }}>
                      {revealing === candidate.source_id ? <LoaderCircle className="local-model-discovery__spin" size={14} /> : revealed ? '隐藏' : '显示'}
                    </button>
                  </div>
                </li>
              })}
            </ul> : !error && <div className="local-model-discovery__status" role="status">未找到可导入的模型配置</div>}
        </div>
        {issues.length > 0 && <p className="local-model-discovery__notice" role="status">部分配置无法读取：{issues.join('、')}</p>}
        {error && <p className="local-model-discovery__error" role="alert">{error}</p>}
      </section>
    </div>, document.body,
  )
}
