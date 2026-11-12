import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ContentBlock, Message } from '../works-store.js'

const fixture = vi.hoisted(() => ({
  messages: [] as Message[],
  streamChat: vi.fn(),
  route: vi.fn(),
  work: { id: 'example-channel-work', title: 'Example conversation' },
}))
vi.mock('../agent.js', () => ({ streamChat: fixture.streamChat }))
vi.mock('../routed-turn.js', () => ({ tryRoutedTurn: fixture.route, historyBeforeLastUser: (messages: Message[]) => messages.slice(0, -1) }))
vi.mock('../config.js', () => ({ getSettings: () => ({ api_key: 'example-placeholder-key' }) }))
vi.mock('../style-settings.js', () => ({ resolveStyleId: () => null }))
vi.mock('../title-utils.js', () => ({ generateTitle: () => 'Example', generateTitleWithLLM: async () => null }))
vi.mock('../tools.js', () => ({ resolveToolDisplayName: (name: string) => name }))
vi.mock('../channels/site-auth-notifier.js', () => ({ siteAuthChannelNotifier: {
  registerTurn: () => ({ close() {}, observeToolCall() {}, finishToolCall() {} }),
} }))
vi.mock('../works-store.js', () => ({
  saveChannelNotifyTarget() {}, markExternalWrite() {},
  getOrCreateChannelWork: () => ({ work: fixture.work, created: false }),
  getWorkWithMessages: () => ({ ...fixture.work, messages: [...fixture.messages] }),
  appendMessage: (workId: string, role: string, content: ContentBlock[]) => {
    fixture.messages.push({ id: `example-message-${fixture.messages.length}`, work_id: workId, role, content: structuredClone(content), created_at: new Date().toISOString() })
  },
}))

import { WecomChannel } from '../channels/wecom-channel.js'
import { chatTurns } from '../chat-turn-lifecycle.js'
import { listBackgroundChatRuns } from '../background-chat-progress.js'

function deferred() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}
function bot() {
  const replies: string[] = []
  const channel = new WecomChannel({ enabled: true, bot_id: 'example-bot', secret: 'example-placeholder-secret' }, {
    channelKey: 'wecom', titleLabel: () => 'Example', welcomeText: () => '',
    authorize: () => ({ kind: 'allow', mode: 'full' }), memoryScope: () => ({ user: 'example-user' }), chatOptions: () => ({}),
  })
  ;(channel as any)._send = (frame: any) => replies.push(frame.body.stream.content)
  return { channel, replies, send: (text = 'Example request') => (channel as any)._onMessage({
    headers: { req_id: 'example-request' },
    body: { from: { userid: 'example-user' }, chattype: 'single', msgtype: 'text', text: { content: text } },
  }) as Promise<void> }
}
beforeEach(() => {
  fixture.messages = []
  fixture.route.mockReset().mockResolvedValue({ handled: false, text: '', timing: null })
  fixture.streamChat.mockReset()
})
afterEach(() => { expect(listBackgroundChatRuns()).toEqual([]) })

it('exposes initial, partial text and running tools, rejects overlap, then persists once', async () => {
  const route = deferred(), entered = deferred(), release = deferred()
  fixture.route.mockImplementation(async () => { await route.promise; return { handled: false } })
  fixture.streamChat.mockImplementation(async function* (_history, _settings, _controller, options) {
    expect(options.streaming).toBe(true)
    yield { type: 'text_delta', content: 'Partial answer' }
    yield { type: 'tool_call_start', id: 'example-tool', name: 'example.search', args: {} }
    yield { type: 'tool_call_start', id: 'example-tool', name: 'example.search', args: { query: 'example' } }
    entered.resolve(); await release.promise
    yield { type: 'tool_call_result', id: 'example-tool', result: 'Found' }
    yield { type: 'text_delta', content: 'Final answer' }
  })
  const b = bot(), running = b.send()
  try {
    expect(listBackgroundChatRuns()[0]).toMatchObject({ workId: fixture.work.id, source: 'channel', messages: [
      { role: 'user' }, { role: 'assistant', content: [] },
    ] })
    expect(chatTurns.start(fixture.work.id)).toBeNull()
    route.resolve(); await entered.promise
    const content = listBackgroundChatRuns()[0].messages.at(-1)!.content
    expect(content).toContainEqual({ type: 'text', text: 'Partial answer' })
    expect(content.filter(block => block.type === 'tool_use')).toEqual([
      expect.objectContaining({ id: 'example-tool', args: { query: 'example' }, status: 'running' }),
    ])
    await b.send('Overlapping request')
    expect(fixture.messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(fixture.streamChat).toHaveBeenCalledTimes(1)
    expect(b.replies.at(-1)).toContain('/stop')
  } finally { route.resolve(); release.resolve(); await running }
  expect(fixture.messages.filter(m => m.role === 'assistant')).toHaveLength(1)
  expect(fixture.messages.at(-1)!.content).toContainEqual(expect.objectContaining({ status: 'done', result: 'Found' }))
  const unlocked = chatTurns.start(fixture.work.id)
  expect(unlocked).not.toBeNull(); unlocked?.finish()
})

it('rejects a channel turn while the desktop owns the same conversation', async () => {
  const turn = chatTurns.start(fixture.work.id)!
  try {
    await bot().send()
    expect(fixture.messages).toEqual([])
    expect(fixture.streamChat).not.toHaveBeenCalled()
  } finally { turn.finish() }
})

it('keeps streamed Markdown continuous across timed remote updates and tool boundaries', async () => {
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 900)
  const fragments = ['`', 'ls` finished.\n\n| Type | Name |\n| --- | --- |\n| file | `exa', 'mple.json` |\n| file | `other.json` |\n']
  fixture.streamChat.mockImplementation(async function* () {
    for (const fragment of fragments) {
      yield { type: 'text_delta', content: fragment }
      expect(listBackgroundChatRuns()[0].messages.at(-1)!.content.filter(block => block.type === 'text')).toHaveLength(1)
    }
    yield { type: 'tool_call_start', id: 'example-tool', name: 'example.search' }
    yield { type: 'tool_call_result', id: 'example-tool', result: 'Found' }
    yield { type: 'text_delta', content: 'After ' }
    yield { type: 'text_delta', content: 'tool' }
  })
  try {
    await bot().send()
    const content = fixture.messages.at(-1)!.content.filter(block => block.type !== 'timing')
    expect(content).toEqual([
      { type: 'text', text: fragments.join('') },
      expect.objectContaining({ type: 'tool_use', id: 'example-tool', status: 'done' }),
      { type: 'text', text: 'After tool' },
    ])
  } finally { clock.mockRestore() }
})

