import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import type { Message } from '../works-store.js'
import * as contextAssembly from '../context-assembly.js'

const mocks = vi.hoisted(() => ({ query: vi.fn(), directory: '', prompts: [] as string[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }))
vi.mock('../config.js', () => ({
  getConfigDirectory: () => mocks.directory,
  getUserDirectory: () => mocks.directory,
  getOpenBrowserAllowedOrigins: () => [],
  getUserDirectoryBlacklist: () => [],
  getSiteEnabled: () => false,
}))
vi.mock('../tools.js', () => ({ buildMcpServer: () => ({}), getMcpToolDefinitionSummary: () => '' }))
vi.mock('../logger.js', () => ({ createLogger: () => ({ info() {}, error() {}, warn() {}, debug() {} }) }))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))
vi.mock('../webcli-path.js', () => ({
  resolveWebcliDir: () => path.join(mocks.directory, 'webcli'),
  resolveWebcliEntry: () => path.join(mocks.directory, 'route.cjs'),
}))
vi.mock('../user-directory-access.js', () => ({
  buildAgentFilesystemSettings: () => ({ permissions: { allow: [] } }),
  createUnifiedToolGuard: () => async () => ({ behavior: 'deny' }),
}))

import { clearStoredConversationCompaction, streamChat } from '../agent.js'
import { configureWorkLogs, readWorkLog } from '../work-log-file.js'
import { disposeAllChatSessions } from '../chat-session.js'
import { hasPendingAskUser, requestUserChoice } from '../ask-user-pending.js'

function message(id: string, text: string, role: Message['role'] = 'user'): Message {
  return { id, work_id: 'compaction-test', role, content: [{ type: 'text', text }], created_at: '' }
}

const history = () => [
  message('old-user', '旧目标：保留订单号A123。' + '历史内容。'.repeat(600)),
  message('old-assistant', '历史查询结果。'.repeat(600), 'assistant'),
  message('current', '继续检查订单A123'),
]
const settings = { active_provider: 'anthropic', api_key: 'test-only', base_url: 'https://api.anthropic.com', model: 'test-model', context_limit: 1_000_000 } as Settings
const options = { workId: 'compaction-test', memoryEnabled: false, channelPermissionMode: 'qa_only' as const }

async function collect(messages: Message[], overrides = {}, turnSettings = settings) {
  const events = []
  for await (const event of streamChat(messages, turnSettings, undefined, { ...options, ...overrides })) events.push(event)
  return events
}

beforeEach(() => {
  mocks.prompts = []
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-compaction-test-'))
  fs.writeFileSync(path.join(mocks.directory, 'route.cjs'), `console.log(JSON.stringify({ kind: 'routed', site: { adapterId: 'example.com' }, command: { name: 'search' }, callCommand: 'webcli call example.com.search', request: process.argv.at(-1) }))`)
  for (const name of ['webcli', 'webcli-browser', 'webcli-api-exploration']) {
    const skillDir = path.join(mocks.directory, 'webcli/skills', name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Public fixture\n---\nRead https://example.com/items`)
  }
  const builtinDir = path.join(mocks.directory, 'builtin')
  fs.mkdirSync(builtinDir, { recursive: true })
  fs.writeFileSync(path.join(builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: [] }))
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public')
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', builtinDir)
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', path.join(mocks.directory, 'adapters'))
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', path.join(mocks.directory, 'adapters'))
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', path.join(mocks.directory, 'adapter-data'))
  vi.stubEnv('WEWORKER_CLAUDE_CODE_PATH', process.execPath)
  mocks.query.mockReset()
  mocks.query.mockImplementation((request) => ({
    async *[Symbol.asyncIterator]() {
      const result = { type: 'result', subtype: 'success', is_error: false, result: request.options.tools ? '已确认订单号A123，等待检查。' : '继续处理', usage: { input_tokens: 400, output_tokens: 8 } }
      if (typeof request.prompt === 'string') { mocks.prompts.push(request.prompt); yield result }
      else {
        const input = request.prompt
        for await (const message of input) {
          request.prompt = message.message.content
          mocks.prompts.push(request.prompt)
          yield result
        }
      }
    },
    close() {},
  }))
})

