import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let dom, server, Component, createRoot
const originalFetch = globalThis.fetch
const calls = []
const saved = { base_url: 'https://example.org/exploration', base_url_is_full: true,
  use_main_key: true, configured_model: 'fixture-explore-model', main_model: 'fixture-main-model', has_key: true, status: 'independent' }

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'MouseEvent', 'Event']) globalThis[name] = name === 'window' ? dom.window : dom.window[name]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null })
    return Response.json({ ...saved, ok: true, model: 'fixture-explore-model' })
  }
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  Component = (await server.ssrLoadModule('/src/components/settings/ExplorationModelSettings.jsx')).default
})

after(async () => {
  await server?.close()
  dom?.window.close()
  globalThis.fetch = originalFetch
  for (const name of ['window', 'document', 'MouseEvent', 'Event', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[name]
})

test('restores the original exploration form, saved fields, key toggle and verification save', async t => {
  const root = createRoot(document.getElementById('test'))
  t.after(() => act(async () => root.unmount()))
  await act(async () => root.render(React.createElement(Component)))
  const toggle = document.querySelector('.exploration-model-toggle')
  assert.equal(toggle.querySelector('strong').textContent, '网站探索模型')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  await act(async () => toggle.click())
  const address = document.querySelector('input[type="url"]')
  assert.ok(address, 'original service address field is available')
  assert.equal(address.value, saved.base_url)
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')]
  assert.equal(boxes.length, 2, 'complete URL and main key options are restored')
  assert.equal(boxes[0].checked, true)
  assert.equal(boxes[1].checked, true)
  assert.equal(document.querySelector('input[type="password"]'), null)
  await act(async () => boxes[1].click())
  assert.equal(document.querySelector('input[type="password"]').required, false, 'blank key retains the existing saved key')
  await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  assert.deepEqual(calls.find(call => call.body)?.body, { base_url: saved.base_url, base_url_is_full: true, use_main_key: false, model: saved.configured_model, api_key: '' })
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(document.querySelector('.exploration-provider-tabs'), null, 'does not introduce the replacement provider tabs')
})
