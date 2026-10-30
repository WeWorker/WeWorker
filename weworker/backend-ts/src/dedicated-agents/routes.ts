/**
 * HTTP API for dedicated agents (专属 Agent).
 * All routes sit behind the backend's existing local auth middleware.
 */
import type express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureProjectDirectory, getSettings } from '../config.js'
import { clearStoredConversationCompaction } from '../agent.js'
import { disposeChatSession } from '../chat-session.js'
import { parseAllAdapters, type ParsedAdapter } from '../adapter-parser.js'
import * as works from '../works-store.js'
import { createLogger } from '../logger.js'
import {
  agentChannel,
  addAgentWork,
  createAgent,
  deleteAgent,
  DedicatedAgentError,
  getAgent,
  listAgents,
  normalizeSkillName,
  removeAgentWork,
  resetPairing,
  toAgentView,
  updateAgent,
  type AgentBotInput,
  type DedicatedAgentRecord,
  type ReservedBots,
} from './agent-store.js'
import { getAgentChannelStatus, restartAgentChannel, startAgentChannel, stopAgentChannel, agentChannelKey } from './agent-channel.js'
import { scheduler, Scheduler } from '../scheduler.js'
import { removeAgentRuntime } from './agent-runtime.js'
import { createWecomQrSessions } from './wecom-qr.js'
import { createWeixinQrSessions } from './weixin-qr.js'
import {
  generateAgentSkill,
  reviseAgentSkill,
  suggestSkillName,
  normalizeSkillMarkdown,
  type SkillAuthorAdapter,
} from './skill-author.js'
import { importSkillFromPath } from './skill-import.js'
import {
  createAgentSkill,
  createAgentSkillPackage,
  listAgentSkills,
  listTakenSkillNames,
  locateSkill,
  moveAgentSkill,
  readAgentSkill,
  updateAgentSkill,
  type SkillLocations,
  type SkillScope,
} from './skill-library.js'

const log = createLogger('dedicated-agent-api')

export interface DedicatedAgentRouteDeps {
  qrSessions?: ReturnType<typeof createWecomQrSessions>
  weixinQrSessions?: ReturnType<typeof createWeixinQrSessions>
  skillLocations?: () => SkillLocations
}

function sendError(res: express.Response, error: unknown): void {
  if (error instanceof DedicatedAgentError) {
    res.status(error.statusCode).json({ detail: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  log.error('request failed:', message)
  res.status(500).json({ detail: message })
}

/** Bots saved for the main channels (active or not) cannot also serve an agent. */
function reservedBots(): ReservedBots {
  const settings = getSettings()
  const botIds = new Set<string>()
  const tokens = new Set<string>()
  const wecomActive = settings.channels.wecom.bot_id?.trim()
  if (wecomActive) botIds.add(wecomActive)
  const weixinActive = settings.channels.weixin.token?.trim()
  if (weixinActive) tokens.add(weixinActive)
  for (const entry of Object.values(settings.channel_configurations ?? {})) {
    const config = entry.config as { bot_id?: string; token?: string }
    if (entry.type === 'wecom' && String(config.bot_id ?? '').trim()) botIds.add(String(config.bot_id).trim())
    if (entry.type === 'weixin' && String(config.token ?? '').trim()) tokens.add(String(config.token).trim())
  }
  return { reservedBotIds: [...botIds], reservedWeixinTokens: [...tokens] }
}

function viewWithStatus(agent: DedicatedAgentRecord) {
  return { ...toAgentView(agent), connection: getAgentChannelStatus(agent.id) }
}

function toAuthorAdapter(adapter: ParsedAdapter): SkillAuthorAdapter {
  return {
    id: adapter.id,
    name: adapter.name,
    description: adapter.description,
    requiresAuth: adapter.requiresAuth,
    authCheckTool: adapter.authCheckTool,
    tools: adapter.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      safety: tool.safety,
      requiresConfirmation: tool.requiresConfirmation,
    })),
  }
}

function requireAdapter(siteId: unknown): ParsedAdapter {
  const adapter = parseAllAdapters().get(String(siteId ?? ''))
  if (!adapter) throw new DedicatedAgentError('所选网站不存在或尚未安装')
  return adapter
}

function parseScope(value: unknown, fallback: SkillScope): SkillScope {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'private' || value === 'public') return value
  throw new DedicatedAgentError('scope 只能是 private 或 public')
}

