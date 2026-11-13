import { create } from 'zustand'
import { useCapabilitiesPanelStore } from './capabilities-panel.js'
import { useUserFilesStore } from './user-files.js'
import { useTerminalStore } from './terminal.js'

export const useFileChangesStore = create(set => ({
  open: false, workId: null, records: [], recordId: null, fileIndex: 0,
  openPanel: (workId, records, recordId = records[0]?.id, fileIndex = 0) => {
    useCapabilitiesPanelStore.getState().closePanel()
    useUserFilesStore.getState().closePanel()
    useTerminalStore.getState().closePanel()
    set({ open: true, workId, records, recordId, fileIndex })
  },
  selectFile: (recordId, fileIndex) => set({ recordId, fileIndex }),
  refreshPanel: (workId, toolIds, records) => set(state => {
    if (!state.open || state.workId !== workId || !state.records.some(record => toolIds.includes(record.toolCallId))) return state
    const previous = state.records.find(record => record.id === state.recordId)?.files[state.fileIndex]?.path
    const record = records.find(record => record.id === state.recordId) || records.find(record => record.files.length)
    if (!record) return { open: false, records: [] }
    const index = record.files.findIndex(file => file.path === previous)
    return { records, recordId: record.id, fileIndex: Math.max(0, index) }
  }),
  closePanel: () => set({ open: false }),
}))