afterEach(() => {
  configureWorkLogs(undefined)
  disposeAllChatSessions('test')
  clearStoredConversationCompaction(options.workId)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

it.each([200_000, 1_000_000, 1_500_000])('tells the model the configured %i-token window with provider and usage caveats', async context_limit => {
  await collect([message('current', 'What is the context window?')], {
    systemPromptOverride: 'Public custom system prompt.', appendSystemPrompt: 'Public additional instruction.',
  }, { ...settings, model: 'public-model-alias', context_limit })
  const request = mocks.query.mock.calls[0][0]
  expect(request.options.systemPrompt).toContain(`当前配置的上下文窗口为 ${context_limit} token`)
  expect(request.options.systemPrompt).toContain('实际可用上限以供应商返回为准')
  expect(request.options.systemPrompt).toContain('累计计费 token')
  expect(request.options.systemPrompt).toContain('模型名称、别名或 SDK 默认值')
  expect(request.options.systemPrompt).toContain('Public custom system prompt.')
  expect(request.options.systemPrompt).toContain('Public additional instruction.')
  expect(request.prompt).not.toContain('当前配置的上下文窗口')
})

it('refreshes a reused session window notice after the configured capacity changes', async () => {
  const messages = [message('current', 'Public question')]
  await collect(messages, { reuseSession: true, channelPermissionMode: 'full' }, { ...settings, context_limit: 200_000 })
  mocks.query.mockClear()
  await collect([...messages, message('answer', 'Public answer', 'assistant'), message('next', 'Next public question')], {
    reuseSession: true, channelPermissionMode: 'full',
  }, { ...settings, context_limit: 1_000_000 })
  const request = mocks.query.mock.calls[0][0]
  expect(request.options.systemPrompt).toContain('当前配置的上下文窗口为 1000000 token')
  expect(request.options.systemPrompt).not.toContain('当前配置的上下文窗口为 200000 token')
})

it('delivers routing context in the current prompt without rewriting saved user messages', async () => {
  const messages = [message('current', '原始问题')]
  await collect(messages, { directRoute: { status: 'failed', reason: 'timeout' } }, { ...settings, webcli_route_enabled: false })
  const request = mocks.query.mock.calls[0][0]
  expect(request.prompt).toContain('<turn_routing>')
  expect(request.prompt).toContain('timeout')
  expect(request.prompt).toContain('disabled')
  expect(request.prompt).toContain('原始问题')
  expect(request.options.systemPrompt).not.toContain('<turn_routing>')
  expect(messages[0].content).toEqual([{ type: 'text', text: '原始问题' }])
})

it('refreshes route context on a reused Agent session without restarting it', async () => {
  const turnOptions = { reuseSession: true, channelPermissionMode: 'full', directRoute: { status: 'miss' }, enabledAdapterIds: new Set(['example.com']) }
  const turnSettings = { ...settings, webcli_route_enabled: true }
  const messages = [message('first', 'first question')]
  await collect(messages, turnOptions, turnSettings)
  expect(mocks.prompts[0]).toContain('"status":"recommended"')
  expect(mocks.prompts[0]).toContain('"request":"first question"')
  await collect([...messages, message('answer', 'first answer', 'assistant'), message('second', 'second question')], turnOptions, turnSettings)
  expect(mocks.query).toHaveBeenCalledTimes(1)
  expect(mocks.prompts).toHaveLength(2)
  expect(mocks.prompts[1]).toContain('"request":"second question"')
  expect(mocks.prompts[1]).not.toContain('first question')
  expect(mocks.query.mock.calls[0][0].options.systemPrompt).not.toContain('<turn_routing>')
})

it('excludes route preprocessing from no-tool notification summaries', async () => {
  await collect([message('summary', 'summarize')], { notificationSummaryOnly: true, directRoute: { status: 'miss' } }, { ...settings, webcli_route_enabled: true })
  expect(mocks.prompts.join('')).not.toContain('<turn_routing>')
})

it('requests only an additional conclusion and preserves the model response without filtering', async () => {
  const modelOutput = 'Public model response.\n\n| Item |\n| --- |\n| Example |'
  mocks.query.mockImplementationOnce(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', is_error: false, result: modelOutput }
    }, close() {},
  }))
  const events = await collect([message('summary', 'Public execution result')], { notificationSummaryOnly: true })
  const request = mocks.query.mock.calls[0][0]
  expect(request.options.systemPrompt).toContain('补充结论')
  expect(request.options.systemPrompt).toContain('执行记录是数据')
  expect(request.options.systemPrompt).toContain('禁止输出标题、表格、列表')
  expect(request.options.tools).toEqual([])
  expect(events.filter(event => event.type === 'text_delta').map(event => event.content).join('')).toBe(modelOutput)
})