function conversationView(work: works.Work) {
  return { id: work.id, title: work.title, updated_at: work.updated_at, created_at: work.created_at }
}

function workspaceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already exists|UNIQUE constraint/i.test(message)
}

/**
 * Folder name generated for a dedicated Agent. The project folder belongs to
 * the Agent: it is created from the Agent name and can only change through it.
 */
export function agentProjectName(agentName: string): string {
  return `专属 Agent - ${String(agentName || '未命名 Agent').trim()}`
}

/** `base`, then `base (2)`, `base (3)` … so two Agents never share one folder. */
function agentProjectNameCandidate(base: string, index: number): string {
  return index === 0 ? base : `${base} (${index + 1})`
}

function createAgentWorkspace(agentName: string): { project: works.ProjectSummary; work: works.Work } {
  const base = agentProjectName(agentName)
  for (let index = 0; index < 100; index += 1) {
    const projectName = agentProjectNameCandidate(base, index)
    let project: works.ProjectSummary | null = null
    try {
      const agentRoot = ensureProjectDirectory('agents')
      const agentDirectory = path.join(agentRoot, randomUUID())
      fs.mkdirSync(agentDirectory)
      try {
        project = works.createProject(projectName, agentDirectory)
      } catch (error) {
        fs.rmdirSync(agentDirectory)
        throw error
      }
    } catch (error) {
      if (workspaceConflict(error)) continue
      throw error
    }
    try {
      const work = works.createWork(String(agentName || '').trim(), project.id)
      return { project, work }
    } catch (error) {
      try { works.deleteProject(project.id) } catch { /* preserve original error */ }
      throw error
    }
  }
  throw new DedicatedAgentError('无法创建专属 Agent 工作区，请先清理同名项目')
}

function agentProjectId(agent: DedicatedAgentRecord): string | null {
  if (agent.project_id && works.getProject(agent.project_id)) return agent.project_id
  for (const workId of agent.work_ids) {
    const projectId = works.getWork(workId)?.project_id
    if (projectId && works.getProject(projectId)) return projectId
  }
  return null
}

/**
 * Keep the generated project folder name in sync with the Agent name. Folder
 * renames stay best-effort so a name collision cannot fail the Agent rename.
 */
function syncAgentProjectName(agent: DedicatedAgentRecord): void {
  const projectId = agentProjectId(agent)
  if (!projectId) return
  const base = agentProjectName(agent.name)
  for (let index = 0; index < 100; index += 1) {
    try {
      works.renameProject(projectId, agentProjectNameCandidate(base, index))
      return
    } catch (error) {
      if (workspaceConflict(error)) continue
      return
    }
  }
}

