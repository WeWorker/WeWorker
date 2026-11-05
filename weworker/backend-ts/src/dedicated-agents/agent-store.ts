/**
 * Dedicated agent records.
 *
 * Stored in ~/.weworker/dedicated-agents.json (override: WEWORKER_DEDICATED_AGENTS_FILE).
 * Each agent is served by one bot: a WeCom (企业微信) smart bot or a WeChat
 * (微信) iLink bot. Bot secrets/tokens are SM4-encrypted with the settings
 * master key and never leave the backend; API views only expose `has_secret`
 * / `has_token`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomInt, randomUUID } from 'node:crypto'
import { getConfigDirectory } from '../config.js'
import { assertAllowedWeixinBaseUrl } from '../channel-egress.js'
import { decryptSecret, encryptSecret, isSecretStoreReady } from '../secret-store.js'

export type AgentChannelType = 'wecom' | 'weixin'
/** Whether a WeCom agent is private to its pairing owner or shared through WeCom. */
export type AgentAccessMode = 'owner_only' | 'wecom_authorized'

export const AGENT_CHANNEL_LABELS: Record<AgentChannelType, string> = {
  wecom: '企业微信',
  weixin: '微信',
}

export interface DedicatedAgentRecord {
  id: string
  name: string
  description: string
  /** Adapter id of the website this agent operates. */
  site_id: string
  /** Skill directory name in the runtime skills dir; '' means Adapter capabilities only. */
  skill_name: string
  examples: string[]
  enabled: boolean
  /** Which IM serves this agent. Records written before WeChat support are WeCom. */
  channel?: AgentChannelType
  /** Owner-only by default; sharing is available only for WeCom bots. */
  access_mode: AgentAccessMode
  wecom: { bot_id: string; secret_enc: string }
  weixin?: { bot_id: string; token_enc: string; base_url: string }
  /** IM user id of the person who paired the bot. */
  owner_user_id: string
  /** One-time code the owner sends to the bot to pair; '' after pairing. */
  pairing_code: string
  /** Conversations created by this agent; also visible in the main task list. */
  work_ids: string[]
  /** Main conversation project containing this agent's conversations. */
  project_id?: string
  created_at: string
  updated_at: string
}

/** Bot credentials for either channel. `channel` defaults to WeCom. */
export interface AgentBotInput {
  channel?: AgentChannelType
  bot_id: string
  /** WeCom long-connection secret. */
  secret?: string
  /** WeChat iLink bot token. */
  token?: string
  /** WeChat iLink API host returned by the QR login. */
  base_url?: string
}

export interface DedicatedAgentInput extends AgentBotInput {
  name: string
  description?: string
  site_id: string
  skill_name?: string
  examples?: string[]
  /** Only supported for WeCom agents; defaults to owner_only. */
  access_mode?: AgentAccessMode
  project_id?: string
}

export interface DedicatedAgentPatch {
  name?: string
  description?: string
  site_id?: string
  skill_name?: string
  examples?: string[]
  access_mode?: AgentAccessMode
  enabled?: boolean
  bot?: AgentBotInput
  project_id?: string
}

/** Bots already used outside dedicated agents (the main 设置 → 通道). */
export interface ReservedBots {
  reservedBotIds?: string[]
  reservedWeixinTokens?: string[]
}

interface StoreFile {
  version: 1
  agents: DedicatedAgentRecord[]
}

export class DedicatedAgentError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
    this.name = 'DedicatedAgentError'
  }
}

const NAME_MAX = 40
const DESCRIPTION_MAX = 200
const EXAMPLE_MAX = 120
const EXAMPLES_MAX = 6
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/
const WEIXIN_BOT_ID_PATTERN = /^[A-Za-z0-9@._:-]{1,128}$/
const WEIXIN_TOKEN_MAX = 4096

export function getDedicatedAgentsFile(): string {
  return process.env.WEWORKER_DEDICATED_AGENTS_FILE
    || path.join(getConfigDirectory(), 'dedicated-agents.json')
}

export function agentChannel(agent: Pick<DedicatedAgentRecord, 'channel'>): AgentChannelType {
  return agent.channel === 'weixin' ? 'weixin' : 'wecom'
}

/** Validate a requested access mode against the selected IM channel. */
export function normalizeAgentAccessMode(value: unknown, channel: AgentChannelType): AgentAccessMode {
  if (value === undefined || value === 'owner_only') return 'owner_only'
  if (value === 'wecom_authorized' && channel === 'wecom') return 'wecom_authorized'
  if (value === 'wecom_authorized') throw new DedicatedAgentError('允许企业微信授权用户仅适用于企业微信机器人')
  throw new DedicatedAgentError('不支持的访问范围')
}

