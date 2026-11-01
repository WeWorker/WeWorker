import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ARCHIVE_FILE = path.join(os.homedir(), '.weworker', 'archived-works.json')

function readArchivedIds(filePath = ARCHIVE_FILE): Set<string> {
  if (!fs.existsSync(filePath)) return new Set()
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown; ids?: unknown }
  if (parsed?.version !== 1 || !Array.isArray(parsed.ids) || parsed.ids.some((id) => typeof id !== 'string')) {
    throw new Error('invalid archived works index')
  }
  return new Set(parsed.ids)
}

function writeArchivedIds(ids: Set<string>, filePath = ARCHIVE_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, ids: [...ids] }, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, filePath)
}

export function isWorkArchived(workId: string, filePath = ARCHIVE_FILE): boolean {
  return readArchivedIds(filePath).has(workId)
}

export function listArchivedWorkIds(filePath = ARCHIVE_FILE): string[] {
  return [...readArchivedIds(filePath)]
}

export function setWorkArchived(workId: string, archived: boolean, filePath = ARCHIVE_FILE): void {
  const ids = readArchivedIds(filePath)
  if (archived) ids.add(workId)
  else ids.delete(workId)
  writeArchivedIds(ids, filePath)
}

export function removeArchivedWork(workId: string, filePath = ARCHIVE_FILE): void {
  const ids = readArchivedIds(filePath)
  if (!ids.delete(workId)) return
  writeArchivedIds(ids, filePath)
}