export function registerDedicatedAgentRoutes(app: express.Express, deps: DedicatedAgentRouteDeps = {}): void {
  const qrSessions = deps.qrSessions ?? createWecomQrSessions()
  const weixinQrSessions = deps.weixinQrSessions ?? createWeixinQrSessions()
  const locations = deps.skillLocations ?? (() => ({}))

  const assertSkillExists = (name: string) => {
    if (name && !locateSkill(name, locations())) throw new DedicatedAgentError(`Skill「${name}」不存在或已停用`)
  }
  /**
   * Bot credentials from a scan session (企业微信 / 微信) or, for WeCom, manual
   * BotID + Secret. Scanned secrets never pass through the renderer.
   */
  const resolveBot = (body: Record<string, unknown>): { bot: AgentBotInput; consume: () => void } | null => {
    const sessionId = typeof body.qr_session_id === 'string' ? body.qr_session_id : ''
    if (body.channel === 'weixin') {
      if (!sessionId) throw new DedicatedAgentError('请先用微信扫码绑定机器人')
      const creds = weixinQrSessions.peek(sessionId)
      if (!creds) throw new DedicatedAgentError('扫码结果已失效，请重新扫码', 410)
      return {
        bot: { channel: 'weixin', bot_id: creds.botId, token: creds.token, base_url: creds.baseUrl },
        consume: () => { weixinQrSessions.consume(sessionId) },
      }
    }
    if (body.channel !== undefined && body.channel !== 'wecom') throw new DedicatedAgentError('不支持的机器人类型')
    if (sessionId) {
      const creds = qrSessions.peek(sessionId)
      if (!creds) throw new DedicatedAgentError('扫码结果已失效，请重新扫码', 410)
      return {
        bot: { channel: 'wecom', bot_id: creds.botId, secret: creds.secret },
        consume: () => { qrSessions.consume(sessionId) },
      }
    }
    if (body.bot_id !== undefined || body.secret !== undefined) {
      return { bot: { channel: 'wecom', bot_id: String(body.bot_id ?? ''), secret: String(body.secret ?? '') }, consume: () => {} }
    }
    return null
  }
  const requireAgent = (id: string) => {
    const agent = getAgent(id)
    if (!agent) throw new DedicatedAgentError('专属 Agent 不存在', 404)
    return agent
  }

  // ── WeCom QR: create or authorize a bot by scanning ──
  app.post('/dedicated-agents/wecom-qr/start', async (_req, res) => {
    try {
      res.json(await qrSessions.start())
    } catch (error) {
      res.status(502).json({ detail: error instanceof Error ? error.message : '获取企业微信二维码失败' })
    }
  })

  app.post('/dedicated-agents/wecom-qr/poll', async (req, res) => {
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : ''
    if (!sessionId) {
      res.status(400).json({ detail: 'session_id required' })
      return
    }
    try {
      res.json(await qrSessions.poll(sessionId))
    } catch (error) {
      // Transient network errors: let the client keep polling.
      res.json({ status: 'waiting', warning: error instanceof Error ? error.message : String(error) })
    }
  })

  // ── WeChat QR: log in an iLink bot by scanning ──
  app.post('/dedicated-agents/weixin-qr/start', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.json(await weixinQrSessions.start())
    } catch (error) {
      res.status(502).json({ detail: error instanceof Error ? error.message : '获取微信二维码失败' })
    }
  })

  app.post('/dedicated-agents/weixin-qr/poll', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : ''
    if (!sessionId) {
      res.status(400).json({ detail: 'session_id required' })
      return
    }
    try {
      res.json(await weixinQrSessions.poll(sessionId))
    } catch (error) {
      // Transient network errors: let the client keep polling.
      res.json({ status: 'waiting', warning: error instanceof Error ? error.message : String(error) })
    }
  })

  // ── Skills: private (agents only) by default; public = also used by the main chat ──
  app.get('/dedicated-agents/skills', (_req, res) => {
    const agents = listAgents()
    const skills = listAgentSkills(locations()).map((skill) => ({
      ...skill,
      used_by: agents.filter((agent) => agent.skill_name === skill.name).map((agent) => ({ id: agent.id, name: agent.name })),
    }))
    res.json({ skills })
  })

  app.get('/dedicated-agents/skills/:name', (req, res) => {
    try {
      res.json(readAgentSkill(req.params.name, locations()))
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/dedicated-agents/skills/suggest-name', (req, res) => {
    try {
      const adapter = requireAdapter(req.body?.site_id)
      res.json({ skill_name: suggestSkillName(adapter.id, listTakenSkillNames(locations())) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/dedicated-agents/skills/generate', async (req, res) => {
    try {
      const adapter = requireAdapter(req.body?.site_id)
      const skillName = normalizeSkillName(req.body?.skill_name) || suggestSkillName(adapter.id, listTakenSkillNames(locations()))
      const result = await generateAgentSkill({
        adapter: toAuthorAdapter(adapter),
        agentName: String(req.body?.agent_name ?? ''),
        goal: String(req.body?.goal ?? ''),
        knowledge: String(req.body?.knowledge ?? ''),
        skillName,
      }, getSettings())
      res.json(result)
    } catch (error) {
      sendError(res, error instanceof DedicatedAgentError ? error : new DedicatedAgentError(error instanceof Error ? error.message : String(error), 502))
    }
  })

  app.post('/dedicated-agents/skills/revise', async (req, res) => {
    try {
      const adapter = requireAdapter(req.body?.site_id)
      const skillName = normalizeSkillName(req.body?.skill_name)
      if (!skillName) throw new DedicatedAgentError('请填写 Skill 名称')
      const result = await reviseAgentSkill({
        adapter: toAuthorAdapter(adapter),
        markdown: String(req.body?.markdown ?? ''),
        instruction: String(req.body?.instruction ?? ''),
        skillName,
      }, getSettings())
      res.json(result)
    } catch (error) {
      sendError(res, error instanceof DedicatedAgentError ? error : new DedicatedAgentError(error instanceof Error ? error.message : String(error), 502))
    }
  })

  app.post('/dedicated-agents/skills/import', async (req, res) => {
    try {
      const imported = await importSkillFromPath(req.body?.source_path, String(req.body?.skill_name ?? ''))
      const created = createAgentSkillPackage(
        imported.skillName,
        imported.markdown,
        imported.files,
        parseScope(req.body?.scope, 'private'),
        locations(),
      )
      res.json({ ...created, markdown: imported.markdown, source: imported.source, resource_count: imported.files.size })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/dedicated-agents/skills', (req, res) => {
    try {
      const name = normalizeSkillName(req.body?.skill_name)
      if (!name) throw new DedicatedAgentError('请填写 Skill 名称')
      const markdown = normalizeSkillMarkdown(String(req.body?.markdown ?? ''), name)
      const created = createAgentSkill(name, markdown, parseScope(req.body?.scope, 'private'), locations())
      res.json({ ...created, markdown })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.put('/dedicated-agents/skills/:name', (req, res) => {
    try {
      const name = normalizeSkillName(req.params.name)
      const markdown = normalizeSkillMarkdown(String(req.body?.markdown ?? ''), name)
      const updated = updateAgentSkill(name, markdown, locations())
      res.json({ ...updated, markdown })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/dedicated-agents/skills/:name/scope', (req, res) => {
    try {
      res.json(moveAgentSkill(req.params.name, parseScope(req.body?.scope, 'private'), locations()))
    } catch (error) {
      sendError(res, error)
    }
  })

  // ── Agents ──
  app.get('/dedicated-agents', (_req, res) => {
    res.json({ agents: listAgents().map(viewWithStatus) })
  })

  app.get('/dedicated-agents/:id', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      const conversations = agent.work_ids
        .map((id) => works.getWork(id))
        .filter((work): work is works.Work => !!work)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(conversationView)
      const skill = agent.skill_name ? locateSkill(agent.skill_name, locations()) : null
      res.json({ agent: { ...viewWithStatus(agent), skill_scope: skill?.scope ?? null }, conversations })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.get('/dedicated-agents/:id/tasks', (req, res) => {
    try {
      requireAgent(req.params.id)
      res.json({ tasks: works.listScheduledTasksForAgent(req.params.id) })
    } catch (error) { sendError(res, error) }
  })

  app.get('/dedicated-agents/:id/notification-targets', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      if (agentChannel(agent) !== 'wecom') {
        res.json({ targets: [] })
        return
      }
      const targets = works.listChannelNotifyTargets(agentChannelKey(agent.id)).flatMap((entry) => {
        const chatType = Number(entry.extra.chat_type)
        if (chatType !== 1 && chatType !== 2) return []
        return [{ id: entry.user_id, chat_type: chatType, observed_user_id: entry.extra.user_id || '', observed_at: entry.updated_at }]
      })
      res.json({ targets })
    } catch (error) { sendError(res, error) }
  })

  app.patch('/dedicated-agents/:id/tasks/:taskId', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      const task = works.getScheduledTask(req.params.taskId)
      if (!task || task.agent_id !== agent.id) throw new DedicatedAgentError('定时任务不存在', 404)
      const body = (req.body ?? {}) as Record<string, unknown>
      if (body.cron_expression !== undefined) {
        const validation = Scheduler.validateCron(String(body.cron_expression))
        if (!validation.valid) throw new DedicatedAgentError(validation.error || 'Cron 表达式无效')
      }
      const targets = Array.isArray(body.notification_targets) ? body.notification_targets : undefined
      const observed = works.listChannelNotifyTargets(agentChannelKey(agent.id))
      const notificationTargets = targets?.map((target) => {
        const value = target as Partial<works.AgentNotificationTarget>
        const entry = observed.find((candidate) => candidate.user_id === value.id && Number(candidate.extra.chat_type) === Number(value.chat_type))
        if (!entry) throw new DedicatedAgentError('通知目标必须来自该 Agent 已观察到的企业微信会话')
        return { id: entry.user_id, chat_type: Number(entry.extra.chat_type) as 1 | 2, observed_user_id: entry.extra.user_id || '', observed_at: entry.updated_at }
      })
      const updated = works.updateScheduledTask(task.id, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.prompt_template === 'string' ? { prompt_template: body.prompt_template } : {}),
        ...(typeof body.cron_expression === 'string' ? { cron_expression: body.cron_expression } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(notificationTargets ? { notification_targets: notificationTargets } : {}),
      })!
      if (body.enabled === false) scheduler.unregister(updated.id)
      else if (updated.enabled) scheduler.register(updated.id, updated.cron_expression)
      res.json({ task: updated })
    } catch (error) { sendError(res, error) }
  })

  app.delete('/dedicated-agents/:id/tasks/:taskId', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      const task = works.getScheduledTask(req.params.taskId)
      if (!task || task.agent_id !== agent.id) throw new DedicatedAgentError('定时任务不存在', 404)
      scheduler.unregister(task.id)
      works.deleteScheduledTask(task.id)
      res.json({ ok: true })
    } catch (error) { sendError(res, error) }
  })

  /** Start a conversation from the desktop; replies stay in the desktop. */
  app.post('/dedicated-agents/:id/conversations', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      const work = works.createWork('新对话', agentProjectId(agent))
      addAgentWork(agent.id, work.id)
      works.markExternalWrite()
      res.json({ conversation: conversationView(work) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.delete('/dedicated-agents/:id/conversations/:workId', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      if (!agent.work_ids.includes(req.params.workId)) throw new DedicatedAgentError('对话不存在', 404)
      removeAgentWork(agent.id, req.params.workId)
      disposeChatSession(req.params.workId, 'work_deleted')
      clearStoredConversationCompaction(req.params.workId)
      works.deleteWork(req.params.workId)
      works.markExternalWrite()
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/dedicated-agents', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const adapter = requireAdapter(body.site_id)
      const skillName = normalizeSkillName(body.skill_name)
      assertSkillExists(skillName)
      const resolved = resolveBot(body)
      if (!resolved) throw new DedicatedAgentError('请先扫码绑定机器人')
      const workspace = createAgentWorkspace(String(body.name ?? ''))
      let agent: DedicatedAgentRecord
      try {
        agent = createAgent({
          name: String(body.name ?? ''),
          description: String(body.description ?? ''),
          site_id: adapter.id,
          skill_name: skillName,
          examples: Array.isArray(body.examples) ? body.examples as string[] : [],
          access_mode: body.access_mode as 'owner_only' | 'wecom_authorized' | undefined,
          ...resolved.bot,
          project_id: workspace.project.id,
        }, reservedBots())
        addAgentWork(agent.id, workspace.work.id)
        agent = requireAgent(agent.id)
      } catch (error) {
        try { works.deleteWork(workspace.work.id) } catch { /* preserve original error */ }
        try { works.deleteProject(workspace.project.id) } catch { /* preserve original error */ }
        throw error
      }
      resolved.consume()
      await startAgentChannel(agent)
      works.markExternalWrite()
      res.json({ agent: viewWithStatus(agent) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.patch('/dedicated-agents/:id', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      if (body.site_id !== undefined) requireAdapter(body.site_id)
      if (body.skill_name !== undefined) assertSkillExists(normalizeSkillName(body.skill_name))
      const resolved = resolveBot(body)
      const agent = updateAgent(req.params.id, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        site_id: body.site_id as string | undefined,
        skill_name: body.skill_name as string | undefined,
        examples: Array.isArray(body.examples) ? body.examples as string[] : undefined,
        access_mode: body.access_mode as 'owner_only' | 'wecom_authorized' | undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        bot: resolved?.bot,
      }, reservedBots())
      resolved?.consume()
      // The project folder name is generated from the Agent name: keep it in sync.
      if (body.name !== undefined) syncAgentProjectName(agent)
      if (resolved || typeof body.enabled === 'boolean') await restartAgentChannel(agent.id)
      res.json({ agent: viewWithStatus(agent) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/dedicated-agents/:id/pairing/reset', (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      for (const task of works.listScheduledTasksForAgent(agent.id)) {
        scheduler.unregister(task.id)
        works.updateScheduledTask(task.id, { enabled: false })
      }
      res.json({ agent: viewWithStatus(resetPairing(req.params.id)) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.delete('/dedicated-agents/:id', async (req, res) => {
    try {
      const agent = requireAgent(req.params.id)
      for (const task of works.listScheduledTasksForAgent(agent.id)) {
        scheduler.unregister(task.id)
        works.deleteScheduledTask(task.id)
      }
      await stopAgentChannel(agent.id)
      deleteAgent(agent.id)
      const deleteConversations = req.query.keep_conversations !== '1'
      if (deleteConversations) {
        for (const workId of agent.work_ids) {
          disposeChatSession(workId, 'work_deleted')
          clearStoredConversationCompaction(workId)
          works.deleteWork(workId)
        }
        works.markExternalWrite()
      }
      removeAgentRuntime(agent.id)
      res.json({ ok: true })
    } catch (error) {
      sendError(res, error)
    }
  })
}
