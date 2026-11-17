import { backendFetch } from './http.js'
import { checkExplorationModel } from './website-exploration-api.js'

export async function probeExplorationProvider(provider, model, signal) {
  return checkExplorationModel(true, { provider, model, thinking_effort: 'off' }, signal)
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
