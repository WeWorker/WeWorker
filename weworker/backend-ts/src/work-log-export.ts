import type { Message } from './works-store.js'

// Export only known diagnostic fields. Redacting arbitrary text is not enough:
// user content, tool output and paths can be private without containing a credential.
function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : undefined
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function field(name: string, value: number | string | undefined): string {
  return value === undefined ? '' : ` ${name}=${value}`
}

function errorCategory(text: string): string {
  // Never use the raw error message: it may include a request, path or token.
  const label = /^\s*([a-zA-Z]+Error)\b/.exec(text)?.[1]
  return label && /^(?:Type|Range|Reference|Syntax|URI|Eval|Aggregate|Abort|Timeout|Network|Validation|Permission)Error$/.test(label)
    ? label : 'error'
}

/** Format only privacy-safe diagnostic metadata from persisted messages. */
export function summarizeMessage(message: Message): string[] {
  const lines: string[] = []
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        lines.push('text: [content omitted]')
        break
      case 'tool_use':
        lines.push(`tool_use: [tool omitted]${field('id', safeId(block.id))}${field('status', ['success', 'done', 'failed', 'error', 'cancelled', 'pending', 'running'].includes(block.status ?? '') ? block.status : undefined)}${field('thinkMs', safeCount(block.thinkMs))}${field('execMs', safeCount(block.execMs))} args=[omitted]${block.result != null ? ' result=[omitted]' : ''}${block.image ? ' image=[omitted]' : ''}`)
        break
      case 'timing':
        lines.push(`timing:${field('totalMs', safeCount(block.totalMs))}${field('llmMs', safeCount(block.llmMs))}${field('execMs', safeCount(block.execMs))}${field('steps', safeCount(block.steps))}${field('remainingModelMs', safeCount(block.remainingModelMs))}${block.routeTool ? ' route=tool_selected' : ''}${field('source', ['route', 'scenario-a', 'scenario', 'plan', 'override', 'alias', 'pattern', 'template', 'llm'].includes(block.routeSource ?? '') ? block.routeSource : undefined)}${block.routeArgs ? ' args=[omitted]' : ''}`)
        break
      case 'error':
        lines.push(`error: category=${errorCategory(block.text)}`)
        break
      case 'skill_context':
        lines.push(`skill_context: [content omitted]${field('tool_use_id', safeId(block.tool_use_id))}`)
        break
      case 'file_attachment':
        lines.push(`file_attachment: [name and path omitted]${field('sizeBytes', safeCount(block.size))}`)
        break
      case 'image_url':
        lines.push('image_attachment: [image omitted]')
        break
      default:
        lines.push('block: [unsupported content omitted]')
    }
  }
  if (!lines.length) lines.push('(empty message)')
  return lines
}

/** Used only when exporting an old conversation with no execution log file. */
export function buildSavedMessagesLog(work: { id?: string; title?: string | null; messages: Message[] }): string {
  const lines = [
    '── 旧版存量消息 ──',
    '说明: 仅补入已保存消息的安全诊断摘要；缺失的执行过程无法恢复。',
    '标题: [omitted]',
  ]
  const workId = safeId(work.id ?? work.messages[0]?.work_id)
  if (workId) lines.push('对话 ID: ' + workId)
  for (const message of work.messages) {
    const timestamp = typeof message.created_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(message.created_at)
      ? message.created_at : '[time omitted]'
    const role = ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : '[role omitted]'
    lines.push(`[${timestamp}] ${role}${field('message_id', safeId(message.id))}`, ...summarizeMessage(message))
  }
  return lines.join('\n') + '\n'
}
