import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationModelsStore, modelSelectionPayload, useConversationModelsStore } from '../store/conversation-models.js'
import { useSettingsStore } from '../store/settings.js'

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

test('context budget updates only the requested conversation and preserves the previous limit on error', async () => {
  let failure = false
  const store = createConversationModelsStore(async (path, body, method) => {
    if (!body) return { provider: 'example', model: 'test', context_limit: 200_000 }
    assert.equal(path, '/works/example-a/context-limit')
    assert.equal(method, 'PATCH')
    if (failure) throw new Error('save failed')
    return { context_limit: body.context_limit }
  })
  await store.getState().load('work:example-a')
  await store.getState().load('work:example-b')
  await store.getState().saveContextLimit('work:example-a', 960_000)
  failure = true
  await assert.rejects(store.getState().saveContextLimit('work:example-a', 64_000), /save failed/)
  assert.equal(store.getState().selections['work:example-a'].context_limit, 960_000)
  assert.equal(store.getState().selections['work:example-b'].context_limit, 200_000)
  assert.equal(store.getState().pending['work:example-a'], false)
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

test('global reset discards both cached selections and late reads or writes', async () => {
  let finishRead, finishWrite
  const store = createConversationModelsStore(async (_path, body) => new Promise(resolve => {
    if (body) finishWrite = resolve
    else finishRead = resolve
  }))
  const reading = store.getState().load('work:a')
  const writing = store.getState().save('work:b', { provider: 'example', model: 'old' })
  await Promise.resolve()
  store.getState().resetForGlobalModel()
  finishRead({ provider: 'example', model: 'stale-read' })
  finishWrite({ provider: 'example', model: 'stale-write' })
  await Promise.all([reading, writing])
  assert.deepEqual(store.getState().selections, {})
  assert.deepEqual(store.getState().pending, {})
})

test('a successful global activation clears all conversation overrides and new local choices keep settings unchanged', async () => {
  const previous = useSettingsStore.getState()
  try {
    useSettingsStore.setState({ modelSelectionRevision: 'revision-before' })
    useConversationModelsStore.setState({ selections: { welcome: { provider: 'example', model: 'draft' },
      'work:bot': { provider: 'example', model: 'bot-local' } } })
    useSettingsStore.setState({ activeProvider: 'custom', model: 'global-next', modelSelectionRevision: 'revision-after' })
    assert.deepEqual(useConversationModelsStore.getState().selections, {})
    let request
    const local = createConversationModelsStore(async (_path, body) => { request = body; return body })
    await local.getState().save('work:bot', { provider: 'example', model: 'local-next' })
    assert.equal(request.selection_revision, 'revision-after')
    assert.equal(useSettingsStore.getState().model, 'global-next')
    assert.equal(useSettingsStore.getState().activeProvider, 'custom')
  } finally { useSettingsStore.setState(previous, true) }
})

test('a local switch waiting for an initial read cannot cross a global activation', async () => {
  let finishRead
  let writes = 0
  const store = createConversationModelsStore(async (_path, body) => {
    if (body) { writes++; return body }
    return new Promise(resolve => { finishRead = resolve })
  })
  const reading = store.getState().load('work:a')
  const saving = store.getState().save('work:a', { provider: 'example', model: 'old' })
  store.getState().resetForGlobalModel()
  finishRead({ provider: 'example', model: 'initial' })
  await reading
  await assert.rejects(saving, /全局模型已切换/)
  assert.equal(writes, 0)
})
