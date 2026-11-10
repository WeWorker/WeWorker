import { create } from 'zustand'
import { backendFetch } from '../api/http.js'

const STORAGE_KEY = 'weworker-model-health-v1'
export const modelHealthKey = (provider, model) => JSON.stringify([provider, model])

function readHistory(storage) {
  try {
    const data = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')
    return Object.fromEntries(Object.entries(data).filter(([, value]) => (
      typeof value?.ok === 'boolean' && Number.isFinite(value.checkedAt)
      && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0
    )))
  } catch {
    return {}
  }
}

async function requestProbe(provider, model) {
  const response = await backendFetch('/settings/provider/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Ignore the exploration address, including an incomplete saved URL.
    body: JSON.stringify({ provider, model, target: 'weworker', openai_base_url: '', openai_base_url_is_full: false }),
    signal: AbortSignal.timeout(35000),
  })
  const data = await response.json()
  if (!response.ok) return { ok: false, error: 'request_failed' }
  return data
}

export function createModelHealthStore({ storage, probe = requestProbe, now = Date.now } = {}) {
  const batches = new Map()
  const probes = new Map()
  return create((set, get) => ({
    results: readHistory(storage),
    running: {},
    checking: {},
    cancelBatch(provider) {
      const batch = batches.get(provider)
      if (batch) batch.cancelled = true
    },
    checkModel(provider, value) {
      const model = String(value || '').trim()
      if (!provider || !model) return Promise.resolve()
      const key = modelHealthKey(provider, model)
      if (probes.has(key)) return probes.get(key).promise
      // A manually selected queued model starts now instead of being probed again later.
      const queue = batches.get(provider)?.queue
      const index = queue?.indexOf(model) ?? -1
      if (index >= 0) queue.splice(index, 1)
      let finish
      const promise = new Promise(resolve => { finish = resolve })
      probes.set(key, { provider, promise })
      set(state => ({ running: { ...state.running, [provider]: true }, checking: { ...state.checking, [key]: true } }))
      void (async () => {
        const started = now()
        let result
        try { result = await probe(provider, model) }
        catch (error) { result = { ok: false, error: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error' } }
        const record = {
          ok: result.ok === true,
          elapsedMs: Number.isFinite(result.elapsed_ms) ? Math.max(1, Math.round(result.elapsed_ms)) : Math.max(1, now() - started),
          checkedAt: Number.isFinite(result.checked_at) ? result.checked_at : now(),
          error: result.error || '',
        }
        probes.delete(key)
        set(state => ({ results: { ...state.results, [key]: record }, checking: { ...state.checking, [key]: false },
          running: { ...state.running, [provider]: batches.has(provider) || [...probes.values()].some(item => item.provider === provider) } }))
        // Keep only status metadata, never credentials or upstream response bodies.
        try { storage?.setItem(STORAGE_KEY, JSON.stringify(get().results)) } catch {}
        finish()
      })()
      return promise
    },
    async checkModels(provider, models) {
      // Repeated clicks and multiple mounted selectors share one batch.
      if (batches.has(provider)) return batches.get(provider).promise
      const queue = [...new Set(models.map(model => String(model || '').trim()).filter(Boolean))]
      if (!provider || !queue.length) return
      const batch = { cancelled: false, promise: null, queue }
      batches.set(provider, batch)
      set(state => ({ running: { ...state.running, [provider]: true } }))
      const worker = async () => {
        while (queue.length && !batch.cancelled) {
          const model = queue.shift()
          await get().checkModel(provider, model)
        }
      }
      // A small pool avoids sending the whole provider catalog simultaneously.
      batch.promise = Promise.all([worker(), worker()]).finally(() => {
        batches.delete(provider)
        set(state => ({ running: { ...state.running, [provider]: [...probes.values()].some(item => item.provider === provider) } }))
      })
      return batch.promise
    },
  }))
}

let storage
try { storage = globalThis.localStorage } catch {}
export const useModelHealthStore = createModelHealthStore({ storage })
