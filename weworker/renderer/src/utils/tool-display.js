/**
 * Shared formatters for tool call / bash execution UI.
 */

import { displayToolName } from './tool-name.js'
import { isWeWorkerShellToolName } from './terminal-chat-output.js'

export function stringifyToolValue(val, whenEmpty = '(empty)') {
  if (val == null || val === '') return whenEmpty
  if (typeof val === 'string') return val
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

export function formatToolResultText(block, whenEmpty = '(empty)') {
  if (isWeWorkerShellToolName(block?.name) && block?.liveOutput) {
    return String(block.liveOutput)
  }

  const result = block?.result
  if (result == null || result === '') return whenEmpty

  if (isWeWorkerShellToolName(block?.name) && typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
        return parsed.output || whenEmpty
      }
    } catch {
      // Fall back to the raw result for malformed tool output.
    }
  }

  return stringifyToolValue(result, whenEmpty)
}

export function getSkillSummary(args) {
  if (!args || typeof args !== 'object') return ''
  const name = args.skill || args.skill_name || args.name || ''
  if (!name) return ''
  return name.replace(/^webcli-/, '')
}

export function getToolCallSummary(args) {
  if (!args || typeof args !== 'object') return ''

  if (args.tool_name) {
    return String(args.tool_name)
  }

  if (Array.isArray(args.todos) && args.todos.length > 0) {
    const labels = args.todos
      .map((todo) => String(todo?.content || todo?.subject || '').trim())
      .filter(Boolean)
    if (labels.length) {
      const joined = labels.join('，')
      const MAX = 120
      return joined.length > MAX ? `${joined.slice(0, MAX)}…` : joined
    }
  }

  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  const firstVal = entries[0][1]
  if (firstVal != null && typeof firstVal === 'object') {
    try {
      const compact = JSON.stringify(firstVal)
      const MAX = 60
      return compact.length > MAX ? `${compact.slice(0, MAX)}…` : compact
    } catch {
      return ''
    }
  }
  const firstText = String(firstVal)
  const MAX = 60
  return firstText.length > MAX ? firstText.slice(0, MAX) + '…' : firstText
}

export function getBashCommandText(block) {
  const command = block?.args?.command
  if (command == null || command === '') return '(无命令)'
  return String(command)
}

export function getBaseToolName(rawName) {
  return displayToolName(rawName || '').split('.').pop() || rawName || '(tool)'
}

export function getToolExecLineText(block) {
  const name = getBaseToolName(block?.name)
  const args = block?.args && typeof block.args === 'object' ? block.args : {}

  if (name === 'Bash' || name === 'PowerShell') return getBashCommandText(block)
  if (name === 'webcli_route') return 'webcli route'

  const path = args.file_path || args.path || args.target_file || args.file || ''
  if (name === 'Read') return path ? `Read ${path}` : 'Read'
  if (name === 'Write' || name === 'Edit' || name === 'StrReplace') {
    return path ? `${name} ${path}` : name
  }
  if (name === 'Grep') {
    const pattern = args.pattern || args.query || ''
    const scope = args.path || args.glob || ''
    if (pattern && scope) return `Grep ${pattern} — ${scope}`
    return pattern ? `Grep ${pattern}` : 'Grep'
  }
  if (name === 'Glob') return String(args.glob_pattern || args.pattern || 'Glob')
  if (name === 'Delete') return String(args.path || args.target || 'Delete')
  if (name === 'WebFetch') return String(args.url || 'WebFetch')
  if (name === 'WebSearch') return String(args.search_term || args.query || 'WebSearch')

  const summary = getToolCallSummary(args)
  return summary ? `${name} — ${summary}` : name
}

export function getToolExecGroupLabel(blocks) {
  const count = blocks?.length ?? 0
  if (count <= 0) return ''
  const allCommands = blocks.every((block) => ['Bash', 'PowerShell', 'webcli_route'].includes(getBaseToolName(block.name)))
  if (allCommands) return count === 1 ? '执行了 1 个命令' : `执行了 ${count} 个命令`
  return count === 1 ? '执行了 1 个操作' : `执行了 ${count} 个操作`
}

export function getToolExecTooltipText(block) {
  const name = getBaseToolName(block?.name)
  if (name === 'Bash' || name === 'PowerShell' || isWeWorkerShellToolName(block?.name)) {
    return getBashCommandText(block)
  }
  return getToolExecLineText(block)
}

export function getToolExecStatusText(block, streaming = false) {
  if (streaming && block.status === 'running') return '执行中'
  if (getBaseToolName(block.name) === 'webcli_route') {
    try {
      const result = typeof block.result === 'string' ? JSON.parse(block.result) : block.result
      if (result?.status === 'cancelled') return '已取消'
      if (result?.status === 'failed') return '已失败'
    } catch {
      // Historical records may contain non-JSON results; fall back to stored status.
    }
    if (block.status === 'failed') return '已失败'
    if (block.status === 'cancelled') return '已取消'
  }
  return '已执行'
}
