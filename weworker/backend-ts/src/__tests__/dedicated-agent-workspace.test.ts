import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', () => ({
  getConfigDirectory: () => fixture.root,
  ensureUserDirectory: () => fixture.root,
  ensureProjectDirectory: (...segments: string[]) => {
    const directory = path.join(fixture.root, ...segments)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  getSettings: () => ({ channels: { wecom: {}, weixin: {} } }),
}))
vi.mock('../agent.js', () => ({ clearStoredConversationCompaction: vi.fn() }))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map([['example.com', { id: 'example.com' }]]) }))
vi.mock('../dedicated-agents/agent-channel.js', () => ({
  getAgentChannelStatus: () => ({ status: 'stopped' }),
  agentChannelKey: (id: string) => `agent:${id}`,
  startAgentChannel: vi.fn(), stopAgentChannel: vi.fn(), restartAgentChannel: vi.fn(),
}))
vi.mock('../dedicated-agents/agent-runtime.js', () => ({ removeAgentRuntime: vi.fn() }))
vi.mock('../dedicated-agents/skill-author.js', () => ({}))
vi.mock('../dedicated-agents/skill-import.js', () => ({}))
vi.mock('../dedicated-agents/skill-library.js', () => ({}))

import { registerDedicatedAgentRoutes } from '../dedicated-agents/routes.js'
import { getAgent } from '../dedicated-agents/agent-store.js'
import { setMasterKeyForTests } from '../secret-store.js'
import * as works from '../works-store.js'

let handlers: Map<string, Function>
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-agent-workspace-'))
  vi.stubEnv('WEWORKER_DEDICATED_AGENTS_FILE', path.join(fixture.root, 'agents.json'))
  setMasterKeyForTests('00112233445566778899aabbccddeeff')
  works._initTestDb()
  handlers = new Map()
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method,
    (route: string, handler: Function) => handlers.set(`${method} ${route}`, handler)]))
  registerDedicatedAgentRoutes(app as any, { weixinQrSessions: {
    peek: () => ({ botId: 'fixture-bot@im.bot', token: 'placeholder-token', baseUrl: 'https://ilinkai.weixin.qq.com' }),
    consume: vi.fn(),
  } as any })
})
afterEach(() => {
  vi.unstubAllEnvs()
  setMasterKeyForTests(null)
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

async function call(route: string, body = {}, params = {}) {
  let code = 200
  let data: any
  const response = { status(value: number) { code = value; return this }, json(value: unknown) { data = value } }
  await handlers.get(route)!({ body, params, query: {} }, response)
  return { code, data }
}
const input = { name: 'Example Agent', site_id: 'example.com', bot_id: 'placeholder-bot', secret: 'placeholder-secret' }

it.each(['wecom', 'weixin'])('creates a desktop-visible project and primary conversation for %s', async channel => {
  const result = await call('post /dedicated-agents', channel === 'wecom' ? input : {
    name: input.name, site_id: input.site_id, channel, qr_session_id: 'fixture-session',
  })
  expect(result.code).toBe(200)
  expect(result.data.agent.conversation_count).toBe(1)
  const agent = getAgent(result.data.agent.id)!
  expect(works.listProjects()).toHaveLength(1)
  expect(works.listWorks()).toMatchObject([{ id: agent.work_ids[0], title: input.name, project_id: agent.project_id }])
  expect(fs.existsSync(works.getProject(agent.project_id!)!.folder_path)).toBe(true)
  const next = await call('post /dedicated-agents/:id/conversations', {}, { id: agent.id })
  expect(next.code).toBe(200)
  expect(works.getWork(next.data.conversation.id)?.project_id).toBe(agent.project_id)
})

it('persists the access scope provided at creation and through later edits', async () => {
  const created = await call('post /dedicated-agents', { ...input, access_mode: 'wecom_authorized' })
  expect(created.code).toBe(200)
  expect(created.data.agent.access_mode).toBe('wecom_authorized')

  const updated = await call('patch /dedicated-agents/:id', { access_mode: 'owner_only' }, { id: created.data.agent.id })
  expect(updated.code).toBe(200)
  expect(updated.data.agent.access_mode).toBe('owner_only')
})

it('removes only the newly created empty workspace when bot validation fails', async () => {
  const first = await call('post /dedicated-agents', input)
  const duplicate = await call('post /dedicated-agents', input)
  expect(first.code).toBe(200)
  expect(duplicate.code).toBe(409)
  expect(works.listProjects()).toHaveLength(1)
  expect(works.listWorks()).toHaveLength(1)
})

it('keeps separate projects for agents with the same display name', async () => {
  await call('post /dedicated-agents', input)
  const second = await call('post /dedicated-agents', { ...input, bot_id: 'placeholder-other-bot' })
  expect(second.code).toBe(200)
  expect(new Set(works.listWorks().map(work => work.project_id)).size).toBe(2)
})

it('renames the generated project folder when the Agent name changes', async () => {
  const created = await call('post /dedicated-agents', input)
  expect(created.code).toBe(200)
  const agent = getAgent(created.data.agent.id)!
  expect(works.getProject(agent.project_id!)!.name).toBe('专属 Agent - Example Agent')

  const renamed = await call('patch /dedicated-agents/:id', { name: 'Example Operations' }, { id: agent.id })
  expect(renamed.code).toBe(200)
  expect(renamed.data.agent.name).toBe('Example Operations')
  // The folder follows the Agent name; no second project appears.
  expect(works.getProject(agent.project_id!)!.name).toBe('专属 Agent - Example Operations')
  expect(works.listProjects()).toHaveLength(1)
  expect(fs.existsSync(works.getProject(agent.project_id!)!.folder_path)).toBe(true)
})

it('leaves the project folder alone when a patch does not change the name', async () => {
  const created = await call('post /dedicated-agents', input)
  const agent = getAgent(created.data.agent.id)!
  expect((await call('patch /dedicated-agents/:id', { description: 'updated' }, { id: agent.id })).code).toBe(200)
  expect(works.getProject(agent.project_id!)!.name).toBe('专属 Agent - Example Agent')
})