function normalizeRecord(agent: DedicatedAgentRecord): DedicatedAgentRecord {
  const channel = agentChannel(agent)
  return {
    ...agent,
    channel,
    access_mode: channel === 'wecom' && agent.access_mode === 'wecom_authorized' ? 'wecom_authorized' : 'owner_only',
    wecom: agent.wecom ?? { bot_id: '', secret_enc: '' },
  }
}

function readFile(): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDedicatedAgentsFile(), 'utf8')) as Partial<StoreFile>
    if (parsed && Array.isArray(parsed.agents)) {
      return {
        version: 1,
        agents: parsed.agents.filter((agent) => agent && typeof agent.id === 'string').map(normalizeRecord),
      }
    }
  } catch {
    // Missing or unreadable file: start empty.
  }
  return { version: 1, agents: [] }
}

function writeFile(data: StoreFile): void {
  const file = getDedicatedAgentsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function generatePairingCode(): string {
  return String(randomInt(100000, 1000000))
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

function cleanExamples(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => cleanText(entry, EXAMPLE_MAX))
    .filter(Boolean)
    .slice(0, EXAMPLES_MAX)
}

export function normalizeSkillName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (!name) return ''
  if (!SKILL_NAME_PATTERN.test(name) || name.startsWith('webcli')) {
    throw new DedicatedAgentError('Skill 名称只能包含字母、数字、点、下划线和连字符，且不能以 webcli 开头')
  }
  return name
}

type ValidBot =
  | { channel: 'wecom'; bot_id: string; secret: string }
  | { channel: 'weixin'; bot_id: string; token: string; base_url: string }

function validateBot(input: AgentBotInput): ValidBot {
  if (input.channel !== undefined && input.channel !== 'wecom' && input.channel !== 'weixin') {
    throw new DedicatedAgentError('不支持的机器人类型')
  }
  if (input.channel === 'weixin') {
    const bot_id = String(input.bot_id ?? '').trim()
    const token = String(input.token ?? '').trim()
    if (bot_id && !WEIXIN_BOT_ID_PATTERN.test(bot_id)) throw new DedicatedAgentError('微信机器人 ID 格式不正确')
    if (!token || token.length > WEIXIN_TOKEN_MAX) throw new DedicatedAgentError('微信机器人凭证无效，请重新扫码')
    let base_url: string
    try {
      base_url = assertAllowedWeixinBaseUrl(input.base_url)
    } catch {
      throw new DedicatedAgentError('微信机器人服务地址不在允许列表中')
    }
    return { channel: 'weixin', bot_id, token, base_url }
  }
  const bot_id = String(input.bot_id ?? '').trim()
  const plain = String(input.secret ?? '').trim()
  if (!BOT_ID_PATTERN.test(bot_id)) throw new DedicatedAgentError('机器人 BotID 格式不正确')
  if (!plain || plain.length > 512) throw new DedicatedAgentError('机器人 Secret 不能为空')
  return { channel: 'wecom', bot_id, secret: plain }
}

function encrypt(secret: string): string {
  if (!isSecretStoreReady()) {
    throw new DedicatedAgentError('系统密钥存储不可用，无法安全保存机器人凭证', 503)
  }
  return encryptSecret(secret)
}

function decryptOrEmpty(value: string | undefined): string {
  if (!value) return ''
  try {
    return decryptSecret(value)
  } catch {
    return ''
  }
}

function assertBotUnused(agents: DedicatedAgentRecord[], bot: ValidBot, exceptId: string | null, reserved: ReservedBots): void {
  const others = agents.filter((agent) => agent.id !== exceptId && agentChannel(agent) === bot.channel)
  if (bot.channel === 'wecom') {
    if ((reserved.reservedBotIds ?? []).includes(bot.bot_id)) {
      throw new DedicatedAgentError('该机器人已在「设置 → 通道 → 企业微信」中使用。一个机器人只能连接一个 Agent，请换一个机器人', 409)
    }
    const owner = others.find((agent) => agent.wecom.bot_id === bot.bot_id)
    if (owner) throw new DedicatedAgentError(`该机器人已被WeWorker Bot「${owner.name}」使用。一个机器人只能连接一个 Agent`, 409)
    return
  }
  if ((reserved.reservedWeixinTokens ?? []).includes(bot.token)) {
    throw new DedicatedAgentError('该微信机器人已在「设置 → 通道 → 微信」中使用。一个机器人只能连接一个 Agent，请换一个微信号扫码', 409)
  }
  const owner = others.find((agent) => (bot.bot_id && agent.weixin?.bot_id === bot.bot_id)
    || decryptOrEmpty(agent.weixin?.token_enc) === bot.token)
  if (owner) {
    throw new DedicatedAgentError(`这个微信号的机器人已被WeWorker Bot「${owner.name}」使用。一个机器人只能连接一个 Agent，请换一个微信号扫码`, 409)
  }
}

