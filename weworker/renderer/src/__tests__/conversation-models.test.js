import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationModelsStore, modelSelectionPayload } from '../store/conversation-models.js'

test('conversation model reads and writes are isolated, and drafts use a stateless resolver', async () => {
  const requests = []
  const a = { provider: 'example', model: 'a', thinking_effort: 'off', context_limit: 200000 }
  const b = { provider: 'example', model: 'b', thinking_effort: 'high', context_limit: 128000 }
  const store = createConversationModelsStore(async (path, body) => {
    requests.push({ path, body })
    return body ? { ...(body.selection || body), context_limit: 128000 } : a
  })
  await store.getState().load('work:a')
  await store.getState().save('work:b', b)
  await store.getState().save('welcome', b)
  assert.equal(store.getState().selections['work:a'].model, 'a')
  assert.equal(store.getState().selections['work:b'].model, 'b')
  assert.deepEqual(requests.at(-1), { path: '/chat/model/resolve', body: { selection: modelSelectionPayload(b) } })
  store.getState().discard('welcome')
  assert.equal(store.getState().selections.welcome, undefined)
  assert.equal(store.getState().selections['work:b'].model, 'b')
  assert.equal(requests.some(item => item.path.startsWith('/settings')), false)
})

test('late initial read cannot overwrite a new selection and failed saves preserve it', async () => {
  let resolveRead, fail = false
  const store = createConversationModelsStore(async (_path, body) => {
    if (!body) return new Promise(resolve => { resolveRead = resolve })
    if (fail) throw new Error('Example failure')
    return body
  })
  const reading = store.getState().load('work:a')
  const saving = store.getState().save('work:a', { provider: 'example', model: 'new' })
  resolveRead({ provider: 'example', model: 'old' })
  await Promise.all([reading, saving])
  assert.equal(store.getState().selections['work:a'].model, 'new')
  fail = true
  await assert.rejects(store.getState().save('work:a', { provider: 'example', model: 'failed' }))
  assert.equal(store.getState().selections['work:a'].model, 'new')
  assert.equal(store.getState().pending['work:a'], false)
})
