import AppSwitch from '../common/AppSwitch.jsx'
import React, { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../store/settings.js'
import * as api from '../../api/website-exploration-api.js'
import { connectionMessage, explorationForm } from '../../utils/model-connection.js'
import './exploration-model-settings.css'

export default function ExplorationModelSettings() {
  const providers = useSettingsStore(s => s.providers)
  const activeProvider = useSettingsStore(s => s.activeProvider)
  const model = useSettingsStore(s => s.model)
  const revision = useSettingsStore(s => s.explorationModelRevision)
  const [form, setForm] = useState(null)
  const [stored, setStored] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [loadError, setLoadError] = useState('')
  const requestId = useRef(0)

  useEffect(() => {
    const id = ++requestId.current
    setResult(null)
    setLoadError('')
    setBusy(true)
    async function load() {
      try {
        const data = await api.getExplorationModel()
        if (id !== requestId.current) return
        setStored(data)
        setForm(explorationForm(data))
      } catch (error) {
        if (id !== requestId.current) return
        setLoadError(error.message)
        setOpen(true)
      } finally { if (id === requestId.current) setBusy(false) }
    }
    void load()
    return () => { ++requestId.current }
  }, [providers, activeProvider, model, revision])

  function edit(key, value) {
    ++requestId.current
    setForm(current => ({ ...current, [key]: value }))
    setResult(null)
    setLoadError('')
  }

  async function run(save) {
    const id = ++requestId.current
    setBusy(true)
    setResult(null)
    setLoadError('')
    try {
      const data = save ? await api.saveExplorationModel(form) : await api.checkExplorationModel(true)
      if (id !== requestId.current) return
      setResult(data)
      if (data.ok) {
        setStored(data)
        if (save) {
          setForm(explorationForm(data))
          setOpen(false)
          useSettingsStore.setState(state => ({ explorationModelRevision: state.explorationModelRevision + 1 }))
        }
      } else setOpen(true)
    } catch (error) {
      if (id !== requestId.current) return
      setLoadError(error.message)
      setOpen(true)
    } finally { if (id === requestId.current) setBusy(false) }
  }

  const status = busy ? '正在检测…' : loadError || (result && !result.ok) ? '连接待修复' : ['connected', 'independent'].includes(stored?.status) ? '已连接' : '待验证'
  return <section className="exploration-model-settings" aria-label="网站探索模型">
    <button type="button" className="exploration-model-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>网站探索模型</strong>
      <span className="exploration-model-toggle-meta">
        <span className={`exploration-model-status${status === '已连接' ? ' is-connected' : ''}`}>
          {status === '已连接' && <span className="exploration-model-status-dot" aria-hidden="true" />}
          {status}
        </span>
        <span>· {open ? '收起' : '配置'}</span>
      </span>
    </button>
    {open && <div className="exploration-model-body">
      <p>确认服务地址，验证后保存。不影响主任务使用。</p>
      {form && <form onSubmit={event => { event.preventDefault(); void run(true) }}>
        <fieldset disabled={busy}>
            <label>网站探索服务地址<input required type="url" value={form.base_url} onChange={event => edit('base_url', event.target.value)} placeholder={form.base_url_is_full ? 'https://example.com/custom/infer' : 'https://example.com/v1'} /></label>
            <label className="exploration-model-checkbox"><AppSwitch checked={form.base_url_is_full} onChange={event => edit('base_url_is_full', event.target.checked)} />使用完整接口 URL</label>
            <p>{form.base_url_is_full ? '直接使用填写的 OpenAI Chat Completions 完整接口 URL，不追加后缀' : stored?.suggested && form.base_url === stored.candidate_url ? '根据主服务地址生成，请验证' : '填写服务商提供的 Base URL，不包含请求接口后缀'}</p>
            <label className="exploration-model-checkbox"><AppSwitch checked={form.use_main_key} onChange={event => edit('use_main_key', event.target.checked)} />使用现有 API Key（跟随当前主模型服务）</label>
            {!form.use_main_key && <label>API Key<input type="password" autoComplete="new-password" required={!stored?.has_key} value={form.api_key} onChange={event => edit('api_key', event.target.value)} placeholder={stored?.has_key ? '已保存，留空保持不变' : '填写此服务的 API Key'} /></label>}
            <label>模型<input value={form.model} onChange={event => edit('model', event.target.value)} placeholder={`留空使用主模型${stored?.main_model ? `：${stored.main_model}` : ''}`} /></label>
          <div className="exploration-model-actions"><button data-app-button="action" type="button" onClick={() => run(false)}>重新检测已保存配置</button><button data-app-button="action" type="submit">验证并保存</button></div>
        </fieldset>
      </form>}
      {!form && <button data-app-button="action" type="button" disabled={busy} onClick={() => run(false)}>重新检测</button>}
      {loadError && <p role="alert">{loadError}</p>}
      {result && <div role="status" className={`exploration-model-result${result.ok ? ' is-success' : ''}`}><p>{connectionMessage(result)}</p>{!result.ok && result.detail && <details><summary>查看详情</summary><pre>{result.detail}</pre></details>}</div>}
    </div>}
  </section>
}
