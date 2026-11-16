import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer } from 'vite'

test('history renders before browser readiness and the chat-styled controls retain exploration requests', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const replacements = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, ShadowRoot: dom.window.ShadowRoot,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
  }
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const originalFetch = globalThis.fetch
  let releaseBrowser, server, root
  const browserPending = new Promise(resolve => { releaseBrowser = resolve })
  const requests = []
  const writes = []
  const modelWrites = []
  const modelProbes = []
  const pendingProbes = new Map()
  let modelConfig = { selected_provider: 'example-config', effective_model: 'example-model', context_limit: 200000, thinking_effort: 'off' }
  const sessionModels = { example: { provider: 'example-config', model: 'example-model', thinking_effort: 'off' } }
  const attachment = { path: 'C:/example/requirements.txt', name: 'requirements.txt' }
  dom.window.electronAPI = { selectFiles: async () => [attachment.path] }
  let runStatus = 'paused'
  let history = [{ exploration_id: 'example', title: 'Example history', status: 'succeeded', start_url: 'https://example.com', created_at: '2026-01-01T00:00:00Z' },
    { exploration_id: 'other', title: 'Other history', status: 'succeeded', created_at: '2026-01-01T00:00:00Z' }]
  const recordWrites = []
  let renameError = false, deleteError = false, releaseRename
  let renamePending
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    requests.push(path)
    if (options.method === 'PATCH') {
      recordWrites.push({ method: 'PATCH', path, body: JSON.parse(options.body) })
      if (renameError) return Response.json({ detail: 'Example rename failed' }, { status: 503 })
      if (renamePending) await renamePending
      const record = history.find(item => path.endsWith('/' + item.exploration_id))
      record.title = JSON.parse(options.body).title
      return Response.json(record)
    }
    if (options.method === 'DELETE') {
      recordWrites.push({ method: 'DELETE', path })
      if (deleteError) return Response.json({ detail: 'Example deletion failed' }, { status: 503 })
      history = history.filter(item => !path.endsWith('/' + item.exploration_id))
      return Response.json({ ok: true })
    }
    if (path === '/settings/exploration-model') return Response.json(modelConfig)
    if (path === '/settings/exploration-model/resolve') {
      const selection = JSON.parse(options.body).selection || { provider: modelConfig.selected_provider, model: modelConfig.effective_model, thinking_effort: modelConfig.thinking_effort }
      return Response.json({ ...modelConfig, selected_provider: selection.provider, effective_model: selection.model, thinking_effort: selection.thinking_effort, selection })
    }
    if (/\/explorations\/[^/]+\/model$/.test(path)) {
      const id = path.split('/').at(-2)
      if (options.method === 'POST') { sessionModels[id] = JSON.parse(options.body).model_selection; modelWrites.push({ id, selection: sessionModels[id] }) }
      return Response.json({ model_selection: sessionModels[id] || null })
    }
    if (path === '/settings/provider/models') return Response.json({ models: ['example-model', 'example-new'] })
    if (path === '/settings/exploration-model/probe') {
      const body = JSON.parse(options.body)
      modelProbes.push(body)
      return new Promise(resolve => pendingProbes.set(body.model, value => resolve(Response.json(value))))
    }
    if (path === '/settings/exploration-model/selection') {
      const patch = JSON.parse(options.body)
      modelWrites.push(patch)
      modelConfig = { ...modelConfig, ...(patch.model ? { effective_model: patch.model } : {}), ...(patch.thinking_effort ? { thinking_effort: patch.thinking_effort } : {}) }
      return Response.json(modelConfig)
    }
    if (options.method === 'POST' && !path.endsWith('/exploration-model/check')) {
      writes.push({ path, body: JSON.parse(options.body) })
      runStatus = path.endsWith('/cancel') ? 'cancelled' : 'running'
      return Response.json({ exploration_id: 'example' })
    }
    if (path.endsWith('/exploration-model/check')) return Response.json({ ok: true })
    if (path.endsWith('/browser/status')) { await browserPending; return Response.json({ available: true }) }
    if (path.endsWith('/health')) return Response.json({ ok: true })
    if (path.endsWith('/activity')) return Response.json({ running: false })
    if (path.endsWith('/development/chats')) return Response.json([])
    if (path.endsWith('/file-changes')) return Response.json({ records: [], nextOffset: null })
    if (path.endsWith('/explorations')) return Response.json({ explorations: history })
    if (path.endsWith('/explorations/example')) return Response.json({ exploration_id: 'example', title: history.find(item => item.exploration_id === 'example')?.title, status: runStatus, start_url: 'https://example.com', instruction: 'Read the example page', context_usage: { input_tokens: 1234, context_limit: 200000 } })
    if (path.endsWith('/example/timeline')) return Response.json({ items: [{ type: 'agent_step', step: 1, status: 'ok', thought: 'Example observation', code: 'print("example")', observation: { title: 'Example page', url: 'https://example.com', screenshot_url: '/api/explorations/example/files/page.png' } }] })
    if (path.endsWith('/example/files/page.png')) return new Response('example image', { headers: { 'Content-Type': 'image/png' } })
    if (path.endsWith('/example/events')) return new Response('event: exploration_succeeded\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    throw new Error('Unexpected test request: ' + path)
  }
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
    const { default: Page } = await server.ssrLoadModule('/src/components/website-exploration/WebsiteExplorationPage.jsx')
    const { default: DialogHost } = await server.ssrLoadModule('/src/components/DialogHost.jsx')
    const { default: GlobalFileDropLayer } = await server.ssrLoadModule('/src/components/files/GlobalFileDropLayer.jsx')
    const { useUserFilesStore } = await server.ssrLoadModule('/src/store/user-files.js')
    let workspaceImports = 0
    useUserFilesStore.setState({ importFiles: async () => { workspaceImports++; return [] } })
    const { useSettingsStore } = await server.ssrLoadModule('/src/store/settings.js')
    useSettingsStore.setState({ activeProvider: 'main-example', model: 'main-example', providers: { 'example-config': { provider_id: 'custom', name: 'Example', has_key: true, model: 'example-model' } } })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Page, { onOpenSettings() {} }), React.createElement(GlobalFileDropLayer), React.createElement(DialogHost))) })
    assert.ok(requests.some(path => path.endsWith('/browser/status')))
    assert.match(document.body.textContent, /Example history/)
    assert.ok(document.querySelector('input[aria-label="起始网址"]'), 'entry must not wait for browser status')
    assert.match(document.body.textContent, /服务已就绪/)
    assert.doesNotMatch(document.body.textContent, /正在加载|正在检查模型连接/)
    await act(async () => { releaseBrowser() })
    assert.match(document.body.textContent, /浏览器已连接/)
    assert.ok(document.querySelector('input[aria-label="起始网址"]'))
    const click = async selector => {
      const button = document.querySelector(selector)
      assert.ok(button, selector)
      assert.notEqual(button.disabled, true, selector)
      assert.notEqual(button.getAttribute('aria-disabled'), 'true', selector)
      await act(async () => { button.click() })
    }
    const fill = async (selector, value) => {
      const input = document.querySelector(selector)
      assert.ok(input, selector)
      const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }
    const press = async (selector, key) => {
      await act(async () => { document.querySelector(selector).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })) })
    }
    const renameInput = '[aria-label="探索记录标题"]'
    await click('[aria-label="重命名 Example history"]')
    assert.ok(document.querySelector('input[aria-label="起始网址"]'), 'row actions must not open another conversation')
    assert.equal(document.activeElement, document.querySelector(renameInput))
    await fill(renameInput, 'Cancelled title')
    await press(renameInput, 'Escape')
    assert.equal(recordWrites.length, 0)
    await click('[aria-label="重命名 Example history"]')
    await fill(renameInput, 'Renamed history')
    renamePending = new Promise(resolve => { releaseRename = resolve })
    await press(renameInput, 'Enter')
    await act(async () => { document.querySelector(renameInput).dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })) })
    assert.equal(recordWrites.length, 1, 'Enter and blur must share one pending save')
    await act(async () => { releaseRename() })
    renamePending = undefined
    assert.ok(document.querySelector('[aria-label="重命名 Renamed history"]'))
    await click('[aria-label="重命名 Renamed history"]')
    renameError = true
    await fill(renameInput, 'Example history')
    await press(renameInput, 'Enter')
    assert.match(document.body.textContent, /Example rename failed/)
    assert.equal(document.querySelector(renameInput).value, 'Example history')
    renameError = false
    await act(async () => { document.querySelector(renameInput).focus(); document.querySelector(renameInput).blur() })
    assert.ok(document.querySelector('[aria-label="重命名 Example history"]'))
    await click('[aria-label="删除 Other history"]')
    assert.ok(document.querySelector('[role="dialog"]'))
    await press('[role="dialog"]', 'Escape')
    await act(async () => { document.querySelector('.weworker-dialog-overlay').dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(document.querySelector('[role="dialog"]'), 'exploration dialogs require an explicit action')
    await click('.weworker-dialog footer button:first-child')
    assert.equal(recordWrites.filter(write => write.method === 'DELETE').length, 0)
    assert.equal(document.querySelector('[aria-label="权限模式"]'), null)
    await click('[aria-label="模型选择"]')
    const probeButton = model => `[aria-label="检测模型 ${model}"]`
    assert.equal(document.querySelector(probeButton('example-model')).textContent, '未检测')
    assert.equal(document.querySelector(probeButton('example-new')).title, '点击仅检测此模型')
    await click(probeButton('example-new'))
    assert.equal(document.querySelector(probeButton('example-new')).textContent, '检测中')
    assert.equal(document.querySelector(probeButton('example-new')).disabled, true)
    await click(probeButton('example-model'))
    assert.deepEqual(modelProbes, [{ provider: 'example-config', model: 'example-new' }, { provider: 'example-config', model: 'example-model' }])
    assert.equal(modelWrites.length, 0, 'probes must not activate a model or close the menu')
    await act(async () => { pendingProbes.get('example-new')({ ok: true, elapsed_ms: 42 }); pendingProbes.get('example-model')({ ok: false, error: 'protocol_mismatch' }) })
    assert.equal(document.querySelector(probeButton('example-new')).textContent, '42ms')
    assert.equal(document.querySelector(probeButton('example-model')).textContent, '不可用')
    const { useModelHealthStore } = await server.ssrLoadModule('/src/store/model-health.js')
    assert.deepEqual(useModelHealthStore.getState().results, {}, 'exploration probes cannot update normal chat health')
    await click('[aria-label="检测全部模型"]')
    assert.equal(modelProbes.length, 4)
    await act(async () => { for (const resolve of pendingProbes.values()) resolve({ ok: true, elapsed_ms: 24 }) })
    const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === 'example-new')
    assert.ok(option)
    await act(async () => { option.click() })
    assert.match(document.querySelector('[aria-label="模型选择"]').textContent, /24ms/, 'choosing a tested model retains its result')
    await click('[aria-label="思考效果"]')
    const high = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === '高')
    await act(async () => { high.click() })
    const { useWebsiteExplorationStore } = await server.ssrLoadModule('/src/store/website-exploration.js')
    assert.deepEqual(useWebsiteExplorationStore.getState().drafts['site/new/instruction/model'], { provider: 'example-config', model: 'example-new', thinking_effort: 'high' })
    assert.deepEqual(modelWrites, [], 'changing a new exploration draft must not write the default or another record')
    assert.equal(modelConfig.effective_model, 'example-model')
    await click('[aria-label="模型选择"]')
    await act(async () => { [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === 'example-new').click() })
    await fill('input[aria-label="起始网址"]', 'https://example.org')
    await fill('textarea[aria-label="探索消息"]', 'Example draft')
    assert.equal(document.querySelector('button[aria-label="发送消息"]').disabled, false, 'selecting the same model again must not leave connection readiness pending')
    assert.equal(useSettingsStore.getState().activeProvider, 'main-example')
    assert.equal(useSettingsStore.getState().model, 'main-example')
    await click('.wx-record')
    assert.match(document.querySelector('[aria-label="模型选择"]').textContent, /example-model/, 'existing exploration keeps its own model')
    await click('[aria-label="模型选择"]')
    await act(async () => { [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === 'example-new').click() })
    assert.deepEqual(modelWrites.at(-1), { id: 'example', selection: { provider: 'example-config', model: 'example-new', thinking_effort: 'off' } })
    assert.equal(modelConfig.effective_model, 'example-model')
    assert.match(document.querySelector('.workspace-toolbar').textContent, /Example history/)
    assert.match(document.querySelector('.wx-message-content').textContent, /Example observation/)
    const actionDisclosure = '.wx-step-disclosure:first-child button'
    const pageDisclosure = '.wx-step-disclosure:last-child button'
    assert.equal(document.querySelector(actionDisclosure).getAttribute('aria-expanded'), 'false')
    assert.equal(requests.some(path => path.endsWith('/page.png')), false, 'collapsed screenshots must not load')
    await click(actionDisclosure)
    assert.equal(document.querySelector(actionDisclosure).getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelector('.wx-step pre').textContent, 'print("example")')
    assert.equal(document.querySelector('.wx-step pre').className, 'tool-exec-group__detail-pre')
    assert.ok(document.querySelector('.wx-step pre').closest('.tool-exec-group__detail-scroll'))
    assert.ok(document.querySelector('.wx-step pre').closest('.tool-exec-group__detail.wx-step-disclosure__content'))
    await click(pageDisclosure)
    assert.ok(requests.some(path => path.endsWith('/page.png')))
    assert.equal(document.querySelector('.wx-step img').alt, 'Example page')
    await click(pageDisclosure)
    assert.equal(document.querySelector('.wx-step img'), null)
    await fill('textarea[aria-label="探索消息"]', 'Continue this exploration')
    await click('[aria-label="查看上下文"]')
    assert.match(document.querySelector('[data-context-panel]').textContent, /1\.23K.*200K/)
    assert.match(document.querySelector('[data-context-panel]').textContent, /供应商最近一次请求/)
    await click('[aria-label="关闭上下文面板"]')
    await click('[aria-label="上传文件"]')
    assert.match(document.querySelector('.chat-attachment-card').textContent, /requirements.txt/)
    await click('[aria-label="移除文件"]')
    assert.equal(document.querySelector('.chat-attachment-card'), null)
    await act(async () => {
      const event = new dom.window.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [attachment] } })
      document.querySelector('textarea[aria-label="探索消息"]').dispatchEvent(event)
    })
    assert.match(document.querySelector('.chat-attachment-card').textContent, /requirements.txt/)
    assert.equal(workspaceImports, 0, 'exploration uploads must not import into the main workspace')
    await click('button[aria-label="发送消息"]')
    assert.deepEqual(writes.at(-1), { path: '/api/website-exploration/explorations/example/resume', body: { note: 'Continue this exploration', attachments: [attachment] } })
    await click('button[aria-label="停止探索"]')
    assert.deepEqual(writes.at(-1), { path: '/api/website-exploration/explorations/example/cancel', body: { reason: 'User stopped exploration' } })
    assert.equal(document.querySelector(actionDisclosure).getAttribute('aria-expanded'), 'true', 'snapshot refresh must preserve expanded steps')
    assert.equal(document.querySelector('.wx-step pre').textContent, 'print("example")')
    await fill('textarea[aria-label="探索消息"]', 'Read another section')
    await click('button[aria-label="发送消息"]')
    assert.deepEqual(writes.at(-1), { path: '/api/website-exploration/explorations/example/messages', body: { content: 'Read another section' } })
    await click('button[aria-label="新探索"]')
    await fill('input[aria-label="起始网址"]', 'https://example.org')
    await fill('textarea[aria-label="探索消息"]', 'Read the page title')
    await click('[aria-label="上传文件"]')
    await click('button[aria-label="发送消息"]')
    assert.deepEqual(writes.at(-1), { path: '/api/website-exploration/explorations', body: { start_url: 'https://example.org', instruction: 'Read the page title', model_selection: { provider: 'example-config', model: 'example-new', thinking_effort: 'high' }, attachments: [attachment] } })
    assert.equal(requests.includes('/settings/exploration-model/selection'), false, 'composer never saves global defaults')
    assert.equal(writes.length, 4)
    runStatus = 'succeeded'
    deleteError = true
    await click('[aria-label="删除 Other history"]')
    await click('.weworker-dialog footer button:last-child')
    assert.match(document.body.textContent, /Example deletion failed/)
    assert.ok(document.querySelector('[aria-label="删除 Other history"]'))
    deleteError = false
    await click('[aria-label="删除 Other history"]')
    await click('.weworker-dialog footer button:last-child')
    assert.equal(document.querySelector('[aria-label="删除 Other history"]'), null)
    assert.match(document.querySelector('.workspace-toolbar').textContent, /Example history/, 'deleting another record preserves the current conversation')
    await click('[aria-label="重命名 Example history"]')
    await fill(renameInput, 'Final title')
    await press(renameInput, 'Enter')
    assert.match(document.querySelector('.workspace-toolbar').textContent, /Final title/)
    await click('[aria-label="删除 Final title"]')
    await click('.weworker-dialog footer button:last-child')
    assert.ok(document.querySelector('input[aria-label="起始网址"]'), 'deleting current record returns to new exploration')
    assert.match(document.querySelector('.wx-history-records').textContent, /没有探索记录/)
    assert.equal(document.querySelector('.wx-record'), null)
    assert.ok(requests.every(path => path.startsWith('/api/website-exploration/') || path.startsWith('/settings/exploration-model') || path === '/settings/provider/models'))
  } finally {
    releaseBrowser()
    if (root) await act(async () => { root.unmount() })
    await server?.close()
    globalThis.fetch = originalFetch
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
