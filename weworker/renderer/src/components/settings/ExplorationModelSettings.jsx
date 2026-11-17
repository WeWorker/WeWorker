import React, { useEffect, useState } from 'react'
import { useExplorationModelStore } from '../../store/exploration-model.js'
import * as api from '../../api/website-exploration-api.js'
import { connectionMessage } from '../../utils/model-connection.js'
import './exploration-model-settings.css'

function providerForm(provider) {
  return { provider: provider.id, base_url: provider.base_url || '', model: provider.model || '',
    protocol: provider.protocol, auth_type: provider.auth_type || 'api_key', api_key: '' }
}

export default function ExplorationModelSettings() {
  const { data, load, save, busy, error } = useExplorationModelStore()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const [forms, setForms] = useState({})
  const [catalogs, setCatalogs] = useState({})
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => { void load() }, [load])
  const providerId = selected || data?.active_provider || (data?.base_url ? 'custom' : data?.providers?.[0]?.id)
  const provider = data?.providers?.find(item => item.id === providerId)
  const form = provider ? forms[providerId] || providerForm(provider) : null
  const edit = (key, value) => { setResult(null); setForms(current => ({ ...current, [providerId]: { ...form, [key]: value } })) }
  const isBusy = busy || checking
  const active = data?.providers?.find(item => item.id === data?.active_provider)
  const status = isBusy ? '正在验证…' : active ? `${active.name} · ${active.model}` : '保留原配置'
  return <section className="exploration-model-settings" aria-label="网站探索模型">
    <button type="button" className="exploration-model-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>高级设置 · 网站探索模型</strong><span className="exploration-model-toggle-meta"><span>{status}</span><span>· {open ? '收起' : '配置'}</span></span>
    </button>
    {open && <div className="exploration-model-body">
      <p>独立配置网站探索与开发使用的模型，在探索输入框下方切换供应商和模型。</p>
      <div className="exploration-provider-tabs" role="group" aria-label="网站探索供应商">
        {data?.providers?.map(item => <button type="button" key={item.id} aria-pressed={providerId === item.id} disabled={isBusy} onClick={() => { setSelected(item.id); setResult(null) }}>{item.name}{item.configured ? ' · 已配置' : ''}</button>)}
      </div>
      {form && <form onSubmit={event => { event.preventDefault(); void (async () => {
        const ok = await save(form)
        if (ok) { setForms(current => ({ ...current, [providerId]: { ...form, api_key: '' } })); setResult({ ok: true, model: form.model }) }
      })() }}>
        <fieldset disabled={isBusy}>
          <label>API Key<input type="password" autoComplete="new-password" value={form.api_key} onChange={event => edit('api_key', event.target.value)} placeholder={provider.has_key ? '已保存，留空保持不变' : '填写此探索供应商的 API Key'} required={!provider.has_key} /></label>
          {providerId === 'custom' && <>
            <label>接口协议<select value={form.protocol} onChange={event => edit('protocol', event.target.value)}><option value="openai_chat_completions">OpenAI Chat Completions</option><option value="anthropic_messages">Anthropic Messages</option></select></label>
            <label>服务地址<input type="url" required value={form.base_url} onChange={event => edit('base_url', event.target.value)} placeholder="https://example.com/v1" /></label>
            {form.protocol === 'anthropic_messages' && <label>鉴权方式<select value={form.auth_type} onChange={event => edit('auth_type', event.target.value)}><option value="api_key">API Key</option><option value="auth_token">Bearer Token</option></select></label>}
          </>}
          <label>模型<input required list={'exploration-models-' + providerId} value={form.model} onChange={event => edit('model', event.target.value)} placeholder="选择或填写模型名称" /></label>
          <datalist id={'exploration-models-' + providerId}>{[...new Set([...(catalogs[providerId]?.models || []), ...provider.models])].map(model => <option key={model} value={model} />)}</datalist>
          <div className="exploration-model-actions">
            <button type="button" onClick={() => { setChecking(true); setResult(null); void api.listExplorationModels(form).then(catalog => setCatalogs(current => ({ ...current, [providerId]: catalog }))).catch(error => setResult({ ok: false, detail: error.message })).finally(() => setChecking(false)) }}>刷新模型列表</button>
            <button type="button" disabled={!provider.configured} onClick={() => { setChecking(true); setResult(null); void api.checkExplorationModel(true).then(setResult).catch(error => setResult({ ok: false, detail: error.message })).finally(() => setChecking(false)) }}>重新检测当前探索配置</button>
            <button type="submit">验证并使用此探索模型</button>
          </div>
        </fieldset>
      </form>}
      {catalogs[providerId]?.warning && <p role="status">{catalogs[providerId].warning}</p>}
      {error && <p role="alert">{error}</p>}
      {result && <div role="status" className={`exploration-model-result${result.ok ? ' is-success' : ''}`}><p>{connectionMessage(result)}</p>{!result.ok && result.detail && <details><summary>查看详情</summary><pre>{result.detail}</pre></details>}</div>}
    </div>}
  </section>
}
