/**
 * Field-compact view of a work execution log, generated at download time.
 *
 * NO semantic rewriting: event types, field names and values stay exactly as
 * written — only redundancy is removed (the envelope already carries
 * time/type/turnId, so repeated copies inside `data` and the timestamped
 * prefix inside diagnostic messages are stripped) and long values are
 * truncated. If the log schema changes, this view changes with it instead of
 * silently mis-translating.
 *
 * Line shape: `HH:MM:SS | <type> | key=value key=value …`
 * `webcli.ext_log` additionally lists its raw log lines indented below.
 */

interface RawEvent {
  time?: unknown
  type?: unknown
  turnId?: unknown
  data?: unknown
}

const VALUE_CLIP = 160
const LINE_CLIP = 600

function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Drop the `date time [source] [LEVEL] [work:…] [turn:…]` prefix: the envelope repeats it. */
function stripDiagnosticPrefix(message: string): string {
  return message
    .replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[[^\]]+\] \[\w+\] /, '')
    // Bracket tags may be glued together (`[work:x][turn:y]`) or spaced; both repeat envelope data.
    .replace(/^\s*(\[[^\]]+\]\s*)+/, '')
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

function flatFields(data: Record<string, unknown>, envelopeType: string): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue
    // The inner `type` echoes the envelope type on SSE-shaped events.
    if (key === 'type' && str(value) === envelopeType) continue
    parts.push(`${key}=${clip(renderValue(value), VALUE_CLIP)}`)
  }
  return clip(parts.join(' '), LINE_CLIP)
}

/** Transform the raw JSONL execution log into the field-compact view. */
export function digestWorkLog(raw: string, workId = ''): string {
  const header = [
    'WeWorker 对话执行日志 · 精简版（下载时由完整日志生成，无语义改写，仅去冗余字段与截断长文本）',
    ...(workId ? [`对话 ID: ${workId}`] : []),
    `生成时间: ${new Date().toLocaleString()} · 时间为本地时区，仅时分秒`,
    '说明: 每行=时间 | 事件类型 | 原始字段；完整内容请下载完整版。',
    '',
  ]
  const lines: string[] = []
  let turn = 0
  const seenTurns = new Set<string>()
  // Extension buffers accumulate per traceId (login retries reuse it), so a
  // later pull repeats earlier pulls: show only lines new since the last pull.
  const shownExtLines = new Map<string, Set<string>>()
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let parsed: RawEvent
    try { parsed = JSON.parse(line) as RawEvent } catch { continue }
    const type = str(parsed.type)
    const turnId = str(parsed.turnId)
    const data = record(parsed.data)
    const time = clock(str(parsed.time))
    // Turn sections follow turnId changes (routing/user events precede execution_start).
    if (turnId && !seenTurns.has(turnId)) {
      seenTurns.add(turnId)
      turn += 1
      lines.push('', `── 第 ${turn} 轮 · ${turnId.slice(0, 8)} ──`)
    }
    if (type === 'diagnostic') {
      lines.push(`${time} | diagnostic | source=${str(data.source)} level=${str(data.level)} message=${clip(stripDiagnosticPrefix(str(data.message)), 200)}`)
      continue
    }
    if (type === 'webcli.ext_log') {
      const traceId = str(data.traceId)
      const logs = Array.isArray(data.logs) ? data.logs.filter((l): l is string => typeof l === 'string') : []
      const seen = shownExtLines.get(traceId) ?? new Set<string>()
      const fresh = logs.filter(l => !seen.has(l))
      for (const l of logs) seen.add(l)
      shownExtLines.set(traceId, seen)
      const shown = fresh.slice(0, 40)
      const rest = fresh.length - shown.length
      lines.push(`${time} | webcli.ext_log | traceId=${traceId} trigger=${str(data.trigger)} count=${logs.length}${fresh.length === 0 ? '（与上次拉取无新增）' : rest > 0 ? ` 新增${fresh.length}行（仅显示前 ${shown.length} 行）` : ` 新增${fresh.length}行`}`)
      for (const log of shown) lines.push(`    ${clip(log, 240)}`)
      continue
    }
    // Tool results are multi-line documents (CLI notices + result JSON); the
    // actual payload sits past the notice lines, so render it as an indented
    // block instead of one truncated inline value.
    if (type === 'tool_call_result' && typeof data.result === 'string' && (data.result.includes('\n') || data.result.length > VALUE_CLIP)) {
      const rest = { ...data, result: undefined }
      const block = data.result.split('\n').filter(l => l.trim())
      const shown = block.slice(0, 12)
      const skipped = block.length - shown.length
      lines.push(`${time} | tool_call_result | ${flatFields(rest, type)}`.replace(/\s+$/, ''))
      for (const l of shown) lines.push(`    ${clip(l, 240)}`)
      if (skipped > 0) lines.push(`    …（省略 ${skipped} 行，共 ${data.result.length.toLocaleString()} 字符）`)
      continue
    }
    const fields = flatFields(data, type)
    lines.push(`${time} | ${type}${fields ? ` | ${fields}` : ''}`)
  }
  return header.join('\n') + lines.join('\n').replace(/^\n+/, '\n') + '\n'
}
