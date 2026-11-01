import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { consumeSSE } from '../api/website-exploration-events.js'
import { resourcePath } from '../api/website-exploration-api.js'
import { useWebsiteExplorationStore as store, leaveWebsiteExploration, changeWebsiteContext } from '../store/website-exploration.js'

const pageSource = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../components/website-exploration/WebsiteExplorationPage.jsx'), 'utf8')

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

test('website exploration page reports errors through the top message and hides the inline unavailable notice', () => {
  assert.match(pageSource, /message\.useMessage\(\)/)
  assert.match(pageSource, /messageApi\.error\(pageError\)/)
  assert.doesNotMatch(pageSource, /正在等待客户端托管的网站探索服务/)
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
