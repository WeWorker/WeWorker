import { needsAdapterApplyReview, adapterApplyFeedback } from '../utils/website-adapter-apply.js'
import { getInstallReview, applyAdapter } from '../api/website-exploration-api.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { consumeSSE } from '../api/website-exploration-events.js'
import { resourcePath, deleteTool, deleteInstalledCommand, matchBrowser } from '../api/website-exploration-api.js'
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

test('exploration page matching sends the Adapter and Tool identity and retains candidates', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { electronAPI: {} }
  const candidates = { status: 'choose', target: null, targets: [
    { target_id: 'one', url: 'https://example.com/a?x=1' },
    { target_id: 'two', url: 'https://example.com/b#open' },
  ] }
  globalThis.fetch = async url => {
    const params = new URL(url).searchParams
    assert.equal(params.get('toolkit_id'), 'demo')
    assert.equal(params.get('tool_id'), 'read_page')
    assert.equal(params.get('url'), 'https://example.com/')
    return Response.json(candidates)
  }
  try { assert.deepEqual(await matchBrowser('https://example.com/', 'demo', 'read_page'), candidates) }
  finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
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


test('whole Adapter review covers multiple commands and installation changes', () => {
  const review = { addedPermissions: [], changedTools: ['read_page'] }
  assert.equal(needsAdapterApplyReview(review), false)
  for (const change of [{ changedTools: ['read_page', 'list_items'] }, { addedPermissions: ['host:example.com'] }, { sourceChange: true }, { downgrade: true }, { overwritesNewerBase: true }]) {
    assert.equal(needsAdapterApplyReview({ ...review, ...change }), true)
  }
})

test('installation feedback distinguishes refresh and workspace acknowledgement failures', () => {
  assert.match(adapterApplyFeedback({ refreshed: false, acknowledged: true }), /能力同步待完成/)
  assert.match(adapterApplyFeedback({ refreshed: true, acknowledged: false }), /开发区状态同步待完成/)
  assert.match(adapterApplyFeedback({ refreshed: true, acknowledged: true }), /对话中调试/)
})

test('direct apply uses host review and install without local publish or debug calls', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const calls = []
  globalThis.window = { electronAPI: {} }
  globalThis.fetch = async (url, options) => {
    calls.push([String(url), options])
    return Response.json(String(url).endsWith('install-review') ? { reviewId: 'review-test' } : { refreshed: true, acknowledged: true })
  }
  try {
    const review = await getInstallReview('demo')
    await applyAdapter('demo', review.reviewId, true)
    assert.equal(calls.length, 2)
    assert.match(calls[0][0], /toolkits\/demo\/install-review$/)
    assert.match(calls[1][0], /toolkits\/demo\/install-apply$/)
    assert.deepEqual(JSON.parse(calls[1][1].body), { reviewId: 'review-test', acceptChanges: true })
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('URL exploration uses global endpoints without Adapter or Tool', async () => {
  const { listExplorations, createSiteExploration } = await import('../api/website-exploration-api.js')
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const calls = []
  globalThis.window = { electronAPI: {} }
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) })
    return Response.json(options.method === 'POST' ? { exploration_id: 'exp_site' } : { explorations: [{ exploration_id: 'exp_site', start_url: 'https://example.com' }] })
  }
  try {
    const created = await createSiteExploration({ start_url: 'https://example.com', instruction: '' })
    assert.equal(created.exploration_id, 'exp_site')
    assert.equal((await listExplorations())[0].start_url, 'https://example.com')
    assert.deepEqual(calls.map(call => [call.url, call.method]), [
      ['http://127.0.0.1:8765/api/website-exploration/explorations', 'POST'],
      ['http://127.0.0.1:8765/api/website-exploration/explorations?view=summary', 'GET'],
    ])
    assert.deepEqual(calls[0].body, { start_url: 'https://example.com', instruction: '' })
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('summary lists fall back only when the older backend explicitly rejects the request', async () => {
  const { listExplorations } = await import('../api/website-exploration-api.js')
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const calls = []
  globalThis.window = { electronAPI: {} }
  globalThis.fetch = async url => {
    calls.push(url)
    return url.includes('?view=summary')
      ? Response.json({ detail: '不支持的网站探索操作' }, { status: 404 })
      : Response.json({ explorations: [{ exploration_id: 'example', start_url: 'https://example.com', created_at: '2026-01-01T00:00:00Z' }] })
  }
  try {
    for (const [args, suffix] of [[[], '/explorations'], [['demo', 'read_page'], '/toolkits/demo/tools/read_page/explorations']]) {
      calls.length = 0
      const result = await listExplorations(...args)
      assert.equal(result[0].exploration_id, 'example')
      assert.equal(result[0].created_at_timestamp, Date.parse('2026-01-01T00:00:00Z'))
      assert.deepEqual(calls, [
        'http://127.0.0.1:8765/api/website-exploration' + suffix + '?view=summary',
        'http://127.0.0.1:8765/api/website-exploration' + suffix,
      ])
    }
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('summary list failures preserve authorization, service and missing-record errors without retrying', async () => {
  const { listExplorations } = await import('../api/website-exploration-api.js')
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { electronAPI: {} }
  try {
    for (const status of [401, 403, 404, 500, 503]) {
      let requests = 0
      globalThis.fetch = async () => { requests++; return Response.json({ detail: 'Example failure' }, { status }) }
      await assert.rejects(listExplorations(), /Example failure/)
      assert.equal(requests, 1)
    }
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})

test('website exploration always renders exploration without workspace tabs or Adapter management', () => {
  assert.match(pageSource, /<ExploreWorkspace disabled=/)
  assert.doesNotMatch(pageSource, /<nav|wx-tabs|DevelopWorkspace|Adapter 目录|ManageModal|DeleteInstalledCommandModal/)
  assert.doesNotMatch(pageSource, /s => s.workspace|workspace ===|changeWebsiteContext/)
  assert.doesNotMatch(pageSource, /listToolkits|listInstalledAdapters|getExportStatus|listTools/)
  assert.doesNotMatch(pageSource, /<ExploreWorkspace[^>]+toolkitId=/)
})

test('current exploration is supplied to list ordering without a redundant navigation button', () => {
  assert.match(pageSource, /activity.kind === 'exploration'/)
  assert.match(pageSource, /activeExplorationId=\{activeExploration \|\| ''\}/)
  assert.doesNotMatch(pageSource, /查看当前探索|selectRecord\('site\/exploration'/)
  assert.doesNotMatch(pageSource, /activity.kind === 'development'|activity.kind === 'debug'/)
})

test('module navigation retains selected exploration and development context', async () => {
  store.setState({ codeDraft: null, leaveRequest: null, toolkitId: 'demo', toolId: 'search', selections: { 'site/exploration': 'exp_site' }, workspace: 'explore' })
  await changeWebsiteContext({ workspace: 'develop' })
  await changeWebsiteContext({ workspace: 'explore' })
  assert.equal(store.getState().toolkitId, 'demo')
  assert.equal(store.getState().toolId, 'search')
  assert.equal(store.getState().selections['site/exploration'], 'exp_site')
})


test('exploration list retains a raw creation timestamp alongside its displayed time', async () => {
  const { listExplorations } = await import('../api/website-exploration-api.js')
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { electronAPI: {} }
  globalThis.fetch = async () => Response.json({ explorations: [
    { exploration_id: 'earlier', created_at: '2026-11-03T09:00:00+08:00', updated_at: '2026-11-03T18:00:00+08:00' },
    { exploration_id: 'later', created_at: '2026-11-03T02:00:00Z' },
    { exploration_id: 'missing', created_at: '' },
    { exploration_id: 'invalid', created_at: 'invalid-date' },
  ] })
  try {
    const records = await listExplorations()
    assert.equal(records[0].created_at_timestamp, Date.parse('2026-11-03T01:00:00Z'))
    assert.ok(records[1].created_at_timestamp > records[0].created_at_timestamp)
    assert.equal(records[0].created_at, new Date('2026-11-03T01:00:00Z').toLocaleString('zh-CN', { hour12: false }))
    assert.ok(Number.isNaN(records[2].created_at_timestamp))
    assert.ok(Number.isNaN(records[3].created_at_timestamp))
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow }
})
