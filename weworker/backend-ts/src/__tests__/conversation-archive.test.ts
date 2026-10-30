import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isWorkArchived, listArchivedWorkIds, removeArchivedWork, setWorkArchived } from '../conversation-archive.js'

const tempDirectories: string[] = []

function archiveFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-archive-test-'))
  tempDirectories.push(directory)
  return path.join(directory, 'archived-works.json')
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('conversation archive index', () => {
  it('persists archive and restore changes without changing conversation data', () => {
    const filePath = archiveFile()
    expect(listArchivedWorkIds(filePath)).toEqual([])

    setWorkArchived('fixture-work-1', true, filePath)
    setWorkArchived('fixture-work-2', true, filePath)
    expect(isWorkArchived('fixture-work-1', filePath)).toBe(true)
    expect(listArchivedWorkIds(filePath)).toEqual(['fixture-work-1', 'fixture-work-2'])

    setWorkArchived('fixture-work-1', false, filePath)
    expect(isWorkArchived('fixture-work-1', filePath)).toBe(false)
    expect(listArchivedWorkIds(filePath)).toEqual(['fixture-work-2'])
  })

  it('removes deleted conversations and rejects malformed index data', () => {
    const filePath = archiveFile()
    setWorkArchived('fixture-work-1', true, filePath)
    removeArchivedWork('fixture-work-1', filePath)
    expect(listArchivedWorkIds(filePath)).toEqual([])

    fs.writeFileSync(filePath, '{invalid json', 'utf8')
    expect(() => listArchivedWorkIds(filePath)).toThrow()
  })
})
