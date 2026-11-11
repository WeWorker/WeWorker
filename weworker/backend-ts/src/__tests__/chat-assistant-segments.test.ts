import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createChatTurnRegistry } from '../chat-turn-lifecycle.js'
import { requestUserChoice, hasPendingAskUser } from '../ask-user-pending.js'
import { configureWorkLogs, readWorkLog } from '../work-log-file.js'
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
  it('persists trailing text and completed results before acknowledging interruption', async () => {
    const work = store.createWork('Fixture')
    store.appendMessage(work.id, 'user', [{ type: 'text', text: 'original goal' }])
    const content: Store.ContentBlock[] = [
      { type: 'text', text: 'earlier answer' },
      { type: 'tool_use', id: 'completed', name: 'Read', args: {}, status: 'done', result: 'keep completed result' },
      { type: 'tool_use', id: 'pending', name: 'Read', args: {}, status: 'running' },
    ]
    const segments = createAssistantSegments(work.id, content)
    segments.checkpoint()
    const registry = createChatTurnRegistry()
    const turn = registry.start(work.id)!
    const choice = requestUserChoice({ workId: work.id, toolCallId: 'pending', question: 'Old question', options: [], onChoice() {}, signal: turn.controller.signal })
    const stopping = registry.stop(work.id)
    expect(turn.controller.signal.aborted).toBe(true)
    expect(await choice).toBe('用户取消了本次操作')
    expect(hasPendingAskUser(work.id)).toBe(false)
    expect(registry.start(work.id)).toBeNull()

    const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    const flushStart = source.indexOf('  const flushText = () => {')
    const flushEnd = source.indexOf('  chatSteeringListeners.set(', flushStart)
    const finalizeStart = source.indexOf('  // Finalize text', flushEnd)
    const finalizeEnd = source.indexOf('  // No automatic memory processing', finalizeStart)
    const scope = vm.createContext({ assistantContent: content, currentText: 'trailing partial answer', segments,
      turnSucceeded: false, observation: undefined, abortController: turn.controller,
      turnTimingResult: { totalMs: 1, llmMs: 1, execMs: 0, steps: 1 },
      turnTiming: { remainingModelMs: () => 1000 }, stepIndex: 1,
    })
    vm.runInContext(ts.transpileModule(source.slice(flushStart, flushEnd) + source.slice(finalizeStart, finalizeEnd), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, scope)
    turn.finish()
    expect(await stopping).toBe('stopped')
    store.appendMessage(work.id, 'user', [{ type: 'text', text: 'correction' }])
    const messages = store.getWorkWithMessages(work.id)!.messages
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
    const blocks = messages.flatMap(message => message.content)
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'text', text: 'earlier answer' }))
    expect(blocks).toContainEqual(expect.objectContaining({ type: 'text', text: 'trailing partial answer' }))
    expect(blocks).toContainEqual(expect.objectContaining({ id: 'completed', result: 'keep completed result', status: 'done' }))
    expect(blocks).toContainEqual(expect.objectContaining({ id: 'pending', status: 'cancelled' }))
  })
  it('appends steering inputs and late tool updates to the same file without replacing earlier entries', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-log-'))
    configureWorkLogs(directory)
    try {
      const work = store.createWork('Fixture')
      store.appendMessage(work.id, 'user', [{ type: 'text', text: 'ORIGINAL' }])
      const content: Store.ContentBlock[] = [{ type: 'tool_use', id: 'tool', name: 'Read', args: {}, status: 'running' }]
      const segments = createAssistantSegments(work.id, content)
      segments.checkpoint()
      const first = fs.readFileSync(path.join(directory, work.id + '.log'), 'utf8')
      store.appendMessage(work.id, 'user', [{ type: 'text', text: 'STEERING-' + 'x'.repeat(3_000) + '-END' }])
      content[0] = { ...content[0] as Extract<Store.ContentBlock, { type: 'tool_use' }>, status: 'done', result: 'TOOL-' + 'r'.repeat(3_000) + '-END' }
      segments.refresh(0)
      const output = readWorkLog({ id: work.id, messages: [] })
      expect(output.startsWith(first)).toBe(true)
      expect(output).toContain('STEERING-' + 'x'.repeat(3_000) + '-END')
      expect(output).toContain('TOOL-' + 'r'.repeat(3_000) + '-END')
      expect(output).toContain('message_updated')
    } finally {
      configureWorkLogs(undefined)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

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
