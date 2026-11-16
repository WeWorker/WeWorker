import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', () => ({
  getConfigDirectory: () => fixture.root,
  ensureUserDirectory: () => fixture.root,
  getUserDirectory: () => fixture.root,
  ensureProjectsDirectory: () => {
    const directory = path.join(fixture.root, 'projects')
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  ensureProjectDirectory: (...segments: string[]) => {
    const directory = path.join(fixture.root, 'projects', ...segments)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  },
  expandHomePath: (value: string) => value,
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
// Keep cron statics real, but never leave timers behind in the test process.
vi.mock('../scheduler.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scheduler.js')>(),
  scheduler: { register: vi.fn(), unregister: vi.fn() },
}))

import { registerDedicatedAgentRoutes } from '../dedicated-agents/routes.js'
import { getAgent } from '../dedicated-agents/agent-store.js'
import { setMasterKeyForTests } from '../secret-store.js'
import { scheduler } from '../scheduler.js'
import * as works from '../works-store.js'

let handlers: Map<string, Function>
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-agent-quick-create-'))
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
  vi.mocked(scheduler.register).mockClear()
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

const wecomInput = { name: 'Example Agent', site_id: 'example.com', bot_id: 'placeholder-bot', secret: 'placeholder-secret' }
const taskInput = {
  title: '团队 API Key 用量日报',
  cron_expression: '0 9 * * *',
  prompt_template: '按 Skill 查询团队成员的 codeplan key 用量并推送日报',
  targets: [{ id: 'direct-placeholder', chat_type: 1 }],
}

async function createWecomAgent() {
  const created = await call('post /dedicated-agents', wecomInput)
  expect(created.code).toBe(200)
  // The pairing message itself observes the owner's direct chat.
  works.saveChannelNotifyTarget(`agent:${created.data.agent.id}`, 'direct-placeholder', { chat_type: '1', user_id: 'owner-placeholder' })
  return created.data.agent.id as string
}

it('creates a scheduled task with its own context work and registers the cron', async () => {
  const agentId = await createWecomAgent()
  const result = await call('post /dedicated-agents/:id/tasks', taskInput, { id: agentId })
  expect(result.code).toBe(200)
  expect(result.data.task).toMatchObject({ title: taskInput.title, cron_expression: '0 9 * * *', agent_id: agentId, enabled: true })
  expect(result.data.task.notification_targets).toEqual([
    { id: 'direct-placeholder', chat_type: 1, observed_user_id: 'owner-placeholder', observed_at: expect.any(String) },
  ])
  expect(result.data.next_run).toBeTruthy()
  expect(scheduler.register).toHaveBeenCalledWith(result.data.task.id, '0 9 * * *')
  // Each task gets a durable conversation attached to the agent.
  const agent = getAgent(agentId)!
  const task = works.listScheduledTasksForAgent(agentId)[0]
  expect(agent.work_ids).toContain(task.context_work_id)
  expect(works.getWork(task.context_work_id!)?.title).toBe(`【定时】${taskInput.title}`)
})

it('rejects cron expressions that are not valid', async () => {
  const agentId = await createWecomAgent()
  const result = await call('post /dedicated-agents/:id/tasks', { ...taskInput, cron_expression: '99 oops' }, { id: agentId })
  expect(result.code).toBeGreaterThanOrEqual(400)
  expect(String(result.data.detail)).toContain('cron')
  expect(works.listScheduledTasksForAgent(agentId)).toHaveLength(0)
})

it('rejects targets the bot has never observed', async () => {
  const agentId = await createWecomAgent()
  const result = await call('post /dedicated-agents/:id/tasks',
    { ...taskInput, targets: [{ id: 'stranger-placeholder', chat_type: 1 }] }, { id: agentId })
  expect(result.code).toBeGreaterThanOrEqual(400)
  expect(works.listScheduledTasksForAgent(agentId)).toHaveLength(0)
})

it('requires at least one observed target for WeCom agents', async () => {
  const agentId = await createWecomAgent()
  const result = await call('post /dedicated-agents/:id/tasks', { ...taskInput, targets: [] }, { id: agentId })
  expect(result.code).toBeGreaterThanOrEqual(400)
  expect(works.listScheduledTasksForAgent(agentId)).toHaveLength(0)
})

it('allows WeChat agents to create tasks without notification targets', async () => {
  const created = await call('post /dedicated-agents', {
    name: 'WeChat Agent', site_id: 'example.com', channel: 'weixin', qr_session_id: 'fixture-session',
  })
  expect(created.code).toBe(200)
  const result = await call('post /dedicated-agents/:id/tasks', { ...taskInput, targets: [] }, { id: created.data.agent.id })
  expect(result.code).toBe(200)
  expect(result.data.task.notification_targets).toEqual([])
  expect(scheduler.register).toHaveBeenCalled()
})

it('rejects unknown agents', async () => {
  const result = await call('post /dedicated-agents/:id/tasks', taskInput, { id: 'missing-agent' })
  expect(result.code).toBe(404)
})
