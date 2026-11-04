import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { redactLogValue } from './log-redaction.js'
import { buildSavedMessagesLog } from './work-log-export.js'
import { getTurnExecutionContext, runWithTurnExecutionContext } from './memory/turn-execution-context.js'
import type { Message } from './works-store.js'

// Configured once by the backend. Libraries/tests do not write to user data.
let directory: string | undefined
const writeErrors = new Map<string, string>()

export function configureWorkLogs(logDirectory: string | undefined): void {
  directory = logDirectory
}

function logPath(workId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(workId)) throw new Error('Invalid work ID')
  if (!directory) throw new Error('Work log directory is not configured')
  return path.join(directory, workId + '.log')
}

function ensureFile(file: string, workId: string, initialContent = ''): void {
  if (fs.existsSync(file)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const header = [
    'WeWorker 对话执行日志',
    '对话 ID: ' + workId,
    '开始记录: ' + new Date().toISOString(),
    '说明: 执行时持续追加；正文、工具参数和结果不截断；凭据脱敏，图片二进制不展开。',
    '范围: 记录启用后的执行事件；旧版本未记录或已覆盖的过程无法恢复。',
    '',
  ].join('\n')
  try {
    fs.writeFileSync(file, header + initialContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

function record(type: string, data: unknown, turnId?: string): string {
  return JSON.stringify({ time: new Date().toISOString(), type, ...(turnId ? { turnId } : {}), data: redactLogValue(data) }) + '\n'
}

/** Write before returning; no UI buffer, export-time filtering or truncation. */
export function appendWorkLog(workId: string | undefined, type: string, data: unknown, turnId?: string): void {
  if (!workId || !directory) return
  let file: string | undefined
  try {
    file = logPath(workId)
    ensureFile(file, workId)
    const context = getTurnExecutionContext()
    const text = record(type, data, turnId ?? (context?.workId === workId ? context.turnId : undefined))
    const previousError = writeErrors.get(file)
    fs.appendFileSync(file, (previousError ? record('log_write_gap', { error: previousError, note: '日志写入曾失败，期间的执行记录可能缺失。' }) : '') + text, 'utf8')
    writeErrors.delete(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || 'LOG_WRITE_FAILED'
    if (file) writeErrors.set(file, code)
    // No logger dependency: a full disk must not recurse or stop the task.
    console.error('[work-log] append failed (' + code + ')')
  }
}

export function readWorkLog(work: { id: string; title?: string | null; messages: Message[] }): string {
  const file = logPath(work.id)
  if (!fs.existsSync(file)) ensureFile(file, work.id, buildSavedMessagesLog(work))
  const text = fs.readFileSync(file, 'utf8')
  const error = writeErrors.get(file)
  return text + (error ? record('log_write_gap', { error, note: '日志写入失败，记录不完整。' }) : '')
}

/** The same event stream still reaches the caller, after each event is on disk. */
export async function* recordWorkLogStream<T extends { type: string }>(
  workId: string | undefined, source: AsyncIterable<T>, input: unknown, signal?: AbortSignal,
): AsyncGenerator<T> {
  if (!workId || !directory) { yield* source; return }
  const current = getTurnExecutionContext()
  const context = current?.workId === workId ? current : { workId, turnId: randomUUID() }
  const append = (type: string, data: unknown) => appendWorkLog(workId, type, data, context.turnId)
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  let failed = false
  append('execution_start', input)
  try {
    while (true) {
      // Async generators run in their consumer's context; bind each pull so
      // channel/task diagnostics also carry the right work ID.
      const next = await runWithTurnExecutionContext(context, () => iterator.next())
      if (next.done) { completed = true; break }
      if (next.value.type === 'error') failed = true
      append(next.value.type, next.value)
      yield next.value
    }
  } catch (error) {
    failed = true
    append('execution_error', { error: error instanceof Error ? error.stack || error.message : String(error) })
    throw error
  } finally {
    try {
      if (!completed) await runWithTurnExecutionContext(context, () => iterator.return?.())
    } finally {
      append('execution_end', { status: signal?.aborted ? 'cancelled' : failed ? 'failed' : completed ? 'completed' : 'interrupted' })
    }
  }
}