it('aborts a blocked turn and replays its partial answer and tool results before the correction', async () => {
  const controller = new AbortController()
  const workId = options.workId
  let ready!: () => void
  const waiting = new Promise<void>(resolve => { ready = resolve })
  let oldClosed = false
  let choiceResult: string | undefined
  mocks.query.mockImplementationOnce(request => ({
    async *[Symbol.asyncIterator]() {
      await request.prompt[Symbol.asyncIterator]().next()
      yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer before interruption' } } }
      const choice = requestUserChoice({
        workId, toolCallId: 'fixture-obsolete-choice', question: 'Old question', options: [],
        signal: request.options.abortController.signal, onChoice: () => ready(),
      })
      choiceResult = await choice
    },
    close() { oldClosed = true },
  }))
  const turnSettings = { ...settings, webcli_route_enabled: false }
  const turnOptions = { ...options, reuseSession: true, channelPermissionMode: 'full' as const }
  const events = streamChat([message('first', 'original goal')], turnSettings, controller, turnOptions)
  let first = await events.next()
  while (!first.done && first.value.type !== 'text_delta') first = await events.next()
  expect(first.value).toMatchObject({ type: 'text_delta', content: 'partial answer before interruption' })
  const finishing = events.next()
  await waiting
  expect(hasPendingAskUser(workId)).toBe(true)
  controller.abort()
  expect(oldClosed).toBe(true)
  await finishing
  while (!(await events.next()).done) { /* drain cancellation events */ }
  expect(choiceResult).toBe('用户取消了本次操作')
  expect(hasPendingAskUser(workId)).toBe(false)

  const partial = message('partial', first.value!.content!, 'assistant')
  partial.content.push(
    { type: 'tool_use', id: 'completed-tool', name: 'Read', args: {}, status: 'done', result: 'completed tool result marker' },
    { type: 'tool_use', id: 'interrupted-tool', name: 'Read', args: {}, status: 'cancelled' },
  )
  const correction = message('correction', 'use the corrected context limit')
  await collect([message('first', 'original goal'), partial, correction], turnOptions, turnSettings)
  expect(mocks.query).toHaveBeenCalledTimes(2)
  const prompt = mocks.prompts.at(-1)!
  expect(prompt).toContain('original goal')
  expect(prompt).toContain('partial answer before interruption')
  expect(prompt).toContain('completed tool result marker')
  expect(prompt).toContain('status: cancelled')
  expect(prompt.indexOf('partial answer')).toBeLessThan(prompt.indexOf('use the corrected context limit'))
})

it('reports the SDK compaction failure instead of leaving an unmatched start event', async () => {
  mocks.query.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'status', status: 'compacting' }
      yield { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'fixture summary request rejected' }
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['fixture summary request rejected'] }
    },
    close() {},
  }))
  const events = await collect([message('question', 'fixture question')])
  expect(events.filter(event => event.type === 'context_compaction_end')).toEqual([
    expect.objectContaining({ compaction: expect.objectContaining({ status: 'failed', error: 'fixture summary request rejected' }) }),
  ])
})

it('streams a visible WebCLI route command before starting the Agent', async () => {
  const events = streamChat([message('route', 'search public projects')], { ...settings, webcli_route_enabled: true }, undefined, {
    ...options, channelPermissionMode: 'full', enabledAdapterIds: new Set(['example.com']), directRoute: { status: 'miss' },
  })
  const start = await events.next()
  expect(start.value).toMatchObject({ type: 'tool_call_start', name: 'webcli_route', args: { command: 'webcli route' } })
  expect(mocks.query).not.toHaveBeenCalled()
  const end = await events.next()
  expect(end.value).toMatchObject({ type: 'tool_call_result', id: start.value?.id, isError: false })
  expect(JSON.parse(end.value!.result!)).toMatchObject({ status: 'recommended', result: { callCommand: 'webcli call example.com.search' } })
  expect(mocks.query).not.toHaveBeenCalled()
  const remaining = []
  for await (const event of events) remaining.push(event)
  expect(remaining.some(event => event.type === 'tool_call_start' && event.name === 'webcli_route')).toBe(false)
  expect(mocks.query).toHaveBeenCalledOnce()
})

it('injects a safe WebCLI error into the Agent context and continues the normal Agent turn', async () => {
  fs.writeFileSync(path.join(mocks.directory, 'route.cjs'), `console.error('Decision service is not configured: set WEBCLI_D3_URL. Authorization: Bearer fixture-secret-must-not-leak'); process.exitCode = 1`)
  const events = await collect([message('route', 'search')], {
    channelPermissionMode: 'full', enabledAdapterIds: new Set(['example.com']), directRoute: { status: 'miss' },
  }, { ...settings, webcli_route_enabled: true })
  const start = events.find(event => event.type === 'tool_call_start')
  const end = events.find(event => event.type === 'tool_call_result')
  expect(start?.name).toBe('webcli_route')
  expect(end).toMatchObject({ id: start?.id, isError: true })
  expect(JSON.parse(end!.result!)).toMatchObject({ status: 'failed', reason: 'not_configured', error: 'WEBCLI_D3_URL 未配置。' })
  expect(mocks.query).toHaveBeenCalledOnce()
  expect(mocks.prompts.at(-1)).toContain('WEBCLI_D3_URL 未配置。')
  expect(mocks.prompts.at(-1)).toContain('search')
  expect(mocks.prompts.at(-1)).not.toContain('fixture-secret-must-not-leak')
})

