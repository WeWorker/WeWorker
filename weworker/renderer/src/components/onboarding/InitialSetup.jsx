import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircleFilled, KeyOutlined, LoadingOutlined } from '@ant-design/icons'
import AppDropdownSelect from '../common/AppDropdownSelect.jsx'
import { isBuiltinProvider, PROVIDERS, useSettingsStore } from '../../store/settings.js'
import { isFixedProvider } from '../../utils/model-selection.js'
import { fetchProviderModels } from '../../api/provider-models.js'
import './initial-setup.css'

function providerOptions() {
  return PROVIDERS
    .filter(provider => isBuiltinProvider(provider.id) || isFixedProvider(provider.id))
    .map(provider => ({
      value: provider.id,
      label: provider.name,
      description: provider.models?.length ? provider.models.join('、') : '',
    }))
}

export default function InitialSetup({ onComplete }) {
  const providers = useSettingsStore(state => state.providers)
  const saveProvider = useSettingsStore(state => state.saveProvider)
  const options = useMemo(providerOptions, [])
  const [provider, setProvider] = useState(() => options.find(option => option.value === 'builtin')?.value || options[0]?.value || '')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState([])
  const [model, setModel] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)

  const selectedIsBuiltin = isBuiltinProvider(provider)
  const selectedProvider = PROVIDERS.find(item => item.id === provider)
  const hasSavedKey = Boolean(providers[provider]?.has_key)
  const needsModelCatalog = provider === 'bank_coding'
  const canContinue = selectedIsBuiltin || (hasSavedKey && (!needsModelCatalog || Boolean(model)))

  useEffect(() => {
    if (!needsModelCatalog || !hasSavedKey) return
    const controller = new AbortController()
    setLoadingModels(true)
    fetchProviderModels({ provider }, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setModels(result.models || [])
      setModel(current => current || providers[provider]?.model || result.models?.[0] || '')
      if (!result.models?.length) setError('模型列表获取失败，请检查 Key 后重新保存重试')
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message || '模型列表获取失败')
    }).finally(() => { if (!controller.signal.aborted) setLoadingModels(false) })
    return () => controller.abort()
  }, [provider, hasSavedKey, providers])

  const handleProviderChange = value => {
    setProvider(value)
    setApiKey('')
    setModels([])
    setModel('')
    setError('')
  }

  const handleSave = async event => {
    event.preventDefault()
    const key = apiKey.trim()
    if (!key) {
      setError('请先填写 API Key')
      return
    }
    setSaving(true)
    setError('')
    try {
      await saveProvider(provider, { api_key: key })
      setApiKey('')
    } catch (failure) {
      setError(failure.message || 'API Key 保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleContinue = async () => {
    if (!canContinue) {
      setError('请填写并保存 API Key 后继续')
      return
    }
    setCompleting(true)
    setError('')
    try {
      if (needsModelCatalog) await saveProvider(provider, { model })
      await onComplete(provider)
    } catch (failure) {
      setError(failure.message || '初始化失败')
      setCompleting(false)
    }
  }

  return (
    <main className="initial-setup" aria-label="初始化模型配置">
      <section className="initial-setup__card">
        <div className="initial-setup__brand" aria-hidden="true">W</div>
        <h1>欢迎使用 WeWorker</h1>
        <p className="initial-setup__intro">先选择一个模型配置，完成后即可开始使用。</p>

        <div className="initial-setup__field">
          <label htmlFor="initial-model-provider">模型配置</label>
          <AppDropdownSelect
            className="initial-setup__select"
            menuClassName="app-dropdown-menu initial-setup__menu"
            value={provider}
            options={options}
            onChange={handleProviderChange}
            ariaLabel="选择模型配置"
            matchAnchorWidth
            minMenuWidth={320}
          />
        </div>

        {!selectedIsBuiltin && (
          <form className="initial-setup__key-form" onSubmit={handleSave}>
            <label htmlFor="initial-api-key">API Key</label>
            <div className="initial-setup__key-row">
              <div className="initial-setup__input-wrap">
                <KeyOutlined aria-hidden="true" />
                <input
                  id="initial-api-key"
                  type="password"
                  value={apiKey}
                  onChange={event => { setApiKey(event.target.value); setError('') }}
                  placeholder={`填写 ${selectedProvider?.name || '供应商'} API Key`}
                  autoComplete="off"
                  disabled={saving || completing}
                />
              </div>
              <button data-app-button="action" type="submit" className="initial-setup__save" disabled={saving || completing || !apiKey.trim()}>
                {saving ? <LoadingOutlined spin /> : hasSavedKey ? '重新保存' : '保存'}
              </button>
            </div>
            <div className={`initial-setup__key-status${hasSavedKey ? ' is-ready' : ''}`}>
              {hasSavedKey ? <><CheckCircleFilled /> API Key 已保存</> : '保存 API Key 后才能继续'}
            </div>
          </form>
        )}

        {needsModelCatalog && hasSavedKey && (
          <div className="initial-setup__field">
            <label>模型{loadingModels ? '（获取中…）' : ''}</label>
            <AppDropdownSelect value={model} options={models.map(value => ({ value, label: value }))}
              onChange={setModel} ariaLabel="选择模型" matchAnchorWidth minMenuWidth={320} />
          </div>
        )}
        {error && <div className="initial-setup__error" role="alert">{error}</div>}
        <button data-app-button="action" type="button" className="initial-setup__continue" onClick={handleContinue} disabled={completing || !canContinue}>
          {completing ? <><LoadingOutlined spin /> 正在进入</> : '下一步'}
        </button>
      </section>
    </main>
  )
}
