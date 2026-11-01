/**
 * Build a plain-text log export for one conversation (work).
 *
 * The export is meant to be sent to developers as-is: a short header with
 * environment facts, a compact timeline of the conversation (roles and tool
 * calls, never full model traffic), and every backend/bridge log line that is
 * tagged with this work's id (`[work:xxxxxxxx]` markers, see agent.ts /
 * webcli bridge). Raw model prompts are deliberately excluded: they are huge
 * and regularly contain private page content; log summaries are enough to
 * follow the call chain.
 */
import { redactSensitive } from './http-security.js'
import type { Message } from './works-store.js'

export interface WorkLogExportWork {
  id: string
  title?: string | null
  created_at: string
  updated_at: string
}

export interface WorkLogExportMeta {
  exportedAt: string
  runtimeMode: string
  backendInstanceId: string
  platform: string
  nodeVersion: string
  logFilePath: string
}

const TEXT_SNIPPET = 100
const TOOL_SNIPPET = 160

function snippet(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) } catch { return String(value) } })()
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** One line per content block; a message stays within a few lines. */
export function summarizeMessage(message: Message): string[] {
  const lines: string[] = []
  for (const block of message.content ?? []) {
    switch (block.type) {
      case 'text':
        lines.push(`text: ${snippet(block.text, TEXT_SNIPPET)}`)
        break
      case 'tool_use':
        lines.push(`tool_use: ${block.name}${block.status ? ` status=${block.status}` : ''}${block.execMs != null ? ` execMs=${block.execMs}` : ''} args=${snippet(block.args, TOOL_SNIPPET)}${block.result != null ? ` result=${snippet(block.result, TOOL_SNIPPET)}` : ''}`)
        break
      case 'timing':
        lines.push(`timing: totalMs=${block.totalMs} llmMs=${block.llmMs} execMs=${block.execMs} steps=${block.steps}${block.routeTool ? ` route=${block.routeTool}` : ''}`)
        break
      case 'error':
        lines.push(`error: ${snippet(block.text, TOOL_SNIPPET)}`)
        break
      case 'file_attachment':
        lines.push(`file_attachment: ${block.name}${block.size != null ? ` (${block.size}B)` : ''}`)
        break
      case 'image_url':
        lines.push('image_attachment: [image omitted]')
        break
      default:
        lines.push(`${(block as { type?: string }).type || 'block'}: [omitted]`)
    }
  }
  if (!lines.length) lines.push('(empty message)')
  return lines
}

/** Log lines tagged with this work: the `[work:xxxxxxxx]` marker or the full id. */
export function filterWorkLogLines(logLines: string[], workId: string): string[] {
  const shortId = workId.slice(0, 8)
  const marker = `work:${shortId}`
  return logLines
    .filter((line) => line.includes(marker) || line.includes(workId))
    .map((line) => redactSensitive(line))
}

export function buildWorkLogExport(input: {
  work: WorkLogExportWork
  messages: Message[]
  logLines: string[]
  meta: WorkLogExportMeta
  logNote?: string
}): string {
  const { work, messages, logLines, meta } = input
  const shortId = work.id.slice(0, 8)
  const header = [
    'WeWorker 对话日志导出',
    '======================',
    `导出时间: ${meta.exportedAt}`,
    `运行模式: ${meta.runtimeMode}（后端实例 ${meta.backendInstanceId || '-'}）`,
    `平台: ${meta.platform} / Node ${meta.nodeVersion}`,
    `日志来源: ${meta.logFilePath}`,
    input.logNote || '说明: 主日志文件在应用每次启动时重建；以下链路日志仅含标记了本对话的行。',
    '',
    `对话 ID: ${work.id}（${shortId}）`,
    `标题: ${work.title || '(无标题)'} `,
    `创建时间: ${work.created_at}`,
    `更新时间: ${work.updated_at}`,
    `消息数: ${messages.length}`,
    '',
    '注意: 导出不包含发送给模型的完整内容（体积与隐私考虑）；时间线仅含摘要。',
    '',
    '── 对话时间线 ──────────────────────────────',
  ]
  const timeline: string[] = []
  for (const message of messages) {
    timeline.push(`[${message.created_at}] ${message.role}`)
    for (const line of summarizeMessage(message)) timeline.push(`  ${line}`)
  }
  const matched = filterWorkLogLines(logLines, work.id)
  const chain = [
    '',
    `── 调用链路日志（[work:${shortId}] 标记，共 ${matched.length} 行）──────`,
    ...(matched.length ? matched : ['（空: 该对话期间没有带标记的日志——对话可能发生在旧版本，或应用重启后日志已被覆盖）']),
  ]
  return [...header, ...timeline, ...chain, ''].join('\n')
}
