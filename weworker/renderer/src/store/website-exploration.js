import { create } from 'zustand'
import * as api from '../api/website-exploration-api.js'

export const useWebsiteExplorationStore = create((set, get) => ({
  open: false, toolkitId: '', toolId: '', workspace: 'explore', explorationContext: null,
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

let pendingDevelopmentChat = null
export function openDevelopmentChat(toolkitId, toolId, body) {
  if (pendingDevelopmentChat) return pendingDevelopmentChat
  pendingDevelopmentChat = (async () => {
    if (!await useWebsiteExplorationStore.getState().guard()) return false
    const [{ useWorksStore }, { useChatDraftStore }, { useScheduledTasksStore }, { useDedicatedAgentsStore }] = await Promise.all([
      import('./works.js'), import('./chat-drafts.js'), import('./scheduled-tasks.js'), import('./dedicated-agents.js'),
    ])
    const { work, attachment, prompt } = await api.prepareDevelopmentChat(toolkitId, toolId, body)
    if (!work?.id || !attachment?.path || typeof prompt !== 'string') throw new Error('开发对话准备失败')
    // The backend always creates a fresh work, so no existing draft is replaced.
    const key = `work:${work.id}`
    useChatDraftStore.getState().setText(key, prompt)
    useChatDraftStore.getState().setAttachments(key, [attachment])
    useWorksStore.setState(state => ({
      works: [work, ...state.works.filter(item => item.id !== work.id)],
      manualStartWorkIds: new Set([...state.manualStartWorkIds, work.id]),
      messages: { ...state.messages, [work.id]: [] },
    }))
    // A code edit may have appeared while the request was in flight. Keep the
    // prepared chat draft even if the user now chooses to stay in exploration.
    if (!await useWebsiteExplorationStore.getState().guard()) return false
    useScheduledTasksStore.setState({ activeTaskId: null })
    useDedicatedAgentsStore.setState({ open: false })
    useWorksStore.setState({ activeWorkId: work.id, draftProjectId: null })
    useWebsiteExplorationStore.setState({ open: false })
    return true
  })().finally(() => { pendingDevelopmentChat = null })
  return pendingDevelopmentChat
}

// Target selection is only a handoff to the main conversation, never a local development page.
export function finishExplorationTransfer({ toolkitId, toolId, explorationId, instruction = '' }) {
  return openDevelopmentChat(toolkitId, toolId, {
    instruction, source_exploration_id: explorationId,
    debug_run_evidence_id: '', exploration_only: true,
  })
}
