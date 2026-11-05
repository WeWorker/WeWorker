import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getToolExecGroupLabel, getToolExecLineText, getToolExecStatusText, formatToolResultText } from '../utils/tool-display.js'
import { partitionContentBlocks } from '../utils/group-tool-blocks.js'

test('shows host WebCLI routing in the same command group, before Agent commands', () => {
  const route = { type: 'tool_use', id: 'route-1', name: 'webcli_route', args: { command: 'webcli route' }, status: 'done', execMs: 250 }
  const call = { type: 'tool_use', id: 'tool-1', name: 'PowerShell', args: { command: 'webcli call example.com.search' }, status: 'running' }
  const groups = partitionContentBlocks([route, call])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'tool_exec_group')
  assert.equal(getToolExecGroupLabel(groups[0].blocks), '执行了 2 个命令')
  assert.equal(getToolExecLineText(groups[0].blocks[0]), 'webcli route')
  assert.equal(getToolExecLineText(groups[0].blocks[1]), 'webcli call example.com.search')
})

test('preserves the routing result for expanding historical command details', () => {
  const saved = JSON.parse(JSON.stringify({ type: 'tool_use', id: 'route-1', name: 'webcli_route', args: { command: 'webcli route' },
    status: 'done', execMs: 250, result: '{"status":"recommended","result":{"callCommand":"webcli call example.com.search"}}' }))
  assert.equal(getToolExecLineText(saved), 'webcli route')
  assert.match(formatToolResultText(saved), /recommended/)
  assert.equal(partitionContentBlocks([saved])[0].blocks[0].execMs, 250)
})

test('shows consistent route status for live events and restored history', () => {
  const route = { name: 'webcli_route', status: 'running' }
  assert.equal(getToolExecStatusText(route, true), '执行中')
  for (const [status, label] of [['recommended', '已执行'], ['low_confidence', '已执行'], ['failed', '已失败'], ['cancelled', '已取消']]) {
    for (const storedStatus of ['done', 'failed']) {
      const block = { ...route, status: storedStatus, result: JSON.stringify({ status }) }
      if (storedStatus === 'failed' && ['recommended', 'low_confidence'].includes(status)) continue
      assert.equal(getToolExecStatusText(block, true), label)
      assert.equal(getToolExecStatusText(JSON.parse(JSON.stringify(block))), label)
    }
  }
  assert.equal(getToolExecStatusText({ ...route, status: 'failed', result: 'legacy result' }), '已失败')
})
