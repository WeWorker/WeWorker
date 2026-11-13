import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileChangeStore, diffFileLines, fileChangeOperation } from '../file-changes.js'
import { createFileChangeHooks } from '../file-change-hooks.js'

let directory: string
let workspace: string
let store: FileChangeStore
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-file-changes-'))
  workspace = path.join(directory, 'workspace')
  fs.mkdirSync(workspace)
  store = new FileChangeStore(path.join(directory, 'records'))
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

const binding = () => ({ workId: 'example-work', turnId: 'example-turn', cwd: workspace })
function event(type: string, id: string, tool = 'Edit', input: object = { file_path: path.join(workspace, 'example.txt') }) {
  return { hook_event_name: type, tool_use_id: id, tool_name: tool, tool_input: input, cwd: workspace, session_id: 'example-session', transcript_path: '' } as any
}
const invoke = (hook: any, input: any) => hook(input, input.tool_use_id, { signal: new AbortController().signal })

describe('file change records', () => {
  it('distinguishes creation, edits and deletion using existence, not the tool or line counts', () => {
    expect(fileChangeOperation({ before: { state: 'missing' }, after: { state: 'text', text: '' } })).toBe('create')
    expect(fileChangeOperation({ before: { state: 'text', text: '' }, after: { state: 'text', text: 'appended' } })).toBe('edit')
    expect(fileChangeOperation({ before: { state: 'binary' }, after: { state: 'binary' } })).toBe('edit')
    expect(fileChangeOperation({ before: { state: 'text', text: 'before' }, after: { state: 'missing' } })).toBe('delete')
    expect(fileChangeOperation({ before: { state: 'unavailable' }, after: { state: 'text', text: 'after' } })).toBe('unknown')
    expect(fileChangeOperation({ before: { state: 'missing' }, after: { state: 'unavailable' } })).toBe('unknown')
  })

  it('classifies old indexes from the original snapshots without changing stored history', async () => {
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => true })
    await invoke(hooks.preToolUse, event('PreToolUse', 'create', 'Write'))
    fs.writeFileSync(path.join(workspace, 'example.txt'), 'new')
    await invoke(hooks.postToolUse, event('PostToolUse', 'create', 'Write'))
    const record = store.list('example-work')[0]
    const metaPath = path.join(store.directory, 'example-work', record.id + '.meta.json')
    const legacy = { ...record, files: record.files.map(({ operation, ...file }) => file) }
    fs.writeFileSync(metaPath, JSON.stringify(legacy))
    expect(store.list('example-work')[0].files[0].operation).toBe('create')
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(JSON.stringify(legacy))
  })
  it('records real before/after content, survives restart, and isolates conversations', async () => {
    const file = path.join(workspace, 'example.txt')
    fs.writeFileSync(file, 'before\nshared\n')
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => true })
    await invoke(hooks.preToolUse, event('PreToolUse', 'edit-1'))
    fs.writeFileSync(file, 'after\nshared\n')
    const reply = await invoke(hooks.postToolUse, event('PostToolUse', 'edit-1'))
    const records = new FileChangeStore(path.join(directory, 'records')).list('example-work')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ toolCallId: 'edit-1', status: 'completed', fileCount: 1, added: 1, removed: 1 })
    const detail = store.read('example-work', records[0].id)
    expect(detail?.files[0]).toMatchObject({ path: file, before: { text: 'before\nshared\n' }, after: { text: 'after\nshared\n' } })
    expect(reply.hookSpecificOutput.additionalContext).toContain(records[0].id)
    expect(store.read('another-work', records[0].id)).toBeNull()
    fs.writeFileSync(file, 'user changed later')
    expect(store.read('example-work', records[0].id)?.files[0].after.text).toBe('after\nshared\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('user changed later')
  })

  it('records new files and partial failures but omits unchanged and read-only calls', async () => {
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => true })
    await invoke(hooks.preToolUse, event('PreToolUse', 'read', 'Read'))
    await invoke(hooks.postToolUse, event('PostToolUse', 'read', 'Read'))
    expect(store.list('example-work')).toEqual([])
    await invoke(hooks.preToolUse, event('PreToolUse', 'create', 'Write'))
    fs.writeFileSync(path.join(workspace, 'example.txt'), 'new\n')
    await invoke(hooks.postToolUse, event('PostToolUse', 'create', 'Write'))
    await invoke(hooks.preToolUse, event('PreToolUse', 'unchanged'))
    await invoke(hooks.postToolUse, event('PostToolUse', 'unchanged'))
    await invoke(hooks.preToolUse, event('PreToolUse', 'failed'))
    fs.appendFileSync(path.join(workspace, 'example.txt'), 'partial')
    await invoke(hooks.postToolUseFailure, event('PostToolUseFailure', 'failed'))
    const records = store.list('example-work')
    expect(records).toHaveLength(2)
    expect(records.some(record => record.status === 'failed')).toBe(true)
    expect(store.read('example-work', records.find(record => record.toolCallId === 'create')!.id)?.files[0].before.state).toBe('missing')
  })

  it('keeps an interrupted operation visibly incomplete without inventing an after snapshot', async () => {
    fs.writeFileSync(path.join(workspace, 'example.txt'), 'before')
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => true })
    await invoke(hooks.preToolUse, event('PreToolUse', 'interrupted'))
    fs.writeFileSync(path.join(workspace, 'example.txt'), 'interrupted write')
    const record = store.list('example-work')[0]
    expect(record.status).toBe('recording')
    expect(store.read('example-work', record.id)?.files[0].after.state).toBe('unavailable')
  })

  it('observes shell changes inside the working directory and labels uncertain attribution', async () => {
    const file = path.join(workspace, 'example.txt')
    fs.writeFileSync(file, 'before')
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => true })
    const command = { command: 'example-script' }
    await invoke(hooks.preToolUse, event('PreToolUse', 'shell', 'Bash', command))
    expect(store.list('example-work')[0]).toMatchObject({ status: 'recording', files: [], fileCount: 0 })
    fs.writeFileSync(file, 'after')
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'created')
    await invoke(hooks.postToolUse, event('PostToolUse', 'shell', 'Bash', command))
    const record = store.list('example-work')[0]
    expect(record).toMatchObject({ source: 'command', fileCount: 2 })
    expect(record.note).toContain('并发')
  })

  it('respects read access, does not traverse symlinks, and bounds binary/large snapshots', async () => {
    const file = path.join(workspace, 'example.txt')
    fs.writeFileSync(file, 'restricted')
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => false })
    await invoke(hooks.preToolUse, event('PreToolUse', 'denied'))
    await invoke(hooks.postToolUse, event('PostToolUse', 'denied'))
    expect(store.list('example-work')).toEqual([])
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]))
    expect(store.snapshot(file)).toMatchObject({ state: 'binary' })
    fs.writeFileSync(file, 'a'.repeat(600_000))
    expect(store.snapshot(file)).toMatchObject({ state: 'too_large' })
    fs.writeFileSync(file, '\n'.repeat(30_000))
    expect(store.snapshot(file)).toMatchObject({ state: 'too_large' })
    const link = path.join(directory, 'linked')
    fs.symlinkSync(workspace, link, 'junction')
    expect(store.snapshot(path.join(link, 'example.txt')).state).toBe('unavailable')
  })

  it('preserves uncomparable explicit edits without claiming they were unchanged', async () => {
    const folder = path.join(workspace, 'example-folder')
    fs.mkdirSync(folder)
    const hooks = createFileChangeHooks({ store, binding, canRead: async () => true })
    const input = { file_path: folder }
    await invoke(hooks.preToolUse, event('PreToolUse', 'unavailable', 'Edit', input))
    await invoke(hooks.postToolUseFailure, event('PostToolUseFailure', 'unavailable', 'Edit', input))
    expect(store.list('example-work')[0]).toMatchObject({ status: 'failed', fileCount: 1, files: [{ comparable: false }] })
  })

  it('resolves reused-session bindings at call time and exposes a bounded AI summary', async () => {
    let workId = 'example-work'
    const hooks = createFileChangeHooks({ store, binding: () => ({ ...binding(), workId }), canRead: async () => true })
    await invoke(hooks.preToolUse, event('PreToolUse', 'one', 'Write'))
    fs.writeFileSync(path.join(workspace, 'example.txt'), 'first')
    await invoke(hooks.postToolUse, event('PostToolUse', 'one', 'Write'))
    expect((await invoke(hooks.userPromptSubmit, {})).hookSpecificOutput.additionalContext).toContain('get_file_changes')
    workId = 'another-work'
    expect(await invoke(hooks.userPromptSubmit, {})).toEqual({})
    await invoke(hooks.preToolUse, event('PreToolUse', 'two'))
    fs.writeFileSync(path.join(workspace, 'example.txt'), 'second')
    await invoke(hooks.postToolUse, event('PostToolUse', 'two'))
    expect(store.list('example-work')).toHaveLength(1)
    expect(store.list('another-work')).toHaveLength(1)
    expect(() => store.list('../escape')).toThrow()
    expect(() => store.read('example-work', '../../escape')).toThrow()
  })
})

describe('line comparisons', () => {
  it('preserves unchanged lines, blank lines and trailing newline changes', () => {
    const result = diffFileLines('a\nold\n\nlast\n', 'a\nnew\n\nlast\n')
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.rows.filter(row => row.kind === 'same')).toHaveLength(4)
    expect(diffFileLines('a\n', 'a').removed).toBe(1)
  })
})
