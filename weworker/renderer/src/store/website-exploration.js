import { create } from 'zustand'
import * as api from '../api/website-exploration-api.js'
import { isDevelopmentSubmitted, useExplorationDevelopmentHandoffsStore as handoffs } from './exploration-development-handoffs.js'
import { getMessageQueue } from './message-queue.js'
import { explorationDevelopmentPermissionSettings, readChatPermissionMode } from '../utils/chat-permission-preferences.js'

export const useWebsiteExplorationStore = create((set, get) => ({
  open: false, activeDevelopmentWorkId: null, toolkitId: '', toolId: '', workspace: 'explore', explorationContext: null,
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

// Reuse normal work-scoped state without selecting or adding to the main list.
export async function rememberDevelopmentSession(session) {
  const { useWorksStore } = await import('./works.js')
  useWorksStore.setState(state => ({
    embeddedWorks: { ...state.embeddedWorks, [session.work.id]: session.work },
    handoffWorkIds: new Set([...state.handoffWorkIds, session.work.id]),
  }))
  handoffs.getState().remember(session)
}

export async function startDevelopmentSession(session) {
  const [{ useWorksStore }, { useChatDraftStore }] = await Promise.all([import('./works.js'), import('./chat-drafts.js')])
  const workId = session.work.id
  const queue = getMessageQueue(workId)
  const state = useWorksStore.getState()
  // Refreshes and remounts must not resend an accepted or queued first turn.
  if (session.needsInitialMessage !== false && !state.messages[workId]?.length && !state.streamingWorkIds.has(workId)
      && !queue.snapshot().running && !queue.snapshot().items.length) {
    if (!queue.enqueue({ text: session.prompt, files: [session.attachment], thinkingEffort: 'off', permissionMode: readChatPermissionMode(explorationDevelopmentPermissionSettings(workId)) })) {
      throw new Error('网站适配器生成请求准备失败，请重试')
    }
    const key = 'work:' + workId
    const draft = useChatDraftStore.getState().drafts[key]
    if (draft?.text === session.prompt && draft.attachments?.length === 1 && draft.attachments[0].path === session.attachment.path) {
      useChatDraftStore.getState().discard(key)
    }
  }
}

const pendingDevelopmentChats = new Map()
export function openDevelopmentChat(explorationId, body = {}, runId = null) {
  const requestKey = JSON.stringify([explorationId, runId])
  if (pendingDevelopmentChats.has(requestKey)) return pendingDevelopmentChats.get(requestKey)
  if (isDevelopmentSubmitted(handoffs.getState().handoffs[explorationId], runId)
      && Object.values(handoffs.getState().sessions).some(s => s.explorationId === explorationId && s.runId === runId)) return Promise.resolve(false)
  const pending = (async () => {
    if (!await useWebsiteExplorationStore.getState().guard()) return false
    const { useChatDraftStore } = await import('./chat-drafts.js')
    const result = await api.prepareDevelopmentChat(explorationId, { ...body, run_id: runId })
    const { work, attachment, prompt } = result
    if (!work?.id || !attachment?.path || typeof prompt !== 'string') throw new Error('网站适配器生成准备失败')
    const session = { ...result, explorationId, runId: result.runId ?? runId }
    const key = 'work:' + work.id
    // Only seed a genuinely empty first turn; reopening must preserve user drafts.
    if (result.needsInitialMessage !== false && !useChatDraftStore.getState().drafts[key]) {
      useChatDraftStore.getState().setText(key, prompt)
      useChatDraftStore.getState().setAttachments(key, [attachment])
    }
    if (!await useWebsiteExplorationStore.getState().guard()) return false
    await startDevelopmentSession(session)
    await rememberDevelopmentSession(session)
    handoffs.getState().record(explorationId, work.id, session.runId)
    // Stay in the exploration page; main selection, drafts and pending inputs are untouched.
    return true
  })().finally(() => { pendingDevelopmentChats.delete(requestKey) })
  pendingDevelopmentChats.set(requestKey, pending)
  return pending
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
