import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { continueWebsiteExploration, rememberDevelopmentSession, finishExplorationTransfer, openDevelopmentChat, useWebsiteExplorationStore as exploration } from '../store/website-exploration.js'
import { explorationDevelopmentPermissionSettings, saveChatPermissionMode } from '../utils/chat-permission-preferences.js'
import { useWorksStore as works } from '../store/works.js'
import { useChatDraftStore as drafts } from '../store/chat-drafts.js'
import { useScheduledTasksStore as scheduled } from '../store/scheduled-tasks.js'
import { useDedicatedAgentsStore as agents } from '../store/dedicated-agents.js'
import { getMessageQueue, discardMessageQueue, useMessageQueueStore } from '../store/message-queue.js'
import { useExplorationDevelopmentHandoffsStore as handoffs } from '../store/exploration-development-handoffs.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const body = { instruction: 'Read title' }
function setup() {
  handoffs.setState({ handoffs: {}, sessions: {} })
  globalThis.window = { electronAPI: {} }
  exploration.setState({ open: true, codeDraft: null, leaveRequest: null })
  works.setState({ embeddedWorks: {}, works: [{ id: 'existing' }], activeWorkId: 'existing', handoffWorkIds: new Set(), pendingMessage: 'unrelated pending message', pendingAttachments: [{ name: 'other.txt', path: 'C:/example/other.txt' }], pendingShellCommand: { command: 'echo unrelated' }, messages: { existing: ['kept'] } })
  drafts.setState({ drafts: { 'work:existing': { text: 'keep me', attachments: [] }, welcome: { text: 'welcome draft', attachments: [] } } })
}
afterEach(() => { for (const id of Object.keys(useMessageQueueStore.getState().queues)) discardMessageQueue(id); globalThis.fetch = originalFetch; globalThis.window = originalWindow; exploration.setState({ codeDraft: null, leaveRequest: null }) })
test('handoff queues one initial turn with its real attachment before opening the chat', async () => {
  setup()
  scheduled.setState({ activeTaskId: 'task' })
  agents.setState({ open: true })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return Response.json({ work: { id: 'new' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read input.json and Skill' })
  }
  let queuedOnOpen
  const unsubscribe = exploration.subscribe((state, previous) => {
    if (previous.open && !state.open) queuedOnOpen = getMessageQueue('new').snapshot().items.length
  })
  try {
    await Promise.all([openDevelopmentChat('exp_example', body), openDevelopmentChat('exp_example', body)])
  } finally { unsubscribe() }
  assert.equal(queuedOnOpen, undefined)
  assert.deepEqual(works.getState().works, [{ id: 'existing' }])
  assert.equal(works.getState().embeddedWorks.new.id, 'new')
  assert.deepEqual(handoffs.getState().handoffs.exp_example, { workId: 'new', runId: null })
  assert.equal(await openDevelopmentChat('exp_example', body), false)
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:8765/api/website-exploration/explorations/exp_example/development/chat', method: 'POST', body: { ...body, run_id: null } }])
  assert.equal(works.getState().activeWorkId, 'existing')
  assert.equal(works.getState().handoffWorkIds.has('new'), true)
  assert.equal(works.getState().pendingMessage, 'unrelated pending message')
  assert.deepEqual(works.getState().messages.existing, ['kept'])
  assert.equal(drafts.getState().drafts['work:existing'].text, 'keep me')
  assert.equal(drafts.getState().drafts.welcome.text, 'welcome draft')
  assert.equal(drafts.getState().drafts['work:new'], undefined)
  const queue = getMessageQueue('new')
  const [item] = queue.snapshot().items
  assert.equal(item.text, 'Read input.json and Skill')
  assert.deepEqual(item.files, [{ path: 'C:/example/input.json', name: 'input.json' }])
  assert.equal(item.thinkingEffort, 'off')
  assert.equal(item.permissionMode, 'full')
  assert.equal(item.command, undefined)
  assert.deepEqual(works.getState().pendingShellCommand, { command: 'echo unrelated' })
  assert.equal(works.getState().pendingAttachments[0].name, 'other.txt')
  // Simulate ChatView binding/rebinding the normal sender (including StrictMode).
  const sent = []
  let finish
  queue.setHandlers({ send: payload => { sent.push(payload); return new Promise(resolve => { finish = resolve }) } })
  queue.wake(); queue.wake()
  await tick()
  queue.setHandlers({ send: payload => { sent.push(payload); return { status: 'completed' } } })
  queue.wake()
  await tick()
  assert.equal(sent.length, 1)
  finish({ status: 'completed', accepted: true })
  await tick()
  queue.wake()
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(queue.snapshot().items.length, 0)
  assert.equal(exploration.getState().open, true)
  assert.equal(scheduled.getState().activeTaskId, 'task')
  assert.equal(agents.getState().open, true)
})
test('handoff error leaves current page and drafts unchanged', async () => {
  setup()
  globalThis.fetch = async () => Response.json({ detail: 'Source unavailable' }, { status: 409 })
  await assert.rejects(openDevelopmentChat('exp_example', body), /Source unavailable/)
  assert.equal(exploration.getState().open, true)
  assert.equal(works.getState().activeWorkId, 'existing')
  assert.equal(Object.keys(drafts.getState().drafts).length, 2)
  assert.deepEqual(handoffs.getState().handoffs, {})
})
test('dirty-code cancellation does not prepare a chat', async () => {
  setup()
  exploration.setState({ codeDraft: { code: 'unsaved' } })
  globalThis.fetch = async () => assert.fail('must not request handoff')
  const pending = openDevelopmentChat('exp_example', body)
  exploration.getState().resolveLeave(false)
  assert.equal(await pending, false)
  assert.equal(exploration.getState().open, true)
})
test('inline completion choice hands exploration directly to embedded development without target selection', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /TransferExploration|api.createToolkit|api.createTool|开发目标|setDevelopmentChoice/)
  const actions = source.slice(source.indexOf("{data.status === 'succeeded' &&"), source.indexOf('{data.active_issue'))
  assert.match(actions, /transferAction.run\(\(\) => finishExplorationTransfer\(\{ explorationId: id, runId: data.last_run_id \?\? null \}\)\)/)
  assert.doesNotMatch(actions, /modelReady|toolkitId|toolId/)
  assert.match(source, /transferAction.error/)
})
test('exploration asks about development in the message stream, not a header button or popup', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  const actions = source.slice(source.indexOf("{data.status === 'succeeded' &&"), source.indexOf('{data.active_issue'))
  assert.match(actions, /<CompletionQuestion/)
  assert.match(actions, /onContinue=\{\(\) => sendMessage/)
  assert.doesNotMatch(source, /到WeWorker中开发|<Modal/)
  const detail = source.slice(source.indexOf('function ExplorationDetail'))
  const header = detail.slice(detail.indexOf('<header>'), detail.indexOf('</header>'))
  assert.doesNotMatch(header, /button|CompletionQuestion/)
  assert.doesNotMatch(actions, /回放|暂停|取消运行/)
  assert.doesNotMatch(source, /转为开发|<ActionMenu|changeWebsiteContext/)
  assert.match(source, /<ExplorationComposer[\s\S]*<ExplorationControls/)
  assert.doesNotMatch(source, /api\.replayExploration\(/)
})
test('selected exploration and target prepare a chat directly, without navigating to development or replacing its drafts', async () => {
  setup()
  exploration.setState({ workspace: 'explore', drafts: { 'demo/read_title/source': 'keep-source' } })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return Response.json({ work: { id: 'target-chat' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read Skill' })
  }
  assert.equal(await finishExplorationTransfer({ explorationId: 'exp_selected', instruction: 'Read title' }), true)
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:8765/api/website-exploration/explorations/exp_selected/development/chat',
    body: { instruction: 'Read title', run_id: null },
  }])
  assert.equal(exploration.getState().workspace, 'explore')
  assert.equal(exploration.getState().drafts['demo/read_title/source'], 'keep-source')
  assert.equal(works.getState().activeWorkId, 'existing')
})
test('target selection never falls back to the hidden local development workflow', async () => {
  setup()
  exploration.setState({ workspace: 'develop', drafts: {} })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method || 'GET' })
    return Response.json({ work: { id: 'target-chat' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read Skill' })
  }
  assert.equal(await finishExplorationTransfer({ explorationId: 'exp_selected' }), true)
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:8765/api/website-exploration/explorations/exp_selected/development/chat', method: 'POST' },
  ])
  assert.equal(exploration.getState().open, true)
  assert.deepEqual(exploration.getState().drafts, {})
  assert.equal(works.getState().activeWorkId, 'existing')
})

