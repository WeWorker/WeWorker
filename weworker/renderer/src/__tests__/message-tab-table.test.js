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
})
