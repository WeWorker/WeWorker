import { isFixedProvider, isBuiltinProvider, configuredProvider } from './provider-config.js'
export { isFixedProvider } from './provider-config.js'

export function buildModelOptions(models, currentModel, { annotateCurrent = true, customModels = [] } = {}) {
  const values = [...new Set((Array.isArray(models) ? models : [])
    .map((model) => String(model || '').trim())
    .filter(Boolean))]
  const customValues = [...new Set((Array.isArray(customModels) ? customModels : [])
    .map((model) => String(model || '').trim())
    .filter(Boolean))]
  const customSet = new Set(customValues)
  const allValues = [...new Set([...values, ...customValues])]
  const current = String(currentModel || '').trim()
  return [
    ...(current && !allValues.includes(current)
      ? [{ value: current, label: annotateCurrent ? `${current}（当前配置）` : current, currentOnly: true }]
      : []),
    ...allValues.map((value) => ({ value, label: value, currentOnly: false, ...(customSet.has(value) ? { custom: true } : {}) })),
  ]
}

export function selectModelAfterCatalogRefresh(currentModel, catalog, { customModels = [] } = {}) {
  const current = String(currentModel || '').trim()
  if (current && Array.isArray(customModels) && customModels.includes(current)) return current
  const models = [...new Set((Array.isArray(catalog?.models) ? catalog.models : [])
    .map((model) => String(model || '').trim())
    .filter(Boolean))]
  if (catalog?.source !== 'remote' || models.length === 0) return current
  return current && models.includes(current) ? current : models[0]
}

// Saved keys are intentionally absent from the form. A blank input keeps the
// saved credential; each custom interface must use its own configuration.
export function getModelCatalogIssue(providerId, form, stored = {}, target = 'weworker') {
  const webwright = providerId === 'custom' && target === 'webwright'
  if (providerId === 'custom') {
    const explicitUrl = String(webwright ? form.openai_models_url || '' : form.models_url || '').trim()
    const address = explicitUrl || String(webwright ? form.openai_base_url || '' : form.base_url || '').trim()
    if (!address) return '请先填写接口地址'
    try {
      const url = new URL(address)
      if (!['http:', 'https:'].includes(url.protocol)) return '接口地址须为有效的 HTTP 或 HTTPS URL'
      if (explicitUrl) {
        const fullUrl = webwright ? form.openai_models_url_is_full !== false : form.models_url_is_full !== false
        if (url.username || url.password || url.hash) return '模型列表地址不允许包含用户凭据或片段'
        if (!fullUrl && url.search) return '基础 URL 不支持查询参数，请勾选使用完整 URL'
      }
    } catch {
      return '接口地址须为有效的 HTTP 或 HTTPS URL'
    }
    if (!explicitUrl && (webwright ? form.openai_base_url_is_full : form.base_url_is_full)) {
      return '完整 URL 模式请单独填写模型列表地址'
    }
  }
  const key = String(webwright ? form.openai_api_key || '' : form.api_key || '').trim()
  const hasSavedKey = webwright ? stored.has_openai_key || stored.openai_has_key : stored.has_key
  return key || hasSavedKey ? '' : '请先填写 API Key'
}

export function buildModelCatalogAccess(id, providerId, form, target = 'weworker') {
  if (providerId !== 'custom') return { provider: id, api_key: form.api_key.trim() }
  const webwright = target === 'webwright'
  return {
    provider: id, target,
    api_key: webwright ? '' : form.api_key.trim(),
    openai_api_key: webwright ? form.openai_api_key.trim() : '',
    // An unfinished address in the other section must not block this request.
    base_url: webwright ? '' : form.base_url.trim(),
    base_url_is_full: !webwright && form.base_url_is_full,
    openai_base_url: webwright ? form.openai_base_url.trim() : '',
    openai_base_url_is_full: webwright && form.openai_base_url_is_full,
    auth_type: form.auth_type,
    models_url: webwright ? '' : String(form.models_url || '').trim(),
    models_url_is_full: webwright || form.models_url_is_full !== false,
    models_auth_type: webwright ? 'inherit' : form.models_auth_type || 'inherit',
    openai_models_url: webwright ? String(form.openai_models_url || '').trim() : '',
    openai_models_url_is_full: !webwright || form.openai_models_url_is_full !== false,
    weworker_protocol: form.weworker_protocol || 'anthropic_messages',
  }
}

export function getModelCatalogStatus(catalog, loading, issue = '') {
  if (issue) return { hint: issue, failed: false, detail: '' }
  if (loading) return { hint: '正在获取模型列表…', failed: false, detail: '' }
  if (!catalog) return { hint: '填写正确地址和 API Key 后获取模型', failed: false, detail: '' }
  if (isModelRefreshFailed(catalog)) return {
    hint: '模型列表获取失败，不代表对话不可用',
    failed: true,
    detail: catalog.warning || (catalog.source === 'remote' ? '接口返回空模型列表' : '模型列表获取失败'),
  }
  return { hint: `已获取 ${catalog.models.length} 个模型`, failed: false, detail: catalog.warning || '' }
}

