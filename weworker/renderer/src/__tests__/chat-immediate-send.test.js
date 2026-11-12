import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { createMessageQueue } from '../utils/message-queue.js'
import { useWorksStore } from '../store/works.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('immediate send describes interruption and context retention', () => {
  const source = readFileSync(new URL('../components/chat/MessageQueue.jsx', import.meta.url), 'utf8')
  assert.match(source, /立即发送：停止当前回复，保留上下文并发送此消息/)
})

for (const permissionMode of ['ask', 'workspace', 'full']) {
  test(`immediate send stops and reloads the interruption point in ${permissionMode} mode`, async t => {
    const before = useWorksStore.getState()
    t.after(() => useWorksStore.setState(before, true))
    t.mock.method(globalThis, 'fetch', async () => Response.json({ messages: saved }))
    const previousWindow = globalThis.window
    globalThis.window = {}
    t.after(() => { globalThis.window = previousWindow })
    const controller = new AbortController()
    const saved = [
      { id: 'user', role: 'user', content: [{ type: 'text', text: 'original goal' }] },
      { id: 'partial', role: 'assistant', content: [
        { type: 'text', text: 'completed text and trailing partial output' },
        { type: 'tool_use', id: 'done-tool', status: 'done', result: 'completed result' },
        { type: 'tool_use', id: 'pending-tool', status: 'cancelled' },
      ] },
    ]
    useWorksStore.setState({ streamingWorkIds: new Set(), backgroundChatRuns: {}, abortControllers: {}, messages: {} })
    const oldStream = deferred()
    const stopped = deferred()
    let stopRequested = false
    let nextContext
    let sent = 0
    const send = async item => {
      sent++
      if (sent === 1) {
        useWorksStore.setState({ streamingWorkIds: new Set(['fixture']), abortControllers: { fixture: controller } })
        return oldStream.promise
      }
      nextContext = structuredClone(useWorksStore.getState().messages.fixture)
      assert.equal(item.permissionMode, permissionMode)
      assert.equal(item.files[0].name, 'sample.txt')
      return { status: 'completed', accepted: true }
    }
    const queue = createMessageQueue()
    const source = readFileSync(new URL('../components/chat/ChatView.jsx', import.meta.url), 'utf8')
    const start = source.indexOf('  queue.setHandlers({')
    const end = source.indexOf('\n  // A handoff', start)
    const context = vm.createContext({ queue, workId: 'fixture', useWorksStore,
      stopChat: async () => { stopRequested = true; await stopped.promise },
    })
    vm.runInContext(source.slice(start, end), context)
    // Exercise ChatView's real stop/refresh handlers with a controlled stream.
    queue.setHandlers({ send })
    queue.enqueue({ text: 'original goal', permissionMode }); await tick()
    const id = queue.enqueue({ text: 'use the corrected limit', permissionMode, files: [{ name: 'sample.txt' }] })
    const sending = queue.sendNow(id)
    assert.equal(stopRequested, true)
    assert.equal(sent, 1)
    stopped.resolve(); await tick()
    assert.equal(controller.signal.aborted, true)
    assert.equal(sent, 1)
    oldStream.resolve({ status: 'stopped', accepted: true })
    await sending; await tick()
    assert.equal(sent, 2)
    assert.deepEqual(nextContext, saved)
    queue.dispose()
  })
}

test('immediate send stops a background chat and waits for its saved history', async t => {
  const before = useWorksStore.getState()
  t.after(() => useWorksStore.setState(before, true))
  const previousWindow = globalThis.window
  globalThis.window = {}
  t.after(() => { globalThis.window = previousWindow })
  const events = []
  const stopped = deferred()
  const refreshed = deferred()
  const saved = [{ id: 'partial', role: 'assistant', content: [{ type: 'text', text: 'saved background output' }] }]
  t.mock.method(globalThis, 'fetch', async () => {
    events.push('refresh')
    await refreshed.promise
    return Response.json({ messages: saved })
  })
  useWorksStore.setState({
    streamingWorkIds: new Set(['fixture']), backgroundChatRuns: { fixture: 'fixture-run' },
    abortControllers: {}, messages: {}, contextCompactionStatuses: {},
    syncBackgroundChatRuns: async () => {
      events.push('sync')
      useWorksStore.setState({ streamingWorkIds: new Set(), backgroundChatRuns: {} })
    },
  })
  const queue = createMessageQueue()
  t.after(() => queue.dispose())
  const source = readFileSync(new URL('../components/chat/ChatView.jsx', import.meta.url), 'utf8')
  const start = source.indexOf('  queue.setHandlers({')
  const end = source.indexOf('\n  // A handoff', start)
  vm.runInContext(source.slice(start, end), vm.createContext({ queue, workId: 'fixture', useWorksStore,
    stopChat: async () => { events.push('stop'); await stopped.promise },
  }))
  queue.setHandlers({ send: async () => {
    events.push('send')
    assert.deepEqual(useWorksStore.getState().messages.fixture, saved)
    return { status: 'completed', accepted: true }
  } })
  const id = queue.enqueue({ text: 'correct the background task' }); await tick()
  assert.deepEqual(events, [])
  const sending = queue.sendNow(id)
  assert.deepEqual(events, ['stop'])
  stopped.resolve(); await tick()
  assert.deepEqual(events, ['stop', 'sync', 'refresh'])
  refreshed.resolve(); await sending; await tick()
  assert.deepEqual(events, ['stop', 'sync', 'refresh', 'send'])
})

test('required history refresh fails without replacing the existing conversation', async t => {
  const before = useWorksStore.getState()
  t.after(() => useWorksStore.setState(before, true))
  const previousWindow = globalThis.window
  globalThis.window = {}
  t.after(() => { globalThis.window = previousWindow })
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  t.mock.method(console, 'error', () => {})
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'keep partial output' }] }]
  useWorksStore.setState({ streamingWorkIds: new Set(), messages: { fixture: messages } })
  await assert.rejects(useWorksStore.getState().refreshWorkMessages('fixture', { required: true }), /排队消息已保留/)
  assert.deepEqual(useWorksStore.getState().messages.fixture, messages)
})
