import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

// Only opaque conversation/exploration IDs are persisted, never input.json or evidence.
const defaultStorage = {
  getItem: key => { try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null } },
  setItem: (key, value) => { try { globalThis.localStorage?.setItem(key, value) } catch { /* Keep in-memory state if storage is unavailable. */ } },
  removeItem: key => { try { globalThis.localStorage?.removeItem(key) } catch {} },
}
export function isDevelopmentSubmitted(handoff, runId = null) {
  return Boolean(handoff?.workId && handoff.runId === runId)
}
export const createExplorationDevelopmentHandoffsStore = (storage = defaultStorage) => create(persist((set) => ({
  handoffs: {},
  record: (explorationId, workId, runId = null) => set(state => ({
    handoffs: { ...state.handoffs, [explorationId]: { workId, runId } },
  })),
  clear: explorationId => set(state => {
    const handoffs = { ...state.handoffs }
    delete handoffs[explorationId]
    return { handoffs }
  }),
}), {
  name: 'weworker-exploration-development-handoffs',
  version: 1,
  storage: createJSONStorage(() => storage),
  partialize: state => ({ handoffs: state.handoffs }),
}))
export const useExplorationDevelopmentHandoffsStore = createExplorationDevelopmentHandoffsStore()
