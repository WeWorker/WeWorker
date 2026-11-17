import { backendFetch } from './http.js'
import { checkExplorationModel, getExplorationModel } from './website-exploration-api.js'

export async function probeSavedExplorationModel(signal) {
  const settings = await getExplorationModel(signal)
  const configured = settings.providers?.filter(item => item.configured) || []
  const provider = configured.find(item => item.id === settings.active_provider) || configured[0]
  if (!provider) return { ok: false, error: 'not_configured', detail: '尚未配置网站探索模型，请先验证并保存' }
  return checkExplorationModel(true, {
    provider: `__exploration__:${provider.id}`, model: provider.model, thinking_effort: 'off',
  }, signal)
}

export async function fetchProviderModels(access, signal) {
  const response = await backendFetch('/settings/provider/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(access),
    signal,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || '模型列表获取失败')
  return data
}
