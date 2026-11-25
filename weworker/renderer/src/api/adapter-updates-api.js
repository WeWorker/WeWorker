import { backendFetch } from './http.js'

async function request(path, options = {}) {
  const response = await backendFetch(`/adapter-updates${path}`, options)
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || `Adapter 更新请求失败（${response.status}）`)
  }
  if (!['idle', 'checking', 'ready', 'error'].includes(data?.status) || !data.items) {
    throw new Error('无法读取 Adapter 更新状态')
  }
  return data
}

export function fetchAdapterUpdates(signal) {
  return request('', { signal })
}

export function checkAdapterUpdates() {
  return request('/check', { method: 'POST' })
}

export function applyAdapterUpdate(id, version) {
  return request(`/${encodeURIComponent(id)}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  })
}

export function installedAdapterVersion(site) {
  return site?.version || site?.managed?.version || '未知'
}
