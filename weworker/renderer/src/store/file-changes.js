import { create } from 'zustand'
import { useCapabilitiesPanelStore } from './capabilities-panel.js'
import { useUserFilesStore } from './user-files.js'
import { useTerminalStore } from './terminal.js'

export const useFileChangesStore = create(set => ({
  open: false, workId: null, scope: 'chat', records: [], recordId: null, fileIndex: 0,
  openPanel: (workId, records, recordId = records[0]?.id, fileIndex = 0, scope = 'chat') => {
    useCapabilitiesPanelStore.getState().closePanel()
    useUserFilesStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    set({ open: true, workId, scope, records, recordId, fileIndex })
  },
  selectFile: (recordId, fileIndex) => set({ recordId, fileIndex }),
  refreshPanel: (workId, toolIds, records, scope = 'chat') => set(state => {
    if (!state.open || state.workId !== workId || state.scope !== scope || (scope === 'chat' && !state.records.some(record => toolIds.includes(record.toolCallId)))) return state
    const previous = state.records.find(record => record.id === state.recordId)?.files[state.fileIndex]?.path
    const record = records.find(record => record.id === state.recordId) || records.find(record => record.files.length)
    if (!record) return { open: false, records: [] }
    const index = record.files.findIndex(file => file.path === previous)
    return { records, recordId: record.id, fileIndex: Math.max(0, index) }
  }),
  closePanel: () => set({ open: false }),
}))
