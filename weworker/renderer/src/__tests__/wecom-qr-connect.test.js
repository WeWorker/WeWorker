import test, { before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

let server, dom, root, createRoot, View, calls, reply
const globals = new Map()
before(async () => {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, localStorage: dom.window.localStorage,
    ShadowRoot: dom.window.ShadowRoot, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  globals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)), configFile: false,
    plugins: [react()], server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'silent' })
  View = (await server.ssrLoadModule('/src/components/settings/WecomQrConnect.jsx')).default
})
beforeEach(() => {
  calls = []
  reply = () => Response.json({ detail: 'Fixture unavailable' }, { status: 502 })
  globalThis.fetch = async (url, options) => { calls.push(new URL(url).pathname); return reply(url, options) }
  root = createRoot(document.getElementById('root'))
})
afterEach(async () => { await act(async () => root.unmount()) })
after(async () => {
  await server?.close(); dom?.window.close()
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

for (const channel of ['wecom', 'qq', 'feishu']) {
  test(`${channel}: an existing robot cannot start another creation scan`, async () => {
    const bindingConfig = channel === 'wecom' ? { bot_id: 'fixture-bot', has_secret: true } : { app_id: 'fixture-app', has_app_secret: true }
    await act(async () => root.render(React.createElement(View, { channel, bindingConfig, onImport: async () => {} })))
    const button = document.querySelector('button')
    assert.equal(button.disabled, true)
    assert.match(button.textContent, /已关联机器人/)
    await act(async () => button.click())
    assert.deepEqual(calls, [])
  })
}

test('rapid clicks on a fresh profile start only one request', async () => {
  let release
  reply = () => new Promise(resolve => { release = resolve })
  await act(async () => root.render(React.createElement(View, { bindingConfig: {}, onImport: async () => {} })))
  const button = document.querySelector('button')
  await act(async () => { button.click(); button.click() })
  assert.deepEqual(calls, ['/settings/wecom/qr-start'])
  await act(async () => release(Response.json({}, { status: 502 })))
  assert.equal(document.querySelector('button').disabled, false)
})
