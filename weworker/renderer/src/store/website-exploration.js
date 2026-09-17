import { create } from 'zustand'
import * as api from '../api/website-exploration-api.js'

export const useWebsiteExplorationStore = create((set, get) => ({
  open: false, toolkitId: '', toolId: '', workspace: 'explore',
  drafts: {}, selections: {}, scrolls: {}, codeDraft: null, leaveRequest: null,
  activity: { running: false }, connection: 'starting',
  setContext: (patch) => set(patch),
  setDraft: (key, value) => set(s => ({ drafts: { ...s.drafts, [key]: value } })),
  selectRecord: (key, value) => set(s => ({ selections: { ...s.selections, [key]: value } })),
  setCodeDraft: (value) => set({ codeDraft: value }),
  saveCode: async () => {
    const draft = get().codeDraft
    if (!draft) return
    await api.updateDevelopmentCode(draft.toolkitId, draft.toolId, draft.code, draft.hash)
    set({ codeDraft: null })
  },
  guard: () => {
    if (!get().codeDraft) return Promise.resolve(true)
    if (get().leaveRequest) return Promise.resolve(false)
    return new Promise(resolve => set({ leaveRequest: resolve }))
  },
  resolveLeave: (allowed) => {
    const resolve = get().leaveRequest
    set({ leaveRequest: null })
    resolve?.(allowed)
  },
}))

export async function leaveWebsiteExploration() {
  const state = useWebsiteExplorationStore.getState()
  if (!state.open) return true
  if (!await state.guard()) return false
  useWebsiteExplorationStore.setState({ open: false })
  return true
}

export async function changeWebsiteContext(patch) {
  if (!await useWebsiteExplorationStore.getState().guard()) return false
  useWebsiteExplorationStore.setState(patch)
  return true
}
