import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

test('exploration picker uses only saved exploration configurations and their model catalog', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
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
  const requests = []
  let empty = false, server, root
  const configurations = [
    { id: 'custom', name: '网站探索配置（自定义）', model: 'fixture-explore', models: ['fixture-explore'], configured: true, has_key: true },
    { id: 'glm', name: 'Exploration GLM', model: 'glm-explore', models: ['glm-explore'], configured: true, has_key: true },
    { id: 'anthropic', name: 'Unconfigured exploration', configured: false },
  ]
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path, body })
    const status = { providers: empty ? [] : configurations, active_provider: 'custom', selected_provider: 'chat-only', effective_model: 'chat-only-model' }
    if (path === '/settings/exploration-model') return Response.json(status)
    if (path.endsWith('/resolve')) {
      const selection = body.selection || { provider: 'chat-only', model: 'chat-only-model' }
      return Response.json({ ...status, selected_provider: selection.provider, active_provider: selection.provider.split(':')[1], effective_model: selection.model, selection })
    }
    if (path.endsWith('/models')) return Response.json({ models: body.provider === 'glm' ? ['glm-explore', 'glm-next'] : ['fixture-explore'] })
    if (path.endsWith('/check')) return Response.json({ ok: true })
    if (path === '/settings/provider/models') return Response.json({ models: ['chat-only-model'] })
    throw new Error('Unexpected fixture request: ' + path)
  }
  try {
    server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
      server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
    const Component = (await server.ssrLoadModule('/src/components/website-exploration/ExplorationModelSelector.jsx')).default
    const { useSettingsStore } = await server.ssrLoadModule('/src/store/settings.js')
    const { useWebsiteExplorationStore } = await server.ssrLoadModule('/src/store/website-exploration.js')
    useSettingsStore.setState({ activeProvider: 'chat-only', model: 'chat-only-model', providers: {
      'chat-only': { provider_id: 'custom', name: 'Chat only', has_key: true, base_url: 'https://example.com/chat', model: 'chat-only-model' },
    } })
    useWebsiteExplorationStore.getState().setDraft('fixture/model', { provider: 'chat-only', model: 'chat-only-model' })
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    const render = async key => act(async () => root.render(React.createElement(Component, { key, draftModelKey: 'fixture/model' })))
    await render('configured')
    const click = async selector => {
      const element = document.querySelector(selector)
      assert.ok(element, selector)
      assert.equal(element.disabled, false)
      await act(async () => element.click())
    }
    await click('[aria-label="模型供应商选择"]')
    const options = [...document.querySelectorAll('[role="option"]')]
    assert.deepEqual(options.map(el => el.textContent.trim()), ['网站探索配置（自定义）', 'Exploration GLM'])
    assert.doesNotMatch(document.body.textContent, /Chat only|自动识别|Unconfigured exploration/)
    await act(async () => options[1].click())
    assert.deepEqual(useWebsiteExplorationStore.getState().drafts['fixture/model'], { provider: '__exploration__:glm', model: 'glm-explore', thinking_effort: 'off' })
    assert.ok(requests.some(r => r.path === '/settings/exploration-model/models' && r.body.provider === 'glm'))
    assert.equal(requests.some(r => r.path === '/settings/provider/models'), false)
    await click('[aria-label="模型选择"]')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.match(document.querySelector('.chat-model-health-menu').textContent, /glm-next/)
    assert.equal(useSettingsStore.getState().activeProvider, 'chat-only')
    const checks = requests.filter(r => r.path.endsWith('/check')).length
    empty = true
    await render('empty')
    assert.match(document.body.textContent, /请先.*网站探索/)
    assert.equal(document.querySelector('[aria-label="模型选择"]').disabled, true)
    assert.equal(requests.filter(r => r.path.endsWith('/check')).length, checks, 'missing exploration settings must not probe chat credentials')
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