export function isModelRefreshFailed(catalog) {
  return Boolean(catalog && (
    catalog.source !== 'remote'
    || !Array.isArray(catalog.models)
    || catalog.models.length === 0
  ))
}

export function shouldShowModelRefreshFailure(catalog) {
  return Boolean(catalog?.explicitRefresh && isModelRefreshFailed(catalog))
}

export function getVisibleModelRefreshDetail(catalog) {
  if (!catalog?.explicitRefresh) return ''
  if (catalog.warning) return String(catalog.warning)
  if (catalog.source === 'remote' && Array.isArray(catalog.models) && catalog.models.length === 0) {
    return '远程接口返回空模型列表'
  }
  return ''
}

export function buildProbeResultRows(results) {
  const seen = new Map()
  return (Array.isArray(results) ? results : []).map((result) => {
    const protocol = result?.protocol
    const occurrence = seen.get(protocol) || 0
    seen.set(protocol, occurrence + 1)
    const protocolName = protocol === 'anthropic_messages' ? 'Anthropic' : protocol === 'openai_responses' ? 'OpenAI Responses' : protocol === 'openai_chat_completions' ? 'OpenAI Chat Completions' : '模型'
    return { ...result, label: occurrence > 0 ? `${protocolName} 结构化输出接口` : `${protocolName} 接口` }
  })
}

export function buildProviderProbeTargets(providerId, openAiBaseUrl) {
  if (providerId === 'custom' && !String(openAiBaseUrl || '').trim()) return ['weworker']
  return ['weworker', 'webwright']
}

export function buildChatProviderOptions(providerList, providers, activeProvider) {
  const configured = buildSettingsProviderLists(providerList, providers).visible
  const builtin = item => item.builtin || isBuiltinProvider(item.id)
  const custom = id => (providers[id]?.provider_id || id) === 'custom'
  const customReady = id => Boolean(providers[id]?.has_key && String(providers[id]?.base_url || '').trim())
  const visible = configured.filter(item => builtin(item) || (custom(item.id)
    ? customReady(item.id)
    : isFixedProvider(item.id) || providers[item.id]?.has_key))
  if (activeProvider && !visible.some(item => item.id === activeProvider) && !custom(activeProvider)) {
    const fallback = configured.find(item => item.id === activeProvider)
    visible.unshift({ id: activeProvider, name: fallback?.name || activeProvider })
  }
  return visible.map(item => ({
    value: item.id,
    label: item.name,
    keyConfigured: Boolean(builtin(item) || providers[item.id]?.has_key),
  }))
}

export function isProviderVisibleInSettings(provider, stored) {
  if (isFixedProvider(provider?.id)) return true
  if (provider?.builtin) return true
  if (isBuiltinProvider(provider?.id)) return true
  if (!stored) return false
  const model = String(stored.model || '').trim()
  return Boolean(
    stored.visible
    || stored.added
    || stored.has_key
    || (model && model !== (provider.defaultModel || '') && stored.visible === undefined)
    || String(stored.base_url || '').trim()
    || String(stored.openai_base_url || '').trim(),
  )
}

export function buildSettingsProviderLists(providerList, providers) {
  const allProviders = Array.isArray(providerList) ? providerList : []
  const storedProviders = providers || {}
  const visible = allProviders.filter((provider) => isProviderVisibleInSettings(provider, storedProviders[provider.id]))
  for (const [id, configuration] of Object.entries(storedProviders)) {
    const template = allProviders.find(provider => provider.id === configuration.provider_id)
    if (!template || allProviders.some(provider => provider.id === id)) continue
    visible.push({ ...template, id, providerId: template.id })
  }
  const usedNames = new Set(visible.map(provider => isFixedProvider(provider.id) ? provider.name : storedProviders[provider.id]?.name?.trim()).filter(Boolean))
  const namedVisible = visible.map(provider => {
    const supplierName = provider.name || provider.id
    let name = isFixedProvider(provider.id) ? supplierName : storedProviders[provider.id]?.name?.trim()
    if (!name) {
      if (provider.builtin || isBuiltinProvider(provider.id)) {
        name = supplierName
      } else {
        let number = 1
        while (usedNames.has(`${supplierName}(${number})`)) number++
        name = `${supplierName}(${number})`
      }
      usedNames.add(name)
    }
    return { ...provider, supplierName, name }
  })
  const addable = allProviders.filter((provider) => (
    !provider.builtin
    && !isBuiltinProvider(provider.id)
    && (provider.allowMultiple ?? configuredProvider(provider.id)?.allowMultiple) !== false
  ))
  return { visible: namedVisible, addable }
}
