import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_SNAPSHOT_LINES = 20_000
export interface FileSnapshot {
  state: 'text' | 'missing' | 'binary' | 'too_large' | 'unavailable'
  text?: string
  hash?: string
  size?: number
  modifiedAt?: number
}
export interface FileChange {
  path: string
  before: FileSnapshot
  after: FileSnapshot
  added: number
  removed: number
}
export type FileChangeOperation = 'create' | 'edit' | 'delete' | 'unknown'
export interface FileChangeRecord {
  id: string
  workId: string
  turnId: string
  toolCallId: string
  tool: string
  source: 'file_tool' | 'command'
  status: 'recording' | 'completed' | 'failed' | 'unchanged'
  startedAt: string
  completedAt?: string
  note?: string
  files: FileChange[]
}
export type FileChangeSummary = Omit<FileChangeRecord, 'files'> & {
  files: Array<Pick<FileChange, 'path' | 'added' | 'removed'> & { comparable: boolean; operation: FileChangeOperation }>
  fileCount: number
  added: number
  removed: number
}
export interface DiffRow { kind: 'same' | 'add' | 'remove'; beforeLine?: number; afterLine?: number; text: string }

/** Bound worst-case work on generated/minified files; a fallback is still a valid edit script. */
export function diffFileLines(before: string, after: string) {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const rows: DiffRow[] = []
  let left = 0, right = 0, added = 0, removed = 0
  const push = (kind: DiffRow['kind']) => {
    if (kind === 'same') rows.push({ kind, beforeLine: ++left, afterLine: ++right, text: a[left - 1] })
    else if (kind === 'remove') { rows.push({ kind, beforeLine: ++left, text: a[left - 1] }); removed++ }
    else { rows.push({ kind, afterLine: ++right, text: b[right - 1] }); added++ }
  }
  while (left < prefix) push('same')
  const m = a.length - prefix - suffix, n = b.length - prefix - suffix
  if ((m + 1) * (n + 1) <= 500_000) {
    const lengths = new Uint32Array((m + 1) * (n + 1))
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
      lengths[i * (n + 1) + j] = a[prefix + i] === b[prefix + j]
        ? 1 + lengths[(i + 1) * (n + 1) + j + 1]
        : Math.max(lengths[(i + 1) * (n + 1) + j], lengths[i * (n + 1) + j + 1])
    }
    while (left < prefix + m || right < prefix + n) {
      const i = left - prefix, j = right - prefix
      if (i < m && j < n && a[left] === b[right]) push('same')
      else if (i < m && (j === n || lengths[(i + 1) * (n + 1) + j] >= lengths[i * (n + 1) + j + 1])) push('remove')
      else push('add')
    }
  } else {
    while (left < prefix + m) push('remove')
    while (right < prefix + n) push('add')
  }
  while (left < a.length) push('same')
  return { rows, added, removed }
}

const safeId = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid change record ID')
  return value
}
export function withoutSymlinks(file: string): boolean {
  let current = path.resolve(file)
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) return false }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
    const parent = path.dirname(current)
    if (parent === current) return true
    current = parent
  }
}
export function comparable(snapshot: FileSnapshot): boolean {
  return snapshot.state === 'text' || snapshot.state === 'missing'
}
export function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  if (a.state === 'unavailable' || b.state === 'unavailable') return false
  return a.state === b.state && a.hash === b.hash && a.size === b.size
    && (a.hash !== undefined || a.modifiedAt === b.modifiedAt)
}
export function fileChangeOperation(file: Pick<FileChange, 'before' | 'after'>): FileChangeOperation {
  const { before, after } = file
  if (before.state === 'unavailable' || after.state === 'unavailable') return 'unknown'
  if (before.state === 'missing') return after.state === 'missing' ? 'unknown' : 'create'
  return after.state === 'missing' ? 'delete' : 'edit'
}
export function summarizeFileChange(record: FileChangeRecord): FileChangeSummary {
  // The command's baseline is not evidence that it changed every scanned file.
  const files = record.source === 'command' && record.status === 'recording' ? [] : record.files
  return {
    ...record,
    files: files.map(file => ({ path: file.path, added: file.added, removed: file.removed, operation: fileChangeOperation(file), comparable: comparable(file.before) && comparable(file.after) })),
    fileCount: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  }
}

