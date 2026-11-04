import { afterEach, expect, it, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDevelopmentChatHandoff } from '../website-exploration-handoff.js'
import { createWebsiteExplorationAdapterRouter } from '../website-exploration-adapters.js'
import { importChatAttachments } from '../user-files.js'
import type { Work } from '../works-store.js'

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const input = { schema_version: 1, site: { start_url: 'https://example.com/', allowed_domains: ['example.com'] }, source_exploration: { exploration_id: 'exp_example' }, instruction: 'Read title' }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'development-handoff-'))
  roots.push(root)
  const createWork = vi.fn((title = '', projectId: string | null = null, workspaceDirectory?: string) => ({
    id: 'work-' + Math.random(), title, project_id: projectId, workspace_directory: workspaceDirectory,
    label: null, zcf_role: null, created_at: '', updated_at: '',
  } as Work))
  return { workspaceRoot: () => root, createWork }
}
it('creates a readable input attachment in the new work workspace without overwriting files', () => {
  const deps = fixture()
  const first = createDevelopmentChatHandoff(input, deps)
  const second = createDevelopmentChatHandoff(input, deps)
  expect(first.attachment.path).not.toBe(second.attachment.path)
  expect(path.dirname(first.attachment.path)).toBe(first.work.workspace_directory)
  expect(JSON.parse(fs.readFileSync(first.attachment.path, 'utf8'))).toEqual(input)
  const blocks = importChatAttachments([first.attachment], first.work.workspace_directory)
  expect(blocks[0]).toMatchObject({ type: 'file_attachment', path: first.attachment.path, name: 'input.json' })
  expect(first.prompt).toBe('请读取附件 input.json，运行 `webcli skills read adapter-development`，并按照该 Skill 开发和调试 Adapter。')
  expect(deps.createWork).toHaveBeenCalledTimes(2)
})
it('invalid input or failed file write does not create a work', () => {
  const deps = fixture()
  expect(() => createDevelopmentChatHandoff({}, deps)).toThrow()
  expect(() => createDevelopmentChatHandoff(input, { ...deps, workspaceRoot: () => path.join(deps.workspaceRoot(), 'missing') })).toThrow()
  expect(deps.createWork).not.toHaveBeenCalled()
})
async function harness(fetchAgent: typeof fetch, callback: (value: unknown) => unknown) {
  const app = express()
  app.use(express.json())
  app.use(createWebsiteExplorationAdapterRouter({ instanceId: 'instance-placeholder', fetchAgent, onDevelopmentHandoff: callback }))
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
  servers.push(server)
  return (body: object = {}) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/explorations/exp_example/development/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}
it('verifies service identity, forwards context with identity header and returns prepared chat', async () => {
  const callback = vi.fn(value => createDevelopmentChatHandoff(value, fixture()))
  const fetchAgent = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/api/health')) return Response.json({ ok: true, instance_id: 'instance-placeholder' })
    expect(url).toBe('http://127.0.0.1:8766/api/explorations/exp_example/development/input')
    expect(options.redirect).toBe('error')
    expect(options.headers).toMatchObject({ 'X-WeWorker-Exploration-Instance': 'instance-placeholder' })
    expect(JSON.parse(options.body as string)).toEqual({ instruction: 'Read title' })
    return Response.json(input)
  }) as unknown as typeof fetch
  const request = await harness(fetchAgent, callback)
  const response = await request({ instruction: 'Read title' })
  expect(response.status).toBe(200)
  expect((await response.json()).attachment.name).toBe('input.json')
  expect(callback).toHaveBeenCalledExactlyOnceWith(input)
})
it.each(['foreign-instance', 'wrong-exploration', 'input-error'])('rejects %s before creating a chat', async failure => {
  const callback = vi.fn()
  const fetchAgent = vi.fn(async (url: string) => url.endsWith('/api/health')
    ? Response.json({ ok: true, instance_id: failure === 'foreign-instance' ? 'other' : 'instance-placeholder' })
    : failure === 'input-error' ? Response.json({ detail: 'No source' }, { status: 400 })
      : Response.json({ ...input, source_exploration: { exploration_id: 'other' } })) as unknown as typeof fetch
  const request = await harness(fetchAgent, callback)
  expect((await request()).status).toBe(409)
  expect(callback).not.toHaveBeenCalled()
})
