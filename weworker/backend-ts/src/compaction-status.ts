/**
 * 压缩心跳：只记录「还在不在产出」，用于区分「压缩中」和「卡住」。
 * 进程内的轻量状态，不落盘；压缩结束即删除。
 */
export interface CompactionHeartbeat {
  started_at: number
  last_activity_at: number
  chunks: number
  total_ms: number
}

const active = new Map<string, CompactionHeartbeat>()

export function markCompactionStarted(workId: string | undefined, totalMs: number): void {
  if (!workId) return
  const now = Date.now()
  active.set(workId, { started_at: now, last_activity_at: now, chunks: 0, total_ms: totalMs })
}

export function markCompactionProgress(workId: string | undefined): void {
  if (!workId) return
  const entry = active.get(workId)
  if (!entry) return
  entry.last_activity_at = Date.now()
  entry.chunks += 1
}

export function markCompactionFinished(workId: string | undefined): void {
  if (!workId) return
  active.delete(workId)
}

export interface CompactionStatus {
  status: 'running' | 'idle'
  started_at?: number
  last_activity_at?: number
  chunks?: number
  idle_ms?: number
  elapsed_ms?: number
  total_ms?: number
}

export function getCompactionStatus(workId: string): CompactionStatus {
  const entry = active.get(workId)
  if (!entry) return { status: 'idle' }
  const now = Date.now()
  return {
    status: 'running',
    started_at: entry.started_at,
    last_activity_at: entry.last_activity_at,
    chunks: entry.chunks,
    idle_ms: now - entry.last_activity_at,
    elapsed_ms: now - entry.started_at,
    total_ms: entry.total_ms,
  }
}
