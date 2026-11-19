import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let dom, server, MessageItem, createRoot
const copied = []

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'MouseEvent']) globalThis[name] = name === 'window' ? dom.window : dom.window[name]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => copied.push(text) } })
  ;({ createRoot } = await import('react-dom/client'))
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  MessageItem = (await server.ssrLoadModule('/src/components/chat/MessageItem.jsx')).default
})

after(async () => {
  await server?.close()
  dom?.window.close()
  for (const name of ['window', 'document', 'MouseEvent', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[name]
})

async function mount(t, props = {}) {
  const root = createRoot(document.getElementById('test'))
  t.after(async () => act(async () => root.unmount()))
  window.getSelection().removeAllRanges()
  copied.length = 0
  await act(async () => root.render(React.createElement(MessageItem, {
    message: { id: 'example', role: 'assistant', content: [{ type: 'text', text: '# Heading\n\n**bold** and `code`' }] }, ...props,
  })))
  return document.querySelector('.message-item')
}

async function openMenu(element) {
  await act(async () => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100 })))
}

async function clickCopy(label) {
  const button = [...document.querySelector('[data-message-context-menu]').children].find(node => node.textContent === label)
  assert.ok(button, label)
  await act(async () => button.click())
  assert.equal(document.querySelector('[data-message-context-menu]'), null)
}

test('right-click exposes exactly two copy formats and writes the corresponding whole-message content', async t => {
  const message = await mount(t)
  await openMenu(message)
  assert.deepEqual([...document.querySelector('[data-message-context-menu]').children].map(node => node.textContent), ['复制 Markdown', '复制纯文本', '多选', '删除'])
  await clickCopy('复制 Markdown')
  await openMenu(message)
  await clickCopy('复制纯文本')
  assert.deepEqual(copied, ['# Heading\n\n**bold** and `code`', 'Heading\nbold and code'])
})

test('both copy actions use the selection captured before the menu takes focus', async t => {
  const message = await mount(t)
  for (const label of ['复制 Markdown', '复制纯文本']) {
    const range = document.createRange()
    range.selectNodeContents(message.querySelector('strong'))
    window.getSelection().addRange(range)
    await openMenu(message)
    window.getSelection().removeAllRanges()
    await clickCopy(label)
    assert.equal(window.getSelection().toString(), 'bold', '复制完成后恢复蓝色选中高亮')
  }
  assert.deepEqual(copied, ['**bold**', 'bold'])
})

for (const props of [{ streaming: true }, { selectMode: true }]) {
  test(`menu is suppressed with ${JSON.stringify(props)}`, async t => {
    const message = await mount(t, props)
    await openMenu(message)
    assert.equal(document.querySelector('[data-message-context-menu]'), null)
  })
}
