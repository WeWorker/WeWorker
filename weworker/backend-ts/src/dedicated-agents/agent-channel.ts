/**
 * IM bot connection per dedicated agent (企业微信 or 微信).
 *
 * Each agent owns one bot. Its pairing owner always has access; a WeCom agent
 * can optionally also serve members authorized for that bot in WeCom. Every
 * turn runs with isolated skills, memory scope and focused tool limits.
 */
import { channelManager, type ChannelStatus } from '../channels/channel-manager.js'
import type { ChannelAccessDecision, ChannelProfile } from '../channels/channel-profile.js'
import { WecomChannel } from '../channels/wecom-channel.js'
import { WeixinChannel } from '../channels/weixin-channel.js'
import * as works from '../works-store.js'
import { parseAllAdapters } from '../adapter-parser.js'
import { getSiteEnabled } from '../config.js'
import { createLogger } from '../logger.js'
import {
  addAgentWork,
  agentChannel,
  completePairing,
  getAgent,
  getAgentBotSecret,
  getAgentWeixinToken,
  listAgents,
  AGENT_CHANNEL_LABELS,
  type DedicatedAgentRecord,
} from './agent-store.js'
import { buildAgentChatOptions } from './agent-runtime.js'

const log = createLogger('dedicated-agent')
const KEY_PREFIX = 'agent:'
const MAX_PAIRING_ATTEMPTS = 5
const PAIRING_LOCK_MS = 10 * 60_000

export function agentChannelKey(agentId: string): string {
  return `${KEY_PREFIX}${agentId}`
}

export function isAgentChannelKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX)
}

/** Extract a 6-digit code from 「绑定 123456」, 「/bind 123456」 or just 「123456」. */
export function extractPairingCode(text: string): string | null {
  const normalized = String(text ?? '').replace(/\s+/g, '').toLowerCase()
  const match = normalized.match(/^(?:绑定|配对|\/bind|bind|\/绑定)?[:：]?(\d{6})$/)
  return match ? match[1] : null
}

interface SiteInfo { name: string; enabled: boolean; exists: boolean }

function resolveSite(siteId: string): SiteInfo {
  const adapter = parseAllAdapters().get(siteId)
  if (!adapter) return { name: siteId, enabled: false, exists: false }
  return {
    name: adapter.name || siteId,
    enabled: getSiteEnabled(siteId, adapter.defaultEnabled, adapter.managed?.enabled),
    exists: true,
  }
}

function examplesText(agent: DedicatedAgentRecord): string {
  if (!agent.examples.length) return ''
  return `\n\n可以这样问我：\n${agent.examples.map((example) => `· ${example}`).join('\n')}`
}

function resolveAgentProjectId(agentId: string): string | null {
  const agent = getAgent(agentId)
  if (!agent) return null
  if (agent.project_id && works.getProject(agent.project_id)) return agent.project_id
  for (const workId of agent.work_ids) {
    const projectId = works.getWork(workId)?.project_id
    if (projectId && works.getProject(projectId)) return projectId
  }
  return null
}

export type PairingAttempts = Map<string, { failures: number; lockedUntil: number }>

/**
 * Access decision for one inbound message. Pure apart from `onPair`, so it can
 * be unit-tested without a WeCom connection.
 */
export function decideAgentAccess(input: {
  agent: DedicatedAgentRecord
  userId: string
  text: string
  site: SiteInfo
  attempts: PairingAttempts
  now: number
  onPair: (userId: string) => DedicatedAgentRecord
}): ChannelAccessDecision {
  const { agent, userId, text, site, attempts, now } = input
  if (text.trim() === '/myid') {
    return { kind: 'reply', text: `你的${AGENT_CHANNEL_LABELS[agentChannel(agent)]}用户 ID：${userId}` }
  }
  if (!agent.enabled) {
    return { kind: 'reply', text: `「${agent.name}」已在 WeWorker 中停用。` }
  }
  if (!agent.owner_user_id) {
    const record = attempts.get(userId)
    if (record && record.lockedUntil > now) {
      return { kind: 'reply', text: '绑定码错误次数过多，请 10 分钟后再试。' }
    }
    const code = extractPairingCode(text)
    if (code && agent.pairing_code && code === agent.pairing_code) {
      attempts.delete(userId)
      const paired = input.onPair(userId)
      return {
        kind: 'reply',
        text: `✅ 绑定成功！我是你的专属 Agent「${paired.name}」，专门帮你处理「${site.name}」上的工作。现在可以直接给我发消息了。${examplesText(paired)}`,
      }
    }
    if (code) {
      const failures = (record?.failures ?? 0) + 1
      attempts.set(userId, {
        failures: failures >= MAX_PAIRING_ATTEMPTS ? 0 : failures,
        lockedUntil: failures >= MAX_PAIRING_ATTEMPTS ? now + PAIRING_LOCK_MS : 0,
      })
      return { kind: 'reply', text: '绑定码不正确，请核对 WeWorker 桌面端「专属 Agent」页面上显示的绑定码。' }
    }
    return {
      kind: 'reply',
      text: `「${agent.name}」还没有完成绑定。请打开 WeWorker 桌面端「专属 Agent」页面，把显示的绑定码发给我，例如：绑定 123456`,
    }
  }
  const hasAccess = userId === agent.owner_user_id
    || (agentChannel(agent) === 'wecom' && agent.access_mode === 'wecom_authorized')
  if (!hasAccess) {
    return { kind: 'reply', text: `这是「${agent.name}」的专属 Agent，目前仅允许它的主人使用。` }
  }
  if (!site.exists || !site.enabled) {
    return { kind: 'reply', text: `「${site.name}」的网站能力当前未启用，请在 WeWorker 桌面端启用后再试。` }
  }
  return { kind: 'allow', mode: 'full' }
}