it('settles a cancelled route record without starting the Agent', async () => {
  fs.writeFileSync(path.join(mocks.directory, 'route.cjs'), 'setTimeout(() => {}, 10000)')
  const controller = new AbortController()
  const events = streamChat([message('route', 'search')], { ...settings, webcli_route_enabled: true }, controller, {
    ...options, channelPermissionMode: 'full', enabledAdapterIds: new Set(['example.com']), directRoute: { status: 'miss' },
  })
  const start = await events.next()
  expect(start.value?.type).toBe('tool_call_start')
  const pending = events.next()
  controller.abort()
  const end = await pending
  expect(end.value).toMatchObject({ type: 'tool_call_result', id: start.value?.id, isError: true })
  expect(JSON.parse(end.value!.result!).status).toBe('cancelled')
  expect((await events.next()).done).toBe(true)
  expect(mocks.query).not.toHaveBeenCalled()
})

it.each([
  { webcli_route_enabled: false, directRoute: { status: 'miss' } },
  { webcli_route_enabled: true, directRoute: { status: 'skipped', reason: 'dedicated_agent' } },
])('emits no route command when routing is disabled or skipped: %j', async ({ webcli_route_enabled, directRoute }) => {
  const events = await collect([message('route', 'search')], { channelPermissionMode: 'full', directRoute }, { ...settings, webcli_route_enabled })
  expect(events.some(event => event.name === 'webcli_route')).toBe(false)
})

it('keeps WebCLI routing off by default when the setting is absent', async () => {
  const events = await collect([message('route', 'search')], {
    channelPermissionMode: 'full', enabledAdapterIds: new Set(['example.com']), directRoute: { status: 'miss' },
  }, settings)
  expect(events.some(event => event.type === 'tool_call_start' && event.name === 'webcli_route')).toBe(false)
})

it('runs WebCLI routing when the setting is explicitly enabled', async () => {
  const events = await collect([message('route', 'search')], {
    channelPermissionMode: 'full', enabledAdapterIds: new Set(['example.com']), directRoute: { status: 'miss' },
  }, { ...settings, webcli_route_enabled: true })
  expect(events.some(event => event.type === 'tool_call_start' && event.name === 'webcli_route')).toBe(true)
})

