import ProviderIcon from '../icons/ProviderIcon.jsx'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { CheckCircleFilled, KeyOutlined } from '@ant-design/icons'
import { useSettingsStore } from '../../store/settings.js'
import { buildModelOptions } from '../../utils/model-selection.js'
import { BASIC_OPTIONS } from '../../utils/thinking-effort.js'
import { createModelHealthStore, modelHealthKey } from '../../store/model-health.js'
import * as api from '../../api/website-exploration-api.js'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import ContextPanel from '../chat/ContextPanel.jsx'
import { ModelHealthIndicator, ModelHealthToolbar } from '../chat/ModelHealth.jsx'
import PresetKeyDialog from '../chat/PresetKeyDialog.jsx'
import { useWebsiteExplorationStore } from '../../store/website-exploration.js'
import '../chat/model-selector.css'

const selectionProvider = item => item.selection_provider || `__exploration__:${item.id}`
const hasExplorationEndpoint = item => item?.has_key && item.base_url && item.protocol === 'openai_chat_completions'

export default function ExplorationModelSelector({ disabled, usage, conversationId, draftModelKey = 'site/new/instruction/model', onPendingChange, onReadyChange, children }) {
  const providers = useSettingsStore(s => s.providers)
  const activeProvider = useSettingsStore(s => s.activeProvider)
  const mainModel = useSettingsStore(s => s.model)
  const revision = useSettingsStore(s => s.explorationModelRevision)
  const [config, setConfig] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const pendingRef = useRef(false)
  const selectionRef = useRef(null)
  const requestVersion = useRef(0)
  const [loading, setLoading] = useState(true)
  const [connection, setConnection] = useState(null)
  const [retry, setRetry] = useState(0)
  const [keyProvider, setKeyProvider] = useState(null)
  useEffect(() => {
    if (keyProvider || pendingRef.current) return
    let alive = true
    const version = ++requestVersion.current
    setLoading(true)
    setConfig(null)
    ;(async () => {
      const saved = conversationId
        ? (await api.getExplorationSessionModel(conversationId)).model_selection
        : useWebsiteExplorationStore.getState().drafts[draftModelKey]
      const available = await api.getExplorationModel()
      if (!alive || version !== requestVersion.current) return
      const savedReference = saved?.provider === '__exploration__' ? `__exploration__:${available.active_provider}` : saved?.provider
      const configured = available.providers?.filter(item => item.configured
        || selectionProvider(item) === savedReference && saved?.model && hasExplorationEndpoint(item)) || []
      const previous = configured.find(item => selectionProvider(item) === savedReference)
      const entry = previous || configured.find(item => item.id === available.active_provider) || configured[0]
      if (!entry) {
        selectionRef.current = null
        setConfig({ ...available, selection: null, selected_provider: '', effective_model: '' })
        setError('请先在设置 → 模型中配置 Adapter 工坊 OpenAI 接口')
        return
      }
      const selection = { provider: selectionProvider(entry), model: previous ? saved.model : entry.model,
        thinking_effort: saved?.thinking_effort || 'off' }
      if (conversationId && saved && saved.provider !== selection.provider && disabled) {
        selectionRef.current = null
        setConfig({ ...available, selection: null, selected_provider: '', effective_model: '' })
        setError('当前记录使用旧模型配置，请在任务停止后选择网站探索配置')
        return
      }
      const value = await api.resolveExplorationSessionModel(selection)
      if (!alive || version !== requestVersion.current) return
      selectionRef.current = value.selection
      if (conversationId && !disabled && (!saved || saved.provider !== value.selection.provider)) await api.saveExplorationSessionModel(conversationId, value.selection)
      if (!conversationId) useWebsiteExplorationStore.getState().setDraft(draftModelKey, value.selection)
      if (alive && version === requestVersion.current) { setConfig(value); setError('') }
    })().catch(e => { if (alive && version === requestVersion.current) setError(e.message) }).finally(() => { if (alive && version === requestVersion.current) setLoading(false) })
    return () => { alive = false }
  }, [conversationId, draftModelKey, providers, activeProvider, mainModel, revision, disabled, keyProvider])
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
  const provider = config?.providers?.find(item => selectionProvider(item) === selected)
  const fixedModel = provider?.fixed_model === true
  useEffect(() => {
    const controller = new AbortController()
    setCatalog(null)
    if (provider && config?.selection) {
      api.listExplorationModels({ provider: selected, model: currentModel })
        .then(value => { if (!controller.signal.aborted) setCatalog({ provider: selected, models: value.models || [] }) })
        .catch(() => {})
    }
    return () => controller.abort()
  }, [selected, config?.health_scope, provider?.id, provider?.configured, currentModel])

  async function persistSelection(patch) {
    const selection = { thinking_effort: 'off', ...selectionRef.current, ...patch }
    const result = await api.resolveExplorationSessionModel(selection)
    if (conversationId) await api.saveExplorationSessionModel(conversationId, result.selection)
    else useWebsiteExplorationStore.getState().setDraft(draftModelKey, result.selection)
    selectionRef.current = result.selection
    setConfig(result)
  }
  async function providerSelection(entry) {
    if (!entry?.configured) {
      if (!hasExplorationEndpoint(entry)) throw new Error('请先在设置 → 模型中配置该供应商的 Adapter 工坊 OpenAI 接口')
      const catalog = await api.listExplorationModels({ provider: selectionProvider(entry) })
      const model = catalog.models?.find(value => typeof value === 'string' && value.trim())
      if (!model) throw new Error('未获取到可用模型，请在设置 → 模型中选择或填写模型')
      return { provider: selectionProvider(entry), model }
    }
    return { provider: selectionProvider(entry), model: entry.model }
  }
  async function save(patch) {
    if (disabled || pendingRef.current) return
    requestVersion.current++
    pendingRef.current = true; setPending(true); onPendingChange?.(true); setError('')
    try {
      if (patch.provider && !patch.model) {
        const entry = config?.providers?.find(item => selectionProvider(item) === patch.provider)
        patch = { ...patch, ...await providerSelection(entry) }
      }
      await persistSelection(patch)
      return true
    } catch (e) { setError(e.message); return false }
    finally { pendingRef.current = false; setPending(false); setLoading(false); onPendingChange?.(false) }
  }
  async function selectProvider(id) {
    if (id === selected || disabled || pendingRef.current) return
    const entry = config?.providers?.find(item => selectionProvider(item) === id)
    if (!entry) return
    if (entry.fixed_provider && !entry.has_key && !providers[entry.id]?.has_key) {
      setError(''); setKeyProvider(entry); return
    }
    if (!entry.configured && !hasExplorationEndpoint(entry)) {
      setError('请先在设置 → 模型中配置该供应商的 Adapter 工坊 OpenAI 接口'); return
    }
    await save({ provider: id, model: entry.configured ? entry.model : '' })
  }
  async function savePresetKey(apiKey) {
    if (disabled || pendingRef.current) throw new Error('请稍后重试')
    requestVersion.current++
    pendingRef.current = true; setPending(true); onPendingChange?.(true); setError('')
    try {
      await useSettingsStore.getState().saveProvider(keyProvider.id, { api_key: apiKey })
      const available = await api.getExplorationModel()
      const entry = available.providers?.find(item => item.id === keyProvider.id)
      if (!entry?.configured && !hasExplorationEndpoint(entry)) throw new Error('API Key 已保存，请在设置 → 模型中配置该供应商的 Adapter 工坊 OpenAI 接口')
      await persistSelection(await providerSelection(entry))
    } finally {
      pendingRef.current = false; setPending(false); onPendingChange?.(false)
    }
  }
  const unavailable = disabled || pending || loading || Boolean(keyProvider) || !config?.selection
  const renderModelHealth = (option, interactive = false) => {
    if (!option) return null
    const key = modelHealthKey(selected, option.value)
    return <ModelHealthIndicator model={option.value} result={healthResults[key]} busy={checking[key]}
      disabled={unavailable} protocolLabel="网站探索接口"
      onCheck={interactive ? () => { void checkModel(selected, option.value) } : undefined} />
  }
  const providerOptions = (config?.providers || []).filter(item => item.fixed_provider || item.builtin || item.configured).map(item => ({
    value: selectionProvider(item), label: item.name, keyConfigured: Boolean(item.has_key || item.fixed_provider && providers[item.id]?.has_key),
  }))
  const modelOptions = buildModelOptions(fixedModel ? [currentModel] : catalog?.provider === selected ? catalog.models : provider?.models, currentModel, { annotateCurrent: false })
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
          disabled={disabled || pending || loading || Boolean(keyProvider)} onChange={selectProvider}
          prefix={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--bg-secondary)" /><circle cx="15" cy="17" r="3" fill="var(--bg-secondary)" /></svg>}
          fallbackOption={{ value: '', label: '未配置网站探索模型' }}
          menuHeader={<div className="provider-discovery-toolbar">网站探索配置</div>}
          renderOptionPrefix={option => <ProviderIcon provider={providers[option.value]?.provider_id || option.value.replace('__exploration__:', '')} size={18} />}
          renderOptionSuffix={option => <span className={`provider-key-status${option?.keyConfigured ? ' is-configured' : ''}`} title={option?.keyConfigured ? '已填写 API Key' : '未填写 API Key，点击配置'} aria-label={option?.keyConfigured ? '已填写 API Key' : '未填写 API Key'}>{option?.keyConfigured ? <CheckCircleFilled /> : <KeyOutlined />}</span>} />
        <AppDropdownSelect className="chat-model-selector__model" menuClassName="app-dropdown-menu chat-model-selector-menu chat-model-health-menu"
          value={currentModel} options={modelOptions} ariaLabel="模型选择" placement="top" minMenuWidth={280}
          disabled={unavailable} searchable={!fixedModel} allowCustom={!fixedModel} searchPlaceholder="搜索或输入模型名"
          fallbackOption={{ value: '', label: '未配置' }}
          renderOptionSuffix={renderModelHealth} renderOptionAction={option => renderModelHealth(option, true)}
          menuHeader={<ModelHealthToolbar running={running} disabled={unavailable || !modelOptions.length} protocolLabel="网站探索接口"
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
    {keyProvider && <PresetKeyDialog providerName={keyProvider.name} dismissible={false}
      onSave={savePresetKey} onClose={() => setKeyProvider(null)} />}
  </>
}