/** Store fields for a validated bot; the other channel's fields are cleared. */
function botFields(bot: ValidBot): Pick<DedicatedAgentRecord, 'channel' | 'wecom' | 'weixin'> {
  if (bot.channel === 'weixin') {
    return {
      channel: 'weixin',
      wecom: { bot_id: '', secret_enc: '' },
      weixin: { bot_id: bot.bot_id, token_enc: encrypt(bot.token), base_url: bot.base_url },
    }
  }
  return { channel: 'wecom', wecom: { bot_id: bot.bot_id, secret_enc: encrypt(bot.secret) }, weixin: undefined }
}

/** Identity used to decide whether rebinding changed who can reach the bot. */
function botIdentity(agent: DedicatedAgentRecord): string {
  return agentChannel(agent) === 'weixin'
    ? `weixin:${agent.weixin?.bot_id || decryptOrEmpty(agent.weixin?.token_enc)}`
    : `wecom:${agent.wecom.bot_id}`
}

export function listAgents(): DedicatedAgentRecord[] {
  return readFile().agents
}

export function getAgent(id: string): DedicatedAgentRecord | null {
  return readFile().agents.find((agent) => agent.id === id) ?? null
}

/** Plaintext WeCom secret for starting the connection. Backend use only. */
export function getAgentBotSecret(agent: DedicatedAgentRecord): string {
  return decryptOrEmpty(agent.wecom?.secret_enc)
}

/** Plaintext WeChat token for starting the connection. Backend use only. */
export function getAgentWeixinToken(agent: DedicatedAgentRecord): string {
  return decryptOrEmpty(agent.weixin?.token_enc)
}

export function createAgent(input: DedicatedAgentInput, options: ReservedBots = {}): DedicatedAgentRecord {
  const name = cleanText(input.name, NAME_MAX)
  if (!name) throw new DedicatedAgentError('请填写 Agent 名称')
  const site_id = String(input.site_id ?? '').trim()
  if (!site_id) throw new DedicatedAgentError('请选择要操作的网站')
  const bot = validateBot(input)
  const data = readFile()
  assertBotUnused(data.agents, bot, null, options)
  const now = new Date().toISOString()
  const record: DedicatedAgentRecord = {
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    name,
    description: cleanText(input.description, DESCRIPTION_MAX),
    site_id,
    skill_name: normalizeSkillName(input.skill_name),
    examples: cleanExamples(input.examples),
    enabled: true,
    ...botFields(bot),
    access_mode: normalizeAgentAccessMode(input.access_mode, bot.channel),
    owner_user_id: '',
    pairing_code: generatePairingCode(),
    work_ids: [],
    project_id: String(input.project_id ?? '').trim(),
    created_at: now,
    updated_at: now,
  }
  if (!record.weixin) delete record.weixin
  data.agents.push(record)
  writeFile(data)
  return record
}

function mutate(id: string, apply: (agent: DedicatedAgentRecord, all: DedicatedAgentRecord[]) => void): DedicatedAgentRecord {
  const data = readFile()
  const agent = data.agents.find((entry) => entry.id === id)
  if (!agent) throw new DedicatedAgentError('WeWorker Bot 不存在', 404)
  apply(agent, data.agents)
  agent.updated_at = new Date().toISOString()
  writeFile(data)
  return agent
}

export function updateAgent(id: string, patch: DedicatedAgentPatch, options: ReservedBots = {}): DedicatedAgentRecord {
  return mutate(id, (agent, all) => {
    if (patch.name !== undefined) {
      const name = cleanText(patch.name, NAME_MAX)
      if (!name) throw new DedicatedAgentError('请填写 Agent 名称')
      agent.name = name
    }
    if (patch.description !== undefined) agent.description = cleanText(patch.description, DESCRIPTION_MAX)
    if (patch.site_id !== undefined) {
      const site = String(patch.site_id).trim()
      if (!site) throw new DedicatedAgentError('请选择要操作的网站')
      agent.site_id = site
    }
    if (patch.skill_name !== undefined) agent.skill_name = normalizeSkillName(patch.skill_name)
    if (patch.examples !== undefined) agent.examples = cleanExamples(patch.examples)
    if (patch.access_mode !== undefined) {
      const channel = patch.bot?.channel === 'weixin' ? 'weixin' : agentChannel(agent)
      agent.access_mode = normalizeAgentAccessMode(patch.access_mode, channel)
    }
    if (patch.enabled !== undefined) agent.enabled = patch.enabled === true
    if (patch.project_id !== undefined) agent.project_id = String(patch.project_id ?? '').trim()
    if (patch.bot) {
      const bot = validateBot(patch.bot)
      assertBotUnused(all, bot, agent.id, options)
      const previousIdentity = botIdentity(agent)
      Object.assign(agent, botFields(bot))
      if (!agent.weixin) delete agent.weixin
      if (agentChannel(agent) === 'weixin') agent.access_mode = 'owner_only'
      if (botIdentity(agent) !== previousIdentity) {
        // A different bot may be visible to different people: pair again.
        agent.owner_user_id = ''
        agent.pairing_code = generatePairingCode()
      }
    }
  })
}

