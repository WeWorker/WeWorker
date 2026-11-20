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
    if (path === '/settings/provider') return Response.json({
      active_provider: 'builtin', model: 'ark-code-latest', providers: { builtin: { provider_id: 'builtin', has_key: true, model: 'ark-code-latest' } },
      model_checks: [
        { target: 'weworker', status: 'success', message: '连接成功 · saved-chat' },
        { target: 'webwright', status: 'success', message: '连接成功 · saved-explore' },
      ],
    })
    if (path === '/settings/provider/probe') return body.target === 'webwright'
      ? Response.json(failExplore
        ? { ok: false, error: 'auth_failed', detail: 'Fixture exploration authentication failed', protocol: 'openai_chat_completions' }
        : { ok: true, model: 'fixture-explore', protocol: 'openai_chat_completions' })
      : Response.json({ ok: true, model: 'fixture-chat', protocol: 'anthropic_messages' })
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
    await act(async () => root.render(React.createElement(Component)))
    const save = [...document.querySelectorAll('button')].find(element => element.textContent === '保存')
    await act(async () => save.click())
    const savedChecklist = document.querySelector('[aria-label="连通性检查"]')
    assert.match(savedChecklist.textContent, /全部通过/)
    assert.match(savedChecklist.textContent, /saved-chat/)
    assert.match(savedChecklist.textContent, /saved-explore/)
    assert.equal(calls.filter(call => call.path.endsWith('/provider/probe')).length, 0, 'saving must reuse the backend checks without probing again')
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
    assert.deepEqual(calls.filter(c => c.path.endsWith('/provider/probe')).map(c => c.body.target), ['weworker', 'webwright'])
    failExplore = true
    checklist = await runCheck()
    assert.match(checklist.textContent, /检查未通过/)
    assert.match(checklist.querySelector('.is-failure').textContent, /Adapter工坊·探索接口.*Fixture exploration authentication failed/)
    const logs = [...checklist.querySelectorAll('button')].find(e => e.textContent === '显示日志')
    await act(async () => logs.click())
    assert.match(checklist.querySelector('.model-probe-checklist__message.is-expanded').closest('[role="list"]').textContent, /fixture-chat.*Fixture exploration authentication failed/)
    // Let the temporary saved-button state settle while this DOM is still installed.
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
