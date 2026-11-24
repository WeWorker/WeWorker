import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let server, Step, Status, LiveActivity, formatElapsedDuration, ToolExecutionGroup, ToolExecutionDetail, ToolExecutionText
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' })
  const module = await server.ssrLoadModule('/src/components/website-exploration/ExplorationStep.jsx')
  Step = module.default; Status = module.ExplorationStatus; LiveActivity = module.ExplorationLiveActivity; formatElapsedDuration = module.formatElapsedDuration
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

test('live activity stays hidden for finished or waiting explorations', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'paused', 'waiting_for_user']) {
    const html = renderToStaticMarkup(React.createElement(LiveActivity, {
      status,
      activity: { phase: 'thinking', step: 2, updated_at_ms: 1000 },
      now: 15000,
    }))
    assert.equal(html, '')
  }
})

test('live activity explains recovery after step failure, compaction, and slow model wait', () => {
  const recovery = renderToStaticMarkup(React.createElement(LiveActivity, {
    status: 'running',
    activity: { phase: 'thinking', step: 2, reason: 'recovering_from_error', updated_at_ms: 10_000 },
    timeline: [{ type: 'agent_step', step: 1, status: 'error' }],
    now: 24_000,
  }))
  assert.match(recovery, /tool-running-indicator__spin/)
  assert.match(recovery, /上一步执行失败，正在分析原因并调整方案…/)
  assert.match(recovery, /已耗时 14s/)
  assert.doesNotMatch(recovery, /模型响应较慢/)

  const slow = renderToStaticMarkup(React.createElement(LiveActivity, {
    status: 'running',
    activity: { phase: 'thinking', step: 2, reason: 'recovering_from_error', updated_at_ms: 10_000 },
    now: 45_000,
  }))
  assert.match(slow, /已耗时 35s/)
  assert.match(slow, /模型响应较慢，仍在等待返回；如长时间无变化可点击停止探索。/)

  const compacting = renderToStaticMarkup(React.createElement(LiveActivity, {
    status: 'running',
    activity: { phase: 'compacting', step: 5, updated_at_ms: 10_000 },
    now: 75_000,
  }))
  assert.match(compacting, /历史记录较长，正在整理上下文…/)
  assert.match(compacting, /已耗时 1m 5s/)
  assert.match(compacting, /模型响应较慢/)

  const fallbackRecovery = renderToStaticMarkup(React.createElement(LiveActivity, {
    status: 'running',
    activity: null,
    timeline: [{ type: 'agent_step', step: 1, status: 'error' }],
    now: 10_000,
  }))
  assert.match(fallbackRecovery, /上一步执行失败，正在分析原因并调整方案…/)
})

test('live activity renders an in-progress step card before timeline persistence and deduplicates afterwards', () => {
  const liveCard = renderToStaticMarkup(React.createElement(LiveActivity, {
    status: 'running',
    activity: {
      phase: 'action_running',
      step: 2,
      thought: 'Open the search panel',
      code: 'await page.click("#search")',
      updated_at_ms: 10_000,
    },
    timeline: [{ type: 'agent_step', step: 1, status: 'error' }],
    now: 38_000,
  }))
  assert.match(liveCard, /步骤 2/)
  assert.match(liveCard, /执行中/)
  assert.match(liveCard, /Open the search panel/)
  assert.match(liveCard, /执行动作/)
  assert.match(liveCard, /已耗时 28s/)
  assert.match(liveCard, /页面操作耗时较长，仍在等待浏览器响应…/)

  const deduped = renderToStaticMarkup(React.createElement(LiveActivity, {
    status: 'running',
    activity: {
      phase: 'action_running',
      step: 2,
      thought: 'Open the search panel',
      code: 'await page.click("#search")',
      updated_at_ms: 10_000,
    },
    timeline: [
      { type: 'agent_step', step: 1, status: 'error' },
      { type: 'agent_step', step: 2, status: 'running', thought: 'Open the search panel' },
    ],
    now: 15_000,
  }))
  assert.doesNotMatch(deduped, /<h3>步骤 2<\/h3>/)
  assert.match(deduped, /正在浏览器中执行第 2 步…/)
  assert.match(deduped, /已耗时 5s/)
  assert.equal(formatElapsedDuration(0), '0s')
  assert.equal(formatElapsedDuration(60), '1m')
  assert.equal(formatElapsedDuration(65), '1m 5s')
})
