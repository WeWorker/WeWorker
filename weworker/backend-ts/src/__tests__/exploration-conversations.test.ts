import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDevelopmentChatHandoff } from '../website-exploration-handoff.js'
import { excludeExplorationConversations, listExplorationConversations, prepareExplorationConversation } from '../exploration-conversations.js'
import type { WorkWithMessages } from '../works-store.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-conversations-'))
  roots.push(root)
  const file = path.join(root, 'index.json')
  const records = new Map<string, WorkWithMessages>()
  const create = vi.fn((input: unknown, options: { beforeCreate?: (id: string) => void } = {}) => createDevelopmentChatHandoff(input, {
    ...options, workspaceRoot: () => root,
    createWork: (title = '', project_id = null, workspace_directory = '', id = crypto.randomUUID()) => {
      const work: WorkWithMessages = { id, title, project_id, workspace_directory, label: null, zcf_role: null, created_at: '', updated_at: '', messages: [] }
      // Ownership exists before the work is visible, including SSE/list races.
      expect(excludeExplorationConversations([work], file)).toEqual([])
      records.set(id, work)
      return work
    },
  }))
  return { file, create, records, hasMessages: (id: string) => Boolean(records.get(id)?.messages.length), getWork: (id: string) => records.get(id) ?? null }
}
const input = (run = 'run_one', exploration = 'exp_example') => ({ schema_version: 1, site: { start_url: 'https://example.com/', allowed_domains: ['example.com'] }, source_exploration: { exploration_id: exploration, run_id: run } })
it('retries reuse the same run, survive reload and do not resubmit accepted history', () => {
  const deps = fixture()
  const first = prepareExplorationConversation(input(), deps)
  expect(prepareExplorationConversation(input(), deps).work.id).toBe(first.work.id)
  expect(deps.create).toHaveBeenCalledTimes(1)
  expect(first.needsInitialMessage).toBe(true)
  deps.records.get(first.work.id)!.messages.push({ id: 'message', work_id: first.work.id, role: 'user', content: [{ type: 'text', text: 'Example task' }], created_at: '' })
  expect(listExplorationConversations(deps)[0].needsInitialMessage).toBe(false)
  expect(prepareExplorationConversation(input(), deps).needsInitialMessage).toBe(false)
  expect(fs.readFileSync(deps.file, 'utf8')).not.toContain('example.com')
})
it('isolates every development round from main and archived lists, preserving other works', () => {
  const deps = fixture()
  const first = prepareExplorationConversation(input(), deps)
  const next = prepareExplorationConversation(input('run_two'), deps)
  const other = prepareExplorationConversation(input('run_one', 'exp_other'), deps)
  expect(new Set([first.work.id, next.work.id, other.work.id]).size).toBe(3)
  expect(listExplorationConversations(deps)).toHaveLength(3)
  expect(excludeExplorationConversations([{ id: 'main' }, first.work, next.work, other.work], deps.file)).toEqual([{ id: 'main' }])
  deps.records.delete(first.work.id)
  expect(listExplorationConversations(deps)).toHaveLength(2)
  expect(excludeExplorationConversations([first.work], deps.file)).toEqual([])
})
it('corrupt metadata fails closed instead of leaking conversations or creating duplicate work', () => {
  const deps = fixture()
  fs.writeFileSync(deps.file, '{')
  expect(() => excludeExplorationConversations([{ id: 'main' }], deps.file)).toThrow()
  expect(() => prepareExplorationConversation(input(), deps)).toThrow()
  expect(deps.create).not.toHaveBeenCalled()
})
it('failed reservation never inserts a work', () => {
  const deps = fixture()
  const beforeCreate = () => { throw new Error('Example disk failure') }
  const createWork = vi.fn()
  expect(() => createDevelopmentChatHandoff(input(), { workspaceRoot: () => path.dirname(deps.file), createWork, beforeCreate })).toThrow('Example disk failure')
  expect(createWork).not.toHaveBeenCalled()
})
