import test, { after, afterEach, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

let server, dom, root, ModelSelector, SettingsPage, SecretInput, store
let calls, state, detectResponse
const globals = new Map()
const imported = { name: 'Claude Code', provider_id: 'custom', model: 'fixture-model',
  base_url: 'https://example.com', has_key: true, external_source_id: 'fixture-source', added: true }
const candidates = [{ source_id: 'fixture-source', name: 'Claude Code', product: 'Claude Code', model: 'fixture-model',
  base_url: 'https://example.com', weworker_protocol: 'anthropic_messages', imported: false },
{ source_id: 'fixture-second', name: 'Codex', product: 'Codex', model: 'fixture-codex',
  base_url: 'https://example.org', weworker_protocol: 'openai_responses', imported: false }]

before(async () => {
  dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost/' })
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, ShadowRoot: dom.window.ShadowRoot,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  globals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    define: { __BUILD_DEPLOYMENT_CONFIG__: JSON.stringify({ officialUrl: 'https://example.com', githubUrl: 'https://example.org' }) },
    plugins: [react()], server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'silent' })
  ModelSelector = (await server.ssrLoadModule('/src/components/chat/ModelSelector.jsx')).default
  SettingsPage = (await server.ssrLoadModule('/src/components/settings/SettingsModal.jsx')).default
  SecretInput = (await server.ssrLoadModule('/src/components/settings/SecretInput.jsx')).default
  store = (await server.ssrLoadModule('/src/store/settings.js')).useSettingsStore
})

