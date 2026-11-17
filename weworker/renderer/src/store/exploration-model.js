import { create } from 'zustand'
import * as api from '../api/website-exploration-api.js'

export const useExplorationModelStore = create((set, get) => ({
  data: null,
  revision: 0,
  busy: false,
  error: '',
  load: async () => {
    const revision = get().revision
    try {
      const data = await api.getExplorationModel()
      if (!get().busy && revision === get().revision) set({ data, error: '' })
    } catch (error) { set({ error: error.message }) }
  },
  save: async body => {
    if (get().busy) return false
    set({ busy: true, error: '' })
    try {
      const data = await api.saveExplorationModel(body)
      if (!data.ok) throw new Error(data.detail || '模型验证失败')
      set(state => ({ data, revision: state.revision + 1 }))
      return true
    } catch (error) { set({ error: error.message }); return false }
    finally { set({ busy: false }) }
  },
  activate: async (provider, model) => {
    if (get().busy) return false
    set({ busy: true, error: '' })
    try {
      const data = await api.activateExplorationModel(provider, model)
      if (!data.ok) throw new Error(data.detail || '模型验证失败')
      set(state => ({ data, revision: state.revision + 1 }))
      return true
    } catch (error) { set({ error: error.message }); return false }
    finally { set({ busy: false }) }
  },
}))
