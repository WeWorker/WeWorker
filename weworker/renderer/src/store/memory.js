import { create } from 'zustand'
import { backendFetch } from '../api/http.js'
import { MEMORY_FILTER_ALL } from '../utils/memory-settings.js'

const API = 'http://127.0.0.1:8765'

// 记忆面板专用 store：/memory/* 与 /settings/* 是两组独立资源，复用 useSettingsStore
// 会把记忆状态混进设置快照（settingsPatch 也没有对应字段），所以单独建 store。
let recordsRequestId = 0

export const useMemoryStore = create((set, get) => ({
  settings: null,
  settingsLoaded: false,
  records: [],
  archivedWorks: [],
  loadingSettings: false,
  savingBudgets: false,
  loadingRecords: false,
  deletingId: null,
  loadingArchivedWorks: false,
  restoringWorkId: null,

  /** GET /memory/settings */
  loadSettings: async () => {
    set({ loadingSettings: true })
    try {
      const res = await backendFetch(`${API}/memory/settings`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || '记忆设置加载失败')
      set({ settings: data, settingsLoaded: true })
      return data
    } finally {
      set({ loadingSettings: false })
    }
  },

  /** POST /memory/settings，成功后用返回结构刷新整个面板 */
  saveBudgets: async (memoryBudgets, scheduledTaskHistoryLimit) => {
    set({ savingBudgets: true })
    try {
      const res = await backendFetch(`${API}/memory/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memory_budgets: memoryBudgets,
          ...(scheduledTaskHistoryLimit !== undefined ? { scheduled_task_history_limit: scheduledTaskHistoryLimit } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || '保存失败')
      set({ settings: data, settingsLoaded: true })
      return data
    } finally {
      set({ savingBudgets: false })
    }
  },

  /** GET /memory/records（type 省略或 'all' 表示全部） */
  loadRecords: async (type = MEMORY_FILTER_ALL) => {
    const requestId = recordsRequestId + 1
    recordsRequestId = requestId
    set({ loadingRecords: true })
    try {
      const query = type && type !== MEMORY_FILTER_ALL ? `?type=${encodeURIComponent(type)}` : ''
      const res = await backendFetch(`${API}/memory/records${query}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || '记忆列表加载失败')
      if (recordsRequestId !== requestId) return get().records
      const records = Array.isArray(data?.records) ? data.records : []
      set({ records })
      return records
    } finally {
      if (recordsRequestId === requestId) set({ loadingRecords: false })
    }
  },

  loadArchivedWorks: async () => {
    set({ loadingArchivedWorks: true })
    try {
      const res = await backendFetch(`${API}/works/archived`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || '归档对话加载失败')
      const works = Array.isArray(data) ? data : []
      set({ archivedWorks: works })
      return works
    } finally {
      set({ loadingArchivedWorks: false })
    }
  },

  restoreArchivedWork: async (id) => {
    if (!id) throw new Error('缺少对话 ID')
    set({ restoringWorkId: id })
    try {
      const res = await backendFetch(`${API}/works/${encodeURIComponent(id)}/archive`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: false }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || '恢复对话失败')
      set((state) => ({ archivedWorks: state.archivedWorks.filter((work) => work.id !== id) }))
      return data
    } finally {
      set({ restoringWorkId: null })
    }
  },

  /** DELETE /memory/records/:id，成功后从列表移除 */
  deleteRecord: async (id) => {
    if (!id) throw new Error('缺少记忆 ID')
    set({ deletingId: id })
    try {
      const res = await backendFetch(`${API}/memory/records/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || '删除失败')
      set((state) => ({ records: state.records.filter((record) => record?.id !== id) }))
      return data
    } finally {
      set({ deletingId: null })
    }
  },
}))
