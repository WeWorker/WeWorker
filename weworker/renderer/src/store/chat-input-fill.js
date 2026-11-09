import { create } from 'zustand'

/** Cross-panel fill for the main chat input (welcome + active work). */
export const useChatInputFillStore = create((set) => ({
  seq: 0,
  text: '',
  scenario: null,
  requestFill: (text, scenario = null) => {
    const trimmed = (text || '').trim()
    if (!trimmed) return
    set((s) => ({
      text: trimmed,
      scenario: trimmed === text ? scenario : null,
      seq: s.seq + 1,
    }))
  },
}))
