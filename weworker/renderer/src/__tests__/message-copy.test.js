import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { captureMessageSelection, messageCopyContent } from '../utils/message-copy.js'

function fixture(html) {
  const dom = new JSDOM(`<div class="message-item message-item--assistant">${html}</div>`)
  return { dom, root: dom.window.document.querySelector('.message-item') }
}

test('whole-message Markdown preserves transport fragments and excludes tools and timing', () => {
  const message = { role: 'assistant', content: [
    { type: 'text', text: '**bo' }, { type: 'text', text: 'ld**' },
    { type: 'tool_use', name: 'Example', input: { text: 'tool data' } },
    { type: 'text', text: '\n`code`' }, { type: 'timing', steps: 1 },
  ] }
  const { root } = fixture('<div class="message-text-selectable"><p><strong>bold</strong></p></div><button>tool data</button><div class="message-text-selectable"><p><code>code</code></p></div><div>timing</div>')
  assert.deepEqual(messageCopyContent(message, root), { markdown: '**bold**\n\n`code`', plainText: 'bold\n\ncode' })
})

test('plain copy keeps headings, list rows, tables and code without Markdown markers or code controls', () => {
  const { root } = fixture('<div class="message-text-selectable"><h2>Heading</h2><ul><li>One</li><li>Two</li></ul><table><tr><th>Name</th><th>Value</th></tr><tr><td>Example</td><td>1</td></tr></table><pre><code>const a = 1;\n  next();\n</code></pre><div class="chat-shell-command-header"><button>复制</button>运行命令</div><p><a href="https://example.com">Link</a><br>Done</p></div>')
  const result = messageCopyContent({ role: 'assistant', content: [] }, root)
  assert.equal(result.plainText, 'Heading\nOne\nTwo\nName\tValue\nExample\t1\nconst a = 1;\n  next();\nLink\nDone')
})

test('partial bold selection keeps Markdown formatting and a stable plain snapshot', () => {
  const { dom, root } = fixture('<div class="message-text-selectable"><p>Before <strong>bold text</strong> after</p></div>')
  const selection = dom.window.getSelection()
  const range = dom.window.document.createRange()
  range.setStart(root.querySelector('strong').firstChild, 0)
  range.setEnd(root.querySelector('strong').firstChild, 4)
  selection.addRange(range)
  const captured = captureMessageSelection(root, selection)
  selection.removeAllRanges()
  assert.deepEqual(messageCopyContent({ role: 'assistant', content: [] }, root, captured), { markdown: '**bold**', plainText: 'bold' })
})

test('selection in another message is ignored and user messages retain literal Markdown-like text', () => {
  const { dom, root } = fixture('<div class="message-text-selectable">Here</div>')
  const other = dom.window.document.createElement('p')
  other.textContent = 'Other message'
  dom.window.document.body.append(other)
  const range = dom.window.document.createRange()
  range.selectNodeContents(other)
  dom.window.getSelection().addRange(range)
  assert.equal(captureMessageSelection(root, dom.window.getSelection()), null)
  assert.deepEqual(messageCopyContent({ role: 'user', content: [{ type: 'text', text: '  *literal*\n\n' }] }, root), { markdown: '  *literal*\n\n', plainText: '  *literal*\n\n' })
})

test('selected inline code, fenced code and links retain their Markdown semantics', () => {
  for (const [html, selector, expected] of [
    ['<p><code>example()</code></p>', 'code', '`example()`'],
    ['<pre><code>const a = 1;\n  next();\n</code></pre>', 'code', '```\nconst a = 1;\n  next();\n```'],
    ['<p><a href="https://example.com">Example</a></p>', 'a', '[Example](https://example.com)'],
  ]) {
    const { dom, root } = fixture(`<div class="message-text-selectable">${html}</div>`)
    const range = dom.window.document.createRange()
    range.selectNodeContents(root.querySelector(selector))
    dom.window.getSelection().addRange(range)
    const result = captureMessageSelection(root, dom.window.getSelection())
    assert.equal(result.markdown, expected)
    assert.equal(result.plainText, range.toString())
    dom.window.close()
  }
})
