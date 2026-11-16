import React, { useEffect, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { CheckCircleFilled, KeyOutlined, LoadingOutlined, ReloadOutlined } from '@ant-design/icons'
import { PROVIDERS, useSettingsStore } from '../../store/settings.js'
import { isBuiltinProvider, hasFixedModel } from '../../store/settings.js'
import { fetchProviderModels } from '../../api/provider-models.js'
import { buildModelOptions, buildSettingsProviderLists, buildChatProviderOptions, isFixedProvider } from '../../utils/model-selection.js'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import Tooltip from '../Tooltip.jsx'
import PresetKeyDialog from './PresetKeyDialog.jsx'
import LocalModelDiscoveryDialog from '../common/LocalModelDiscoveryDialog.jsx'
import { getThinkingEffortOptions, normalizeThinkingEffort } from '../../utils/thinking-effort.js'
import { modelHealthKey, useModelHealthStore } from '../../store/model-health.js'
import { ModelHealthIndicator, ModelHealthToolbar } from './ModelHealth.jsx'
import { useConversationModel, useConversationModelsStore } from '../../store/conversation-models.js'
import './model-selector.css'
import { cancelActiveQrForModelSwitch } from '../../utils/model-switch-cancel.js'

export default function ModelSelector({ disabled, onPendingChange, thinkingEffort = 'off', onThinkingEffortChange, conversationScope = 'welcome' }) {
  const session = useConversationModel(conversationScope)
  const activeProvider = session.selection.provider
  const model = session.selection.model
  const providers = useSettingsStore(state => state.providers)
  const loaded = useSettingsStore(state => state.loaded)
  const saveProvider = useSettingsStore(state => state.saveProvider)
  const saveSelection = patch => useConversationModelsStore.getState().save(conversationScope, { ...session.selection, ...patch })
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [keyProvider, setKeyProvider] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const fixedModel = hasFixedModel(providers[activeProvider]?.provider_id || activeProvider)
  const pendingRef = useRef(false)
  const autoCheckProvider = useRef(null)
  const healthResults = useModelHealthStore(state => state.results)
  const checking = useModelHealthStore(state => state.checking)
  const running = useModelHealthStore(state => Boolean(state.running[activeProvider]))
  const checkModels = useModelHealthStore(state => state.checkModels)
  const checkModel = useModelHealthStore(state => state.checkModel)

  useEffect(() => {
    const controller = new AbortController()
    setCatalog(null)
    if (!loaded) return () => controller.abort()
    const definition = PROVIDERS.find(item => item.id === (providers[activeProvider]?.provider_id || activeProvider))
    const finishCatalog = (data) => {
      if (controller.signal.aborted) return
      setCatalog({ ...data, provider: activeProvider })
      // 模型名不再内置默认值：首次拉到列表且当前还没选模型时，先落到第一个可用模型上。
      const catalogModels = Array.isArray(data?.models) ? data.models.filter(Boolean) : []
      if (!model && catalogModels.length) {
        void saveSelection({ model: catalogModels[0] }).catch(() => {})
      }
      if (autoCheckProvider.current === activeProvider) {
        autoCheckProvider.current = null
        void checkModels(activeProvider, buildModelOptions(data.models, model).map(item => item.value))
      }
    }
    if (fixedModel) {
      finishCatalog({ models: [model || definition?.defaultModel].filter(Boolean) })
      return () => controller.abort()
    }
    fetchProviderModels({ provider: activeProvider, target: 'weworker', openai_base_url: '', openai_base_url_is_full: false }, controller.signal)
      .then(finishCatalog)
      .catch(() => finishCatalog({ models: definition?.models || [] }))
    return () => controller.abort()
  }, [activeProvider, providers, loaded, conversationScope])

  useEffect(() => () => useModelHealthStore.getState().cancelBatch(activeProvider), [activeProvider])

  const changeSelection = async (value, kind) => {
    if (disabled || !loaded || pendingRef.current) return
    if (kind === 'provider' && !isBuiltinProvider(value) && !providers[value]?.has_key) {
      if (isFixedProvider(value)) { setError(''); setKeyProvider(value) }
      return
    }
    if (kind === 'model' && fixedModel) return
    if (value === (kind === 'provider' ? activeProvider : model)) return
    pendingRef.current = true
    setPending(true)
    onPendingChange?.(true)
    setError('')
    try {
      await cancelActiveQrForModelSwitch()
      if (kind === 'provider') {
        let nextModel = providers[value]?.model || PROVIDERS.find(item => item.id === value)?.defaultModel || ''
        if (!nextModel) {
          const catalog = await fetchProviderModels({ provider: value, target: 'weworker' })
          const firstModel = catalog.models?.find(item => typeof item === 'string' && item.trim())
          if (!firstModel) throw new Error('已导入 API 配置，请在模型配置中选择或填写模型名称')
          nextModel = firstModel
        }
        autoCheckProvider.current = value
        await saveSelection({ provider: value, model: nextModel })
      }
      else await saveSelection({ model: value })
    } catch (failure) {
      autoCheckProvider.current = null
      setError(failure.message || '模型切换失败')
    } finally {
      pendingRef.current = false
      setPending(false)
      onPendingChange?.(false)
    }
  }

  const configuredProviders = buildSettingsProviderLists(PROVIDERS, providers).visible
  const providerOptions = buildChatProviderOptions(PROVIDERS, providers, activeProvider)

  const savePresetKey = async apiKey => {
    pendingRef.current = true
    setPending(true)
    onPendingChange?.(true)
    try {
      autoCheckProvider.current = keyProvider
      await saveProvider(keyProvider, { api_key: apiKey })
      const entry = useSettingsStore.getState().providers[keyProvider]
      await saveSelection({ provider: keyProvider, model: entry?.model || PROVIDERS.find(item => item.id === keyProvider)?.defaultModel || '' })
    } catch (failure) {
      autoCheckProvider.current = null
      throw failure
    } finally {
      pendingRef.current = false
      setPending(false)
      onPendingChange?.(false)
    }
  }

  const provider = configuredProviders.find(item => item.id === activeProvider)
  const modelSource = catalog?.provider === activeProvider
    ? catalog?.models
    : provider?.models
  const modelOptions = buildModelOptions(modelSource, model, { annotateCurrent: false })
  const unavailable = disabled || pending || session.pending || !loaded || (!session.loaded && !session.error) || Boolean(keyProvider)
  const errorTitle = error || session.error ? `模型切换失败：${error || session.error}` : undefined
  const thinkingOptions = getThinkingEffortOptions(activeProvider, model)
  const normalizedThinkingEffort = normalizeThinkingEffort(thinkingEffort, thinkingOptions)

  useEffect(() => {
    if (session.loaded && !session.pending && normalizedThinkingEffort !== thinkingEffort) onThinkingEffortChange?.(normalizedThinkingEffort)
  }, [normalizedThinkingEffort, thinkingEffort, onThinkingEffortChange])

  const renderModelHealth = (option, interactive = false) => {
    if (!option) return null
    const key = modelHealthKey(activeProvider, option.value)
    return <ModelHealthIndicator model={option.value} result={healthResults[key]} busy={checking[key]}
      disabled={unavailable} onCheck={interactive ? () => { void checkModel(activeProvider, option.value) } : undefined} />
  }

  return (
    <div className="chat-model-selector" aria-busy={pending} title={errorTitle || '仅用于当前对话'}>
      <AppDropdownSelect
        className="chat-model-selector__provider"
        menuClassName="app-dropdown-menu chat-model-selector-menu"
        value={activeProvider}
        options={providerOptions}
        fallbackOption={{ value: activeProvider, label: provider?.name || activeProvider || '请选择', keyConfigured: Boolean(providers[activeProvider]?.has_key) }}
        onChange={value => changeSelection(value, 'provider')}
        disabled={unavailable}
        ariaLabel="模型供应商选择"
        prefix={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="var(--bg-secondary)" /><circle cx="15" cy="17" r="3" fill="var(--bg-secondary)" /></svg>}
        placement="top"
        minMenuWidth={240}
        menuHeader={(
          <div className="provider-discovery-toolbar">
            <button type="button" className="provider-discovery-action" disabled={unavailable}
              onClick={() => setDiscoveryOpen(true)}>
              {pending ? <LoadingOutlined spin aria-hidden="true" /> : <ReloadOutlined aria-hidden="true" />}<span>自动识别</span>
            </button>
          </div>
        )}
        renderOptionSuffix={option => option?.keyConfigured === undefined ? null : (
          <span className={`provider-key-status${option.keyConfigured ? ' is-configured' : ''}`}
            title={option.keyConfigured ? '已填写 API Key' : '未填写 API Key，点击配置'}
            aria-label={option.keyConfigured ? '已填写 API Key' : '未填写 API Key'}>
            {option.keyConfigured ? <CheckCircleFilled /> : <KeyOutlined />}
          </span>
        )}
      />
      <AppDropdownSelect
        className="chat-model-selector__model"
        menuClassName="app-dropdown-menu chat-model-selector-menu chat-model-health-menu"
        value={model || ''}
        options={modelOptions}
        onChange={value => changeSelection(value, 'model')}
        disabled={unavailable}
        ariaLabel="模型选择"
        placement="top"
        minMenuWidth={280}
        searchable={!fixedModel}
        allowCustom={!fixedModel}
        searchPlaceholder="搜索或输入模型名"
        renderOptionSuffix={renderModelHealth}
        renderOptionAction={option => renderModelHealth(option, true)}
        menuHeader={<ModelHealthToolbar running={running} disabled={!modelOptions.length || unavailable}
          onCheck={() => { void checkModels(activeProvider, modelOptions.map(item => item.value)) }} />}
      />
      <Tooltip text={`思考：${thinkingOptions.find(option => option.value === normalizedThinkingEffort)?.label || '关'}`}>
        <AppDropdownSelect
          className={`chat-model-selector__thinking${normalizedThinkingEffort !== 'off' ? ' is-active' : ''}`}
          menuClassName="app-dropdown-menu chat-model-selector-menu"
          value={normalizedThinkingEffort}
          options={thinkingOptions}
          onChange={value => onThinkingEffortChange?.(normalizeThinkingEffort(value, thinkingOptions))}
          disabled={unavailable}
          ariaLabel="思考效果"
          prefix={<Brain size={18} strokeWidth={1.8} aria-hidden="true" />}
          placement="top"
          minMenuWidth={88}
        />
      </Tooltip>
      {discoveryOpen && <LocalModelDiscoveryDialog onClose={() => setDiscoveryOpen(false)} />}
      {keyProvider && <PresetKeyDialog
        providerName={PROVIDERS.find(item => item.id === keyProvider)?.name || keyProvider}
        onSave={savePresetKey}
        onClose={() => setKeyProvider(null)}
      />}
    </div>
  )
}
