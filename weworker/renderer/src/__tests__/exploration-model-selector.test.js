import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

test('exploration picker configures fixed supplier keys and preserves exploration references and chat defaults', async () => {
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
  let empty = false, failKeySave = false, server, root
  const configurations = [
    { id: 'custom', name: '网站探索配置（自定义）', model: 'fixture-explore', models: ['fixture-explore'], configured: true, has_key: true },
    { id: 'glm', name: 'Exploration GLM', model: 'glm-explore', models: ['glm-explore'], configured: true, has_key: true },
    { id: 'named-config', name: 'Claude Code', model: 'named-explore', models: ['named-explore'], configured: true, has_key: true },
    { id: 'builtin', selection_provider: 'builtin', name: '内置模型', model: 'builtin-model', models: ['builtin-model'], configured: true, has_key: true, fixed_model: true },
    { id: 'anthropic', name: 'Anthropic', configured: false, fixed_provider: true, has_key: false },
    { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', configured: false, fixed_provider: true, has_key: false },
    { id: 'unconfigured-custom', name: 'Unconfigured exploration', configured: false },
  ]
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ path, body })
    const status = { providers: empty ? configurations.filter(item => item.fixed_provider) : configurations, active_provider: 'custom', selected_provider: 'chat-only', effective_model: 'chat-only-model' }
    if (path === '/settings/exploration-model') return Response.json(status)
    if (path === '/settings/provider') {
      if (failKeySave) return Response.json({ detail: 'Fixture key save failed' }, { status: 400 })
      const entry = configurations.find(item => item.id === body.provider)
      if (entry.id !== 'anthropic') Object.assign(entry, { configured: true, has_key: true })
      return Response.json({ active_provider: 'chat-only', model: 'chat-only-model', providers: {
        'chat-only': { has_key: true }, [body.provider]: { has_key: true, model: entry.model },
      } })
    }
    if (path.endsWith('/resolve')) {
      const selection = body.selection || { provider: 'chat-only', model: 'chat-only-model' }
      return Response.json({ ...status, selected_provider: selection.provider, active_provider: selection.provider.split(':')[1], effective_model: selection.model, selection })
    }
    if (path.endsWith('/models')) return Response.json({ models: body.provider === '__exploration__:glm' ? ['glm-explore', 'glm-next'] : ['fixture-explore'] })
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
    assert.deepEqual(options.map(el => el.textContent.trim()), ['网站探索配置（自定义）', 'Exploration GLM', 'Claude Code', '内置模型', 'Anthropic', 'DeepSeek'])
    const unconfiguredPreset = options.find(el => el.textContent.trim() === 'Anthropic')
    assert.equal(unconfiguredPreset.disabled, false)
    assert.ok(unconfiguredPreset.querySelector('[aria-label="未填写 API Key"]'))
    const requestCount = requests.length
    await act(async () => unconfiguredPreset.click())
    assert.equal(requests.length, requestCount, 'unconfigured presets must not resolve or probe credentials')
    assert.match(document.querySelector('[role="dialog"]').textContent, /配置 Anthropic/)
    await act(async () => document.querySelector('[role="dialog"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.ok(document.querySelector('[role="dialog"]'), 'exploration dialogs require an explicit close')
    await click('[role="dialog"] button[type="button"]')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await click('[aria-label="模型供应商选择"]')
    assert.doesNotMatch(document.body.textContent, /Chat only|自动识别|Unconfigured exploration/)
    await act(async () => [...document.querySelectorAll('[role="option"]')][1].click())
    assert.deepEqual(useWebsiteExplorationStore.getState().drafts['fixture/model'], { provider: '__exploration__:glm', model: 'glm-explore', thinking_effort: 'off' })
    assert.ok(requests.some(r => r.path === '/settings/exploration-model/models' && r.body.provider === '__exploration__:glm'))
    assert.equal(requests.some(r => r.path === '/settings/provider/models'), false)
    await click('[aria-label="模型选择"]')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.match(document.querySelector('.chat-model-health-menu').textContent, /glm-next/)
    await click('[aria-label="模型选择"]')
    await click('[aria-label="模型供应商选择"]')
    await act(async () => [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === 'Claude Code').click())
    assert.equal(useWebsiteExplorationStore.getState().drafts['fixture/model'].provider, '__exploration__:named-config')
    await render('reload')
    assert.match(document.querySelector('[aria-label="模型供应商选择"]').textContent, /Claude Code/)
    await click('[aria-label="模型供应商选择"]')
    await act(async () => [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === '内置模型').click())
    assert.equal(useWebsiteExplorationStore.getState().drafts['fixture/model'].provider, 'builtin')
    assert.ok(requests.some(r => r.path.endsWith('/check') && r.body.selection.provider === 'builtin'))
    assert.equal(requests.some(r => r.path === '/settings/exploration-model/selection' || r.path === '/settings/exploration-model' && r.body), false)
    assert.equal(useSettingsStore.getState().activeProvider, 'chat-only')
    await click('[aria-label="模型供应商选择"]')
    await act(async () => [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === 'DeepSeek').click())
    const keyInput = document.querySelector('[role="dialog"] input[type="password"]')
    assert.ok(keyInput)
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(keyInput, 'fixture-api-key')
      keyInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    failKeySave = true
    await act(async () => document.querySelector('[role="dialog"] form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.match(document.querySelector('[role="dialog"]').textContent, /Fixture key save failed/)
    assert.equal(useWebsiteExplorationStore.getState().drafts['fixture/model'].provider, 'builtin')
    failKeySave = false
    await act(async () => document.querySelector('[role="dialog"] form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(useWebsiteExplorationStore.getState().drafts['fixture/model'].provider, '__exploration__:deepseek')
    assert.equal(useSettingsStore.getState().activeProvider, 'chat-only')
    assert.equal(requests.some(r => r.path === '/settings/provider/activate'), false)
    assert.ok(requests.some(r => r.path === '/settings/provider' && r.body.provider === 'deepseek' && r.body.api_key === 'fixture-api-key'))
    await click('[aria-label="模型供应商选择"]')
    await act(async () => [...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === 'Anthropic').click())
    const unsupportedKeyInput = document.querySelector('[role="dialog"] input[type="password"]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(unsupportedKeyInput, 'fixture-anthropic-key')
      unsupportedKeyInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    const resolutions = requests.filter(r => r.path.endsWith('/resolve')).length
    await act(async () => document.querySelector('[role="dialog"] form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
    assert.match(document.querySelector('[role="dialog"]').textContent, /API Key 已保存.*OpenAI 接口/)
    assert.equal(requests.filter(r => r.path.endsWith('/resolve')).length, resolutions, 'saving a key must not enable an unsupported exploration interface')
    assert.equal(useWebsiteExplorationStore.getState().drafts['fixture/model'].provider, '__exploration__:deepseek')
    await click('[role="dialog"] button[type="button"]')
    Object.assign(configurations.find(item => item.id === 'deepseek'), { configured: false, has_key: false })
    const checks = requests.filter(r => r.path.endsWith('/check')).length
    empty = true
    await act(async () => {
      useSettingsStore.setState({ providers: { 'chat-only': { has_key: true } } })
      root.render(React.createElement(Component, { key: 'empty', draftModelKey: 'fixture/model' }))
    })
    assert.match(document.body.textContent, /请先在设置 → 模型中配置 Adapter 工坊 OpenAI 接口/)
    assert.equal(document.querySelector('[aria-label="模型选择"]').disabled, true)
    assert.equal(requests.filter(r => r.path.endsWith('/check')).length, checks, 'missing exploration settings must not probe chat credentials')
    await click('[aria-label="模型供应商选择"]')
    const emptyOptions = [...document.querySelectorAll('[role="option"]')]
    assert.deepEqual(emptyOptions.map(el => el.textContent.trim()), ['Anthropic', 'DeepSeek'])
    assert.equal(emptyOptions[0].disabled, false)
    await act(async () => emptyOptions[0].click())
    assert.ok(document.querySelector('[role="dialog"]'))
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
