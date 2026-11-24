import { backendFetch } from './http.js'

function normalizeEntry(raw) {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return null
  const installed = typeof raw.installedVersion === 'string' ? raw.installedVersion : ''
  return {
    id: raw.name,
    name: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    official: raw.official === true,
    iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : '',
    installedVersion: installed,
  }
}

export function normalizeHubEntries(items) {
  return (Array.isArray(items) ? items : []).map(normalizeEntry).filter(Boolean)
}

export async function fetchAdapterHub(signal) {
  const response = await backendFetch('/adapter-hub', { signal })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.detail || data?.error || `读取 AdapterHub 失败（${response.status}）`)
  return normalizeHubEntries(data?.items)
}

export async function installAdapterFromHub(id, version) {
  const response = await backendFetch(`/adapter-hub/${encodeURIComponent(id)}/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.detail || data?.error || '安装 Adapter 失败，请稍后重试。')
  return data
}
