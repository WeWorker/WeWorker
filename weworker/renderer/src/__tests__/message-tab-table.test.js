import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let dom, server, MessageItem, createRoot

before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'MouseEvent']) globalThis[name] = name === 'window' ? dom.window : dom.window[name]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
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
  for (const name of ['window', 'document', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame']) delete globalThis[name]
})

async function mountMessage(t, text) {
  const root = createRoot(document.getElementById('test'))
  t.after(async () => act(async () => root.unmount()))
  await act(async () => root.render(React.createElement(MessageItem, {
    message: { id: 'example', role: 'assistant', content: [{ type: 'text', text }] },
  })))
  return document.querySelector('.markdown pre')
}

const TABLE = '发票号码\t销方识别号\t销方名称\t金额\n25422000000023737201\t待补充\t示例餐厅\t687.13'

test('tab-separated table block scrolls horizontally with copy-safe column separators', async t => {
  const pre = await mountMessage(t, '```\n' + TABLE + '\n```')
  assert.ok(pre, 'renders a code block')
  assert.ok(pre.classList.contains('markdown-tab-table'), 'tab table gets the scroll/separator class')
  assert.ok(!pre.classList.contains('markdown-pre-wrap'), '不再按容器宽度换行，恢复左右滑动')
  const seps = pre.querySelectorAll('.tab-sep')
  assert.equal(seps.length, 6, '每个 Tab 都包进分隔 span（2 行 × 3 个 Tab）')
  assert.equal(seps[0].textContent, '\t', '分隔 span 里保留真实 Tab')
  assert.equal(pre.textContent.replace(/\n$/, ''), TABLE, '选中整行复制的仍是原始 Tab 分隔文本')
})

test('plain code blocks keep the default rendering', async t => {
  const pre = await mountMessage(t, '```js\nconst a = 1\nconsole.log(a)\n```')
  assert.ok(pre)
  assert.ok(!pre.classList.contains('markdown-tab-table'), '普通代码块不走表格型渲染')
  assert.equal(pre.querySelectorAll('.tab-sep').length, 0)
  assert.equal(pre.closest('.chat-code-file').querySelector('.chat-code-file__name').textContent, 'code')
})

test('previews, copies and downloads only the code using the declared filename', async t => {
  const code = 'def greet():\n    print("你好")\n'
  const pre = await mountMessage(t, '```python filename=example.py\n' + code + '```\n\n`inline`')
  const block = pre.closest('.chat-code-file')
  const button = label => block.querySelector(`button[aria-label="${label}"]`)
  const dialog = document.body.querySelector(':scope > dialog.chat-code-preview')
  assert.ok(button('查看').querySelector('svg'))
  assert.equal(button('查看').textContent, '')
  dialog.showModal = () => { dialog.open = true }
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')) }
  await act(async () => button('查看').click())
  assert.equal(dialog.open, true)
  assert.equal(dialog.querySelector('strong').textContent, 'example.py')
  assert.deepEqual([...dialog.querySelectorAll('.chat-code-preview__number')].map(node => node.textContent), ['1', '2'])
  assert.equal([...dialog.querySelectorAll('.chat-code-preview__source')].map(node => node.textContent).join('') + '\n', code)
  assert.equal(dialog.querySelector('.hljs-keyword').textContent, 'def')
  assert.equal(pre.className, dialog.querySelector('pre').className)
  assert.equal(pre.innerHTML, dialog.querySelector('pre').innerHTML)
  assert.equal(block.querySelector('.chat-code-preview__language').textContent, 'python')
  await act(async () => dialog.querySelector('button[aria-label="关闭"]').click())
  assert.equal(dialog.open, false)

  let copied, saved
  t.mock.method(globalThis, 'navigator', () => ({ clipboard: { writeText: async value => { copied = value } } }), { getter: true })
  t.mock.method(URL, 'createObjectURL', blob => { saved = { blob }; return 'blob:mock' })
  t.mock.method(URL, 'revokeObjectURL', () => {})
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () { saved.filename = this.download })
  await act(async () => button('复制').click())
  assert.equal(copied, code)
  assert.equal(block.querySelector('[role="status"]').textContent, '已复制')
  const timer = t.mock.timers
  timer.enable({ apis: ['setTimeout'] })
  button('下载').click()
  assert.equal(saved.filename, 'example.py')
  assert.equal(await saved.blob.text(), code)
  timer.tick(30_000)
  assert.equal(document.querySelectorAll('.chat-code-file').length, 1)
})

test('highlights by filename and detects unlabelled code while respecting plain text', async t => {
  await mountMessage(t, '```text filename=plain.py\ndef greet():\n    return True\n```\n\n```unknown filename=greet.py\ndef greet():\n    return True\n```\n\n```\n#include <iostream>\nint main() { std::cout << "hello"; return 0; }\n```')
  const [plain, named, detected] = document.querySelectorAll('.chat-code-file > pre')
  assert.equal(plain.querySelector('.hljs-keyword'), null)
  assert.equal(named.querySelector('.hljs-keyword').textContent, 'def')
  assert.ok(detected.querySelector('.hljs-keyword'))
})

test('preserves extensionless filenames and falls back for invalid names', async t => {
  await mountMessage(t, '```make filename=Makefile\nall:\n```\n\n```python filename=../example.py\npass\n```\n\n```js filename=CON.js\n0\n```')
  assert.deepEqual([...document.querySelectorAll('.chat-code-file > .chat-code-file__bar .chat-code-file__name')].map(node => node.textContent), ['Makefile', 'code', 'code'])
  const download = document.querySelector('.chat-code-file button[aria-label="下载"]')
  let filename
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () { filename = this.download })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  download.click()
  assert.equal(filename, 'Makefile')
  t.mock.timers.tick(30_000)
})
