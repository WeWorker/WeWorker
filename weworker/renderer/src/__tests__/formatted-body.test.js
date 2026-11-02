import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const { DOMParser } = new JSDOM('').window
import { clipboardMarkdown, createFormattedBody, safeBodyUrl } from '../utils/formatted-body.js'
const paste = html => clipboardMarkdown({ html: `<html><body>${html}</body></html>` }, DOMParser)

test('rich clipboard retains paragraphs, nested lists, emphasis, links and tables through HTML export', () => {
  const markdown = paste('<p>Weekly report</p><ul><li>First<ul><li><strong>Nested</strong></li></ul></li><li><em>Second</em></li></ul><ol start="3"><li>Third</li></ol><blockquote>Quote</blockquote><p><a href="https://example.com">Link</a></p><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>')
  const { content, 'markdown-content': saved } = createFormattedBody(markdown)
  assert.equal(saved, markdown)
  for (const tag of ['ul', 'ol', 'strong', 'em', 'blockquote', 'table', 'th', 'td']) assert(content.includes(`<${tag}`), tag)
  assert(content.includes('start="3"'))
  assert(content.includes('https://example.com'))
})

test('raw Markdown and code clipboard preserve blank lines and indentation exactly', () => {
  const text = '  title\n\n\n- item\n\n    code\n'
  assert.equal(clipboardMarkdown({ text }), text)
  assert.equal(clipboardMarkdown({ text, html: '<html><body><pre>coloured source</pre></body></html>' }, DOMParser), text)
  assert.equal(createFormattedBody(text)['markdown-content'], text)
})

test('pasted active markup, UI controls, CSS and unsafe URLs do not reach exported HTML', () => {
  const markdown = paste('<script>alert(1)</script><style>body{display:none}</style><button>Editor</button><p onclick="bad()" style="position:fixed"><span style="font-weight:700;font-style:italic">Safe</span><a href="javascript:alert(1)">link</a><img src="https://example.com/tracker" onerror="bad()" alt="image"></p>')
  const { content } = createFormattedBody(markdown)
  assert(content.includes('<strong>'))
  assert(content.includes('<em>'))
  assert(!/script|onclick|onerror|position:|tracker|Editor|javascript:/i.test(content))
  assert(!content.includes('<img'))
  assert.equal(safeBodyUrl('data:text/html,bad'), '')
  const raw = createFormattedBody('<script>alert(1)</script>\n\n[bad](javascript:alert(1))').content
  assert(!raw.includes('<script>'))
  assert(!raw.includes('href="javascript:'))
})

test('edited Markdown generates fresh HTML without old content or editor wrappers', () => {
  const original = paste('<div id="viewer"><div class="editor"><ul><li>Before</li></ul></div><button>Editor</button></div>')
  const edited = original.replace('Before', 'After') + '\n\n1. Next'
  const body = createFormattedBody(edited)
  assert(body.content.includes('After'))
  assert(body.content.includes('<ol>'))
  assert(!/Before|viewer|class=|Editor/.test(body.content))
  assert.throws(() => createFormattedBody('  '))
})

test('export uses explicit HTML line breaks matching preview and preserves tables without headings', () => {
  const { content } = createFormattedBody('First line\nSecond line\n\n```text\ncode one\ncode two\n```')
  assert.match(content, /First line<br\/>\nSecond line/)
  assert.match(content, /code one\ncode two/)
  const table = createFormattedBody(paste('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>')).content
  assert(table.includes('<table>'))
  for (const cell of ['A', 'B', 'C', 'D']) assert(table.includes(`<td>${cell}</td>`))
})
