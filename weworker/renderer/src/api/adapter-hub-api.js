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
    totalBytes: Number.isSafeInteger(raw.totalBytes) && raw.totalBytes > 0 ? raw.totalBytes : undefined,
    unavailableReason: typeof raw.unavailableReason === 'string' ? raw.unavailableReason : '',
    action: raw.action === 'install' || raw.action === 'update' ? raw.action
      : raw.action === undefined && raw.version && raw.version !== installed ? (installed ? 'update' : 'install') : null,
  }
}

export function normalizeHubEntries(items) {
  return (Array.isArray(items) ? items : []).map(normalizeEntry).filter(Boolean)
}

export async function fetchAdapterHub({ page, query, signal }) {
  const params = new URLSearchParams({ page: String(page) })
  if (query) params.set('q', query)
  const response = await backendFetch(`/adapter-hub?${params}`, { signal })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.detail || data?.error || `读取 AdapterHub 失败（${response.status}）`)
  if (!Array.isArray(data?.items) || data.page !== page || typeof data.hasMore !== 'boolean') {
    throw new Error('无法读取 AdapterHub 目录分页。')
  }
  return { items: normalizeHubEntries(data.items), hasMore: data.hasMore }
}

export async function fetchAdapterHubDetail(id, signal) {
  const response = await backendFetch(`/adapter-hub/${encodeURIComponent(id)}/detail`, { signal })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.detail || '无法读取 AdapterHub 详情。')
  return data
}

export async function fetchAdapterHubInstallProgress(signal) {
  const response = await backendFetch('/adapter-hub/install-progress', { signal })
  if (!response.ok) throw new Error('无法读取下载进度。')
  const data = await response.json()
  if (!Array.isArray(data?.items)) throw new Error('无法读取下载进度。')
  return data.items
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