/** Separate local records; no message/DB migration and deliberately no restore API. */
export class FileChangeStore {
  constructor(readonly directory: string) {}

  recordId(toolCallId: string): string {
    return createHash('sha256').update(toolCallId).digest('hex').slice(0, 32)
  }

  snapshot(file: string): FileSnapshot {
    try {
      if (!withoutSymlinks(file)) return { state: 'unavailable' }
      const stat = fs.lstatSync(file)
      if (!stat.isFile()) return { state: 'unavailable' }
      const meta = { size: stat.size, modifiedAt: stat.mtimeMs }
      if (stat.size > MAX_SNAPSHOT_BYTES) return { state: 'too_large', ...meta }
      const content = fs.readFileSync(file)
      if (content.length > MAX_SNAPSHOT_BYTES) return { state: 'too_large', ...meta }
      const finalStat = fs.statSync(file)
      if (finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) return { state: 'unavailable', ...meta }
      const hash = createHash('sha256').update(content).digest('hex')
      if (content.includes(0)) return { state: 'binary', hash, ...meta }
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
        // A small byte count can still produce hundreds of thousands of diff rows.
        let lines = 1
        for (const char of text) if (char === '\n' && ++lines > MAX_SNAPSHOT_LINES) return { state: 'too_large', hash, ...meta }
        return { state: 'text', text, hash, ...meta }
      }
      catch { return { state: 'binary', hash, ...meta } }
    } catch (error) {
      return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }
    }
  }

  save(record: FileChangeRecord): void {
    const folder = path.join(this.directory, safeId(record.workId))
    const id = safeId(record.id)
    if (!withoutSymlinks(folder)) throw new Error('Change record directory is not safe')
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    for (const [suffix, data] of [['.json', record], ['.meta.json', summarizeFileChange(record)]] as const) {
      const file = path.join(folder, id + suffix)
      const temp = `${file}.${randomUUID()}.tmp`
      fs.writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      fs.renameSync(temp, file)
    }
  }

  read(workId: string, id: string): FileChangeRecord | null {
    const file = path.join(this.directory, safeId(workId), safeId(id) + '.json')
    if (!withoutSymlinks(file)) return null
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as FileChangeRecord
      return record.workId === workId && record.id === id && Array.isArray(record.files) ? record : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Cannot read change record')
    }
  }

  list(workId: string, toolCallIds?: string[]): FileChangeSummary[] {
    const folder = path.join(this.directory, safeId(workId))
    if (!withoutSymlinks(folder)) return []
    let names: string[]
    try { names = toolCallIds ? [...new Set(toolCallIds)].map(id => this.recordId(id) + '.meta.json') : fs.readdirSync(folder).filter(name => /^[a-f0-9]{32}\.meta\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const records: FileChangeSummary[] = []
    for (const name of names) {
      try {
        const file = path.join(folder, name)
        if (!withoutSymlinks(file)) continue
        let record = JSON.parse(fs.readFileSync(file, 'utf8')) as FileChangeSummary
        // Older indexes omit operation. Derive it from saved snapshots without rewriting history.
        if (record.workId === workId && record.files.some(entry => !entry.operation)) {
          const saved = this.read(workId, record.id)
          if (saved) record = summarizeFileChange(saved)
        }
        if (record.workId === workId && record.status !== 'unchanged' && (record.fileCount || record.note)) records.push(record)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read change record index') }
    }
    return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
  }
}

export const fileChanges = new FileChangeStore(path.join(os.homedir(), '.weworker', 'file-changes'))
