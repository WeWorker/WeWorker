import test from 'node:test'
import assert from 'node:assert/strict'
import { scenarioHintForCard, scenarioForSend } from '../utils/scenario-hint.js'
import { useChatDraftStore } from '../store/chat-drafts.js'
import { createMessageQueue } from '../utils/message-queue.js'

const site = { id: 'example.com', promptVarDisplay: { item: { resolve: '示例商品' } } }
const card = { id: 'lookup', prompts: [{ text: '查询${item}的状态' }] }

test('only genuine matching card templates create hints with named slot values', () => {
  assert.deepEqual(scenarioHintForCard(site, card, '查询示例商品的状态', card.prompts[0].text), {
    adapterId: 'example.com', scenarioId: 'lookup', slots: { item: '示例商品' },
  })
  assert.deepEqual(scenarioHintForCard(site, card, '查询自选商品的状态', card.prompts[0].text, { 0: '自选商品' })?.slots, { item: '自选商品' })
  assert.equal(scenarioHintForCard(site, card, '查询示例商品的状态', '其它模板'), null)
  assert.equal(scenarioHintForCard(site, { ...card, id: null }, '查询示例商品的状态', card.prompts[0].text), null)
  assert.equal(scenarioHintForCard(site, card, '查询改写的状态', card.prompts[0].text), null)
  assert.equal(scenarioHintForCard(site, { id: 'fallback', prompts: [] }, '描述', ''), null)
})

test('send-time match rejects edits, attachments and model text transformations', () => {
  const scenario = { adapterId: 'example.com', scenarioId: 'lookup', slots: { item: '示例商品' } }
  const hint = { text: '查询示例商品的状态', scenario }
  assert.deepEqual(scenarioForSend(hint, hint.text), scenario)
  assert.equal(scenarioForSend(hint, '查询其它商品的状态'), undefined)
  assert.equal(scenarioForSend(hint, hint.text, [{ name: 'file.txt' }]), undefined)
  assert.equal(scenarioForSend(hint, hint.text, [], '附加上下文'), undefined)
})

test('draft edits clear hints and a subsequent card fill restores only the new hint', () => {
  const drafts = useChatDraftStore.getState()
  drafts.fillScenario('test', '查询示例商品的状态', { scenarioId: 'lookup' })
  assert.equal(useChatDraftStore.getState().drafts.test.scenarioHint.text, '查询示例商品的状态')
  drafts.setText('test', '查询自选商品的状态')
  assert.equal(useChatDraftStore.getState().drafts.test.scenarioHint, undefined)
  drafts.fillScenario('test', '查询示例商品的状态', { scenarioId: 'lookup' })
  drafts.discard('test')
  assert.equal(useChatDraftStore.getState().drafts.test, undefined)
})

test('queued message edit drops stale hint but unchanged save keeps it', async () => {
  const q = createMessageQueue()
  const hint = { text: '查询示例商品的状态', scenario: { scenarioId: 'lookup' } }
  const id = q.enqueue({ text: hint.text, scenarioHint: hint })
  q.beginEdit(id)
  q.saveEdit(id, hint.text)
  assert.deepEqual(q.snapshot().items[0].scenarioHint, hint)
  q.beginEdit(id)
  q.saveEdit(id, '查询自选商品的状态')
  assert.equal(q.snapshot().items[0].scenarioHint, null)
  q.dispose()
})
