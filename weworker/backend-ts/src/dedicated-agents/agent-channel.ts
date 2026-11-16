/**
 * IM bot connection per dedicated agent (企业微信 or 微信).
 *
 * Each agent owns one bot. Its pairing owner always has access; a WeCom agent
 * can optionally also serve members authorized for that bot in WeCom. Every
 * turn runs with isolated skills, memory scope, an optional working directory
 * and webcli scoped to the agent's own sites.
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
import { extractPairingCode } from '../channels/pairing-code.js'
export { extractPairingCode } from '../channels/pairing-code.js'

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

/** Site info for every site the agent operates, in record order. */
function resolveAgentSites(agent: Pick<DedicatedAgentRecord, 'site_ids'>): SiteInfo[] {
  return (agent.site_ids ?? []).map(resolveSite)
}

/** Sites the agent could actually reach right now (installed and enabled). */
function usableSites(sites: SiteInfo[]): SiteInfo[] {
  return sites.filter((site) => site.exists && site.enabled)
}

function sitesTextLabel(sites: SiteInfo[]): string {
  return sites.map((site) => `「${site.name}」`).join('')
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
  sites: SiteInfo[]
  attempts: PairingAttempts
  now: number
  onPair: (userId: string) => DedicatedAgentRecord
}): ChannelAccessDecision {
  const { agent, userId, text, sites, attempts, now } = input
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
      const usable = usableSites(sites)
      const intro = usable.length
        ? `专门帮你处理${sitesTextLabel(usable)}上的工作`
        : '可以随时为你处理各类工作'
      return {
        kind: 'reply',
        text: `✅ 绑定成功！我是你的WeWorker Bot「${paired.name}」，${intro}。现在可以直接给我发消息了。${examplesText(paired)}`,
      }
    }
    if (code) {
      const failures = (record?.failures ?? 0) + 1
      attempts.set(userId, {
        failures: failures >= MAX_PAIRING_ATTEMPTS ? 0 : failures,
        lockedUntil: failures >= MAX_PAIRING_ATTEMPTS ? now + PAIRING_LOCK_MS : 0,
      })
      return { kind: 'reply', text: '绑定码不正确，请核对 WeWorker 桌面端「WeWorker Bot」页面上显示的绑定码。' }
    }
    return {
      kind: 'reply',
      text: `「${agent.name}」还没有完成绑定。请打开 WeWorker 桌面端「WeWorker Bot」页面，把显示的绑定码发给我，例如：绑定 123456`,
    }
  }
  const hasAccess = userId === agent.owner_user_id
    || (agentChannel(agent) === 'wecom' && agent.access_mode === 'wecom_authorized')
  if (!hasAccess) {
    return { kind: 'reply', text: `这是「${agent.name}」的WeWorker Bot，目前仅允许它的主人使用。` }
  }
  // Website capabilities are auxiliary: block only when the agent has sites
  // and none of them is currently installed and enabled.
  if (sites.length && !usableSites(sites).length) {
    return { kind: 'reply', text: `这个WeWorker Bot 绑定的网站能力当前未启用（${sites.map((site) => site.name).join('、')}），请在 WeWorker 桌面端启用后再试；其他工作不受影响。` }
  }
  return { kind: 'allow', mode: 'full' }
}

export function createAgentProfile(agentId: string, options: { attempts?: PairingAttempts; now?: () => number } = {}): ChannelProfile {
  const attempts: PairingAttempts = options.attempts ?? new Map()
  const now = options.now ?? Date.now
  const current = (): DedicatedAgentRecord => {
    const agent = getAgent(agentId)
    if (!agent) throw new Error('WeWorker Bot 已被删除')
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
      const usable = usableSites(resolveAgentSites(agent))
      const intro = `你好，我是「${agent.name}」。${usable.length ? `我可以帮你处理${sitesTextLabel(usable)}上的工作` : '我是你的专属助手'}${agent.work_dir ? '，也可以处理本地目录里的工作' : ''}。${agent.description ? `\n${agent.description}` : ''}`
      if (!agent.owner_user_id) return `${intro}\n\n首次使用请把 WeWorker 桌面端显示的绑定码发给我，例如：绑定 123456`
      return `${intro}${examplesText(agent)}\n\n发送 /new 开启新对话，发送 /help 查看说明。`
    },
    helpText: () => {
      const agent = current()
      const sites = resolveAgentSites(agent)
      const usable = usableSites(sites)
      return [
        `「${agent.name}」`,
        usable.length ? `可操作网站：${usable.map((site) => site.name).join('、')}` : '可操作网站：未绑定',
        agent.work_dir ? `工作目录：${agent.work_dir}` : '',
        agent.skill_names.length ? `专属 Skill：${agent.skill_names.join('、')}` : '专属 Skill：未设置',
        '',
        '/new 开启新对话',
        '/stop 停止当前任务',
        '/id 查看当前对话 ID',
        '/help 查看本说明',
      ].filter(Boolean).join('\n') + examplesText(agent)
    },
    authorize: (userId, text) => {
      const agent = getAgent(agentId)
      if (!agent) return { kind: 'reply', text: '这个WeWorker Bot 已被删除。' }
      return decideAgentAccess({
        agent,
        userId,
        text,
        sites: resolveAgentSites(agent),
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
      return buildAgentChatOptions({ agent, actorUserId: userId })
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
    ...buildAgentChatOptions({ agent }),
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
