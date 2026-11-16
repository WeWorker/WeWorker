import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { backendFetch } from '../api/http.js'
import { useSettingsStore } from './settings.js'

export const modelSelectionPayload = value => ({ provider: value.provider, model: value.model, thinking_effort: value.thinking_effort || 'off' })
async function request(path, body) {
  const response = await backendFetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.detail || '会话模型配置失败')
  return value
}
export function createConversationModelsStore(send = request) {
  const loads = new Map()
  return create((set, get) => ({
    selections: {}, pending: {}, errors: {},
    load(scope) {
      if (!scope.startsWith('work:') || get().selections[scope]) return Promise.resolve()
      if (loads.has(scope)) return loads.get(scope)
      const promise = send(`/works/${encodeURIComponent(scope.slice(5))}/model`)
        .then(value => set(s => ({ selections: { ...s.selections, [scope]: value }, errors: { ...s.errors, [scope]: value.error || '' } })))
        .catch(error => set(s => ({ errors: { ...s.errors, [scope]: error.message } })))
        .finally(() => loads.delete(scope))
      loads.set(scope, promise)
      return promise
    },
    async save(scope, selection) {
      if (get().pending[scope]) throw new Error('会话模型正在保存')
      // An initial read must finish before writing, so it cannot overwrite the new selection.
      set(s => ({ pending: { ...s.pending, [scope]: true }, errors: { ...s.errors, [scope]: '' } }))
      try {
        await loads.get(scope)
        const body = modelSelectionPayload(selection)
        const value = await send(scope.startsWith('work:') ? `/works/${encodeURIComponent(scope.slice(5))}/model` : '/chat/model/resolve',
          scope.startsWith('work:') ? body : { selection: body })
        set(s => ({ selections: { ...s.selections, [scope]: value } }))
        return value
      } catch (error) {
        set(s => ({ errors: { ...s.errors, [scope]: error.message } }))
        throw error
      } finally { set(s => ({ pending: { ...s.pending, [scope]: false } })) }
    },
    discard(scope) {
      set(s => { const selections = { ...s.selections }; delete selections[scope]; return { selections } })
    },
  }))
}
export const useConversationModelsStore = createConversationModelsStore()
export function useConversationModel(scope = 'welcome') {
  const stored = useConversationModelsStore(s => s.selections[scope])
  const pending = useConversationModelsStore(s => Boolean(s.pending[scope]))
  const error = useConversationModelsStore(s => s.errors[scope] || '')
  const provider = useSettingsStore(s => s.activeProvider)
  const model = useSettingsStore(s => s.model)
  const contextLimit = useSettingsStore(s => s.contextLimit)
  const settingsLoaded = useSettingsStore(s => s.loaded)
  const fallback = useMemo(() => ({ provider, model, context_limit: contextLimit, thinking_effort: 'off' }), [provider, model, contextLimit])
  useEffect(() => { if (settingsLoaded) void useConversationModelsStore.getState().load(scope) }, [scope, settingsLoaded])
  return { selection: stored || fallback, pending, error, loaded: settingsLoaded && (!scope.startsWith('work:') || Boolean(stored && !stored.unavailable)) }
}
