import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server, Step, Status, ToolExecutionGroup, ToolExecutionDetail, ToolExecutionText
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  const module = await server.ssrLoadModule('/src/components/website-exploration/ExplorationStep.jsx')
  Step = module.default; Status = module.ExplorationStatus
  ToolExecutionGroup = (await server.ssrLoadModule('/src/components/chat/ToolExecutionGroup.jsx')).default
  const detail = await server.ssrLoadModule('/src/components/chat/ToolExecutionDetail.jsx')
  ToolExecutionDetail = detail.default; ToolExecutionText = detail.ToolExecutionText
})
after(async () => { await server?.close() })

test('chat and exploration share the exact expanded output markup without changing text', () => {
  const text = '1  Example\n\n    print("<example>")\n'
  const shared = renderToStaticMarkup(React.createElement(ToolExecutionDetail, null, React.createElement(ToolExecutionText, null, text)))
  const chat = renderToStaticMarkup(React.createElement(ToolExecutionGroup, { blocks: [{ id: 'example', name: 'Read', args: { file_path: 'example.txt' }, result: text, status: 'done', chatBang: true }] }))
  assert.ok(chat.includes(shared))
  assert.match(shared, /class="tool-exec-group__detail-scroll"/)
  assert.match(shared, /class="tool-exec-group__detail-pre"/)
  assert.match(shared, /Example\n\n    print/)
})

test('shared detail preserves ordinary chat running and empty-result placeholders', () => {
  const block = { id: 'example', name: 'Bash', args: { command: 'example' }, chatBang: true }
  assert.match(renderToStaticMarkup(React.createElement(ToolExecutionGroup, { streaming: true, blocks: [{ ...block, status: 'running' }] })), /等待命令输出…/)
  assert.match(renderToStaticMarkup(React.createElement(ToolExecutionGroup, { blocks: [{ ...block, status: 'done' }] })), /无输出/)
})

test('step renders distinct thought, action and page icons with keyboard-accessible disclosure buttons', () => {
  const html = renderToStaticMarkup(React.createElement(Step, { item: {
    step: 1, status: 'ok', thought: 'Read the example page', code: 'print("example")',
    observation: { title: 'Example page', url: 'https://example.com', screenshot_url: '/api/explorations/example/files/page.png' },
  } }))
  assert.match(html, /lucide-brain/)
  assert.match(html, /tool-row-static-icon/)
  assert.match(html, /lucide-globe/)
  assert.match(html, /步骤 1/)
  assert.match(html, /已完成/)
  assert.match(html, /Read the example page/)
  assert.match(html, /执行动作/)
  assert.match(html, /页面结果/)
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 2)
  assert.equal((html.match(/aria-controls=/g) || []).length, 2)
  assert.doesNotMatch(html, /<img|<pre|<details|tool-running-indicator/)
})

for (const [value, label, animated] of [
  ['running', '执行中', true], ['starting', '启动中', true], ['cancel_requested', '正在停止', true],
  ['ok', '已完成', false], ['error', '执行失败', false], ['succeeded', '已完成', false],
  ['failed', '失败', false], ['paused', '已暂停', false], ['waiting_for_user', '等待你处理', false],
  ['cancelled', '已停止', false], ['done', '已完成', false], ['unknown', '已记录', false], ['', '已记录', false],
]) test(`status ${value || 'unknown'} is truthful and only active execution animates`, () => {
  const html = renderToStaticMarkup(React.createElement(Status, { value }))
  assert.ok(html.includes(label))
  assert.equal(html.includes('tool-running-indicator__spin'), animated)
})

test('empty observations add no placeholder rows and failure details remain visible', () => {
  const html = renderToStaticMarkup(React.createElement(Step, { item: {
    step: 2, status: 'error', observation: {}, exception: { message: 'Example action failed' },
  } }))
  assert.doesNotMatch(html, /页面结果|执行动作|<button/)
  assert.match(html, /执行失败/)
  assert.match(html, /role="alert"/)
  assert.match(html, /Example action failed/)
})
