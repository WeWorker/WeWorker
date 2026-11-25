import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { buildProviderProbeTargets } from '../utils/model-selection.js'

test('model availability checks include both conversation and exploration interfaces', () => {
  assert.deepEqual(buildProviderProbeTargets(), ['weworker', 'webwright'])
})

test('settings checklist probes both built-in interfaces and displays separate results and logs', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const replacements = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout, ResizeObserver: class { observe() {} disconnect() {} },
  }
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const originalFetch = globalThis.fetch
  let server, root, failExplore = false
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ path, body })
    if (path === '/settings/provider/models') return Response.json({ models: ['fixture-chat'], source: 'remote' })
    if (path === '/settings/provider/activate') return Response.json({
      active_provider: body.provider, model: 'ark-code-latest', providers: { builtin: { provider_id: 'builtin', has_key: true, model: 'ark-code-latest' } },
    })
    if (path === '/settings/provider') return Response.json({
      active_provider: 'builtin', model: 'ark-code-latest', providers: { builtin: { provider_id: 'builtin', has_key: true, model: 'ark-code-latest' } },
    })
    if (path === '/settings/provider/probe') {
      const exploration = body.target === 'webwright'
      const result = exploration
        ? (failExplore
          ? { ok: false, error: 'auth_failed', detail: 'Fixture exploration authentication failed', protocol: 'openai_chat_completions' }
          : { ok: true, model: 'fixture-explore', protocol: 'openai_chat_completions' })
        : { ok: true, model: 'fixture-chat', protocol: 'anthropic_messages' }
      const retryCount = exploration ? 1 : 0
      return new Response([
        { type: 'attempt', retry_count: 0 },
        ...(retryCount ? [{ type: 'attempt', retry_count: retryCount }] : []),
        { type: 'result', result: { ...result, retry_count: retryCount, attempt_elapsed_ms: exploration ? 3000 : 1000 } },
      ].map(event => JSON.stringify(event) + '\n').join(''), { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
    throw new Error('Unexpected fixture request: ' + path)
  }
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), define: { __BUILD_DEPLOYMENT_CONFIG__: '{}' },
      server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
    const Component = (await server.ssrLoadModule('/src/components/settings/SettingsModal.jsx')).default
    const { useSettingsStore } = await server.ssrLoadModule('/src/store/settings.js')
    useSettingsStore.setState({ activeProvider: 'builtin', model: 'ark-code-latest', providers: {
      builtin: { provider_id: 'builtin', name: '免费模型（办公VDI）', has_key: true, model: 'ark-code-latest',
        base_url: 'https://example.com/chat', weworker_protocol: 'anthropic_messages', added: true },
    } })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    const { default: DialogHost } = await server.ssrLoadModule('/src/components/DialogHost.jsx')
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(Component), React.createElement(DialogHost))))
    const save = [...document.querySelectorAll('button')].find(element => element.textContent === '保存')
    await act(async () => save.click())
    assert.ok(document.querySelector('[aria-label="连通性检查"]'))
    assert.deepEqual(calls.filter(c => c.path.endsWith('/provider/probe')).map(c => c.body.target), ['weworker', 'webwright'])
    assert.equal(calls.filter(call => call.path === '/settings/provider').length, 1)
    const runCheck = async () => {
      const button = [...document.querySelectorAll('button')].find(e => e.textContent.includes('测试连通性'))
      assert.ok(button)
      await act(async () => button.click())
      const checklist = document.querySelector('[aria-label="连通性检查"]')
      assert.ok(checklist)
      return checklist
    }
    let checklist = await runCheck()
    assert.equal(checklist.querySelectorAll('[role="listitem"]').length, 2)
    assert.match(checklist.textContent, /WeWorker 对话接口.*连接成功 · fixture-chat/)
    assert.match(checklist.textContent, /Adapter工坊·探索接口.*连接成功 · fixture-explore/)
    assert.match(checklist.textContent, /全部通过/)
    assert.doesNotMatch(checklist.textContent, /WeWorker 对话接口.*\（1\/30s/)
    assert.match(checklist.textContent, /Adapter工坊·探索接口.*（3\/30s，重试1次）/)
    const probeCalls = () => calls.filter(c => c.path.endsWith('/provider/probe')).map(c => [c.body.target, c.body.probe_timeout_seconds])
    assert.deepEqual(probeCalls(), [['weworker', 30], ['webwright', 30], ['weworker', 30], ['webwright', 30]])
    const nav = name => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === name)
    assert.equal(document.querySelector('input[aria-label="WeWorker 对话接口超时（秒）"]'), null)
    localStorage.setItem('model_probe_timeout_weworker', '42')
    await act(async () => nav('网络').click())
    const chatTimeout = document.querySelector('input[aria-label="WeWorker 对话接口超时（秒）"]')
    const exploreTimeout = document.querySelector('input[aria-label="Adapter 工坊探索接口超时（秒）"]')
    assert.equal(chatTimeout.value, '42')
    assert.equal(exploreTimeout.value, '30')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(exploreTimeout, '57')
      exploreTimeout.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(localStorage.getItem('model_probe_timeout_webwright'), '57')
    await act(async () => nav('模型').click())
    failExplore = true
    checklist = await runCheck()
    assert.deepEqual(probeCalls().slice(-2), [['weworker', 42], ['webwright', 57]])
    assert.match(checklist.textContent, /检查未通过（仍可切换）/)
    assert.match(checklist.querySelector('.is-failure').textContent, /Adapter工坊·探索接口.*Fixture exploration authentication failed/)
    const logs = [...checklist.querySelectorAll('button')].find(e => e.textContent === '显示日志')
    await act(async () => logs.click())
    assert.match(checklist.textContent, /WeWorker 对话接口.*（1\/42s，重试0次）/)
    assert.match(checklist.querySelector('.model-probe-checklist__message.is-expanded').closest('[role="list"]').textContent, /fixture-chat.*Fixture exploration authentication failed/)
    await act(async () => useSettingsStore.setState({ activeProvider: 'deepseek' }))
    const switchButton = [...document.querySelectorAll('button')].find(button => button.textContent === '切换使用')
    assert.ok(switchButton)
    assert.equal(switchButton.disabled, false)
    await act(async () => switchButton.click())
    assert.equal(calls.filter(call => call.path === '/settings/provider/activate').at(-1)?.body.provider, 'builtin')
    assert.equal(useSettingsStore.getState().activeProvider, 'builtin')
    // Let the temporary saved-button state settle while this DOM is still installed.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
    await act(async () => useSettingsStore.setState({ activeProvider: 'deepseek' }))
    const dialog = () => document.querySelector('[role="dialog"]')
    const pendingStart = calls.length
    await act(async () => nav('保存').click())
    assert.match(dialog().textContent, /连通性检查未通过/)
    assert.equal(calls.slice(pendingStart).some(c => c.path === '/settings/provider'), false)
    await act(async () => nav('取消').click())
    assert.equal(dialog(), null)
    assert.equal(calls.slice(pendingStart).some(c => c.path === '/settings/provider'), false)
    assert.equal(useSettingsStore.getState().activeProvider, 'deepseek')
    const start = calls.length
    await act(async () => nav('保存').click())
    assert.ok(dialog())
    await act(async () => nav('确定').click())
    assert.deepEqual(calls.slice(start).filter(c => ['/settings/provider/probe', '/settings/provider'].includes(c.path)).map(c => c.body.target || c.body.activate), ['weworker', 'webwright', true])
    assert.equal(useSettingsStore.getState().activeProvider, 'builtin')
    assert.match(document.querySelector('[aria-label="连通性检查"]').textContent, /检查未通过/)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)) })
  } finally {
    await act(async () => root?.unmount())
    await server?.close()
    globalThis.fetch = originalFetch
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
