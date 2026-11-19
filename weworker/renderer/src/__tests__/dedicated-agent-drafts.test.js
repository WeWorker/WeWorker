import test from 'node:test'
import assert from 'node:assert/strict'
import { createDedicatedAgentsStore } from '../store/dedicated-agents.js'
import { agentStatusPresentation } from '../utils/dedicated-agents.js'

function fixture(fetchAgentList = async () => []) {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  return { values, storage, store: createDedicatedAgentsStore({ storage, fetchAgentList }) }
}
const add = (store, name) => {
  store.getState().startCreate()
  const id = store.getState().selectedId
  store.getState().updateDraftAgent({ name }, id)
  return id
}

test('each click creates a separate persistent draft and selection restores its own fields', () => {
  const { store, storage } = fixture()
  const first = add(store, 'Example One')
  store.getState().updateDraftAgent({ siteIds: ['example-site'], workDir: 'C:/weworker-fixtures/workspace', goal: 'Example goal', knowledge: 'Example notes', skillMarkdown: '# Example', wizardStep: 1 }, first)
  const second = add(store, 'Example Two')
  assert.notEqual(first, second)
  assert.equal(store.getState().agents.length, 2)
  store.getState().selectAgent(first)
  assert.equal(store.getState().draftAgentId, first)
  assert.equal(store.getState().view, 'create')
  const restored = createDedicatedAgentsStore({ storage })
  assert.equal(restored.getState().agents.length, 2)
  assert.deepEqual(restored.getState().agents[0].siteIds, ['example-site'])
  assert.equal(restored.getState().agents[0].workDir, 'C:/weworker-fixtures/workspace')
  assert.equal(restored.getState().agents[0].knowledge, 'Example notes')
  assert.equal(restored.getState().agents[0].wizardStep, 1)
  assert.equal(restored.getState().agents[1].goal, undefined)
  assert.equal(agentStatusPresentation(restored.getState().agents[0]).label, '配置中')
})

test('late async updates stay with their draft and backend ID replacement preserves stable identity', () => {
  const { store, storage } = fixture()
  const first = add(store, 'Example One')
  const second = add(store, 'Example Two')
  store.getState().updateDraftAgent({ id: 'saved-example', wizardStep: 3, pairing_code: 'EXAMPLE' }, first)
  store.getState().updateDraftAgent({ skillMarkdown: 'Late result' }, first)
  assert.equal(store.getState().selectedId, second)
  assert.equal(store.getState().draftAgentId, second)
  const saved = store.getState().agents.find(agent => agent.id === 'saved-example')
  assert.equal(saved.draftKey, first)
  assert.equal(saved.skillMarkdown, 'Late result')
  const restored = createDedicatedAgentsStore({ storage })
  restored.getState().selectAgent('saved-example')
  assert.equal(restored.getState().view, 'create')
  restored.getState().updateDraftAgent({ paired: true }, first)
  assert.equal(agentStatusPresentation(restored.getState().agents[0]).label, '配置中')
  restored.getState().completeCreate({ id: 'saved-example', paired: true }, first)
  assert.equal(restored.getState().agents.find(agent => agent.id === second).draft, true)
  assert.equal(restored.getState().agents.find(agent => agent.id === 'saved-example').draft, false)
  assert.equal(createDedicatedAgentsStore({ storage }).getState().agents.length, 1)
})

test('leaving keeps drafts and completing a background draft does not change the active editor', () => {
  const { store } = fixture()
  const first = add(store, 'Example One')
  const second = add(store, 'Example Two')
  store.getState().cancelCreate()
  assert.equal(store.getState().agents.length, 2)
  store.getState().selectAgent(second)
  store.getState().completeCreate({ id: 'saved-example', paired: true }, first)
  assert.equal(store.getState().selectedId, second)
  assert.equal(store.getState().view, 'create')
  assert.equal(store.getState().agents.length, 2)
})

test('remote refresh merges with drafts instead of overwriting them or duplicating created rows', async () => {
  const { store } = fixture(async () => [{ id: 'remote-example', name: 'Remote' }, { id: 'saved-example', name: 'Remote saved' }])
  const first = add(store, 'Example One')
  const second = add(store, 'Example Two')
  store.getState().updateDraftAgent({ id: 'saved-example' }, first)
  await store.getState().loadAgents()
  assert.equal(store.getState().agents.length, 3)
  assert.equal(store.getState().agents.filter(agent => agent.id === 'saved-example').length, 1)
  assert.equal(store.getState().agents.find(agent => agent.id === 'saved-example').name, 'Example One')
  assert.equal(store.getState().selectedId, second)
})

test('draft persistence excludes credentials and configured agents', () => {
  const { store, values, storage } = fixture()
  const id = add(store, 'Example')
  store.getState().updateDraftAgent({ secret: 'EXAMPLE_SECRET', wecom: { secret: 'EXAMPLE_SECRET' }, qr_session_id: 'EXAMPLE_SESSION', channel: 'weixin' }, id)
  store.getState().upsertAgent({ id: 'remote-example', name: 'Configured' })
  const serialized = [...values.values()][0]
  assert.equal(serialized.includes('EXAMPLE_SECRET'), false)
  assert.equal(serialized.includes('EXAMPLE_SESSION'), false)
  const restored = createDedicatedAgentsStore({ storage })
  assert.equal(restored.getState().agents.length, 1)
  assert.equal(restored.getState().agents[0].channel, 'weixin')
})

test('removing a draft only removes that draft and ignores its late update', () => {
  const { store } = fixture()
  const first = add(store, 'Example One')
  const second = add(store, 'Example Two')
  store.getState().removeAgent(first)
  store.getState().updateDraftAgent({ name: 'Late update' }, first)
  assert.deepEqual(store.getState().agents.map(agent => agent.id), [second])
  assert.equal(store.getState().agents[0].name, 'Example Two')
})
