import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let server, dom, createRoot, Workspace, store, handoffs
const originalFetch = globalThis.fetch
const globals = new Map()
const id = 'exp_example'

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} } })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  Workspace = (await server.ssrLoadModule('/src/components/website-exploration/ExploreWorkspace.jsx')).default
  store = (await server.ssrLoadModule('/src/store/website-exploration.js')).useWebsiteExplorationStore
  handoffs = (await server.ssrLoadModule('/src/store/exploration-development-handoffs.js')).useExplorationDevelopmentHandoffsStore
})

after(async () => {
  await server?.close()
  dom?.window.close()
  globalThis.fetch = originalFetch
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

async function mount(t, draft = '', attachments = []) {
  const posts = []
  let runId = 'run_example'
  const record = () => ({ exploration_id: id, title: '示例网站', start_url: 'https://example.com', status: 'succeeded', last_run_id: runId })
  const selection = { provider: '__independent__', model: 'example-model', thinking_effort: 'off' }
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname.replace('/api/website-exploration', '')
    if (path === '/settings/exploration-model/resolve') return Response.json({ selection, selected_provider: selection.provider, effective_model: selection.model, thinking_effort: 'off' })
    if (path === '/settings/exploration-model/check') return Response.json({ ok: true })
    if (path.endsWith('/model')) return Response.json({ model_selection: selection })
    if (options.method === 'POST') {
      posts.push({ path, body: JSON.parse(options.body) })
      runId = 'run_next'
      return Response.json({})
    }
    if (path === '/explorations') return Response.json({ explorations: [record()] })
    if (path === '/development/chats') return Response.json([])
    if (path === '/explorations/' + id) return Response.json(record())
    if (path.endsWith('/timeline')) return Response.json({ items: [] })
    if (path.endsWith('/events')) return new Response(null, { status: 503 })
    throw new Error('Unexpected request: ' + path)
  }
  store.setState({ explorationContext: null, drafts: { [id + '/prompt']: draft, [id + '/attachments']: attachments }, selections: {}, scrolls: {} })
  handoffs.setState({ sessions: {}, handoffs: {} })
  const host = document.getElementById('test')
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()) })
  const render = async (props = {}) => {
    await act(async () => root.render(React.createElement(Workspace, { disabled: false, globalBusy: false, ...props })))
  }
  await render()
  await act(async () => host.querySelector('.wx-record').click())
  const click = async label => {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent.includes(label))
    assert.ok(button, 'Missing button: ' + label)
    await act(async () => button.click())
  }
  return { host, posts, click, render, input: () => host.querySelector('textarea') }
}

test('continuing asks for instructions and focuses the composer without submitting an existing draft', async t => {
  const instruction = '重点探索搜索筛选和导出流程，不要修改数据。'
  const attachments = [{ path: 'C:/example/requirements.txt', name: 'requirements.txt' }]
  const view = await mount(t, instruction, attachments)
  await view.click('否，还需要进一步探索')
  assert.match(view.host.textContent, /接下来想重点探索什么？/)
  assert.match(view.host.textContent, /发送后继续探索/)
  assert.equal(document.activeElement, view.input())
  assert.equal(view.input().value, instruction)
  assert.deepEqual(view.posts, [])
  const supplement = '只探索搜索筛选，先不要导出。'
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(view.input(), supplement)
    view.input().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => view.input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.deepEqual(view.posts, [{ path: '/explorations/' + id + '/messages', body: { content: supplement, attachments } }])
  assert.equal(view.input().value, '')
  assert.match(view.host.textContent, /否，还需要进一步探索/, 'a new completed run starts with fresh choices')
})

test('empty or whitespace instructions cannot continue and there is no default continuation shortcut', async t => {
  const view = await mount(t, '   ')
  await view.click('否，还需要进一步探索')
  assert.equal(view.host.querySelector('[aria-label="发送消息"]').disabled, true)
  await act(async () => view.input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.deepEqual(view.posts, [])
  assert.doesNotMatch(view.host.textContent, /默认目标|尚未覆盖的功能/)
  assert.deepEqual([...view.host.querySelectorAll('.wx-completion-question button')].map(button => button.textContent), ['返回选择'])
  await act(async () => store.getState().setDraft(id + '/prompt', ''))
  assert.equal(view.host.querySelector('[aria-label="发送消息"]').disabled, true)
  await act(async () => view.input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.deepEqual(view.posts, [])
})

test('back preserves the draft and continuation respects model readiness', async t => {
  const view = await mount(t, '继续探索设置页面')
  await view.click('否，还需要进一步探索')
  await view.click('返回选择')
  assert.equal(view.input().value, '继续探索设置页面')
  assert.deepEqual(view.posts, [])
  await view.click('否，还需要进一步探索')
  await view.render({ modelReady: false })
  await act(async () => view.input().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.equal(view.host.querySelector('[aria-label="发送消息"]').disabled, true)
  assert.deepEqual(view.posts, [])
})
