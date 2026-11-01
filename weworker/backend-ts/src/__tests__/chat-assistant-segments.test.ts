import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession, PromptQueue } from '../chat-session.js'
import type * as Store from '../works-store.js'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

vi.mock('../config.js', () => ({
  ensureUserDirectory: () => 'C:/weworker-fixtures',
  ensureProjectDirectory: (...segments: string[]) => `C:/weworker-fixtures/${segments.join('/')}`,
}))
const store = await import('../works-store.js')
const { createAssistantSegments } = await import('../chat-assistant-segments.js')
const entry = (message: Store.Message) => ({ id: message.id, role: message.role, digest: createHash('sha256').update(JSON.stringify(message.content)).digest('hex') })

describe('assistant segments around steering', () => {
  beforeEach(() => { store._initTestDb() })

  it('reloads chronological segments and updates late tools in their original message', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      const work = store.createWork('Fixture')
      store.appendMessage(work.id, 'user', [{ type: 'text', text: 'original' }])
      const content: Store.ContentBlock[] = [{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'tool', name: 'Read', args: {}, status: 'running' }]
      const updated = vi.fn()
      const segments = createAssistantSegments(work.id, content, updated)
      const first = segments.checkpoint()!
      store.appendMessage(work.id, 'user', [{ type: 'text', text: 'steer one' }])
      content.push({ type: 'text', text: 'between' })
      segments.checkpoint()
      store.appendMessage(work.id, 'user', [{ type: 'text', text: 'steer two' }])
      content[1] = { ...content[1] as Extract<Store.ContentBlock, { type: 'tool_use' }>, result: 'done', status: 'done' }
      segments.refresh(1)
      content.push({ type: 'text', text: 'after' }, { type: 'timing', totalMs: 100, llmMs: 60, execMs: 40, steps: 1 })
      segments.checkpoint()
      const messages = store.getWorkWithMessages(work.id)!.messages
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
      expect(messages.map(m => m.content.find(b => b.type === 'text'))).toEqual(['original', 'before', 'steer one', 'between', 'steer two', 'after'].map(text => ({ type: 'text', text })))
      expect(messages[1].id).toBe(first.id)
      expect(messages[1].content[1]).toMatchObject({ id: 'tool', status: 'done', result: 'done' })
      expect(messages.flatMap(m => m.content).filter(b => b.type === 'tool_use')).toHaveLength(1)
      expect(messages.flatMap(m => m.content).filter(b => b.type === 'timing')).toHaveLength(1)
      expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }))
    } finally { vi.useRealTimers() }
  })

  it('does not save empty assistant placeholders between consecutive steers', () => {
    const work = store.createWork('Fixture')
    const content: Store.ContentBlock[] = []
    const segments = createAssistantSegments(work.id, content)
    expect(segments.checkpoint()).toBeUndefined()
    store.appendMessage(work.id, 'user', [{ type: 'text', text: 'first' }])
    expect(segments.checkpoint()).toBeUndefined()
    store.appendMessage(work.id, 'user', [{ type: 'text', text: 'second' }])
    content.push({ type: 'text', text: 'answer' })
    segments.checkpoint()
    expect(segments.checkpoint()).toBeUndefined()
    expect(store.getWorkWithMessages(work.id)!.messages.map(m => m.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('reuses the live CLI after split persistence while still rejecting edited history', async () => {
    const work = store.createWork('Fixture')
    const first = store.appendMessage(work.id, 'user', [{ type: 'text', text: 'original' }])
    const uuid = '11111111-1111-4111-8111-111111111111'
    const input: SDKUserMessage = { type: 'user', uuid, session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'steer' } }
    const session = new ChatSession({ workId: work.id, fingerprint: 'fixture', queue: new PromptQueue(), bindings: { workIdRef: { current: work.id }, onAskUser: null, memory: { userPromptInjections: 0, postToolBatchInjections: 0 } }, query: { close() {}, async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init' } as SDKMessage; yield input as SDKMessage; yield { type: 'result', is_error: false, subtype: 'success' } as SDKMessage } } })
    const turn = session.runTurn({ ...input, uuid: undefined })
    await turn.next()
    const content: Store.ContentBlock[] = [{ type: 'tool_use', id: 'tool', name: 'Read', args: {}, status: 'running' }]
    const segments = createAssistantSegments(work.id, content, message => session.refreshSteeredAssistant(entry(message)))
    const previous = segments.checkpoint()!
    const steered = store.appendMessage(work.id, 'user', [{ type: 'text', text: 'steer' }])
    expect(session.steer(input, entry(steered), entry(previous))).toBe(true)
    content[0] = { ...content[0] as Extract<Store.ContentBlock, { type: 'tool_use' }>, status: 'done' }
    segments.refresh(0)
    while (!(await turn.next()).done) { /* consume replay and result */ }
    session.complete([entry(first)])
    content.push({ type: 'text', text: 'after' }); segments.checkpoint()
    store.appendMessage(work.id, 'user', [{ type: 'text', text: 'next' }])
    const history = store.getWorkWithMessages(work.id)!.messages.map(entry)
    expect(session.continues(history)).toBe(true)
    expect(session.continues(history.map((m, i) => i === 1 ? { ...m, digest: 'edited' } : m))).toBe(false)
    expect(session.continues(history.filter(m => m.id !== previous.id))).toBe(false)
    session.close('test')
  })
})
