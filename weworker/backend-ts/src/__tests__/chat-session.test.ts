import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import type { Message } from '../works-store.js'

const mocks = vi.hoisted(() => ({ query: vi.fn(), directory: '', mcpContexts: [] as unknown[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }))
vi.mock('../config.js', () => ({
  getConfigDirectory: () => mocks.directory,
  getUserDirectory: () => path.join(mocks.directory, 'user-files'),
  getOpenBrowserAllowedOrigins: () => [],
  getUserDirectoryBlacklist: () => [],
  getSiteEnabled: () => false,
}))
vi.mock('../tools.js', () => ({
  buildMcpServer: (context: unknown) => {
    mocks.mcpContexts.push(context)
    return {}
  },
  getMcpToolDefinitionSummary: () => '',
}))
vi.mock('../logger.js', () => ({ createLogger: () => ({ info() {}, error() {}, warn() {}, debug() {} }) }))
vi.mock('../zcf-sync.js', () => ({ composeSystemPromptWithZcf: (prompt: string) => prompt }))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))
vi.mock('../user-directory-access.js', () => ({
  buildAgentFilesystemSettings: () => ({}),
  createUnifiedToolGuard: () => async () => ({ behavior: 'allow' }),
}))

import { buildPromptString, HISTORY_REPLAY_HEADER, streamChat } from '../agent.js'
import {
  ChatSession,
  PromptQueue,
  disposeAllChatSessions,
  disposeChatSession,
  listChatSessions,
  registerChatSession,
  sweepIdleChatSessions,
  CHAT_SESSION_IDLE_MS,
  CHAT_SESSION_MAX_SESSIONS,
  CHAT_SESSION_WARM_IDLE_MS,
} from '../chat-session.js'
import { clearDesktopAdapterCatalogCache } from '../adapter-catalog-cache.js'

type Request = { prompt: string | AsyncIterable<{ message: { content: string } }>; options: Record<string, any> }

/** Fake CLI: streaming input answers every pushed message; a string prompt answers once. */
function installFakeCli(behavior: { hold?: Promise<void>; toolCall?: boolean; failTurn?: number } = {}) {
  const sessions: Array<{ request: Request; received: string[]; closed: boolean }> = []
  mocks.query.mockImplementation((request: Request) => {
    const state = { request, received: [] as string[], closed: false }
    sessions.push(state)
    let release: () => void = () => {}
    const closedSignal = new Promise<void>((resolve) => { release = resolve })
    const answer = async function* (index: number) {
      yield { type: 'system', subtype: 'init', session_id: 'fixture-session' }
      if (behavior.toolCall) {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: { command: 'webcli call example.com.list' } }] } }
        await Promise.race([behavior.hold, closedSignal])
        if (state.closed) return
      }
      const failed = behavior.failTurn === index
      yield { type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, errors: failed ? ['fixture failure'] : [], result: `reply ${index}`, usage: { input_tokens: 10, output_tokens: 2 } }
    }
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof request.prompt === 'string') {
          state.received.push(request.prompt)
          yield* answer(1)
          return
        }
        let index = 0
        for await (const message of request.prompt) {
          if (state.closed) return
          state.received.push(message.message.content)
          index += 1
          yield* answer(index)
          if (state.closed) return
        }
      },
      close() {
        state.closed = true
        release()
      },
    }
  })
  return sessions
}

function message(id: string, text: string, role: Message['role'] = 'user'): Message {
  return { id, work_id: 'work-a', role, content: [{ type: 'text', text }], created_at: '' }
}

const settings = { active_provider: 'anthropic', api_key: 'test-only', base_url: 'https://api.anthropic.com', model: 'test-model', context_limit: 1_000_000 } as Settings
const baseOptions = { workId: 'work-a', memoryEnabled: false, reuseSession: true }

async function collect(messages: Message[], overrides: Record<string, unknown> = {}, turnSettings = settings, abort?: AbortController) {
  const events = []
  for await (const event of streamChat(messages, turnSettings, abort, { ...baseOptions, ...overrides })) events.push(event)
  return events
}

