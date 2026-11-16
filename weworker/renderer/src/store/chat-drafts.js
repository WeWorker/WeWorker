import { useCallback } from 'react'
import { create } from 'zustand'

export const EMPTY_CHAT_DRAFT = Object.freeze({ text: '', attachments: Object.freeze([]) })

// Drafts belong to conversations, not to mounted input components.
export const useChatDraftStore = create((set) => {
  const update = (key, patch) => set(state => {
    const draft = { ...(state.drafts[key] ?? EMPTY_CHAT_DRAFT), ...patch }
    if (Object.prototype.hasOwnProperty.call(patch, 'text') && patch.text !== draft.scenarioHint?.text) delete draft.scenarioHint
    if (!draft.scenarioHint) delete draft.scenarioHint
    if (draft.skillTokens?.text !== draft.text || !draft.skillTokens?.items.length) delete draft.skillTokens
    const drafts = { ...state.drafts }
    if (!draft.text && !draft.attachments.length) delete drafts[key]
    else drafts[key] = draft
    return { drafts }
  })
  return {
    drafts: {},
    setText: (key, text) => update(key, { text }),
    setSkillTokens: (key, text, items) => update(key, { skillTokens: { text, items } }),
    fillScenario: (key, text, scenario) => update(key, { text, ...(scenario ? { scenarioHint: { text, scenario } } : { scenarioHint: undefined }) }),
    setAttachments: (key, attachments) => update(key, { attachments }),
    discard: key => set(state => {
      const drafts = { ...state.drafts }
      delete drafts[key]
      return { drafts }
    }),
  }
})

export function useChatDraft(key) {
  const draft = useChatDraftStore(state => state.drafts[key] ?? EMPTY_CHAT_DRAFT)
  const setInputText = useCallback(text => useChatDraftStore.getState().setText(key, text), [key])
  const setAttachments = useCallback(files => useChatDraftStore.getState().setAttachments(key, files), [key])
  return { inputText: draft.text, attachments: draft.attachments, scenarioHint: draft.scenarioHint, setInputText, setAttachments }
}
