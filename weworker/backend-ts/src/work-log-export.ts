import { redactLogText, redactLogValue } from './log-redaction.js'
import type { Message } from './works-store.js'

function fullValue(value: unknown): string {
  const safe = redactLogValue(value)
  return typeof safe === 'string' ? safe : JSON.stringify(safe) ?? String(safe)
}

/** Format persisted message blocks without length limits. */
export function summarizeMessage(message: Message): string[] {
  const lines: string[] = []
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        lines.push(`text: ${fullValue(block.text)}`)
        break
      case 'tool_use':
        lines.push(`tool_use: ${block.name}${block.id ? ` id=${block.id}` : ''}${block.status ? ` status=${block.status}` : ''}${block.thinkMs != null ? ` thinkMs=${block.thinkMs}` : ''}${block.execMs != null ? ` execMs=${block.execMs}` : ''} args=${fullValue(block.args)}${block.result != null ? ` result=${fullValue(block.result)}` : ''}${block.image ? ' image=[binary image omitted]' : ''}`)
        break
      case 'timing':
        lines.push(`timing: totalMs=${block.totalMs} llmMs=${block.llmMs} execMs=${block.execMs} steps=${block.steps}${block.remainingModelMs != null ? ` remainingModelMs=${block.remainingModelMs}` : ''}${block.routeTool ? ` route=${block.routeTool}` : ''}${block.routeSource ? ` source=${block.routeSource}` : ''}${block.routeArgs ? ` args=${fullValue(block.routeArgs)}` : ''}`)
        break
      case 'error':
        lines.push(`error: ${fullValue(block.text)}`)
        break
      case 'skill_context':
        lines.push(`skill_context: ${block.name} tool_use_id=${block.tool_use_id} digest=${block.digest}\n${fullValue(block.text)}`)
        break
      case 'file_attachment':
        lines.push(`file_attachment: ${block.name}${block.size != null ? ` (${block.size}B)` : ''}`)
        break
      case 'image_url':
        lines.push('image_attachment: [image omitted]')
        break
      default:
        lines.push(`${(block as { type?: string }).type || 'block'}: ${fullValue(block)}`)
    }
  }
  if (!lines.length) lines.push('(empty message)')
  return lines
}


/** Used only when exporting an old conversation with no execution log file. */
export function buildSavedMessagesLog(work: { title?: string | null; messages: Message[] }): string {
  const lines = [
    '── 旧版存量消息 ──',
    '说明: 以下仅补入已保存消息；缺失的执行过程无法恢复。',
    '标题: ' + redactLogText(work.title || '(无标题)'),
  ]
  for (const message of work.messages) {
    lines.push('[' + message.created_at + '] ' + message.role, ...summarizeMessage(message))
  }
  return lines.join('\n') + '\n'
}