describe('agent conversation compaction', () => {
  it('writes complete model input and tool result parts during execution, without model credentials', async () => {
    configureWorkLogs(path.join(mocks.directory, 'logs'))
    const first = 'FIRST-RESULT-' + 'a'.repeat(5_000)
    const second = 'SECOND-RESULT-' + 'b'.repeat(5_000)
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fixture-call', name: 'Read', input: { query: 'QUERY-END' } }] } }
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fixture-call', content: [{ type: 'text', text: first }, { type: 'text', text: second }] }] } }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ANSWER-END' }] } }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ANSWER-END' }
      },
      close() {},
    }))
    const messages = [message('current', 'INPUT-' + 'x'.repeat(2_000) + '-END')]
    for await (const event of streamChat(messages, settings, undefined, { ...options, streaming: false })) {
      if (event.type === 'tool_call_result') {
        expect(fs.readFileSync(path.join(mocks.directory, 'logs', options.workId + '.log'), 'utf8')).toContain(event.result)
      }
    }
    const text = readWorkLog({ id: options.workId, messages })
    expect(text).toContain('INPUT-' + 'x'.repeat(2_000) + '-END')
    expect(text).toContain(first)
    expect(text).toContain(second)
    expect(text).toContain('ANSWER-END')
    expect(text).toContain('"status":"completed"')
    expect(text).not.toContain(settings.api_key)
  })
  it.each([{ disabled: '1', enabled: false }, { disabled: '0', enabled: true }])(
    'applies the process memory switch to a real agent turn: disabled=$disabled', async ({ disabled, enabled }) => {
      vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', disabled)
      const recall = vi.spyOn(contextAssembly, 'recallLongTermMemory').mockReturnValue({ recalled: '' })
      await collect([message('only', '请回答测试问题')], { memoryEnabled: true })
      expect(mocks.query).toHaveBeenCalledOnce()
      const request = mocks.query.mock.calls[0][0]
      expect(request.options.systemPrompt.includes('<weworker_memory>')).toBe(enabled)
      expect(Boolean(request.options.hooks?.UserPromptSubmit)).toBe(enabled)
      expect(Boolean(request.options.hooks?.PostToolBatch)).toBe(enabled)
      expect(recall.mock.calls.length).toBe(enabled ? 1 : 0)
    },
  )
  it('keeps workspace permission checks registered when automatic memory is disabled', async () => {
    vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', '1')
    await collect([message('only', 'Public fixture')], {
      memoryEnabled: true, channelPermissionMode: 'workspace', workId: undefined,
    })
    const request = mocks.query.mock.calls[0][0]
    expect(request.options.hooks.UserPromptSubmit).toBeUndefined()
    expect(request.options.hooks.PostToolBatch).toBeUndefined()
    const hook = request.options.hooks.PreToolUse[0].hooks[0]
    const result = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} })
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny')
  })
  it('registers per-operation confirmation independently of automatic memory', async () => {
    vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', '1')
    await collect([message('only', 'Public fixture')], {
      memoryEnabled: false, channelPermissionMode: 'ask', permissionMode: 'default', workId: undefined,
    })
    const request = mocks.query.mock.calls[0][0]
    expect(request.options.disallowedTools).not.toContain(process.platform === 'win32' ? 'PowerShell' : 'Bash')
    expect(request.options.hooks.PreToolUse[0].hooks).toHaveLength(1)
    expect(request.options.hooks.PreToolUse[0].timeout).toBeGreaterThan(300)
    expect(request.options.hooks.UserPromptSubmit).toBeUndefined()
  })
  it('streams visible text before block stop while preserving the hidden memory decision', async () => {
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '立即显示' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<weworker_memory>{"should_remember":false}' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '</weworker_memory>' } } }
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }
        yield { type: 'result', subtype: 'success', is_error: false, result: '立即显示' }
      }, close() {},
    }))
    const events = await collect([message('only', '你好')], { workId: undefined, streaming: true, channelPermissionMode: 'full' })
    const text = events.filter(event => event.type === 'text_delta').map(event => event.content).join('')
    expect(text).toBe('立即显示')
    expect(events.findIndex(event => event.type === 'text_delta')).toBeLessThan(events.findIndex(event => event.type === 'memory_parse'))
    expect(events.some(event => event.type === 'memory_parse' && event.memoryParse?.outcome === 'present_ignore')).toBe(true)
  })

  it.each([false, true])('uses and cleans up full URL forwarding for SDK calls, failure=%s', async (fail) => {
    let relayUrl = ''
    mocks.query.mockImplementation((request) => ({
      async *[Symbol.asyncIterator]() {
        relayUrl = request.options.env.ANTHROPIC_BASE_URL
        expect(relayUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
        expect((await fetch(`${relayUrl}/v1/models`)).status).toBe(404)
        if (fail) throw new Error('synthetic SDK failure')
        yield { type: 'result', subtype: 'success', is_error: false, result: '已确认订单号A123，等待检查。', usage: { input_tokens: 10, output_tokens: 10 } }
      },
      close() {},
    }))
    await collect(history(), { forceCompaction: true, compactionOnly: true }, {
      ...settings, base_url: 'https://example.com/arbitrary-endpoint?version=1', base_url_is_full: true,
    })
    expect(relayUrl).not.toBe('')
    await expect(fetch(`${relayUrl}/v1/models`)).rejects.toThrow()
  })

  it.each([false, true])('forwards SDK assistant API errors with streaming=%s', async (streaming) => {
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', error: 'invalid_request', message: { content: [{ type: 'text', text: 'prompt is too long' }] } }
      },
      close() {},
    }))
    const events = await collect([message('only', '继续')], { streaming, channelPermissionMode: 'full' })
    expect(events.some(event => event.type === 'error' && event.content?.startsWith('prompt is too long'))).toBe(true)
    expect(events.some(event => event.type === 'text_delta')).toBe(false)
  })

  it('preserves the provider overflow message stored in an SDK error result', async () => {
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', is_error: true, result: 'maximum context length exceeded' }
      },
      close() {},
    }))
    const events = await collect([message('only', '继续')])
    expect(events.some(event => event.type === 'error' && event.content?.startsWith('maximum context length exceeded'))).toBe(true)
  })

  it('actually reduces history after an overflow even when the configured window is too large', async () => {
    const events = await collect(history(), { forceCompaction: true, compactionOnly: true })
    const completed = events.find(event => event.type === 'context_compaction_end')?.compaction
    expect(completed?.status).toBe('completed')
    expect(completed!.after_tokens).toBeLessThan(completed!.before_tokens!)
    const summaryRequest = mocks.query.mock.calls.find(([request]) => request.options.tools)?.[0]
    expect(summaryRequest.prompt).toContain('旧目标')
    expect(summaryRequest.prompt).not.toContain('继续检查订单A123')
  })

  it('keeps the compacted history across more than one subsequent turn', async () => {
    const messages = history()
    await collect(messages, { forceCompaction: true, compactionOnly: true }, { ...settings, context_limit: 4000 })
    mocks.query.mockClear()
    await collect(messages)
    const extended = [...messages, message('answer', '已检查', 'assistant'), message('next', '下一步')]
    await collect(extended)
    const prompts = mocks.query.mock.calls.map(([request]) => request.prompt)
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) {
      expect(prompt).toContain('[历史对话摘要]')
      expect(prompt).not.toContain('历史内容'.repeat(10))
      expect(prompt).toContain('A123')
    }
    expect(prompts[1]).toContain('已检查')
    expect(prompts[1]).toContain('下一步')
  })

  it('rejects a summary that does not reduce the conversation', async () => {
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', result: '膨胀'.repeat(8000) }
      },
      close() {},
    }))
    const events = await collect(history(), { forceCompaction: true, compactionOnly: true }, { ...settings, context_limit: 4000 })
    expect(events.find(event => event.type === 'context_compaction_end')?.compaction?.status).toBe('failed')
  })

  it('automatically compacts at the local threshold and preserves the result for later turns', async () => {
    const messages = history()
    const events = await collect(messages, {}, { ...settings, context_limit: 4000 })
    expect(events.find(event => event.type === 'context_compaction_end')?.compaction?.status).toBe('completed')
    mocks.query.mockClear()
    await collect([...messages, message('answer', '已完成', 'assistant'), message('next', '继续')])
    expect(mocks.query.mock.calls[0][0].prompt.includes('[历史对话摘要]')).toBe(true)
    expect(mocks.query.mock.calls[0][0].prompt.includes('历史内容'.repeat(10))).toBe(false)
  })

  it('invalidates cached summaries if the source history is edited', async () => {
    const messages = history()
    await collect(messages, { forceCompaction: true, compactionOnly: true }, { ...settings, context_limit: 4000 })
    mocks.query.mockClear()
    messages[0] = message('old-user', '更正订单号B456')
    await collect(messages)
    expect(mocks.query.mock.calls[0][0].prompt.includes('[历史对话摘要]')).toBe(false)
    expect(mocks.query.mock.calls[0][0].prompt.includes('更正订单号B456')).toBe(true)
  })

  it('does not call the model when there is no older conversation to compress', async () => {
    const events = await collect([message('only', '你好')], { forceCompaction: true, compactionOnly: true })
    expect(events.find(event => event.type === 'context_compaction_end')?.compaction?.status).toBe('skipped')
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('reports summary API failures instead of claiming completion', async () => {
    mocks.query.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['prompt is too long'] }
      },
      close() {},
    }))
    const events = await collect(history(), { forceCompaction: true, compactionOnly: true })
    const result = events.find(event => event.type === 'context_compaction_end')?.compaction
    expect(result?.status).toBe('failed')
    expect(result?.error).toContain('prompt is too long')
  })

  it('fails fast instead of hanging when the summarizer never returns', async () => {
    const previous = process.env.WEWORKER_COMPACTION_TIMEOUT_MS
    process.env.WEWORKER_COMPACTION_TIMEOUT_MS = '60'
    try {
      mocks.query.mockImplementation(() => ({
        // A summarizer that never yields and never ends: exactly the stuck case.
        async *[Symbol.asyncIterator]() { await new Promise(() => {}) },
        close() {},
      }))
      const outcome = await Promise.race([
        collect(history(), { forceCompaction: true, compactionOnly: true }),
        new Promise((resolve) => setTimeout(() => resolve('still-hanging'), 3_000)),
      ])
      expect(outcome).not.toBe('still-hanging')
      const result = (outcome as Array<{ type: string; compaction?: { status?: string; error?: string } }>)
        .find(event => event.type === 'context_compaction_end')?.compaction
      expect(result?.status).toBe('failed')
      expect(result?.error).toContain('对话压缩超时')
    } finally {
      if (previous === undefined) delete process.env.WEWORKER_COMPACTION_TIMEOUT_MS
      else process.env.WEWORKER_COMPACTION_TIMEOUT_MS = previous
    }
  })

  it('keeps a slow summarizer alive as long as it keeps producing output', async () => {
    const previous = process.env.WEWORKER_COMPACTION_TIMEOUT_MS
    // Shorter than the whole run, longer than the gap between two streamed chunks.
    process.env.WEWORKER_COMPACTION_TIMEOUT_MS = '80'
    try {
      mocks.query.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 6; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 40))
            yield { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'x' } } }
          }
          yield { type: 'result', subtype: 'success', result: 'SUMMARY' }
        },
        close() {},
      }))
      const events = await collect(history(), { forceCompaction: true, compactionOnly: true })
      const result = events.find(event => event.type === 'context_compaction_end')?.compaction
      expect(result?.status).toBe('completed')
    } finally {
      if (previous === undefined) delete process.env.WEWORKER_COMPACTION_TIMEOUT_MS
      else process.env.WEWORKER_COMPACTION_TIMEOUT_MS = previous
    }
  })
})

