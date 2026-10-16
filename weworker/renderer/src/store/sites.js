import { create } from 'zustand'
import { fetchRouterAliases, fetchSites, setWelcomeVisibility } from '../api/sites-api.js'
import { backendFetch } from '../api/http.js'

const API = 'http://127.0.0.1:8765'

async function reloadSites(set) {
  set({ sites: await fetchSites() })
}

export const useSitesStore = create((set) => ({
  sites: [],
  systemTools: [],
  /**
   * 后端当前生效的 `!别名`（含 `!` 前缀）。输入框据此把 `!xxx` 判成路由命令。
   * 空数组＝「后端没给」，输入框回退到随包静态清单，不影响既有行为。
   */
  routerAliases: [],
  loading: false,
  togglingIds: [],
  toggleError: null,
  refreshSites: async () => {
    try {
      await reloadSites(set)
    } catch {
      // Keep the current list if the backend is temporarily unavailable.
    }
  },

  load: async () => {
    set({ loading: true })
    try {
      const [sites, sysRes, routerAliases] = await Promise.all([
        fetchSites(),
        backendFetch(`${API}/system-tools`),
        fetchRouterAliases().catch(() => []),
      ])
      const systemTools = sysRes.ok ? await sysRes.json() : []
      set({ sites, systemTools, routerAliases, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  setAllWelcomeVisibility: async (visible) => {
    const targetVisible = visible === true
    const enabledIds = useSitesStore.getState().sites.filter((s) => s.enabled).map((s) => s.id)
    set((s) => ({
      sites: s.sites.map((site) =>
        site.enabled ? { ...site, visible: targetVisible } : site
      ),
    }))
    try {
      await setWelcomeVisibility(targetVisible, enabledIds)
      await reloadSites(set)
    } catch {
      await reloadSites(set)
    }
  },

  toggle: async (id) => {
    if (useSitesStore.getState().togglingIds.includes(id)) return
    set((s) => ({ togglingIds: [...s.togglingIds, id], toggleError: null }))
    try {
      const response = await backendFetch(`${API}/sites/${encodeURIComponent(id)}/toggle`, { method: 'POST' })
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.detail || '无法切换 Adapter，请刷新后重试')
      }
      // Reconcile with server response — reload full list to get correct visible state
      await reloadSites(set)
    } catch (error) {
      set({ toggleError: { id, message: error.message } })
      await reloadSites(set).catch(() => {})
    } finally {
      set((s) => ({ togglingIds: s.togglingIds.filter((entry) => entry !== id) }))
    }
  },

  toggleVisibility: async (id) => {
    // Optimistic update
    set((s) => ({
      sites: s.sites.map((site) =>
        site.id === id ? { ...site, visible: !site.visible } : site
      ),
    }))
    try {
      const site = useSitesStore.getState().sites.find(s => s.id === id)
      await backendFetch(`${API}/sites/${encodeURIComponent(id)}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visible: site?.visible ?? false }),
      })
    } catch {
      await reloadSites(set)
    }
  },

  addTestPrompt: async (siteId, prompt) => {
    try {
      await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/test-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      await reloadSites(set)
    } catch (e) {
      console.error('addTestPrompt failed:', e)
    }
  },

  updateTestPrompt: async (siteId, index, prompt) => {
    try {
      await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/test-prompts/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      await reloadSites(set)
    } catch (e) {
      console.error('updateTestPrompt failed:', e)
    }
  },

  deleteTestPrompt: async (siteId, index) => {
    try {
      await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/test-prompts/${index}`, {
        method: 'DELETE',
      })
      await reloadSites(set)
    } catch (e) {
      console.error('deleteTestPrompt failed:', e)
    }
  },

  resetPrompts: async (siteId, type) => {
    try {
      await backendFetch(`${API}/sites/${encodeURIComponent(siteId)}/reset-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })
      await reloadSites(set)
    } catch (e) {
      console.error('resetPrompts failed:', e)
    }
  },
}))