export function createAgentProfile(agentId: string, options: { attempts?: PairingAttempts; now?: () => number } = {}): ChannelProfile {
  const attempts: PairingAttempts = options.attempts ?? new Map()
  const now = options.now ?? Date.now
  const current = (): DedicatedAgentRecord => {
    const agent = getAgent(agentId)
    if (!agent) throw new Error('专属 Agent 已被删除')
    return agent
  }
  return {
    channelKey: agentChannelKey(agentId),
    dedicatedAgentId: agentId,
    serializeTurns: true,
    projectId: () => resolveAgentProjectId(agentId),
    titleLabel: () => current().name,
    welcomeText: () => {
      const agent = getAgent(agentId)
      if (!agent) return '你好！'
      const site = resolveSite(agent.site_id)
      const intro = `你好，我是「${agent.name}」，专门帮你处理「${site.name}」上的工作。${agent.description ? `\n${agent.description}` : ''}`
      if (!agent.owner_user_id) return `${intro}\n\n首次使用请把 WeWorker 桌面端显示的绑定码发给我，例如：绑定 123456`
      return `${intro}${examplesText(agent)}\n\n发送 /new 开启新对话，发送 /help 查看说明。`
    },
    helpText: () => {
      const agent = current()
      const site = resolveSite(agent.site_id)
      return [
        `「${agent.name}」`,
        `负责网站：${site.name}`,
        agent.skill_name ? `专属 Skill：${agent.skill_name}` : '专属 Skill：未设置（仅使用网站能力）',
        '',
        '/new 开启新对话',
        '/stop 停止当前任务',
        '/id 查看当前对话 ID',
        '/help 查看本说明',
      ].join('\n') + examplesText(agent)
    },
    authorize: (userId, text) => {
      const agent = getAgent(agentId)
      if (!agent) return { kind: 'reply', text: '这个专属 Agent 已被删除。' }
      return decideAgentAccess({
        agent,
        userId,
        text,
        site: resolveSite(agent.site_id),
        attempts,
        now: now(),
        onPair: (owner) => {
          const paired = completePairing(agentId, owner)
          const primaryWorkId = paired.work_ids.find((workId) => !!works.getWork(workId))
          if (primaryWorkId) works.bindChannelWork(agentChannelKey(agentId), owner, primaryWorkId)
          log.info(`agent ${agentId} paired`)
          return paired
        },
      })
    },
    memoryScope: (userId) => {
      const agent = getAgent(agentId)
      return { user: `${agent ? agentChannel(agent) : 'wecom'}:${userId}`, project: `agent:${agentId}` }
    },
    chatOptions: (userId) => {
      const agent = current()
      return buildAgentChatOptions({ agent, siteName: resolveSite(agent.site_id).name, actorUserId: userId })
    },
    onWorkCreated: (workId) => addAgentWork(agentId, workId),
  }
}

/**
 * Options for continuing an agent conversation from the desktop chat.
 * The desktop user is the owner, so access checks do not apply; long-term
 * memory stays off so agent turns never write into the main chat's memory.
 */
export function buildDesktopAgentTurnOptions(agent: DedicatedAgentRecord) {
  return {
    ...buildAgentChatOptions({ agent, siteName: resolveSite(agent.site_id).name }),
    memoryEnabled: false,
  }
}

export async function stopAgentChannel(agentId: string): Promise<void> {
  await channelManager.unregister(agentChannelKey(agentId))
}

export async function startAgentChannel(agent: DedicatedAgentRecord): Promise<void> {
  await stopAgentChannel(agent.id)
  if (!agent.enabled) return
  let channel: WecomChannel | WeixinChannel
  if (agentChannel(agent) === 'weixin') {
    const token = getAgentWeixinToken(agent)
    if (!token) {
      log.warn(`agent ${agent.id}: missing WeChat bot credentials, not starting`)
      return
    }
    channel = new WeixinChannel({ token, base_url: agent.weixin?.base_url }, createAgentProfile(agent.id))
  } else {
    const secret = getAgentBotSecret(agent)
    if (!agent.wecom.bot_id || !secret) {
      log.warn(`agent ${agent.id}: missing bot credentials, not starting`)
      return
    }
    channel = new WecomChannel({ enabled: true, bot_id: agent.wecom.bot_id, secret }, createAgentProfile(agent.id))
  }
  channelManager.register(agentChannelKey(agent.id), channel)
  channel.start().catch((error) => log.error(`agent ${agent.id} start error:`, error))
}

export async function restartAgentChannel(agentId: string): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent) {
    await stopAgentChannel(agentId)
    return
  }
  await startAgentChannel(agent)
}

export async function startAllDedicatedAgents(): Promise<void> {
  for (const agent of listAgents()) {
    if (!agent.enabled) continue
    try {
      await startAgentChannel(agent)
    } catch (error) {
      log.error(`agent ${agent.id} failed to start:`, error)
    }
  }
}

export function getAgentChannelStatus(agentId: string): ChannelStatus | { status: 'stopped' } {
  return channelManager.getStatuses()[agentChannelKey(agentId)] ?? { status: 'stopped' }
}