beforeEach(() => {
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-chat-session-test-'))
  const builtinDir = path.join(mocks.directory, 'builtin')
  fs.mkdirSync(builtinDir, { recursive: true })
  fs.writeFileSync(path.join(builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: [] }))
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public')
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', builtinDir)
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', path.join(mocks.directory, 'adapters'))
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', path.join(mocks.directory, 'adapters'))
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', path.join(mocks.directory, 'adapter-data'))
  vi.stubEnv('WEWORKER_CLAUDE_CODE_PATH', process.execPath)
  clearDesktopAdapterCatalogCache()
  mocks.query.mockReset()
  mocks.mcpContexts.length = 0
})

afterEach(() => {
  disposeAllChatSessions('test')
  clearDesktopAdapterCatalogCache()
  vi.unstubAllEnvs()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

describe('desktop chat session reuse', () => {
  it('replays history with a readable header', () => {
    const prompt = buildPromptString([message('u1', '第一问'), message('a1', '第一答', 'assistant'), message('u2', '第二问')])
    expect(prompt.startsWith(`${HISTORY_REPLAY_HEADER}\n`)).toBe(true)
    expect(prompt).toContain('[当前用户消息]\n第二问')
  })

  it('keeps one CLI for consecutive turns and sends only the new message', async () => {
    const sessions = installFakeCli()
    const first = [message('u1', '第一问')]
    await collect(first)
    const second = [...first, message('a1', 'reply 1', 'assistant'), message('u2', '第二问')]
    const events = await collect(second)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(typeof sessions[0].request.prompt).not.toBe('string')
    expect(sessions[0].received).toEqual(['第一问', '第二问'])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(listChatSessions()).toEqual([{ workId: 'work-a', busy: false, turns: 2 }])
  })

  it('starts a fresh CLI from stored history when earlier messages changed', async () => {
    const sessions = installFakeCli()
    await collect([message('u1', '第一问')])
    await collect([message('u1-edited', '改过的问题'), message('a1', 'reply 1', 'assistant'), message('u2', '第二问')])
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(sessions[0].closed).toBe(true)
    expect(sessions[1].received[0]).toContain(HISTORY_REPLAY_HEADER)
    expect(sessions[1].received[0]).toContain('改过的问题')
  })

  it('keeps the current site toolkit prompt on both the first and reused turns', async () => {
    const sessions = installFakeCli()
    const first = [message('u1', 'First site question')]
    await collect(first, { siteToolkitPrompt: 'Site A tool catalog' })
    await collect([...first, message('a1', 'reply 1', 'assistant'), message('u2', 'Second site question')], {
      siteToolkitPrompt: 'Site B tool catalog',
    })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(sessions[0].received[0]).toContain('Site A tool catalog')
    expect(sessions[0].received[1]).toBe('Site B tool catalog\n\nSecond site question')
  })

  it('injects site toolkit context after adopting a prewarmed session', async () => {
    const sessions = installFakeCli()
    await collect([], { warmupOnly: true })
    await collect([message('u1', 'First question')], { siteToolkitPrompt: 'Site tool catalog' })
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(sessions[0].received[0]).toContain('Site tool catalog')
    expect(sessions[0].received[0]).toContain('First question')
  })

  it('does not reuse a session after an unseen user message (for example a routed answer)', async () => {
    installFakeCli()
    await collect([message('u1', '第一问')])
    await collect([
      message('u1', '第一问'), message('a1', 'reply 1', 'assistant'),
      message('u-route', '直调查询'), message('a-route', '直调结果', 'assistant'), message('u2', '第二问'),
    ])
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh CLI when the model configuration changes', async () => {
    const sessions = installFakeCli()
    const first = [message('u1', '第一问')]
    await collect(first)
    await collect([...first, message('a1', 'reply 1', 'assistant'), message('u2', '第二问')], {}, { ...settings, model: 'other-model' })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(sessions[0].closed).toBe(true)
    expect(sessions[1].request.options.model).toBe('other-model')
  })

  it('closes the session after a failed turn', async () => {
    const sessions = installFakeCli({ failTurn: 1 })
    const events = await collect([message('u1', '第一问')])
    expect(events.some((event) => event.type === 'error')).toBe(true)
    expect(sessions[0].closed).toBe(true)
    expect(listChatSessions()).toEqual([])
  })

  it('closes the CLI when the turn is aborted and starts a new one next time', async () => {
    const sessions = installFakeCli({ toolCall: true, hold: new Promise(() => {}) })
    const abort = new AbortController()
    const events = []
    for await (const event of streamChat([message('u1', '第一问')], settings, abort, baseOptions)) {
      events.push(event)
      if (event.type === 'tool_call_start') abort.abort()
    }
    expect(sessions[0].closed).toBe(true)
    expect(listChatSessions()).toEqual([])
    mocks.query.mockClear()
    const next = installFakeCli()
    await collect([message('u1', '第一问'), message('u2', '再试一次')])
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(next[0].received[0]).toContain('再试一次')
    expect(listChatSessions()).toEqual([{ workId: 'work-a', busy: false, turns: 1 }])
  })

  it('runs a concurrent turn of the same work as a one-off query', async () => {
    let releaseFirst: () => void = () => {}
    const sessions = installFakeCli({ toolCall: true, hold: new Promise<void>((resolve) => { releaseFirst = resolve }) })
    const first = [message('u1', '第一问')]
    const running = collect(first)
    await vi.waitFor(() => expect(sessions[0]?.received).toEqual(['第一问']))
    const concurrent = collect([...first, message('u2', '并发问题')])
    await vi.waitFor(() => expect(sessions).toHaveLength(2))
    expect(typeof sessions[1].request.prompt).toBe('string')
    releaseFirst()
    await Promise.all([running, concurrent])
    expect(sessions[0].closed).toBe(false)
    expect(listChatSessions()).toEqual([{ workId: 'work-a', busy: false, turns: 1 }])
  })

  it('keeps the endpoint relay alive for the session and closes it with the session', async () => {
    const sessions = installFakeCli()
    await collect([message('u1', '第一问')], {}, {
      ...settings, base_url: 'https://example.com/arbitrary-endpoint?version=1', base_url_is_full: true,
    })
    const relayUrl = sessions[0].request.options.env.ANTHROPIC_BASE_URL as string
    expect(relayUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect((await fetch(`${relayUrl}/v1/models`)).status).toBe(404)
    disposeChatSession('work-a', 'test')
    await vi.waitFor(async () => { await expect(fetch(`${relayUrl}/v1/models`)).rejects.toThrow() })
  })

  it('keeps one-off behavior for channel and compaction runs', async () => {
    const sessions = installFakeCli()
    await collect([message('u1', '第一问')], { channelAskUserHandler: async () => 'ok' })
    await collect([message('u1', '第一问')], { streaming: false })
    expect(sessions.every((session) => typeof session.request.prompt === 'string')).toBe(true)
    expect(listChatSessions()).toEqual([])
  })
})

describe('chat session pre-start', () => {
  async function warmup(overrides: Record<string, unknown> = {}, turnSettings = settings, messages: Message[] = []) {
    for await (const _event of streamChat(messages, turnSettings, undefined, { ...baseOptions, warmupOnly: true, ...overrides })) { /* drain */ }
  }

  it('starts a work session before the first message and uses it for that turn', async () => {
    const sessions = installFakeCli()
    const history = [message('u0', '旧问题'), message('a0', '旧回答', 'assistant')]
    await warmup({}, settings, history)
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(sessions[0].received).toEqual([])
    expect(listChatSessions()).toEqual([{ workId: 'work-a', busy: false, turns: 0 }])
    // A second warm-up is a no-op while the session exists.
    await warmup({}, settings, history)
    expect(mocks.query).toHaveBeenCalledTimes(1)

    await collect([...history, message('u1', '新问题')])
    expect(mocks.query).toHaveBeenCalledTimes(1)
    // The warm CLI has no history yet, so the first turn carries the full replay.
    expect(sessions[0].received[0]).toContain(HISTORY_REPLAY_HEADER)
    expect(sessions[0].received[0]).toContain('新问题')
    expect(listChatSessions()).toEqual([{ workId: 'work-a', busy: false, turns: 1 }])
  })

  it('binds a spare session to the first new work that matches its configuration', async () => {
    const sessions = installFakeCli()
    await warmup({ workId: undefined })
    expect(listChatSessions()).toEqual([])
    const context = mocks.mcpContexts.at(-1) as { workIdRef: { current: string | null } }
    expect(context.workIdRef.current).toBeNull()

    await collect([message('u1', '第一问')])
    expect(mocks.query).toHaveBeenCalledTimes(1)
    expect(sessions[0].received).toEqual(['第一问'])
    expect(context.workIdRef.current).toBe('work-a')
    expect(listChatSessions()).toEqual([{ workId: 'work-a', busy: false, turns: 1 }])
  })

  it('keeps a spare built for another configuration and starts a separate session', async () => {
    const sessions = installFakeCli()
    await warmup({ workId: undefined }, { ...settings, model: 'other-model' })
    await collect([message('u1', '第一问')])
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(sessions[0].closed).toBe(false)
    expect(sessions[1].received).toEqual(['第一问'])
    disposeAllChatSessions('test')
    expect(sessions[0].closed).toBe(true)
  })

  it('closes unused warm sessions sooner than idle conversations', async () => {
    const sessions = installFakeCli()
    await warmup()
    await warmup({ workId: undefined })
    sweepIdleChatSessions(Date.now() + CHAT_SESSION_WARM_IDLE_MS + 1)
    expect(listChatSessions()).toEqual([])
    expect(sessions.every((session) => session.closed)).toBe(true)
  })
})

describe('chat session pool', () => {
  function fakeSession(workId: string) {
    const close = vi.fn()
    const session = new ChatSession({
      workId,
      fingerprint: 'fixture',
      bindings: { workIdRef: { current: workId }, onAskUser: null, memory: { userPromptInjections: 0, postToolBatchInjections: 0 } },
      queue: new PromptQueue(),
      query: { async *[Symbol.asyncIterator]() {}, close },
    })
    return { session, close }
  }

  it('accepts only histories that append assistant replies and one new user message', () => {
    const { session } = fakeSession('work-b')
    session.complete([{ id: 'u1', role: 'user' }])
    expect(session.continues([{ id: 'u1', role: 'user' }])).toBe(false)
    expect(session.continues([{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'u2', role: 'user' }])).toBe(true)
    expect(session.continues([{ id: 'u1', role: 'user' }, { id: 'u2', role: 'user' }, { id: 'u3', role: 'user' }])).toBe(false)
    expect(session.continues([{ id: 'other', role: 'user' }, { id: 'u2', role: 'user' }])).toBe(false)
    expect(session.continues([{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }])).toBe(false)
  })

  it('evicts the least recently used idle session and sweeps idle ones', () => {
    const created = Array.from({ length: CHAT_SESSION_MAX_SESSIONS + 1 }, (_, index) => fakeSession(`work-${index}`))
    created.forEach(({ session }, index) => {
      session.lastUsedAt = index
      registerChatSession(session)
    })
    expect(created[0].close).toHaveBeenCalledTimes(1)
    expect(listChatSessions()).toHaveLength(CHAT_SESSION_MAX_SESSIONS)
    sweepIdleChatSessions(Date.now() + CHAT_SESSION_IDLE_MS + 1)
    expect(listChatSessions()).toEqual([])
    for (const { close } of created) expect(close).toHaveBeenCalledTimes(1)
  })
})
