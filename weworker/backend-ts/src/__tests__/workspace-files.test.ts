import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-projects-root-'))

vi.mock('../config.js', () => ({
  ensureUserDirectory: () => projectsRoot,
  expandHomePath: (input: string) => input,
  getUserDirectory: () => projectsRoot,
  getConfigDirectory: () => projectsRoot,
  getMaxChatAttachments: () => 60,
  getUserDirectoryBlacklist: () => [],
}))

const store = await import('../works-store.js')
const { createUserFile, listUserFiles } = await import('../user-files.js')

describe('workspace directories', () => {
  afterEach(() => {
    store._initTestDb()
    for (const entry of fs.readdirSync(projectsRoot)) {
      fs.rmSync(path.join(projectsRoot, entry), { recursive: true, force: true })
    }
  })

  it('binds a user project and its conversations to the selected folder', () => {
    store._initTestDb()
    const selected = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-selected-project-'))
    const project = store.createProject('Bound project', selected)
    const work = store.createWork('Conversation', project.id)

    expect(store.getWorkspaceDirectoryForWork(work.id)).toBe(selected)

    fs.rmSync(selected, { recursive: true, force: true })
  })

  it('creates the shared scheduled-task folder only when a task is created', () => {
    store._initTestDb()
    expect(fs.existsSync(path.join(projectsRoot, 'scheduled-tasks'))).toBe(false)

    store.createScheduledTask({
      title: 'Daily report',
      cron_expression: '0 9 * * *',
      prompt_template: 'Create a report',
      enabled: false,
      notify_channels: [],
    })

    expect(fs.existsSync(path.join(projectsRoot, 'scheduled-tasks'))).toBe(true)
  })

  it('confines file operations to the active workspace root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-workspace-'))
    const created = createUserFile(undefined, 'notes.txt', root)
    const listing = listUserFiles(root)
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)

    expect(created.file.path).toBe(path.join(root, 'notes.txt'))
    expect(listing.files.map((file) => file.name)).toContain('notes.txt')
    expect(() => createUserFile(outside, 'notes.txt', root)).toThrow('inside workspace directory')
    expect(fs.existsSync(outside)).toBe(false)

    fs.rmSync(root, { recursive: true, force: true })
  })
})
