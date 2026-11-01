import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleChatLinkClick } from '../utils/chat-links.js'
import { useDialogStore } from '../store/dialog.js'

const originalWindow = globalThis.window

afterEach(() => {
  globalThis.window = originalWindow
  useDialogStore.setState({ queue: [] })
})

function linkEvent(href, button = 0) {
  return {
    button,
    defaultPrevented: false,
    currentTarget: { getAttribute: () => href },
    preventDefault() { this.defaultPrevented = true },
  }
}

test('desktop links cancel navigation and send the complete URL to the default browser', async () => {
  const opened = []
  globalThis.window = { electronAPI: { openExternal: async url => opened.push(url) } }
  for (const button of [0, 1]) {
    const event = linkEvent('https://example.com/docs?q=hello#section', button)
    const pending = handleChatLinkClick(event)
    assert.equal(event.defaultPrevented, true, 'navigation must stop before IPC resolves')
    await pending
  }
  assert.deepEqual(opened, Array(2).fill('https://example.com/docs?q=hello#section'))
})

test('web preview uses the native new-tab fallback', async () => {
  globalThis.window = {}
  const event = linkEvent('https://example.com/')
  await handleChatLinkClick(event)
  assert.equal(event.defaultPrevented, false)
})

test('invalid, local and executable URLs never navigate or reach the system shell', async () => {
  globalThis.window = { electronAPI: { openExternal: () => assert.fail('unexpected external launch') } }
  for (const href of ['', undefined, '/relative', 'javascript:alert(1)', 'data:text/html,example', 'file:///example.txt', 'weworker-file://example']) {
    const event = linkEvent(href)
    await handleChatLinkClick(event)
    assert.equal(event.defaultPrevented, true, String(href))
  }
})

test('right click and document anchors do not launch the browser', async () => {
  globalThis.window = { electronAPI: { openExternal: () => assert.fail('unexpected external launch') } }
  for (const event of [linkEvent('https://example.com/', 2), linkEvent('#section')]) {
    await handleChatLinkClick(event)
    assert.equal(event.defaultPrevented, false)
  }
})

test('browser launch failure keeps the chat intact and reports a retryable error', async () => {
  globalThis.window = { electronAPI: { openExternal: async () => { throw new Error('Example failure') } } }
  const event = linkEvent('https://example.com/')
  await handleChatLinkClick(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(useDialogStore.getState().queue.length, 1)
  assert.match(useDialogStore.getState().queue[0].message, /浏览器/)
})