beforeEach(() => {
  calls = []
  state = { active_provider: 'anthropic', model: 'fixture-current', has_api_key: true, model_discovery_enabled: true, providers: {
    anthropic: { has_key: true, model: 'fixture-current', visible: true },
    custom: { has_key: false, visible: false },
  } }
  detectResponse = () => Response.json({ candidates, issues: [] })
  globalThis.fetch = async (url, options = {}) => {
    const endpoint = new URL(url).pathname
    calls.push({ endpoint, ...options })
    if (endpoint === '/settings/provider/models') return Response.json({ models: ['fixture-model'] })
    if (endpoint === '/settings/provider/detect') return detectResponse()
    if (endpoint === '/settings/provider/import') {
      const { source_id } = JSON.parse(options.body)
      assert.equal(source_id, 'fixture-source')
      state.providers['model-fixture'] = imported
      return Response.json({ ...state, imported_provider: 'model-fixture' })
    }
    if (endpoint === '/settings/extensions/model-discovery') {
      state.model_discovery_enabled = JSON.parse(options.body).model_discovery_enabled
      return Response.json(state)
    }
    if (endpoint === '/settings/provider/delete') {
      const { provider } = JSON.parse(options.body)
      delete state.providers[provider]
      return Response.json(state)
    }
    if (endpoint === '/settings/provider') {
      const { provider, model } = JSON.parse(options.body)
      state.providers[provider] = { ...state.providers[provider], model }
      return Response.json(state)
    }
    if (endpoint === '/settings/provider/activate') {
      state.active_provider = JSON.parse(options.body).provider
      state.model = state.providers[state.active_provider].model
      return Response.json(state)
    }
    return Response.json({ ok: true })
  }
  store.setState({ activeProvider: state.active_provider, model: state.model, providers: state.providers, loaded: true, modelDiscoveryEnabled: true })
  root = createRoot(document.getElementById('root'))
})
afterEach(async () => { await act(async () => root.unmount()) })
after(async () => {
  await server?.close()
  dom?.window.close()
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

async function render() { await act(async () => root.render(React.createElement(ModelSelector))) }
async function click(element) { assert.ok(element); await act(async () => element.click()) }
const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label)
const providerTrigger = () => document.querySelector('[aria-label="模型供应商选择"]')
const ariaButton = label => document.querySelector(`button[aria-label="${label}"]`)
async function open() { await click(providerTrigger()) }

test('discovery opens a preview dialog and imports only a clicked row without switching selection', async () => {
  await render()
  await open()
  assert.ok(button('自动识别').compareDocumentPosition(document.querySelector('[role="option"]')) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  await click(button('自动识别'))
  assert.equal(calls.find(item => item.endpoint === '/settings/provider/detect').method, 'POST')
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.equal(document.querySelectorAll('.local-model-discovery__list li').length, 2)
  assert.equal(store.getState().providers['model-fixture'], undefined)
  assert.equal(calls.some(item => item.endpoint === '/settings/provider/import'), false)
  await click(ariaButton('导入 Claude Code fixture-model'))
  assert.equal(store.getState().activeProvider, 'anthropic')
  assert.ok(store.getState().providers['model-fixture'])
  assert.equal(ariaButton('已导入 Claude Code fixture-model').disabled, true)
  assert.equal(ariaButton('导入 Codex fixture-codex').disabled, false)
  const imports = calls.filter(item => item.endpoint === '/settings/provider/import')
  assert.equal(imports.length, 1)
  assert.deepEqual(JSON.parse(imports[0].body), { source_id: 'fixture-source' })
  assert.equal(document.querySelector('.app-dropdown-select__remove-option'), null)
  assert.equal(document.querySelector('.app-dropdown-select__removable-option'), null)
})

test('imported providers remain selectable without a delete column', async () => {
  state.providers['model-fixture'] = imported
  store.setState({ providers: state.providers })
  await render()
  await open()
  assert.equal(document.querySelector('.app-dropdown-select__remove-option'), null)
  await click(button('Claude Code'))
  const request = calls.find(item => item.endpoint === '/settings/provider/activate')
  assert.deepEqual(JSON.parse(request.body), { provider: 'model-fixture' })
  assert.ok(store.getState().providers['model-fixture'])
  assert.equal(store.getState().activeProvider, 'model-fixture')
  assert.equal(calls.some(item => item.endpoint === '/settings/provider/delete'), false)
})

test('the active imported provider has no delete control, and keyboard focus can leave the menu', async () => {
  state.providers['model-fixture'] = imported
  store.setState({ providers: state.providers, activeProvider: 'model-fixture' })
  await render()
  await open()
  assert.equal(document.querySelector('.app-dropdown-select__remove-option'), null)
  assert.equal(document.querySelector('.app-dropdown-select__removable-option'), null)
  await act(async () => document.getElementById('outside').focus())
  assert.equal(providerTrigger().getAttribute('aria-expanded'), 'false')
})

test('manual discovery supports empty results, read warnings, retry and errors', async () => {
  detectResponse = () => Response.json({ candidates: [], issues: [] })
  await render()
  await open()
  await click(button('自动识别'))
  assert.equal(document.querySelector('[role="status"]').textContent, '未找到可导入的模型配置')
  detectResponse = () => Response.json({ candidates: [{ ...candidates[0], imported: true }], issues: ['Codex'] })
  await click(ariaButton('重新识别'))
  assert.equal(document.querySelector('[role="status"]').textContent, '部分配置无法读取：Codex')
  assert.equal(ariaButton('已导入 Claude Code fixture-model').disabled, true)
  detectResponse = () => Response.json({ detail: '自动识别暂时失败，请稍后重试' }, { status: 500 })
  await click(ariaButton('重新识别'))
  assert.equal(document.querySelector('[role="alert"]').textContent, '自动识别暂时失败，请稍后重试')
  assert.equal(store.getState().providers.anthropic.has_key, true)
  assert.equal(ariaButton('重新识别').disabled, false)
})

test('closing a pending scan cancels it without updating saved configurations', async () => {
  let finish
  detectResponse = () => new Promise(resolve => { finish = resolve })
  await render()
  await open()
  await click(button('自动识别'))
  assert.equal(ariaButton('重新识别').disabled, true)
  await click(ariaButton('重新识别'))
  assert.equal(calls.filter(item => item.endpoint === '/settings/provider/detect').length, 1)
  const scan = calls.find(item => item.endpoint === '/settings/provider/detect')
  await click(ariaButton('关闭'))
  assert.equal(scan.signal.aborted, true)
  await act(async () => finish(Response.json({ candidates, issues: [] })))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(store.getState().providers['model-fixture'], undefined)
})

test('import errors leave the candidate available and block duplicate requests while pending', async () => {
  let finish
  const respond = globalThis.fetch
  globalThis.fetch = (url, options) => {
    if (new URL(url).pathname !== '/settings/provider/import') return respond(url, options)
    calls.push({ endpoint: '/settings/provider/import', ...options })
    return new Promise(resolve => { finish = resolve })
  }
  await render()
  await open()
  await click(button('自动识别'))
  await click(ariaButton('导入 Claude Code fixture-model'))
  assert.equal(ariaButton('导入 Codex fixture-codex').disabled, true)
  assert.equal(ariaButton('关闭').disabled, true)
  await click(ariaButton('导入 Claude Code fixture-model'))
  assert.equal(calls.filter(item => item.endpoint === '/settings/provider/import').length, 1)
  await act(async () => finish(Response.json({ detail: '该配置已不可用，请重新识别' }, { status: 404 })))
  assert.match(document.querySelector('[role="alert"]').textContent, /重新识别/)
  assert.equal(ariaButton('导入 Claude Code fixture-model').disabled, false)
})

test('model settings have a compact search toolbar and a discovery dialog beside Add', async () => {
  await act(async () => root.render(React.createElement(SettingsPage)))
  const header = document.querySelector('.model-settings-sidebar__header')
  assert.equal(header.querySelector('.model-settings-sidebar__title'), null)
  assert.equal(header.querySelector('.model-settings-sidebar__count'), null)
  assert.ok(header.querySelector('[aria-label="搜索模型配置名称"]'))
  assert.ok(ariaButton('添加模型'))
  assert.ok(ariaButton('识别本地模型'))
  await click(ariaButton('识别本地模型'))
  await click(ariaButton('导入 Claude Code fixture-model'))
  await click(ariaButton('关闭'))
  assert.ok(document.querySelector('[data-model-configuration="model-fixture"].is-selected'))
})

test('the extension switch defaults on, saves changes and preserves its state after a failed save', async () => {
  await act(async () => root.render(React.createElement(SettingsPage)))
  await click(button('模型识别'))
  let toggle = document.querySelector('[role="switch"][aria-label="模型识别"]')
  assert.equal(toggle.checked, true)
  await click(toggle)
  assert.equal(store.getState().modelDiscoveryEnabled, false)
  const request = calls.find(item => item.endpoint === '/settings/extensions/model-discovery')
  assert.deepEqual(JSON.parse(request.body), { model_discovery_enabled: false })
  await click(button('模型'))
  await click(ariaButton('识别本地模型'))
  assert.equal(document.querySelectorAll('.local-model-discovery__list li').length, 2)
  await click(ariaButton('关闭'))
  await click(button('模型识别'))
  toggle = document.querySelector('[role="switch"][aria-label="模型识别"]')
  assert.equal(toggle.checked, false)
  globalThis.fetch = async () => Response.json({ detail: '保存失败' }, { status: 500 })
  await click(toggle)
  assert.equal(toggle.checked, false)
  assert.equal(document.querySelector('[role="alert"]').textContent, '保存失败')
})

test('selecting an import without an explicit model fetches and saves a model before activation', async () => {
  state.providers['model-fixture'] = { ...imported, model: '' }
  store.setState({ providers: state.providers })
  await render()
  await open()
  await click(button('Claude Code'))
  const save = calls.findIndex(item => item.endpoint === '/settings/provider')
  const activate = calls.findIndex(item => item.endpoint === '/settings/provider/activate')
  assert.ok(save >= 0 && activate > save)
  assert.equal(store.getState().activeProvider, 'model-fixture')
  assert.equal(store.getState().model, 'fixture-model')
})

test('an empty catalog does not activate an incomplete imported provider', async () => {
  state.providers['model-fixture'] = { ...imported, model: '' }
  store.setState({ providers: state.providers })
  const respond = globalThis.fetch
  globalThis.fetch = (url, options) => new URL(url).pathname === '/settings/provider/models'
    ? Promise.resolve(Response.json({ models: [] })) : respond(url, options)
  await render()
  await open()
  await click(button('Claude Code'))
  assert.equal(store.getState().activeProvider, 'anthropic')
  assert.equal(calls.some(item => item.endpoint === '/settings/provider/activate'), false)
  assert.match(document.querySelector('.chat-model-selector').title, /选择或填写模型名称/)
})

test('the eye reads a saved key on demand without editing or saving the form, then clears plaintext', async () => {
  const changes = []
  globalThis.fetch = async (url, options) => {
    calls.push({ endpoint: new URL(url).pathname, ...options })
    return Response.json({ api_key: 'fixture-saved-secret' })
  }
  await act(async () => root.render(React.createElement(SecretInput, { value: '', provider: 'model-fixture',
    hasSavedKey: true, onChange: event => changes.push(event.target.value), placeholder: '••••••••' })))
  const input = document.querySelector('input')
  assert.equal(input.value, '')
  assert.equal(calls.length, 0)
  assert.ok(ariaButton('显示 API Key').querySelector('svg'))
  assert.equal(ariaButton('显示 API Key').textContent, '')
  await click(ariaButton('显示 API Key'))
  assert.equal(input.type, 'text')
  assert.equal(input.value, 'fixture-saved-secret')
  assert.deepEqual(JSON.parse(calls[0].body), { provider: 'model-fixture', target: 'weworker' })
  assert.equal(calls[0].endpoint, '/settings/provider/reveal-key')
  assert.deepEqual(changes, [])
  await click(ariaButton('隐藏 API Key'))
  assert.equal(input.type, 'password')
  assert.equal(input.value, '')
  assert.equal(calls.length, 1)
})

test('the eye shows unsaved input locally and resets when switching configurations', async () => {
  const props = { value: 'fixture-draft-key', provider: 'model-first', hasSavedKey: true, onChange: () => {} }
  await act(async () => root.render(React.createElement(SecretInput, props)))
  await click(ariaButton('显示 API Key'))
  assert.equal(document.querySelector('input').value, 'fixture-draft-key')
  assert.equal(calls.length, 0)
  await act(async () => root.render(React.createElement(SecretInput, { ...props, value: '', provider: 'model-second' })))
  assert.equal(document.querySelector('input').type, 'password')
  assert.equal(document.querySelector('input').value, '')
})

test('saved-key failures stay masked and can be retried, with distinct exploration target', async () => {
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { provider: 'model-fixture', target: 'webwright' })
    return ++requests === 1 ? Response.json({}, { status: 500 }) : Response.json({ api_key: 'fixture-retry-key' })
  }
  await act(async () => root.render(React.createElement(SecretInput, { value: '', provider: 'model-fixture', target: 'webwright',
    ariaLabel: '网站探索agent API Key', hasSavedKey: true, onChange: () => {} })))
  await click(ariaButton('显示 网站探索agent API Key'))
  assert.ok(document.querySelector('[role="alert"]'))
  assert.equal(document.querySelector('input').type, 'password')
  await click(ariaButton('显示 网站探索agent API Key'))
  assert.equal(document.querySelector('input').value, 'fixture-retry-key')
  assert.equal(document.querySelector('[role="alert"]'), null)
})

test('switching configurations ignores a late saved-key response', async () => {
  let resolveRequest
  globalThis.fetch = (_url, options) => {
    calls.push(options)
    return new Promise(resolve => { resolveRequest = resolve })
  }
  const props = { value: '', provider: 'model-first', hasSavedKey: true, onChange: () => {} }
  await act(async () => root.render(React.createElement(SecretInput, props)))
  await click(ariaButton('显示 API Key'))
  assert.equal(ariaButton('显示 API Key').disabled, true)
  await act(async () => root.render(React.createElement(SecretInput, { ...props, provider: 'model-second' })))
  assert.equal(calls[0].signal.aborted, true)
  await act(async () => resolveRequest(Response.json({ api_key: 'fixture-stale-key' })))
  assert.equal(document.querySelector('input').value, '')
  assert.equal(document.querySelector('input').type, 'password')
})