test('code edited during handoff can cancel navigation without losing the prepared draft', async () => {
  setup()
  let respond
  const requested = new Promise(resolve => { respond = resolve })
  let release
  globalThis.fetch = async () => {
    respond()
    return new Promise(resolve => { release = resolve })
  }
  const pending = openDevelopmentChat('exp_example', body)
  await requested
  exploration.setState({ codeDraft: { code: 'new unsaved edit' } })
  release(Response.json({ work: { id: 'prepared' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read input' }))
  // Wait for the normal leave guard to be installed after the response is decoded.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof exploration.getState().leaveRequest, 'function')
  exploration.getState().resolveLeave(false)
  assert.equal(await pending, false)
  assert.equal(works.getState().activeWorkId, 'existing')
  assert.equal(exploration.getState().open, true)
  assert.equal(drafts.getState().drafts['work:prepared'].text, 'Read input')
  assert.equal(useMessageQueueStore.getState().queues.prepared, undefined)
  assert.deepEqual(handoffs.getState().handoffs, {})
})

test('handoff chats bypass both pending message and shell auto-send on mount', () => {
  const source = readFileSync(new URL('../components/chat/ChatView.jsx', import.meta.url), 'utf8')
  const guard = source.indexOf('if (useWorksStore.getState().handoffWorkIds.has(workId)) return')
  assert.ok(guard > 0)
  assert.ok(guard < source.indexOf('const pending = useWorksStore.getState().pendingMessage'))
  assert.ok(guard < source.indexOf('const pendingShellCommand = useWorksStore.getState().pendingShellCommand'))
})


test('failed automatic send pauses until explicit retry and preserves the attachment', async () => {
  setup()
  globalThis.fetch = async () => Response.json({ work: { id: 'retry' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read Skill' })
  await openDevelopmentChat('exp_example')
  const queue = getMessageQueue('retry')
  const sent = []
  queue.setHandlers({ send: payload => {
    sent.push(payload)
    return sent.length === 1 ? { status: 'failed', accepted: false, error: 'Example network error' } : { status: 'completed', accepted: true }
  } })
  queue.wake()
  await tick()
  queue.wake(); queue.wake()
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(queue.snapshot().pausedReason, 'Example network error')
  assert.equal(queue.snapshot().items[0].files[0].name, 'input.json')
  queue.resume()
  await tick()
  assert.equal(sent.length, 2)
  assert.equal(sent[0].id, sent[1].id)
  assert.equal(queue.snapshot().items.length, 0)
})

test('handoff renders queued state without welcome animation or a history-fetch race', () => {
  const source = readFileSync(new URL('../components/chat/ChatView.jsx', import.meta.url), 'utf8')
  assert.ok(source.includes('useLayoutEffect(() => { if (isHandoffChat) queue.wake()'))
  const queueGuard = source.indexOf('(queued.running || queued.items.length)')
  assert.ok(queueGuard > 0)
  assert.ok(queueGuard < source.indexOf('await selectWork(workId)'))
  assert.ok(source.includes("isHandoffChat ? '' : ' motion-view-enter'"))
  assert.ok(source.includes('!queueState.running && !queueState.items.length ? (renderEmpty'))
})


test('only an accepted followup or resume clears the submitted marker for that exploration', async () => {
  setup()
  for (const resumable of [false, true]) {
    handoffs.getState().record('exp_example', 'existing-chat', 'run-first')
    handoffs.getState().record('exp_other', 'other-chat', 'run-other')
    globalThis.fetch = async () => Response.json({ detail: 'Example busy' }, { status: 409 })
    await assert.rejects(continueWebsiteExploration('exp_example', 'Read the next page', resumable), /Example busy/)
    assert.equal(handoffs.getState().handoffs.exp_example.workId, 'existing-chat')
    globalThis.fetch = async (url) => {
      assert.ok(url.endsWith(resumable ? '/resume' : '/messages'))
      return Response.json({ exploration_id: 'exp_example', status: 'running' })
    }
    await continueWebsiteExploration('exp_example', 'Read the next page', resumable)
    assert.equal(handoffs.getState().handoffs.exp_example, undefined)
    assert.equal(handoffs.getState().handoffs.exp_other.workId, 'other-chat')
  }
})

test('a new exploration run can submit again but the same run cannot', async () => {
  setup()
  handoffs.getState().record('exp_example', 'old-chat', 'run-first')
  handoffs.getState().remember({ explorationId: 'exp_example', runId: 'run-first', work: { id: 'old-chat' } })
  globalThis.fetch = async () => assert.fail('same run must not create another chat')
  assert.equal(await openDevelopmentChat('exp_example', {}, 'run-first'), false)
  globalThis.fetch = async () => Response.json({ work: { id: 'new-run-chat' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read Skill' })
  assert.equal(await finishExplorationTransfer({ explorationId: 'exp_example', runId: 'run-second' }), true)
  assert.deepEqual(handoffs.getState().handoffs.exp_example, { workId: 'new-run-chat', runId: 'run-second' })
})


test('different explorations prepare independent conversations concurrently', async () => {
  setup()
  globalThis.fetch = async url => {
    const id = url.includes('/exp_one/') ? 'dev-one' : 'dev-two'
    return Response.json({ work: { id }, attachment: { path: 'C:/example/' + id + '/input.json', name: 'input.json' }, prompt: 'Read input' })
  }
  await Promise.all([openDevelopmentChat('exp_one'), openDevelopmentChat('exp_two')])
  assert.equal(handoffs.getState().handoffs.exp_one.workId, 'dev-one')
  assert.equal(handoffs.getState().handoffs.exp_two.workId, 'dev-two')
  assert.equal(getMessageQueue('dev-one').snapshot().items.length, 1)
  assert.equal(getMessageQueue('dev-two').snapshot().items.length, 1)
  assert.deepEqual(works.getState().works, [{ id: 'existing' }])
})
test('recovered accepted conversation preserves its draft and never resends the initial task', async () => {
  setup()
  drafts.getState().setText('work:recovered', 'unsent followup')
  globalThis.fetch = async () => Response.json({ work: { id: 'recovered' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read input', needsInitialMessage: false })
  await openDevelopmentChat('exp_example')
  assert.equal(getMessageQueue('recovered').snapshot().items.length, 0)
  assert.equal(drafts.getState().drafts['work:recovered'].text, 'unsent followup')
  assert.equal(works.getState().activeWorkId, 'existing')
})
test('history hydration caches metadata without executing, selecting, or replacing messages', async () => {
  setup()
  works.setState({ messages: { existing: ['kept'], recovered: ['live'] } })
  await rememberDevelopmentSession({ explorationId: 'exp_example', runId: 'run_one', work: { id: 'recovered' }, needsInitialMessage: true })
  assert.equal(useMessageQueueStore.getState().queues.recovered, undefined)
  assert.deepEqual(works.getState().messages.recovered, ['live'])
  assert.equal(works.getState().activeWorkId, 'existing')
  assert.deepEqual(works.getState().works, [{ id: 'existing' }])
})

test('automatic recovery uses the same saved permission as its composer without changing main preference', async () => {
  setup()
  const settings = explorationDevelopmentPermissionSettings('restricted-recovery')
  saveChatPermissionMode('ask', settings.permissionScope)
  globalThis.fetch = async () => Response.json({ work: { id: 'restricted-recovery' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read input', needsInitialMessage: true })
  await openDevelopmentChat('exp_recovery')
  assert.equal(getMessageQueue('restricted-recovery').snapshot().items[0].permissionMode, 'ask')
})
