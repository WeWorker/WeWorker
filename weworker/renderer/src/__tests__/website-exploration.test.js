import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeSSE } from '../api/website-exploration-events.js'
import { resourcePath, deleteTool, deleteInstalledCommand } from '../api/website-exploration-api.js'
import { useWebsiteExplorationStore as store, leaveWebsiteExploration, changeWebsiteContext } from '../store/website-exploration.js'

test('SSE handles named events, CRLF, UTF-8 split bytes and multiline JSON', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: step_finished\r\ndata: {"step":1,\r\ndata: "title":"页面"}\r\n\r\nevent: exploration_succeeded\ndata: {}\n\n')
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const events = []
  await consumeSSE(stream, (event, data) => events.push([event, data]))
  assert.deepEqual(events, [['step_finished', { step: 1, title: '页面' }], ['exploration_succeeded', {}]])
})

test('resource URLs stay behind the backend', () => {
  assert.equal(resourcePath('/api/explorations/a/files/a.png'), '/api/website-exploration/explorations/a/files/a.png')
  assert.throws(() => resourcePath('https://example.com/a'))
  assert.throws(() => resourcePath('/api/explorations/a/files/../secret'))
  assert.throws(() => resourcePath('/api/website-exploration/../settings'))
})

test('Tool deletion sends the reviewed Adapter digest to one backend operation', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const calls = []
  globalThis.window = { electronAPI: {} }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) })
    return Response.json({ ok: true })
  }
  try {
    await deleteTool('demo', 'read_page', 'digest-1')
    await deleteInstalledCommand('demo.example.com', 'read-page', 'digest-2')
    assert.deepEqual(calls, [
      { url: 'http://127.0.0.1:8765/api/website-exploration/toolkits/demo/tools/read_page', method: 'DELETE', body: { expectedDigest: 'digest-1' } },
      { url: 'http://127.0.0.1:8765/api/website-exploration/adapters/demo.example.com/commands/read-page', method: 'DELETE', body: { expectedDigest: 'digest-2' } },
    ])
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('leaving a dirty workspace waits for explicit decision and preserves drafts on cancel', async () => {
  store.setState({ open: true, codeDraft: { code: 'draft' }, leaveRequest: null, drafts: { a: 'first' }, toolkitId: 'original' })
  const leave = leaveWebsiteExploration()
  assert.equal(store.getState().open, true)
  assert.equal(typeof store.getState().leaveRequest, 'function')
  store.getState().resolveLeave(false)
  assert.equal(await leave, false)
  assert.equal(store.getState().codeDraft.code, 'draft')
  const change = changeWebsiteContext({ toolkitId: 'next' })
  assert.equal(store.getState().toolkitId, 'original')
  store.setState({ codeDraft: null })
  store.getState().resolveLeave(true)
  assert.equal(await change, true)
  assert.equal(store.getState().toolkitId, 'next')
  assert.deepEqual(store.getState().drafts, { a: 'first' })
  assert.equal(await leaveWebsiteExploration(), true)
  assert.equal(store.getState().open, false)
})

test('a concurrent navigation cannot replace an unresolved leave request', async () => {
  store.setState({ open: true, codeDraft: { code: 'x' }, leaveRequest: null })
  const first = store.getState().guard()
  assert.equal(await store.getState().guard(), false)
  store.getState().resolveLeave(false)
  assert.equal(await first, false)
  store.setState({ codeDraft: null })
})
