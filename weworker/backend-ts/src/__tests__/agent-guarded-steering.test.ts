import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sessions from '../chat-session.js'
import { normalizeContextLimit } from '../context-window.js'

const source = fs.readFileSync(new URL('../agent.ts', import.meta.url), 'utf8')
function between(start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

// Execute the production session selection, creation and cleanup blocks with a
// fake SDK transport, retaining the actual prompt queue and session registry.
function fixture(mode: string, overrides: Record<string, unknown> = {}) {
  const workId = 'steering-fixture'
  const abort = new AbortController()
  const releaseRuntime = vi.fn()
  const queryClose = vi.fn()
  const query = vi.fn(({ prompt }) => ({
    close: queryClose,
    async *[Symbol.asyncIterator]() {
      if (typeof prompt === 'string') return
      for await (const message of prompt) yield message
    },
  }))
  const buildMcp = vi.fn((_options: Record<string, unknown>) => ({}))
  const bindings = { workIdRef: { current: workId }, onAskUser: vi.fn(), memory: {} }
  const opts = { reuseSession: true, workId, ...overrides }
  const context = vm.createContext({
    ...sessions, normalizeContextLimit, AbortController, path, opts, channelPermissionMode: mode,
    internal: { adoptModelRuntime: () => releaseRuntime },
    abortController: abort, workspaceDirectory: '/fixture/workspace',
    query, _buildMcpServer: buildMcp, turnBindings: bindings, activeBindings: bindings,
    settings: {}, sha256: (value: string) => value, systemPrompt: 'Fixture assistant',
    skillIndex: '', sharedWebcliSkillDigest: '', fingerprintSkillFiles: () => '', skillRoots: [],
    filesystemSettings: {}, isolatedSkills: true, getDesktopAdapterCatalog: () => ({ effective: [] }),
    disallowedTools: [], settingSources: [], thinkingEffort: 'off', includePartialMessages: true,
    memoryEnabled: false, agentCwd: '/fixture/workspace', queryEnv: {}, claudeSetup: {}, envWithWebcli: {},
    history: [{ id: 'initial', role: 'user' }], fullFirstPrompt: 'initial', needsCompaction: false,
    readQueryScope: { current: null }, siteToolkitPrompt: '', recalledMemoryBlock: '',
    contextAssembly: { sdk: { prompt: 'initial', system_prompt: 'Fixture assistant' } },
    buildQueryParams: (prompt: unknown, target: unknown) => ({ prompt, target }),
    userTurnMessage: (text: string) => ({ type: 'user', message: { role: 'user', content: text } }),
    log: { info: vi.fn() }, phase: { startedAt: Date.now() },
  })
  const code = `async function* prepare() {
    ${between('  const sessionMode =', '  // Callbacks that')}
    ${between('  let session: ChatSession', '  const sdkStartTime =')}
    yield { session, turnMessages, closeTurn, finish(completed = true, turnFailed = false) {
      ${source.slice(source.lastIndexOf('    if (session && opts.workId)'), source.lastIndexOf('\n  }\n}'))}
    } }
  }; globalThis.prepare = prepare;`
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { workId, abort, releaseRuntime, queryClose, query, buildMcp, bindings, prepare: context.prepare as () => AsyncGenerator<any> }
}

afterEach(() => sessions.disposeAllChatSessions('test'))

describe('desktop guarded steering', () => {
  it.each(['workspace', 'ask', 'full', 'no_bash', 'qa_only'])('registers a steerable %s execution and delivers input to the existing query', async mode => {
    const f = fixture(mode)
    const { value: turn } = await f.prepare().next()
    const iterator = turn.turnMessages[Symbol.asyncIterator]()
    await iterator.next()
    const session = sessions.getSteerableChatSession(f.workId)
    expect(session).toBeDefined()
    expect(session!.steer({ type: 'user', uuid: '11111111-1111-4111-8111-111111111111',
      session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'public correction' } },
    { id: 'correction', role: 'user' })).toBe(true)
    expect((await iterator.next()).value.message.content).toBe('public correction')
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.queryClose).not.toHaveBeenCalled()
    expect(f.buildMcp.mock.calls[0][0].channelPermissionMode).toBe(mode)
    if (mode !== 'full') {
      const mcp = f.buildMcp.mock.calls[0][0] as any
      expect(mcp.workspaceDirectory).toBe('/fixture/workspace')
      expect(mcp.abortSignal.aborted).toBe(false)
    }
    turn.finish()
    if (mode === 'full') {
      expect(sessions.hasChatSession(f.workId)).toBe(true)
    } else {
      expect(sessions.hasChatSession(f.workId)).toBe(false)
      expect(f.queryClose).toHaveBeenCalledOnce()
      expect(f.releaseRuntime).toHaveBeenCalledOnce()
      expect((f.buildMcp.mock.calls[0][0] as any).abortSignal.aborted).toBe(true)
    }
  })

  it.each(['workspace', 'ask', 'no_bash', 'qa_only'])('does not adopt a full-access spare or prewarm a guarded %s session', async mode => {
    const warm = fixture('full', { warmupOnly: true, workId: undefined })
    await warm.prepare().next()
    expect(sessions.hasSpareChatSession()).toBe(true)
    const f = fixture(mode)
    const { value: turn } = await f.prepare().next()
    expect(turn.session).toBeDefined()
    expect(f.query).toHaveBeenCalledOnce()
    expect(sessions.hasSpareChatSession()).toBe(true)
    turn.finish()
    const guardedWarm = fixture(mode, { warmupOnly: true })
    await guardedWarm.prepare().next()
    expect(guardedWarm.query).not.toHaveBeenCalled()
  })

  it.each(['workspace', 'ask', 'full', 'no_bash', 'qa_only'])('cleans up %s sessions after stop or failure', async mode => {
    for (const failure of ['abort', 'error', 'unfinished']) {
      const f = fixture(mode)
      const { value: turn } = await f.prepare().next()
      await turn.turnMessages[Symbol.asyncIterator]().next()
      if (failure === 'abort') { f.abort.abort(); turn.closeTurn() }
      turn.finish(failure !== 'unfinished', failure === 'error')
      expect(sessions.getSteerableChatSession(f.workId)).toBeUndefined()
      expect(sessions.hasChatSession(f.workId)).toBe(false)
      expect(f.queryClose).toHaveBeenCalledOnce()
      expect(f.releaseRuntime).toHaveBeenCalledOnce()
    }
  })
})
