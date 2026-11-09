import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let server, Binding, Guide, QrConnect, dom
before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.ShadowRoot = dom.window.ShadowRoot
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  const bindingModule = await server.ssrLoadModule('/src/components/settings/WecomOwnerBinding.jsx')
  Binding = bindingModule.default
  Guide = bindingModule.WecomPairingGuide
  QrConnect = (await server.ssrLoadModule('/src/components/settings/WecomQrConnect.jsx')).default
})
after(async () => { await server?.close(); dom?.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.ShadowRoot; delete globalThis.IS_REACT_ACT_ENVIRONMENT })
const config = { enabled: true, bot_id: 'fixture-bot', has_secret: true, owner_user_id: '', owner_permission_level: 'qa_only', pairing_code: '123456' }
async function mount(t, extra = {}, Component = Binding) {
  const host = document.getElementById('test')
  const root = createRoot(host)
  const props = { profileId: 'fixture-profile', config, active: true, onAction: async () => {}, onRefresh: async () => {}, ...extra }
  const render = async patch => { Object.assign(props, patch); await act(async () => root.render(React.createElement(Component, props))) }
  t.after(async () => { await act(async () => root.unmount()) })
  await render({})
  return { host, render }
}

test('shows compact binding status and removes the command after owner binding', async t => {
  let refreshes = 0
  const view = await mount(t, { onRefresh: async () => { refreshes++ } })
  assert.ok(!view.host.querySelector('input'), 'binding status should not be an input field')
  assert.equal(view.host.querySelector('[role="status"]').textContent, '未绑定')
  assert.match(view.host.textContent, /在企业微信中输入.*绑定 123456.*完成绑定/)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)) })
  assert.ok(refreshes > 0)
  await view.render({ config: { ...config, owner_user_id: 'fixture-owner', pairing_code: '' } })
  assert.match(view.host.textContent, /已绑定/)
  assert.doesNotMatch(view.host.textContent, /fixture-owner|绑定 123456/)
})

test('copies the displayed guide command and replaces it with success when bound', async t => {
  assert.equal(typeof Guide, 'function')
  let copied = ''
  const previousClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text } } })
  t.after(() => { if (previousClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', previousClipboard); else delete globalThis.navigator.clipboard })
  const view = await mount(t, {}, Guide)
  const guide = view.host.querySelector('[aria-label="主人绑定引导"]')
  assert.ok(guide)
  assert.match(guide.textContent, /最后一步.*绑定主人/)
  assert.match(guide.textContent, /绑定 123456/)
  await act(async () => [...guide.querySelectorAll('button')].find(button => button.textContent === '复制').click())
  assert.equal(copied, '绑定 123456')
  assert.match(guide.textContent, /已复制/)
  await view.render({ config: { ...config, owner_user_id: 'fixture-owner', pairing_code: '' } })
  assert.match(view.host.querySelector('[aria-label="主人绑定引导"]').textContent, /主人已绑定/)
  assert.doesNotMatch(view.host.textContent, /绑定 123456|等待绑定|fixture-owner/)
})

test('refreshes the copy action when a replacement binding code arrives', async t => {
  assert.equal(typeof Guide, 'function')
  let copied = ''
  const previousClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text } } })
  t.after(() => { if (previousClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', previousClipboard); else delete globalThis.navigator.clipboard })
  const view = await mount(t, {}, Guide)
  await act(async () => view.host.querySelector('button').click())
  await view.render({ config: { ...config, pairing_code: '654321' } })
  assert.equal(view.host.querySelector('button').textContent, '复制')
  await act(async () => view.host.querySelector('button').click())
  assert.equal(copied, '绑定 654321')
  assert.doesNotMatch(view.host.textContent, /绑定 123456/)
})

test('replaces the QR area with binding instructions only after the scanned credentials are saved', async t => {
  let finishSave
  const imported = new Promise(resolve => { finishSave = resolve })
  let saving = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname
    assert.equal(options.method, 'POST')
    if (path.endsWith('/qr-start')) return Response.json({ session_id: 'fixture-qr', qrcode_url: 'https://example.com/bot', expires_at: Date.now() + 60000, poll_interval_ms: 20 })
    if (path.endsWith('/qr-poll')) return Response.json({ status: 'confirmed', bot_id: 'fixture-bot', secret: 'fixture-secret' })
    if (path.endsWith('/qr-cancel')) return Response.json({ ok: true })
    throw new Error(`Unexpected request: ${path}`)
  })
  const view = await mount(t, {
    bindingConfig: { ...config, pairing_code: '' },
    onImport: async credentials => {
      assert.deepEqual(credentials, { bot_id: 'fixture-bot', secret: 'fixture-secret' })
      saving = true
      await imported
    },
  }, QrConnect)
  await act(async () => view.host.querySelector('button').click())
  for (let i = 0; i < 40 && !saving; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.ok(saving)
  assert.ok(!view.host.querySelector('[aria-label="主人绑定引导"]'))
  await view.render({ bindingConfig: config })
  await act(async () => { finishSave(); await imported })
  assert.match(view.host.querySelector('[aria-label="主人绑定引导"]')?.textContent || '', /绑定 123456/)
  assert.ok(!view.host.querySelector('img'))
  await view.render({ bindingConfig: { ...config, owner_user_id: 'fixture-owner', pairing_code: '' } })
  assert.match(view.host.querySelector('[aria-label="主人绑定引导"]')?.textContent || '', /主人已绑定/)
  assert.doesNotMatch(view.host.textContent, /绑定 123456|等待绑定/)
})

test('restores an unfinished guide on reopen and shows completion when owner polling finishes', async t => {
  const view = await mount(t, { bindingConfig: config }, QrConnect)
  assert.match(view.host.querySelector('[aria-label="主人绑定引导"]')?.textContent || '', /绑定 123456/)
  await view.render({ bindingConfig: { ...config, owner_user_id: 'fixture-owner', pairing_code: '' } })
  assert.match(view.host.querySelector('[aria-label="主人绑定引导"]')?.textContent || '', /主人已绑定/)
})

test('does not show an old binding guide while new credentials are pending save', async t => {
  const view = await mount(t, { bindingConfig: config, disabled: true }, QrConnect)
  assert.ok(!view.host.querySelector('[aria-label="主人绑定引导"]'))
})

test('initializes an enabled legacy bot code, but never generates one for inactive or unsaved credentials', async t => {
  const calls = []
  const view = await mount(t, { active: false, config: { ...config, pairing_code: '' }, onAction: async action => calls.push(action) })
  assert.deepEqual(calls, [])
  await view.render({ active: true, disabled: true })
  assert.deepEqual(calls, [])
  await view.render({ disabled: false })
  assert.deepEqual(calls, ['pair'])
})

test('requires confirmation before re-pair and displays generation failure with retry', async t => {
  let confirmed = false
  const calls = []
  const view = await mount(t, { config: { ...config, owner_user_id: 'fixture-owner', pairing_code: '' }, confirm: async () => confirmed, onAction: async action => { calls.push(action); throw new Error('fixture request failed') } })
  const button = [...view.host.querySelectorAll('button')].find(item => item.textContent === '重新绑定')
  await act(async () => button.click())
  assert.deepEqual(calls, [])
  confirmed = true
  await act(async () => button.click())
  assert.deepEqual(calls, ['re-pair'])
  assert.match(view.host.textContent, /fixture request failed/)
  assert.match(view.host.textContent, /已绑定/)
})