it('does not start the model when stopped during routing', async () => {
  const entered = deferred(), release = deferred()
  fixture.route.mockImplementation(async () => {
    entered.resolve(); await release.promise
    return { handled: false }
  })
  const running = bot().send()
  await entered.promise
  try {
    const stopping = chatTurns.stop(fixture.work.id, 1000)
    release.resolve()
    expect(await stopping).toBe('stopped')
    await running
    expect(fixture.streamChat).not.toHaveBeenCalled()
    expect(fixture.messages.at(-1)!.content).toContainEqual({ type: 'text', text: '（已停止）' })
  } finally { release.resolve(); await running }
})

it.each(['throw', 'error-event'] as const)('persists partial output and failed tools on %s', async failure => {
  fixture.streamChat.mockImplementation(async function* () {
    yield { type: 'text_delta', content: 'Partial answer' }
    yield { type: 'tool_call_start', id: 'example-tool', name: 'example.search' }
    if (failure === 'throw') throw new Error('Example provider failure')
    yield { type: 'error', content: 'Example provider failure' }
  })
  await bot().send()
  const content = fixture.messages.at(-1)!.content
  expect(content).toContainEqual({ type: 'text', text: 'Partial answer' })
  expect(content).toContainEqual(expect.objectContaining({ type: 'error', text: expect.stringContaining('Example provider failure') }))
  expect(content).toContainEqual(expect.objectContaining({ type: 'tool_use', status: 'failed' }))
})

it('persists a routed answer without invoking the model and releases the shared lock', async () => {
  fixture.route.mockResolvedValue({ handled: true, text: 'Example routed answer', timing: null })
  await bot().send()
  expect(fixture.streamChat).not.toHaveBeenCalled()
  expect(fixture.messages.at(-1)!.content).toEqual([{ type: 'text', text: 'Example routed answer' }])
})

it('does not duplicate persisted output while remote image delivery is still pending', async () => {
  const delivering = deferred(), release = deferred()
  fixture.streamChat.mockImplementation(async function* () {
    yield { type: 'text_delta', content: 'Example answer' }
    yield { type: 'tool_call_start', id: 'example-image', name: 'example.capture' }
    yield { type: 'tool_call_image', id: 'example-image', data: 'ZXhhbXBsZQ==' }
  })
  const b = bot()
  ;(b.channel as any)._uploadImage = async () => { delivering.resolve(); await release.promise; return null }
  const running = b.send()
  await delivering.promise
  try {
    expect(listBackgroundChatRuns()[0].messages.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(listBackgroundChatRuns()[0].messages.at(-1)!.content).toContainEqual(expect.objectContaining({ id: 'example-image', status: 'done' }))
    expect(chatTurns.start(fixture.work.id)).toBeNull()
  } finally { release.resolve(); await running }
})

it.each(['desktop', 'remote', 'shutdown'] as const)('cancels a pending question through %s and retains partial history', async source => {
  const entered = deferred()
  fixture.streamChat.mockImplementation(async function* (_history, _settings, controller, options) {
    yield { type: 'text_delta', content: 'Before question' }
    const answer = options.channelAskUserHandler('Example question', [{ label: 'Example answer' }])
    entered.resolve(); await answer
    expect(controller.signal.aborted).toBe(true)
  })
  const b = bot(), running = b.send()
  await entered.promise
  if (source === 'desktop') expect(await chatTurns.stop(fixture.work.id, 1000)).toBe('stopped')
  else if (source === 'remote') await b.send('/stop')
  else await b.channel.stop()
  await running
  expect(fixture.messages.at(-1)!.content).toEqual(expect.arrayContaining([
    { type: 'text', text: 'Before question' }, { type: 'text', text: '（已停止）' },
  ]))
  expect((b.channel as any)._pendingChoiceResolvers.size).toBe(0)
})
