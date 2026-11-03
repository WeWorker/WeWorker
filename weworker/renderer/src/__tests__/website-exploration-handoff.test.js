import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { finishExplorationTransfer, openDevelopmentChat, useWebsiteExplorationStore as exploration } from '../store/website-exploration.js'
import { useWorksStore as works } from '../store/works.js'
import { useChatDraftStore as drafts } from '../store/chat-drafts.js'
import { useScheduledTasksStore as scheduled } from '../store/scheduled-tasks.js'
import { useDedicatedAgentsStore as agents } from '../store/dedicated-agents.js'
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const body = { instruction: 'Read title', source_exploration_id: 'exp_example', exploration_only: false, debug_run_evidence_id: '' }
function setup() {
  globalThis.window = { electronAPI: {} }
  exploration.setState({ open: true, codeDraft: null, leaveRequest: null })
  works.setState({ works: [{ id: 'existing' }], activeWorkId: 'existing', manualStartWorkIds: new Set(), pendingMessage: 'unrelated pending message', messages: { existing: ['kept'] } })
  drafts.setState({ drafts: { 'work:existing': { text: 'keep me', attachments: [] }, welcome: { text: 'welcome draft', attachments: [] } } })
}
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; exploration.setState({ codeDraft: null, leaveRequest: null }) })
test('handoff seeds a fresh chat draft with real attachment and never sends a turn', async () => {
  setup()
  scheduled.setState({ activeTaskId: 'task' })
  agents.setState({ open: true })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return Response.json({ work: { id: 'new' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read input.json and Skill' })
  }
  await Promise.all([openDevelopmentChat('demo', 'read_title', body), openDevelopmentChat('demo', 'read_title', body)])
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:8765/api/website-exploration/toolkits/demo/tools/read_title/development/chat', method: 'POST', body }])
  assert.equal(works.getState().activeWorkId, 'new')
  assert.equal(works.getState().manualStartWorkIds.has('new'), true)
  assert.equal(works.getState().pendingMessage, 'unrelated pending message')
  assert.deepEqual(works.getState().messages.existing, ['kept'])
  assert.equal(drafts.getState().drafts['work:existing'].text, 'keep me')
  assert.equal(drafts.getState().drafts.welcome.text, 'welcome draft')
  assert.equal(drafts.getState().drafts['work:new'].attachments[0].name, 'input.json')
  assert.equal(drafts.getState().drafts['work:new'].text, 'Read input.json and Skill')
  assert.equal(exploration.getState().open, false)
  assert.equal(scheduled.getState().activeTaskId, null)
  assert.equal(agents.getState().open, false)
})
test('handoff error leaves current page and drafts unchanged', async () => {
  setup()
  globalThis.fetch = async () => Response.json({ detail: 'Source unavailable' }, { status: 409 })
  await assert.rejects(openDevelopmentChat('demo', 'read_title', body), /Source unavailable/)
  assert.equal(exploration.getState().open, true)
  assert.equal(works.getState().activeWorkId, 'existing')
  assert.equal(Object.keys(drafts.getState().drafts).length, 2)
})
test('dirty-code cancellation does not prepare a chat', async () => {
  setup()
  exploration.setState({ codeDraft: { code: 'unsaved' } })
  globalThis.fetch = async () => assert.fail('must not request handoff')
  const pending = openDevelopmentChat('demo', 'read_title', body)
  exploration.getState().resolveLeave(false)
  assert.equal(await pending, false)
  assert.equal(exploration.getState().open, true)
})
test('exploration shortcut retains target selection and only opens the main chat', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  const development = readFileSync(new URL('../components/website-exploration/DevelopWorkspace.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(development, /到WeWorker中开发|openDevelopmentChat/)
  assert.match(source, /<TransferExploration exploration=\{data\}/)
  const actions = source.slice(source.indexOf("{data.status === 'succeeded' &&"), source.indexOf('</div></header>'))
  assert.match(actions, /setTransferring\(true\)/)
  assert.doesNotMatch(actions, /转为开发|develop/)
  assert.doesNotMatch(actions, /modelReady/)
  const dialog = source.slice(source.indexOf('function TransferExploration'))
  assert.match(dialog, /api.createToolkit/)
  assert.match(dialog, /api.createTool/)
  assert.match(dialog, /aria-label="目标 Adapter"/)
  assert.match(dialog, /aria-label="目标 Tool"/)
  assert.match(dialog, /finishExplorationTransfer\(\{/)
  assert.match(dialog, /选择并打开对话/)
  assert.doesNotMatch(dialog, /选择并进入开发|destination|toChat/)
})
test('exploration toolbar shows chat then replay without a local development menu', () => {
  const source = readFileSync(new URL('../components/website-exploration/ExploreWorkspace.jsx', import.meta.url), 'utf8')
  const actions = source.slice(source.indexOf("{data.status === 'succeeded' &&"), source.indexOf('</div></header>'))
  assert.ok(actions.indexOf('到WeWorker中开发</button>') >= 0)
  assert.ok(actions.indexOf('回放</button>') > actions.indexOf('到WeWorker中开发</button>'))
  assert.doesNotMatch(source, /转为开发|<ActionMenu|changeWebsiteContext/)
  assert.match(actions, /!active && <button/)
  assert.match(actions, /!data.timeline\?\.some/)
})
test('selected exploration and target prepare a chat directly, without navigating to development or replacing its drafts', async () => {
  setup()
  exploration.setState({ workspace: 'explore', drafts: { 'demo/read_title/source': 'keep-source' } })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return Response.json({ work: { id: 'target-chat' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read Skill' })
  }
  assert.equal(await finishExplorationTransfer({ toolkitId: 'demo', toolId: 'read_title', explorationId: 'exp_selected', instruction: 'Read title' }), true)
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:8765/api/website-exploration/toolkits/demo/tools/read_title/development/chat',
    body: { instruction: 'Read title', source_exploration_id: 'exp_selected', debug_run_evidence_id: '', exploration_only: true },
  }])
  assert.equal(exploration.getState().workspace, 'explore')
  assert.equal(exploration.getState().drafts['demo/read_title/source'], 'keep-source')
  assert.equal(works.getState().activeWorkId, 'target-chat')
})
test('target selection never falls back to the hidden local development workflow', async () => {
  setup()
  exploration.setState({ workspace: 'develop', drafts: {} })
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method || 'GET' })
    return Response.json({ work: { id: 'target-chat' }, attachment: { path: 'C:/example/input.json', name: 'input.json' }, prompt: 'Read Skill' })
  }
  assert.equal(await finishExplorationTransfer({ toolkitId: 'demo', toolId: 'read_title', explorationId: 'exp_selected' }), true)
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:8765/api/website-exploration/toolkits/demo/tools/read_title/development/chat', method: 'POST' },
  ])
  assert.equal(exploration.getState().open, false)
  assert.deepEqual(exploration.getState().drafts, {})
  assert.equal(works.getState().activeWorkId, 'target-chat')
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
  const pending = openDevelopmentChat('demo', 'read_title', body)
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
})

test('handoff chats bypass both pending message and shell auto-send on mount', () => {
  const source = readFileSync(new URL('../components/chat/ChatView.jsx', import.meta.url), 'utf8')
  const guard = source.indexOf('if (useWorksStore.getState().manualStartWorkIds.has(workId)) return')
  assert.ok(guard > 0)
  assert.ok(guard < source.indexOf('const pending = useWorksStore.getState().pendingMessage'))
  assert.ok(guard < source.indexOf('const pendingShellCommand = useWorksStore.getState().pendingShellCommand'))
})
