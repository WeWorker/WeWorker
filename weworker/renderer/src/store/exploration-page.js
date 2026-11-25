import { create } from 'zustand'
import { changeWebsiteContext } from './website-exploration.js'

export const useExplorationPageStore = create((set) => ({
  open: false,
  // Legacy callers enter the same workshop; no second capture/generation UI.
  openPage: async () => {
    if (await changeWebsiteContext({ open: true, workspace: 'explore' })) set({ open: false })
  },
  closePage: () => set({ open: false }),
}))
