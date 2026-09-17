import { create } from 'zustand'

export const useExplorationPageStore = create((set) => ({
  open: false,
  openPage: () => set({ open: true }),
  closePage: () => set({ open: false }),
}))
