import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenWarmupRequest, createChatWarmupScheduler, readPersistedThinkingEffort, shouldWarmupOnTextChange } from '../utils/chat-warmup.js'
import { warmupChat } from '../api/backend.js'

const originalFetch = global.fetch
const originalWindow = global.window

afterEach(() => {
  global.fetch = originalFetch
  global.window = originalWindow
})

describe('chat warm-up', () => {
  it('triggers only when an empty composer starts a model message', () => {
    assert.equal(shouldWarmupOnTextChange('', '查'), true)
    assert.equal(shouldWarmupOnTextChange('  ', '查询订单'), true)
    assert.equal(shouldWarmupOnTextChange('查', '查询'), false)
    assert.equal(shouldWarmupOnTextChange('', '   '), false)
    assert.equal(shouldWarmupOnTextChange('', '!dir'), false)
  })

  it('throttles warm-ups per conversation target', async () => {
    let clock = 0
    const sent = []
    const request = createChatWarmupScheduler({ send: async (...args) => { sent.push(args) }, now: () => clock, intervalMs: 1000 })
    assert.equal(request('work-a', { thinkingEffort: 'low' }), true)
    assert.equal(request('work-a', { thinkingEffort: 'low' }), false)
    assert.equal(request(null, { thinkingEffort: 'medium' }), true)
    clock = 1500
    assert.equal(request('work-a', { thinkingEffort: 'high' }), true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(sent, [
      ['work-a', { thinkingEffort: 'low' }],
      [null, { thinkingEffort: 'medium' }],
      ['work-a', { thinkingEffort: 'high' }],
    ])
  })

  it('ignores send failures', async () => {
    const request = createChatWarmupScheduler({ send: async () => { throw new Error('offline') } })
    assert.equal(request('work-a'), true)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('warms the session as soon as a conversation is opened', () => {
    const storage = { getItem: (key) => (key === 'weworker-thinking-effort-v2' ? 'high' : null) }
    assert.deepEqual(buildOpenWarmupRequest('work-a', storage), {
      workId: 'work-a',
      payload: { thinkingEffort: 'high' },
    })
    // 未持久化 / 取值非法时回落到 off，和输入框的默认值一致。
    assert.equal(readPersistedThinkingEffort({ getItem: () => null }), 'off')
    assert.equal(readPersistedThinkingEffort({ getItem: () => 'nonsense' }), 'off')
    assert.equal(readPersistedThinkingEffort({ getItem: () => { throw new Error('blocked') } }), 'off')
    assert.deepEqual(buildOpenWarmupRequest(null, storage, 'fixture-style'), {
      workId: null, payload: { thinkingEffort: 'high', styleId: 'fixture-style' },
    })
    assert.equal(buildOpenWarmupRequest('', storage).workId, null)
  })

  it('posts to the work or welcome warm-up endpoint', async () => {
    global.window = {}
    const calls = []
    global.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ status: 'starting' }) }
    }
    assert.deepEqual(await warmupChat('work-a', { thinkingEffort: 'low', styleId: 'ignored' }), { status: 'starting' })
    await warmupChat(null, { thinkingEffort: 'medium', styleId: 'engineer-professional' })
    assert.equal(calls[0].url, 'http://127.0.0.1:8765/works/work-a/warmup')
    assert.deepEqual(calls[0].body, { thinkingEffort: 'low' })
    assert.equal(calls[1].url, 'http://127.0.0.1:8765/chat/warmup')
    assert.deepEqual(calls[1].body, { thinkingEffort: 'medium', zcfRole: 'engineer-professional' })
    await warmupChat(null, { modelSelection: { provider: 'example', model: 'session-model', thinking_effort: 'high', context_limit: 128000 } })
    assert.deepEqual(calls[2].body, { modelSelection: { provider: 'example', model: 'session-model', thinking_effort: 'high' } })
  })
})
