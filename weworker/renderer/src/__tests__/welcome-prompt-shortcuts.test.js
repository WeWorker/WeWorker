import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

let server, Shortcuts, dom
before(async () => {
  dom = new JSDOM('<div id="test"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  Shortcuts = (await server.ssrLoadModule('/src/components/welcome/WelcomePromptShortcuts.jsx')).default
})
after(async () => {
  await server?.close()
  dom?.window.close()
  delete globalThis.window
  delete globalThis.document
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
})

const prompts = [
  { id: 'pending', text: '查询我的待办', tag: 'work' },
  { id: 'due', text: '查看本周到期的工单', tag: 'work' },
  { id: 'files', text: '整理本月资料' },
  { id: 'mail', text: '下载本月发票', tag: 'mail' },
  { id: 'usage', text: '查询剩余额度' },
]

async function mount(t, props) {
  const host = document.getElementById('test')
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()) })
  const render = async next => { await act(async () => root.render(React.createElement(Shortcuts, next))) }
  await render(props)
  return { host, render }
}

test('renders fixed prompts in configuration order and fills only the chosen text', async t => {
  const selected = []
  const props = { prompts, onSelect: text => selected.push(text) }
  const view = await mount(t, props)
  assert.deepEqual([...view.host.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), prompts.map(item => item.text))
  assert.deepEqual(selected, [])
  await act(async () => view.host.querySelectorAll('button')[1].click())
  assert.deepEqual(selected, ['查看本周到期的工单'])
  assert.equal(view.host.querySelectorAll('.welcome-prompt-shortcut__tag').length, 0)
  assert.deepEqual([...view.host.querySelectorAll('button')].map(button => button.textContent), prompts.map(item => item.text))
  await view.render({ ...props })
  assert.deepEqual([...view.host.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), prompts.map(item => item.text))
})

test('empty and malformed optional configuration produces no broken shortcuts', async t => {
  const view = await mount(t, { prompts: [], onSelect: () => {} })
  assert.equal(view.host.childElementCount, 0)
  await view.render({ prompts: [null, { id: 'blank', text: ' ' }, { id: 'invalid', text: 123 }, prompts[0]], onSelect: () => {} })
  assert.equal(view.host.querySelectorAll('button').length, 1)
})

test('does not offer an actionable shortcut without an input target', async t => {
  const view = await mount(t, { prompts })
  assert.ok([...view.host.querySelectorAll('button')].every(button => button.disabled))
})
