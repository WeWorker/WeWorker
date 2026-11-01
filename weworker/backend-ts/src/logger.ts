/**
 * Centralized logger for WeWorker backend.
 *
 * Format: {YYYY-MM-DD HH:MM:SS.mmm} [{source}] [{level}] {message}
 *
 * Usage:
 *   import { createLogger } from './logger.js'
 *   const log = createLogger('chat')
 *   log.info('starting stream')        // 2026-04-03 15:50:48.564 [chat] [INFO] starting stream
 *   log.error('connection failed', e)  // 2026-04-03 15:50:48.564 [chat] [ERROR] connection failed: ...
 */

import { getTurnExecutionContext } from './memory/turn-execution-context.js'

type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

function formatTimestamp(): string {
  const d = new Date()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const pad3 = (n: number) => String(n).padStart(3, '0')
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
}

function formatMessage(source: string, level: Level, msg: string, extra?: unknown): string {
  const turn = getTurnExecutionContext()
  const workTag = turn ? `[work:${turn.workId.slice(0, 8)}]` : ''
  const turnTag = turn ? `[turn:${turn.turnId}]` : ''
  const contextTags = turn
    ? [
        !msg.includes(workTag) && !msg.includes(turn.workId) ? workTag : '',
        !msg.includes(turnTag) ? turnTag : '',
      ].filter(Boolean).join('')
    : ''
  let line = `${formatTimestamp()} [${source}] [${level}] ${contextTags ? `${contextTags} ` : ''}${msg}`
  if (extra !== undefined) {
    if (extra instanceof Error) {
      line += `: ${extra.message}`
    } else if (typeof extra === 'string') {
      line += `: ${extra}`
    } else {
      try { line += ` ${JSON.stringify(extra)}` } catch { line += ` ${String(extra)}` }
    }
  }
  return line
}

export interface Logger {
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
  debug(msg: string, extra?: unknown): void
}

export function createLogger(source: string): Logger {
  return {
    info(msg: string, extra?: unknown) {
      console.log(formatMessage(source, 'INFO', msg, extra))
    },
    warn(msg: string, extra?: unknown) {
      console.warn(formatMessage(source, 'WARN', msg, extra))
    },
    error(msg: string, extra?: unknown) {
      console.error(formatMessage(source, 'ERROR', msg, extra))
    },
    debug(msg: string, extra?: unknown) {
      console.log(formatMessage(source, 'DEBUG', msg, extra))
    },
  }
}
