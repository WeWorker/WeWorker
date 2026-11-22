import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', () => ({
  getConfigDirectory: () => fixture.root,
  ensureUserDirectory: () => fixture.root,
  getUserDirectory: () => fixture.root,
  ensureProjectsDirectory: () => fixture.root,
  ensureProjectDirectory: () => fixture.root,
  expandHomePath: (value: string) => value,
  getSettings: () => ({ channels: { wecom: {}, weixin: {} } }),
}))
vi.mock('../agent.js', () => ({ clearStoredConversationCompaction: vi.fn() }))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))
vi.mock('../dedicated-agents/agent-channel.js', () => ({
  getAgentChannelStatus: () => ({ status: 'stopped' }),
  agentChannelKey: (id: string) => `agent:${id}`,
  startAgentChannel: vi.fn(), stopAgentChannel: vi.fn(), restartAgentChannel: vi.fn(),
}))
vi.mock('../dedicated-agents/agent-runtime.js', () => ({ removeAgentRuntime: vi.fn() }))
vi.mock('../dedicated-agents/skill-author.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dedicated-agents/skill-author.js')>(),
  generateAgentSkill: vi.fn(),
  reviseAgentSkill: vi.fn(),
}))
vi.mock('../scheduler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scheduler.js')>(),
  scheduler: { register: vi.fn(), unregister: vi.fn() },
}))

import { registerDedicatedAgentRoutes } from '../dedicated-agents/routes.js'
import { readAgentSkill } from '../dedicated-agents/skill-library.js'

let handlers: Map<string, Function>
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-skill-chunked-'))
  handlers = new Map()
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method,
    (route: string, handler: Function) => handlers.set(`${method} ${route}`, handler)]))
  registerDedicatedAgentRoutes(app as any, {} as any)
})
afterEach(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

async function call(route: string, body = {}, params = {}) {
  let code = 200
  let data: any
  const response = { status(value: number) { code = value; return this }, json(value: unknown) { data = value } }
  await handlers.get(route)!({ body, params, query: {} }, response)
  return { code, data }
}

const MARKDOWN = ['---\nname: chunked-skill\ndescription: fixture\n---\n\n', 'x'.repeat(900), 'y'.repeat(300)].join('')

async function uploadInChunks(name: string, markdown: string, chunkSize = 1024) {
  const chunks: string[] = []
  for (let offset = 0; offset < markdown.length; offset += chunkSize) chunks.push(markdown.slice(offset, offset + chunkSize))
  const started = await call('post /dedicated-agents/skills/chunked/start', { skill_name: name, scope: 'private', total_chunks: chunks.length })
  expect(started.code).toBe(200)
  for (let index = 0; index < chunks.length; index += 1) {
    const stored = await call('put /dedicated-agents/skills/chunked/:id/:index', { data: chunks[index] }, { id: started.data.upload_id, index: String(index) })
    expect(stored.code).toBe(200)
  }
  return call('post /dedicated-agents/skills/chunked/:id/complete', {}, { id: started.data.upload_id })
}

it('assembles chunked uploads into the same skill as a plain create', async () => {
  const result = await uploadInChunks('chunked-skill', MARKDOWN)
  expect(result.code).toBe(200)
  expect(result.data.name).toBe('chunked-skill')
  expect(result.data.scope).toBe('private')
  // 内容按顺序拼回，且走了与整包创建相同的 frontmatter 归一化。
  expect(result.data.markdown).toBe(await import('../dedicated-agents/skill-author.js').then(m => m.normalizeSkillMarkdown(MARKDOWN, 'chunked-skill')))
  // 落盘后可按普通方式读取。
  const read = readAgentSkill('chunked-skill', {})
  expect(read.markdown).toBe(result.data.markdown)
})

it('surfaces the same 409 conflict message so renderer suffix-retry keeps working', async () => {
  const first = await uploadInChunks('chunked-skill', MARKDOWN)
  expect(first.code).toBe(200)
  const second = await uploadInChunks('chunked-skill', MARKDOWN + '\n不同内容')
  expect(second.code).toBe(409)
  expect(String(second.data.detail)).toMatch(/已存在/)
})

it('rejects completion when chunks are missing', async () => {
  const started = await call('post /dedicated-agents/skills/chunked/start', { skill_name: 'incomplete', total_chunks: 2 })
  await call('put /dedicated-agents/skills/chunked/:id/:index', { data: 'a' }, { id: started.data.upload_id, index: '0' })
  const result = await call('post /dedicated-agents/skills/chunked/:id/complete', {}, { id: started.data.upload_id })
  expect(result.code).toBe(400)
  expect(String(result.data.detail)).toMatch(/分块未收齐/)
})

it('rejects oversized chunks (server cap 4KB regardless of client chunk size)', async () => {
  const started = await call('post /dedicated-agents/skills/chunked/start', { skill_name: 'oversize', total_chunks: 1 })
  const result = await call('put /dedicated-agents/skills/chunked/:id/:index', { data: 'x'.repeat(4097) }, { id: started.data.upload_id, index: '0' })
  expect(result.code).toBe(400)
  expect(String(result.data.detail)).toMatch(/分块过大/)
})

it('rejects unknown or expired upload sessions with 410', async () => {
  const result = await call('post /dedicated-agents/skills/chunked/:id/complete', {}, { id: 'not-exist' })
  expect(result.code).toBe(410)
  expect(String(result.data.detail)).toMatch(/不存在或已过期/)
})