it('excludes the entire current turn including an overflowing assistant result from the summary', async () => {
  const messages = [...history(), message('overflow-result', 'OVERSIZED-CURRENT-RESULT'.repeat(10000), 'assistant')]
  const original = structuredClone(messages)
  await collect(messages, { forceCompaction: true, compactionOnly: true })
  const request = mocks.query.mock.calls.find(([request]) => request.options.tools)?.[0]
  expect(request.prompt).toContain('旧目标')
  expect(request.prompt).not.toContain('继续检查订单A123')
  expect(request.prompt).not.toContain('OVERSIZED-CURRENT-RESULT')
  expect(messages).toEqual(original)
})

it('bounds the summary request and restores every unsummarized sentence and the current turn', async () => {
  const messages = history()
  await collect(messages, { forceCompaction: true, compactionOnly: true }, { ...settings, context_limit: 4000, compaction_ratio: 65 })
  const summaryRequest = mocks.query.mock.calls.find(([request]) => request.options.tools)?.[0]
  const recentRequest = mocks.query.mock.calls.find(([request]) => !request.options.tools)?.[0]
  expect(summaryRequest.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('400')
  expect(contextAssembly.estimateContextTokens(summaryRequest.prompt) + 1024 + 400).toBeLessThan(4000)
  const original = messages.slice(0, -1).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content[0].type === 'text' ? m.content[0].text : ''}`).join('\n\n')
  expect(original.startsWith(summaryRequest.prompt)).toBe(true)
  expect(recentRequest.prompt).toContain(original.slice(summaryRequest.prompt.length).trim())
  expect(recentRequest.prompt).toContain('继续检查订单A123')
})

it.each(['qa_only', 'no_bash', 'full', 'workspace', 'ask'] as const)(
  'compacts provider-calibrated turns in the shared Backend with permission mode %s', async channelPermissionMode => {
    const messages = history()
    mocks.query.mockImplementation(request => ({
      async *[Symbol.asyncIterator]() {
        if (!request.options.tools) {
          if (request.options.includePartialMessages) {
            yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
              delta: { type: 'text_delta', text: 'Public final answer' } } }
          }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Public final answer' }], usage: {
            input_tokens: 100, cache_read_input_tokens: 900000,
          } } }
        }
        yield { type: 'result', subtype: 'success', is_error: false,
          result: request.options.tools ? 'Order A123 is awaiting inspection.' : 'Public final answer',
          usage: { input_tokens: 100, output_tokens: 10 } }
      }, close() {},
    }))
    const events = await collect(messages, {
      channelPermissionMode, channelAskUserHandler: async () => 'Public answer',
    })
    for (const [request] of mocks.query.mock.calls) {
      expect(request.options.systemPrompt).toContain('当前配置的上下文窗口为 1000000 token')
    }
    expect(events.find(event => event.type === 'context_snapshot' && event.context?.phase === 'turn_end')?.context?.actual_input_tokens).toBe(900100)
    expect(events.find(event => event.type === 'context_compaction_end')?.compaction?.status).toBe('completed')
    expect(events.at(-1)?.type).toBe('done')
    expect(events.filter(event => event.type === 'done')).toHaveLength(1)
    const summary = mocks.query.mock.calls.find(([request]) => request.options.tools)?.[0]
    expect(summary.prompt).not.toContain('Public final answer')
    const probe = mocks.query.mock.calls.at(-1)![0]
    expect(probe.prompt).toContain('Public final answer')
    expect(probe.prompt).toContain('继续检查订单A123')
    mocks.query.mockClear()
    await collect([...messages, message('answer', 'Public final answer', 'assistant'), message('next', 'Next step')])
    expect(mocks.query.mock.calls[0][0].prompt).toContain('[历史对话摘要]')
    expect(mocks.query.mock.calls[0][0].prompt.match(/Public final answer/g)).toHaveLength(1)
  },
)

it.each(['channel', 'desktop'])('recovers a %s overflow once with the original question and completed tool results', async entry => {
  const original = history()
  const saved = structuredClone(original)
  let mainCalls = 0
  mocks.query.mockImplementation(request => ({
    async *[Symbol.asyncIterator]() {
      if (typeof request.prompt !== 'string') {
        const next = await request.prompt[Symbol.asyncIterator]().next()
        request.prompt = next.value.message.content
      }
      if (request.options.tools) {
        expect(request.prompt).not.toContain('Public tool result')
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Order A123 is awaiting inspection.' }
        return
      }
      if (request.options.maxTurns === 1) {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 400 } }
        return
      }
      mainCalls++
      if (mainCalls === 1) {
        if (request.options.includePartialMessages) {
          yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text: 'Partial answer before overflow' } } }
        }
        yield { type: 'assistant', message: { content: [
          { type: 'text', text: 'Partial answer before overflow' },
          { type: 'tool_use', id: 'public-completed-tool', name: 'example.update', input: { id: 'A123' } },
        ] } }
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'public-completed-tool', content: 'Public tool result: update completed' }] } }
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Prompt is too long'] }
      } else {
        expect(request.prompt).toContain('[历史对话摘要]')
        expect(request.prompt).toContain('继续检查订单A123')
        expect(request.prompt).toContain('Partial answer before overflow')
        expect(request.prompt).toContain('Public tool result: update completed')
        expect(request.prompt).toContain('不要重复已完成的操作')
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Continued final answer' }
      }
    }, close() {},
  }))
  const events = await collect(original, {
    channelPermissionMode: 'full', reuseSession: entry === 'desktop',
    ...(entry === 'channel' ? { channelAskUserHandler: async () => 'Public answer' } : {}),
  })
  expect(mainCalls).toBe(2)
  expect(events.some(event => event.type === 'error')).toBe(false)
  expect(events.filter(event => event.type === 'tool_call_start')).toHaveLength(1)
  expect(events.filter(event => event.type === 'done')).toHaveLength(1)
  expect(original).toEqual(saved)
})

it('does not mistake retained in-flight output for a reduction when the summary grows history', async () => {
  let mainCalls = 0
  mocks.query.mockImplementation(request => ({
    async *[Symbol.asyncIterator]() {
      if (request.options.tools) {
        yield { type: 'result', subtype: 'success', result: '膨胀'.repeat(8000) }
        return
      }
      mainCalls++
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '本轮保留内容。'.repeat(5000) }] } }
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Prompt is too long'] }
    }, close() {},
  }))
  const events = await collect(history())
  expect(mainCalls).toBe(3) // The first run and two validation probes; no tools are rerun.
  expect(events.find(event => event.type === 'context_compaction_end')?.compaction?.status).toBe('failed')
  expect(events.filter(event => event.type === 'context_compaction_end' && event.compaction?.strategy === 'drop_oldest')).toHaveLength(2)
  expect(events.find(event => event.type === 'error')?.content).toContain('无法继续缩减')
})

it('can summarize the cached history again while excluding the current turn', async () => {
  const messages = history()
  const original = structuredClone(messages)
  await collect(messages, { forceCompaction: true, compactionOnly: true })
  mocks.query.mockClear()
  const events = await collect(messages, { forceCompaction: true, compactionOnly: true })
  const summary = mocks.query.mock.calls.find(([request]) => request.options.tools)?.[0]
  expect(summary.prompt).toContain('[历史对话摘要]')
  expect(summary.prompt).not.toContain('继续检查订单A123')
  expect(events.find(event => event.type === 'context_compaction_end')?.compaction?.status).toBe('completed')
  expect(messages).toEqual(original)
})

it('uses measured probe input above the configured limit to keep shrinking manual compaction', async () => {
  let summaries = 0
  let probes = 0
  mocks.query.mockImplementation(request => ({
    async *[Symbol.asyncIterator]() {
      if (request.options.tools) {
        summaries++
        yield { type: 'result', subtype: 'success', result: 'Earlier order A123.' }
      } else {
        expect(request.options.maxTurns).toBe(1)
        probes++
        yield { type: 'result', subtype: 'success', usage: {
          input_tokens: request.prompt.includes('[历史对话摘要]') || request.prompt.includes('[最近对话]') ? 1_000_001 : 100,
        } }
      }
    }, close() {},
  }))
  const events = await collect(history(), { forceCompaction: true, compactionOnly: true }, { ...settings, compaction_max_attempts: 1 })
  expect(summaries).toBe(1)
  expect(probes).toBe(3)
  expect(events.filter(event => event.type === 'context_compaction_end' && event.compaction?.strategy === 'drop_oldest')).toHaveLength(2)
  expect(events.some(event => event.type === 'error')).toBe(false)
})

it('drops oldest cached history after the summary cap without dropping current instructions or results', async () => {
  const messages = history()
  const original = structuredClone(messages)
  let turns = 0
  let probes = 0
  let summaries = 0
  mocks.query.mockImplementation(request => ({
    async *[Symbol.asyncIterator]() {
      if (request.options.tools) {
        summaries++
        yield { type: 'result', subtype: 'success', result: 'Earlier order A123.' }
        return
      }
      expect(request.prompt).toContain('继续检查订单A123')
      if (request.options.maxTurns === 1) {
        probes++
        expect(request.prompt).toContain('Public completed result')
        if (request.prompt.includes('[历史对话摘要]') || request.prompt.includes('[最近对话]')) {
          yield { type: 'result', subtype: 'error_during_execution', errors: ['Prompt is too long'] }
        } else {
          yield { type: 'result', subtype: 'success', usage: { input_tokens: 100 } }
        }
        return
      }
      turns++
      if (turns === 1) {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Public completed result' }] } }
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Prompt is too long'] }
      } else {
        expect(request.prompt).toContain('Public completed result')
        yield { type: 'result', subtype: 'success', result: 'Finished.' }
      }
    }, close() {},
  }))
  const events = await collect(messages, {}, { ...settings, compaction_max_attempts: 1 })
  expect(summaries).toBe(1)
  expect(probes).toBe(3)
  expect(turns).toBe(2)
  expect(events.some(event => event.type === 'error')).toBe(false)
  expect(events.filter(event => event.type === 'done')).toHaveLength(1)
  expect(messages).toEqual(original)
})
