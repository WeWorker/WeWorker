import React, { useEffect, useRef, useState } from 'react'
import { CheckCircleFilled, KeyOutlined, DisconnectOutlined, LinkOutlined, LoadingOutlined, QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { PROVIDERS, useSettingsStore } from '../../store/settings.js'
import { isBuiltinProvider, hasFixedModel } from '../../store/settings.js'
import { fetchProviderModels } from '../../api/provider-models.js'
import { buildModelOptions, buildSettingsProviderLists, buildChatProviderOptions, isFixedProvider } from '../../utils/model-selection.js'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import PresetKeyDialog from './PresetKeyDialog.jsx'
import { getThinkingEffortOptions, normalizeThinkingEffort } from '../../utils/thinking-effort.js'
import { modelHealthKey, useModelHealthStore } from '../../store/model-health.js'
import './model-selector.css'
import { cancelActiveQrForModelSwitch } from '../../utils/model-switch-cancel.js'

export default function ModelSelector({ disabled, onPendingChange, thinkingEffort = 'off', onThinkingEffortChange }) {
  const activeProvider = useSettingsStore(state => state.activeProvider)
  const model = useSettingsStore(state => state.model)
  const providers = useSettingsStore(state => state.providers)
  const loaded = useSettingsStore(state => state.loaded)
  const activateProvider = useSettingsStore(state => state.activateProvider)
  const saveProvider = useSettingsStore(state => state.saveProvider)
  const configurePresetProvider = useSettingsStore(state => state.configurePresetProvider)
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
      if (!useSettingsStore.getState().model && catalogModels.length) {
        void saveProvider(activeProvider, { model: catalogModels[0] })
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
  }, [activeProvider, providers, loaded])

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
        autoCheckProvider.current = value
        await activateProvider(value)
      }
      else await saveProvider(activeProvider, { model: value })
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
      await configurePresetProvider(keyProvider, apiKey)
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
  const unavailable = disabled || pending || !loaded || Boolean(keyProvider)
  const errorTitle = error ? `模型切换失败：${error}` : undefined
  const thinkingOptions = getThinkingEffortOptions(activeProvider, model)
  const normalizedThinkingEffort = normalizeThinkingEffort(thinkingEffort, thinkingOptions)

  useEffect(() => {
    if (normalizedThinkingEffort !== thinkingEffort) onThinkingEffortChange?.(normalizedThinkingEffort)
  }, [normalizedThinkingEffort, thinkingEffort, onThinkingEffortChange])

  const renderModelHealth = (option) => {
    if (!option) return null
    const key = modelHealthKey(activeProvider, option.value)
    const result = healthResults[key]
    const busy = checking[key]
    const state = result ? (result.ok ? 'success' : 'failure') : 'unknown'
    const time = result ? new Date(result.checkedAt).toLocaleString() : ''
    const title = result
      ? `上次检测：${time} · ${result.ok ? '会话协议可用' : '检测未通过'} · 请求总耗时 ${result.elapsedMs}ms${busy ? ' · 正在重新检测' : ''}`
      : busy ? '正在检测会话协议' : '尚未检测，点击列表顶部图标检测全部模型'
    return (
      <span className={`model-health is-${state}`} title={title} aria-label={title}>
        {busy ? <LoadingOutlined spin /> : result ? (result.ok ? <LinkOutlined /> : <DisconnectOutlined />) : <QuestionCircleOutlined />}
        <span>{result ? (result.ok ? `${result.elapsedMs}ms` : '不可用') : busy ? '检测中' : '未检测'}</span>
      </span>
    )
  }

  return (
    <div className="chat-model-selector" aria-busy={pending} title={errorTitle}>
      <AppDropdownSelect
        className="chat-model-selector__provider"
        menuClassName="app-dropdown-menu chat-model-selector-menu"
        value={activeProvider}
        options={providerOptions}
        fallbackOption={{ value: activeProvider, label: provider?.name || activeProvider || '请选择', keyConfigured: Boolean(providers[activeProvider]?.has_key) }}
        onChange={value => changeSelection(value, 'provider')}
        disabled={unavailable}
        ariaLabel="模型供应商选择"
        placement="top"
        minMenuWidth={150}
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
        menuHeader={(
          <div className="model-health-toolbar">
            <span>{running ? '正在检测会话协议…' : '上次检测结果'}</span>
            <button type="button" className="model-health-refresh" aria-label="检测全部模型"
              title="检测全部模型（真实请求，可能产生费用）" disabled={running || !modelOptions.length || unavailable}
              onClick={() => { void checkModels(activeProvider, modelOptions.map(item => item.value)) }}>
              {running ? <LoadingOutlined spin /> : <ReloadOutlined />}
            </button>
          </div>
        )}
      />
      <AppDropdownSelect
        className="chat-model-selector__thinking"
        menuClassName="app-dropdown-menu chat-model-selector-menu"
        value={normalizedThinkingEffort}
        options={thinkingOptions}
        onChange={value => onThinkingEffortChange?.(normalizeThinkingEffort(value, thinkingOptions))}
        disabled={unavailable}
        ariaLabel="思考效果"
        prefix="思考"
        placement="top"
        minMenuWidth={88}
      />
      {keyProvider && <PresetKeyDialog
        providerName={PROVIDERS.find(item => item.id === keyProvider)?.name || keyProvider}
        onSave={savePresetKey}
        onClose={() => setKeyProvider(null)}
      />}
    </div>
  )
}
