import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { CheckCircleFilled, KeyOutlined, ReloadOutlined } from '@ant-design/icons'
import { PROVIDERS, useSettingsStore } from '../../store/settings.js'
import { buildChatProviderOptions, buildModelOptions } from '../../utils/model-selection.js'
import { BASIC_OPTIONS } from '../../utils/thinking-effort.js'
import { fetchProviderModels } from '../../api/provider-models.js'
import { createModelHealthStore, modelHealthKey } from '../../store/model-health.js'
import * as api from '../../api/website-exploration-api.js'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import LocalModelDiscoveryDialog from '../common/LocalModelDiscoveryDialog.jsx'
import PresetKeyDialog from '../chat/PresetKeyDialog.jsx'
import ContextPanel from '../chat/ContextPanel.jsx'
import { ModelHealthIndicator, ModelHealthToolbar } from '../chat/ModelHealth.jsx'
import { useWebsiteExplorationStore } from '../../store/website-exploration.js'
import '../chat/model-selector.css'

export default function ExplorationModelSelector({ disabled, usage, conversationId, draftModelKey = 'site/new/instruction/model', onPendingChange, onReadyChange, children }) {
  const providers = useSettingsStore(s => s.providers)
  const activeProvider = useSettingsStore(s => s.activeProvider)
  const mainModel = useSettingsStore(s => s.model)
  const revision = useSettingsStore(s => s.explorationModelRevision)
  const [config, setConfig] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [discovery, setDiscovery] = useState(false)
  const [keyProvider, setKeyProvider] = useState(null)
  const pendingRef = useRef(false)
  const selectionRef = useRef(null)
  const requestVersion = useRef(0)
  const [loading, setLoading] = useState(true)
  const [connection, setConnection] = useState(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    const version = ++requestVersion.current
    setLoading(true)
    setConfig(null)
    ;(async () => {
      const saved = conversationId
        ? (await api.getExplorationSessionModel(conversationId)).model_selection
        : useWebsiteExplorationStore.getState().drafts[draftModelKey]
      const value = await api.resolveExplorationSessionModel(saved || undefined)
      if (!alive || version !== requestVersion.current) return
      selectionRef.current = value.selection
      // Adopt the default once for legacy idle records. New records already
      // persist their model at creation, even with an untouched composer.
      if (conversationId && !saved && !disabled) await api.saveExplorationSessionModel(conversationId, value.selection)
      if (!conversationId) useWebsiteExplorationStore.getState().setDraft(draftModelKey, value.selection)
      if (alive && version === requestVersion.current) { setConfig(value); setError('') }
    })().catch(e => { if (alive && version === requestVersion.current) setError(e.message) }).finally(() => { if (alive && version === requestVersion.current) setLoading(false) })
    return () => { alive = false }
  }, [conversationId, draftModelKey, providers, activeProvider, mainModel, revision])
  const connectionKey = JSON.stringify([config?.selection, config?.health_scope])
  useEffect(() => {
    let alive = true
    setConnection(null)
    if (config?.selection) api.checkExplorationModel(retry > 0, config.selection)
      .then(result => { if (alive) setConnection(result) })
      .catch(e => { if (alive) setConnection({ ok: false, detail: e.message }) })
    return () => { alive = false }
  }, [connectionKey, retry])
  useEffect(() => { onPendingChange?.(loading || pending) }, [loading, pending, onPendingChange])
  useEffect(() => { onReadyChange?.(!loading && !pending && Boolean(connection?.ok)) }, [loading, pending, connection, onReadyChange])
  const selected = config?.selected_provider || ''
  const currentModel = config?.effective_model || ''
  // Separate results from normal chat and discard them when credentials or the
  // endpoint change. Reuse the same per-model concurrency and deduplication.
  const useHealth = useMemo(() => createModelHealthStore({ probe: api.probeExplorationModel }), [selected, config?.health_scope])
  const healthResults = useHealth(s => s.results)
  const checking = useHealth(s => s.checking)
  const running = useHealth(s => Boolean(s.running[selected]))
  const checkModel = useHealth(s => s.checkModel)
  const checkModels = useHealth(s => s.checkModels)
  useEffect(() => () => useHealth.getState().cancelBatch(selected), [useHealth, selected])
  const provider = providers[selected]
  const definition = PROVIDERS.find(item => item.id === (provider?.provider_id || selected))
  const fixedModel = definition?.fixedModel === true
  useEffect(() => {
    const controller = new AbortController()
    setCatalog(null)
    if (selected && selected !== '__independent__' && !fixedModel) {
      fetchProviderModels({ provider: selected, target: 'weworker' }, controller.signal)
        .then(value => { if (!controller.signal.aborted) setCatalog({ provider: selected, models: value.models }) })
        .catch(() => {})
    }
    return () => controller.abort()
  }, [selected, providers, fixedModel])

  async function save(patch) {
    if (disabled || pendingRef.current) return
    requestVersion.current++
    pendingRef.current = true; setPending(true); onPendingChange?.(true); setError('')
    try {
      const selection = { thinking_effort: 'off', ...selectionRef.current, ...patch }
      const result = await api.resolveExplorationSessionModel(selection)
      if (conversationId) await api.saveExplorationSessionModel(conversationId, result.selection)
      else useWebsiteExplorationStore.getState().setDraft(draftModelKey, result.selection)
      selectionRef.current = result.selection
      setConfig(result)
      return true
    } catch (e) { setError(e.message); return false }
    finally { pendingRef.current = false; setPending(false); setLoading(false); onPendingChange?.(false) }
  }
  async function selectProvider(id) {
    if (id === selected || disabled || pendingRef.current) return
    const entry = providers[id]
    const preset = PROVIDERS.find(item => item.id === (entry?.provider_id || id))
    if (!preset?.builtin && !entry?.has_key) { setKeyProvider(id); return }
    let model = entry?.model || preset?.defaultModel || ''
    if (!model && entry?.external_source_id) {
      try { model = (await fetchProviderModels({ provider: id, target: 'weworker' })).models?.[0] || '' }
      catch (e) { setError(e.message); return }
    }
    await save({ provider: id, model })
  }
  const unavailable = disabled || pending || loading
  const renderModelHealth = (option, interactive = false) => {
    if (!option) return null
    const key = modelHealthKey(selected, option.value)
    return <ModelHealthIndicator model={option.value} result={healthResults[key]} busy={checking[key]}
      disabled={unavailable} protocolLabel="对话接口"
      onCheck={interactive ? () => { void checkModel(selected, option.value) } : undefined} />
  }
  const providerOptions = buildChatProviderOptions(PROVIDERS, providers, selected)
  const modelOptions = buildModelOptions(fixedModel ? [currentModel] : catalog?.provider === selected ? catalog.models : definition?.models, currentModel, { annotateCurrent: false })
  const glm = config?.model_class === 'zhipu' || /^glm-/i.test(currentModel)
  const thinkingOptions = glm ? (/^glm-5\.3/i.test(currentModel) ? [] : [{ value: 'off', label: '关' }]).concat({ value: 'high', label: '开' }) : BASIC_OPTIONS
  const effort = /^glm-5\.3/i.test(currentModel) ? 'high' : config?.thinking_effort || 'off'
  const tokens = usage?.input_tokens
  const snapshot = Number.isFinite(tokens) ? { context_limit: usage.context_limit, displayed_total_tokens: tokens,
    actual_input_tokens: tokens, token_source: 'provider_calibrated', categories: [] } : null
  return <>
    <div className="wx-composer-context"><ContextPanel snapshot={snapshot} contextLimit={config?.context_limit || usage?.context_limit} usageOnly /></div>
    <div className="chat-input-toolbar-actions wx-chat-controls">
      <div className="chat-model-selector" aria-busy={pending || loading} title="仅用于当前探索会话">
        <AppDropdownSelect className="chat-model-selector__provider" menuClassName="app-dropdown-menu chat-model-selector-menu"
          value={selected} options={providerOptions} ariaLabel="模型供应商选择" placement="top" minMenuWidth={240}
          disabled={unavailable} onChange={selectProvider}
          prefix={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--bg-secondary)" /><circle cx="15" cy="17" r="3" fill="var(--bg-secondary)" /></svg>}
          menuHeader={<div className="provider-discovery-toolbar"><button type="button" className="provider-discovery-action" disabled={unavailable} onClick={() => setDiscovery(true)}><ReloadOutlined />自动识别</button></div>}
          renderOptionSuffix={option => <span className={`provider-key-status${option?.keyConfigured ? ' is-configured' : ''}`} aria-label={option?.keyConfigured ? '已填写 API Key' : '未填写 API Key'}>{option?.keyConfigured ? <CheckCircleFilled /> : <KeyOutlined />}</span>} />
        <AppDropdownSelect className="chat-model-selector__model" menuClassName="app-dropdown-menu chat-model-selector-menu chat-model-health-menu"
          value={currentModel} options={modelOptions} ariaLabel="模型选择" placement="top" minMenuWidth={280}
          disabled={unavailable} searchable={!fixedModel} allowCustom={!fixedModel} searchPlaceholder="搜索或输入模型名"
          renderOptionSuffix={renderModelHealth} renderOptionAction={option => renderModelHealth(option, true)}
          menuHeader={<ModelHealthToolbar running={running} disabled={unavailable || !modelOptions.length} protocolLabel="对话接口"
            onCheck={() => { void checkModels(selected, modelOptions.map(item => item.value)) }} />}
          onChange={model => save({ provider: selected, model })} />
        <AppDropdownSelect className={`chat-model-selector__thinking${effort !== 'off' ? ' is-active' : ''}`} menuClassName="app-dropdown-menu chat-model-selector-menu"
          value={glm && effort !== 'off' ? 'high' : effort} options={thinkingOptions} ariaLabel="思考效果" placement="top" minMenuWidth={88}
          disabled={unavailable} onChange={thinking_effort => save({ thinking_effort })} prefix={<Brain size={18} strokeWidth={1.8} aria-hidden="true" />} />
      </div>
      {children}
    </div>
    {error && <span className="wx-composer-error" role="alert">{error}</span>}
    {!error && connection && !connection.ok && <span className="wx-composer-error" role="alert">{connection.detail || '当前会话模型连接失败'} <button type="button" className="wx-quiet" disabled={unavailable} onClick={() => setRetry(value => value + 1)}>重试</button></span>}
    {discovery && <LocalModelDiscoveryDialog dismissible={false} onClose={() => setDiscovery(false)} />}
    {keyProvider && <PresetKeyDialog dismissible={false} providerName={providers[keyProvider]?.name || keyProvider} onClose={() => setKeyProvider(null)} onSave={async apiKey => {
      await useSettingsStore.getState().saveProvider(keyProvider, { api_key: apiKey })
      const entry = useSettingsStore.getState().providers[keyProvider]
      if (!await save({ provider: keyProvider, model: entry?.model || '' })) throw new Error('探索模型切换失败，请检查模型配置')
    }} />}
  </>
}