/** Clear the owner and issue a new pairing code. */
export function resetPairing(id: string): DedicatedAgentRecord {
  return mutate(id, (agent) => {
    agent.owner_user_id = ''
    agent.pairing_code = generatePairingCode()
  })
}

export function completePairing(id: string, userId: string): DedicatedAgentRecord {
  return mutate(id, (agent) => {
    agent.owner_user_id = userId
    agent.pairing_code = ''
  })
}

export function addAgentWork(id: string, workId: string): void {
  try {
    mutate(id, (agent) => {
      if (!agent.work_ids.includes(workId)) agent.work_ids.push(workId)
    })
  } catch {
    // Agent removed while a turn was running; nothing to record.
  }
}

export function removeAgentWork(id: string, workId: string): DedicatedAgentRecord {
  return mutate(id, (agent) => {
    agent.work_ids = agent.work_ids.filter((entry) => entry !== workId)
  })
}

/** The agent bound to a WeCom bot, so main channel settings cannot reuse it. */
export function findAgentByBotId(botId: string): DedicatedAgentRecord | null {
  const id = String(botId ?? '').trim()
  if (!id) return null
  return readFile().agents.find((agent) => agentChannel(agent) === 'wecom' && agent.wecom.bot_id === id) ?? null
}

/** The agent bound to a WeChat bot token, so main channel settings cannot reuse it. */
export function findAgentByWeixinToken(token: string): DedicatedAgentRecord | null {
  const value = String(token ?? '').trim()
  if (!value) return null
  return readFile().agents.find((agent) => agentChannel(agent) === 'weixin' && getAgentWeixinToken(agent) === value) ?? null
}

export function findAgentByWorkId(workId: string): DedicatedAgentRecord | null {
  return readFile().agents.find((agent) => agent.work_ids.includes(workId)) ?? null
}

export function deleteAgent(id: string): DedicatedAgentRecord | null {
  const data = readFile()
  const index = data.agents.findIndex((agent) => agent.id === id)
  if (index < 0) return null
  const [removed] = data.agents.splice(index, 1)
  writeFile(data)
  return removed
}

/** Work ids owned by any dedicated agent (excluded from the main task list). */
export function listAgentWorkIds(): Set<string> {
  return new Set(readFile().agents.flatMap((agent) => agent.work_ids))
}

/** Project ids owned by any dedicated agent (their folder name is generated). */
export function listAgentProjectIds(): Set<string> {
  return new Set(readFile().agents.map((agent) => agent.project_id).filter((id): id is string => Boolean(id)))
}

export interface DedicatedAgentView {
  id: string
  name: string
  description: string
  site_id: string
  skill_name: string
  examples: string[]
  enabled: boolean
  channel: AgentChannelType
  access_mode: AgentAccessMode
  wecom: { bot_id: string; has_secret: boolean }
  weixin: { bot_id: string; has_token: boolean }
  paired: boolean
  owner_user_id: string
  pairing_code: string
  conversation_count: number
  created_at: string
  updated_at: string
}

export function toAgentView(agent: DedicatedAgentRecord): DedicatedAgentView {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    site_id: agent.site_id,
    skill_name: agent.skill_name,
    examples: [...agent.examples],
    enabled: agent.enabled,
    channel: agentChannel(agent),
    access_mode: agent.access_mode,
    wecom: { bot_id: agent.wecom?.bot_id ?? '', has_secret: !!agent.wecom?.secret_enc },
    weixin: { bot_id: agent.weixin?.bot_id ?? '', has_token: !!agent.weixin?.token_enc },
    paired: !!agent.owner_user_id,
    owner_user_id: agent.owner_user_id,
    pairing_code: agent.owner_user_id ? '' : agent.pairing_code,
    conversation_count: agent.work_ids.length,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  }
}
