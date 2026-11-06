import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatToolResultText, getToolCallSummary, getToolExecGroupLabel, getToolExecLineText, getToolExecTooltipText, getToolExecStatusText } from '../utils/tool-display.js'

describe('tool-display summaries', () => {
  it('keeps the complete shell command in tooltips, including multiline tails', () => {
    const command = 'webcli call example.com.list --keyword=' + 'x'.repeat(180) + '\nWrite-Output "done"'
    for (const name of ['Bash', 'PowerShell', 'weworker_powershell', 'mcp__weworker__weworker_powershell']) {
      assert.equal(getToolExecTooltipText({ name, args: { command } }), command)
    }
    assert.equal(getToolExecTooltipText({ name: 'weworker_powershell', args: {} }), '(无命令)')
    assert.equal(getToolExecTooltipText({ name: 'Read', args: { path: '/example.txt' } }), 'Read /example.txt')
  })

  it('formats TodoWrite todos as readable text', () => {
    const summary = getToolCallSummary({
      merge: true,
      todos: [
        { id: '1', content: '测试1: Web搜索', status: 'pending' },
        { id: '2', content: '测试2: 文件操作', status: 'pending' },
      ],
    })

    assert.match(summary, /测试1: Web搜索/)
    assert.match(summary, /测试2: 文件操作/)
    assert.doesNotMatch(summary, /\[object Object\]/)
  })

  it('renders native PowerShell calls as commands', () => {
    const block = { name: 'PowerShell', args: { command: 'Get-Location' } }

    assert.equal(getToolExecLineText(block), 'Get-Location')
    assert.equal(getToolExecGroupLabel([block]), '执行了 1 个命令')
  })
})

describe('tool result display', () => {
  it('uses host business status independently of Shell exit status', () => {
    const labels = { waiting_confirmation: '等待确认', cancelled: '已取消', not_submitted: '尚未提交', succeeded: '执行成功', failed: '执行失败', unknown: '结果未知' }
    for (const [state, label] of Object.entries(labels)) {
      const result = JSON.stringify({ success: true, exitCode: 0, output: JSON.stringify({ _execution: { state } }) })
      assert.equal(getToolExecStatusText({ name: 'weworker_powershell', status: 'completed', result }), label)
    }
    assert.equal(getToolExecStatusText({ name: 'PowerShell', status: 'completed', result: 'done' }), '命令已结束')
    assert.equal(getToolExecStatusText({ name: 'PowerShell', status: 'completed', result: '等待宿主确认；请勿重复提交。\n' + JSON.stringify({ _execution: { state: 'cancelled' } }) }), '已取消')
  })
  it('shows only command output for WeWorker Shell JSON results', () => {
    const result = JSON.stringify({
      success: true,
      sessionId: 'ps-123',
      shell: 'bash',
      exitCode: 0,
      cwd: 'C:\\Users\\liuqi\\.weworker\\user-files',
      output: "On branch main\nnothing to commit, working tree clean\n",
    }, null, 2)

    assert.equal(
      formatToolResultText({ name: 'weworker_powershell', result }),
      'On branch main\nnothing to commit, working tree clean\n',
    )
  })

  it('keeps non-WeWorker Shell results unchanged', () => {
    const result = '{"success":true,"output":"hidden"}'

    assert.equal(formatToolResultText({ name: 'webcli_result', result }), result)
  })
})
