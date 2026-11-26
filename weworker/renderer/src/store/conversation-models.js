import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { backendFetch } from '../api/http.js'
import { useSettingsStore } from './settings.js'

export const modelSelectionPayload = value => ({ provider: value.provider, model: value.model, thinking_effort: value.thinking_effort || 'off',
  ...(value.selection_revision ? { selection_revision: value.selection_revision } : {}) })
async function request(path, body, method = 'POST') {
  const response = await backendFetch(path, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.detail || '会话模型配置失败')
  return value
}
export function createConversationModelsStore(send = request) {
  const loads = new Map()
  let generation = 0
  return create((set, get) => ({
    selections: {}, pending: {}, errors: {},
    resetForGlobalModel() {
      generation++
      loads.clear()
      set({ selections: {}, pending: {}, errors: {} })
    },
    load(scope) {
      if (!scope.startsWith('work:') || get().selections[scope]) return Promise.resolve()
      if (loads.has(scope)) return loads.get(scope)
      const version = generation
      const promise = send(`/works/${encodeURIComponent(scope.slice(5))}/model`)
        .then(value => { if (version === generation) set(s => ({ selections: { ...s.selections, [scope]: value }, errors: { ...s.errors, [scope]: value.error || '' } })) })
        .catch(error => { if (version === generation) set(s => ({ errors: { ...s.errors, [scope]: error.message } })) })
        .finally(() => { if (loads.get(scope) === promise) loads.delete(scope) })
      loads.set(scope, promise)
      return promise
    },
    async save(scope, selection) {
      const version = generation
      const revision = useSettingsStore.getState().modelSelectionRevision
      if (selection.selection_revision && selection.selection_revision !== revision) throw new Error('全局模型已切换，请重新选择')
      if (get().pending[scope]) throw new Error('会话模型正在保存')
      // An initial read must finish before writing, so it cannot overwrite the new selection.
      set(s => ({ pending: { ...s.pending, [scope]: true }, errors: { ...s.errors, [scope]: '' } }))
      try {
        await loads.get(scope)
        if (version !== generation) throw new Error('全局模型已切换，请重新选择')
        const body = modelSelectionPayload({ ...selection, selection_revision: revision })
        const value = await send(scope.startsWith('work:') ? `/works/${encodeURIComponent(scope.slice(5))}/model` : '/chat/model/resolve',
          scope.startsWith('work:') ? body : { selection: body })
        if (version === generation) set(s => ({ selections: { ...s.selections, [scope]: value } }))
        return value
      } catch (error) {
        if (version === generation) set(s => ({ errors: { ...s.errors, [scope]: error.message } }))
        throw error
      } finally { if (version === generation) set(s => ({ pending: { ...s.pending, [scope]: false } })) }
    },
    async saveContextLimit(scope, contextLimit) {
      const version = generation
      if (!scope.startsWith('work:') || !get().selections[scope] || get().pending[scope]) throw new Error('当前对话暂时无法保存上下文上限')
      set(s => ({ pending: { ...s.pending, [scope]: true } }))
      try {
        const value = await send(`/works/${encodeURIComponent(scope.slice(5))}/context-limit`, { context_limit: contextLimit }, 'PATCH')
        if (version === generation) set(s => ({ selections: {
          ...s.selections,
          [scope]: { ...s.selections[scope], context_limit: value.context_limit },
        } }))
      } finally {
        if (version === generation) set(s => ({ pending: { ...s.pending, [scope]: false } }))
      }
    },
    discard(scope) {
      set(s => { const selections = { ...s.selections }; delete selections[scope]; return { selections } })
    },
  }))
}
export const useConversationModelsStore = createConversationModelsStore()
useSettingsStore.subscribe((next, previous) => {
  if (next.modelSelectionRevision !== previous.modelSelectionRevision) useConversationModelsStore.getState().resetForGlobalModel()
})
export function useConversationModel(scope = 'welcome') {
  const stored = useConversationModelsStore(s => s.selections[scope])
  const pending = useConversationModelsStore(s => Boolean(s.pending[scope]))
  const error = useConversationModelsStore(s => s.errors[scope] || '')
  const provider = useSettingsStore(s => s.activeProvider)
  const model = useSettingsStore(s => s.model)
  const contextLimit = useSettingsStore(s => s.contextLimit)
  const settingsLoaded = useSettingsStore(s => s.loaded)
  const revision = useSettingsStore(s => s.modelSelectionRevision)
  const fallback = useMemo(() => ({ provider, model, context_limit: contextLimit, thinking_effort: 'off', ...(revision ? { selection_revision: revision } : {}) }), [provider, model, contextLimit, revision])
  useEffect(() => { if (settingsLoaded) void useConversationModelsStore.getState().load(scope) }, [scope, settingsLoaded, revision])
  return { selection: stored || fallback, pending, error, loaded: settingsLoaded && (!scope.startsWith('work:') || Boolean(stored && !stored.unavailable)) }
}
