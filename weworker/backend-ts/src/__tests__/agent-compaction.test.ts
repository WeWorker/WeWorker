import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../config.js'
import type { Message } from '../works-store.js'
import * as contextAssembly from '../context-assembly.js'

const mocks = vi.hoisted(() => ({ query: vi.fn(), directory: '' }))
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
vi.mock('../webcli-path.js', () => ({ resolveWebcliDir: () => path.join(mocks.directory, 'webcli') }))
vi.mock('../user-directory-access.js', () => ({
  buildAgentFilesystemSettings: () => ({}),
  createUnifiedToolGuard: () => async () => ({ behavior: 'deny' }),
}))

import { clearStoredConversationCompaction, streamChat } from '../agent.js'

function message(id: string, text: string, role: Message['role'] = 'user'): Message {
  return { id, work_id: 'compaction-test', role, content: [{ type: 'text', text }], created_at: '' }
}

const history = () => [
  message('old-user', '旧目标：保留订单号A123。' + '历史内容'.repeat(600)),
  message('old-assistant', '历史查询结果'.repeat(600), 'assistant'),
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
  mocks.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-compaction-test-'))
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
      if (typeof request.prompt === 'string') yield result
      else {
        const input = request.prompt
        for await (const message of input) {
          request.prompt = message.message.content
          yield result
        }
      }
    },
    close() {},
  }))
})

afterEach(() => {
  clearStoredConversationCompaction(options.workId)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(mocks.directory, { recursive: true, force: true })
})

describe('agent conversation compaction', () => {
  it.each([{ disabled: '1', enabled: false }, { disabled: '0', enabled: true }])(
    'applies the process memory switch to a real agent turn: disabled=$disabled', async ({ disabled, enabled }) => {
      vi.stubEnv('WEWORKER_DISABLE_AUTOMATIC_MEMORY', disabled)
      const recall = vi.spyOn(contextAssembly, 'recallLongTermMemory').mockReturnValue({ recalled: '' })
      await collect([message('only', '请回答测试问题')], { memoryEnabled: true })
      expect(mocks.query).toHaveBeenCalledOnce()
      const request = mocks.query.mock.calls[0][0]
      expect(request.options.systemPrompt.includes('<weworker_memory>')).toBe(enabled)
      expect(Boolean(request.options.hooks)).toBe(enabled)
      expect(recall.mock.calls.length).toBe(enabled ? 1 : 0)
    },
  )
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
    expect(events.some(event => event.type === 'error' && event.content === 'prompt is too long')).toBe(true)
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
    expect(events.some(event => event.type === 'error' && event.content === 'maximum context length exceeded')).toBe(true)
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
})
