import { create } from 'zustand'
import * as api from '../api/website-exploration-api.js'
import { isDevelopmentSubmitted, useExplorationDevelopmentHandoffsStore as handoffs } from './exploration-development-handoffs.js'
import { getMessageQueue } from './message-queue.js'

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
export function openDevelopmentChat(explorationId, body = {}, runId = null) {
  if (pendingDevelopmentChat) return pendingDevelopmentChat
  if (isDevelopmentSubmitted(handoffs.getState().handoffs[explorationId], runId)) return Promise.resolve(false)
  pendingDevelopmentChat = (async () => {
    if (!await useWebsiteExplorationStore.getState().guard()) return false
    const [{ useWorksStore }, { useChatDraftStore }, { useScheduledTasksStore }, { useDedicatedAgentsStore }] = await Promise.all([
      import('./works.js'), import('./chat-drafts.js'), import('./scheduled-tasks.js'), import('./dedicated-agents.js'),
    ])
    const { work, attachment, prompt } = await api.prepareDevelopmentChat(explorationId, body)
    if (!work?.id || !attachment?.path || typeof prompt !== 'string') throw new Error('开发对话准备失败')
    // The backend always creates a fresh work, so no existing draft is replaced.
    const key = `work:${work.id}`
    useChatDraftStore.getState().setText(key, prompt)
    useChatDraftStore.getState().setAttachments(key, [attachment])
    useWorksStore.setState(state => ({
      works: [work, ...state.works.filter(item => item.id !== work.id)],
      handoffWorkIds: new Set([...state.handoffWorkIds, work.id]),
      messages: { ...state.messages, [work.id]: [] },
    }))
    // A code edit may have appeared while the request was in flight. Keep the
    // prepared chat draft even if the user now chooses to stay in exploration.
    if (!await useWebsiteExplorationStore.getState().guard()) return false
    // Enqueue only after both leave guards accept. The per-work queue survives
    // remounts; ChatView uses its normal send pipeline, never global pending state.
    const queued = getMessageQueue(work.id).enqueue({
      text: prompt, files: [attachment], thinkingEffort: 'off', permissionMode: 'workspace',
    })
    if (!queued) throw new Error('开发对话发送准备失败，请在新对话中重试')
    handoffs.getState().record(explorationId, work.id, runId)
    useChatDraftStore.getState().discard(key)
    useScheduledTasksStore.setState({ activeTaskId: null })
    useDedicatedAgentsStore.setState({ open: false })
    useWorksStore.setState({ activeWorkId: work.id, draftProjectId: null })
    useWebsiteExplorationStore.setState({ open: false })
    return true
  })().finally(() => { pendingDevelopmentChat = null })
  return pendingDevelopmentChat
}

// Destination selection belongs to the development Skill, not to exploration.
export function finishExplorationTransfer({ explorationId, instruction = '', target, runId = null }) {
  return openDevelopmentChat(explorationId, { instruction, ...(target ? { target } : {}) }, runId)
}

// A failed continuation, replay or navigation must not reset the submitted state.
export async function continueWebsiteExploration(explorationId, content, resumable = false) {
  const result = resumable
    ? await api.resumeExploration(explorationId, content)
    : await api.sendExplorationFollowup(explorationId, content)
  handoffs.getState().clear(explorationId)
  return result
}
