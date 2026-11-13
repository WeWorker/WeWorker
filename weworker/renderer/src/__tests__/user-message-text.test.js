import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let server, MessageItem
before(async () => {
  server = await createServer({
    configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom',
  })
  MessageItem = (await server.ssrLoadModule('/src/components/chat/MessageItem.jsx')).default
})
after(async () => { await server?.close() })

function renderMessage(role, text) {
  const block = Object.freeze({ type: 'text', text })
  const message = Object.freeze({ id: 'fixture-message', role, content: Object.freeze([block]) })
  return new JSDOM(renderToStaticMarkup(React.createElement(MessageItem, { message }))).window.document
}

for (const text of [
  '*example*',
  '**bold** and _literal_ and ~~text~~',
  '# Heading\n- item\n1. item',
  '`command`\n```text\n*literal*\n```',
  '[label](https://example.com) and ![image](https://example.org/image.png)',
]) {
  test(`user message preserves literal characters: ${JSON.stringify(text)}`, () => {
    const document = renderMessage('user', text)
    const bubble = document.querySelector('.message-bubble--user')
    assert.equal(bubble.textContent, text)
    assert.equal(bubble.querySelector('em, strong, del, code, h1, ul, ol, a, img'), null)
  })
}

test('user message keeps leading spaces, blank lines and indentation', () => {
  const text = '  first  \n\n\tsecond\n'
  const document = renderMessage('user', text)
  const content = document.querySelector('.message-bubble--user .message-text-selectable')
  assert.equal(content.textContent, text)
  assert.equal(content.style.whiteSpace, 'pre-wrap')
})

test('user HTML-like text is displayed literally without mounting elements', () => {
  const text = '<b>literal</b> <img src="https://example.com/image.png"> & text'
  const document = renderMessage('user', text)
  const bubble = document.querySelector('.message-bubble--user')
  assert.equal(bubble.textContent, text)
  assert.equal(bubble.querySelector('b, img'), null)
})

test('assistant replies still render Markdown emphasis and tables', () => {
  const document = renderMessage('assistant', '*italic* **bold**\n\n| Name | Value |\n| --- | --- |\n| Example | 1 |')
  const bubble = document.querySelector('.message-bubble--assistant')
  assert.equal(bubble.querySelector('em').textContent, 'italic')
  assert.equal(bubble.querySelector('strong').textContent, 'bold')
  assert.equal(bubble.querySelectorAll('tbody tr').length, 1)
})
