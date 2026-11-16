/**
 * Per-agent runtime: an isolated Claude config directory whose skills/ folder
 * contains only what the agent needs, plus its system prompt and tool limits.
 */
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDirectory, getSiteEnabled } from '../config.js'
import { getRuntimeSkillsDir } from '../runtime-skills-dir.js'
import { createLogger } from '../logger.js'
import { parseAllAdapters } from '../adapter-parser.js'
import type { DedicatedAgentRecord } from './agent-store.js'
import { createWorkspaceToolGuard, WORKSPACE_AGENT_DISALLOWED_TOOLS } from './focused-tool-guard.js'
import { locateSkill } from './skill-library.js'
import { buildMcpServer } from '../tools.js'
import type { WecomProfileChatOptions } from '../channels/wecom-channel.js'

const log = createLogger('dedicated-agent-runtime')
const CUSTOM_SKILL_MARKER = '.weworker-custom-skill.json'
const BASE_WEBCLI_SKILL = 'webcli'

export function getDedicatedAgentsRoot(): string {
  return process.env.WEWORKER_DEDICATED_AGENTS_DIR || path.join(getConfigDirectory(), 'dedicated-agents')
}

export function getAgentClaudeConfigDir(agentId: string, root = getDedicatedAgentsRoot()): string {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) throw new Error('Invalid agent id')
  return path.join(root, agentId, 'claude-config')
}

function readCustomSkillSiteId(dir: string): string | null {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, CUSTOM_SKILL_MARKER), 'utf8')) as { siteId?: unknown }
    return typeof marker.siteId === 'string' ? marker.siteId : null
  } catch {
    return null
  }
}

/**
 * Skill directories an agent should see, mapped to their source directory:
 * the base webcli skill and each site's Adapter skill + site custom skills
 * (only when the agent operates websites), plus each of the agent's own
 * skills (private library first, then the public skills dir).
 */
export function resolveAgentSkillSources(
  agent: Pick<DedicatedAgentRecord, 'site_ids' | 'skill_names'>,
  runtimeSkillsDir = getRuntimeSkillsDir(),
  libraryDir?: string,
): Map<string, string> {
  const sources = new Map<string, string>()
  const addPublic = (name: string) => {
    const dir = path.join(runtimeSkillsDir, name)
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) sources.set(name, dir)
  }
  const siteIds = new Set(agent.site_ids ?? [])
  if (siteIds.size) {
    addPublic(BASE_WEBCLI_SKILL)
    for (const siteId of siteIds) addPublic(`webcli-${siteId}`)
  }
  try {
    for (const entry of fs.readdirSync(runtimeSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (siteIds.has(readCustomSkillSiteId(path.join(runtimeSkillsDir, entry.name)) ?? '')) addPublic(entry.name)
    }
  } catch {
    // Runtime skills dir missing: only explicit skills below.
  }
  for (const skillName of agent.skill_names ?? []) {
    if (!skillName || sources.has(skillName)) continue
    const located = locateSkill(skillName, { runtimeSkillsDir, libraryDir })
    if (located) sources.set(skillName, located.dir)
  }
  return sources
}

export function resolveAgentSkillNames(
  agent: Pick<DedicatedAgentRecord, 'site_ids' | 'skill_names'>,
  runtimeSkillsDir = getRuntimeSkillsDir(),
  libraryDir?: string,
): string[] {
  return [...resolveAgentSkillSources(agent, runtimeSkillsDir, libraryDir).keys()]
}

/** Cheap change detector: relative path + size + mtime of every file. */
function directoryFingerprint(dir: string): string {
  const parts: string[] = []
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute)
        parts.push(`${relative}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      }
    }
  }
  walk(dir, '')
  return parts.join('|')
}

const FINGERPRINT_FILE = '.weworker-agent-copy'

/**
 * Mirror the agent's skills into its isolated skills directory.
 * The agent directory is fully owned by WeWorker, so stale entries are removed.
 */
export function syncAgentSkills(
  agent: Pick<DedicatedAgentRecord, 'id' | 'site_ids' | 'skill_names'>,
  options: { runtimeSkillsDir?: string; agentsRoot?: string; libraryDir?: string } = {},
): { claudeConfigDir: string; skills: string[]; missingPrivateSkills: string[] } {
  const runtimeSkillsDir = options.runtimeSkillsDir ?? getRuntimeSkillsDir()
  const claudeConfigDir = getAgentClaudeConfigDir(agent.id, options.agentsRoot)
  const targetRoot = path.join(claudeConfigDir, 'skills')
  fs.mkdirSync(targetRoot, { recursive: true })

  const sources = resolveAgentSkillSources(agent, runtimeSkillsDir, options.libraryDir)
  const skills = [...sources.keys()]
  const wanted = new Set(skills)
  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (!wanted.has(entry.name)) fs.rmSync(path.join(targetRoot, entry.name), { recursive: true, force: true })
  }
  for (const name of skills) {
    const source = sources.get(name)!
    const target = path.join(targetRoot, name)
    const fingerprint = directoryFingerprint(source)
    let previous = ''
    try { previous = fs.readFileSync(path.join(target, FINGERPRINT_FILE), 'utf8') } catch { /* first copy */ }
    if (previous === fingerprint && fs.existsSync(path.join(target, 'SKILL.md'))) continue
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(source, target, { recursive: true, dereference: false, filter: (src) => !fs.lstatSync(src).isSymbolicLink() })
    fs.writeFileSync(path.join(target, FINGERPRINT_FILE), fingerprint)
  }
  const missingPrivateSkills = (agent.skill_names ?? []).filter((name) => name && !wanted.has(name))
  for (const name of missingPrivateSkills) log.warn(`agent ${agent.id}: private skill ${name} not found`)
  return { claudeConfigDir, skills, missingPrivateSkills }
}

/** Display names for the agent's sites, in record order; unknown ids (or an unavailable catalog) fall back to the id. */
export function resolveAgentSiteNames(agent: Pick<DedicatedAgentRecord, 'site_ids'>): string[] {
  let adapters: Map<string, { name?: string }> = new Map()
  try {
    adapters = parseAllAdapters()
  } catch {
    // Adapter catalog unavailable (e.g. not prepared): the raw id is still a usable label.
  }
  return (agent.site_ids ?? []).map((siteId) => adapters.get(siteId)?.name || siteId)
}

export function buildAgentSystemPrompt(input: {
  agent: Pick<DedicatedAgentRecord, 'name' | 'description' | 'site_ids' | 'skill_names' | 'work_dir' | 'channel' | 'access_mode'>
  siteNames?: string[]
  /** Names of the agent's own skills that were actually synced into its runtime. */
  availableSkills?: string[]
}): string {
  const { agent } = input
  const siteNames = input.siteNames ?? resolveAgentSiteNames(agent)
  const audience = agent.access_mode === 'wecom_authorized' && agent.channel !== 'weixin' ? '为企业微信已授权用户服务' : '只为主人服务'
  const lines = [
    '## WeWorker Bot',
    '',
    `你是「${agent.name}」，一个${audience}的WeWorker Bot。${agent.description ? `职责：${agent.description}` : ''}`,
    '',
    '- 你的回复会发到企业微信或微信聊天里：先给结论，再给关键依据，只贴必要的原始输出，避免大段刷屏。',
  ]
  if (siteNames.length) {
    const sites = siteNames.map((name, index) => `${name}（${agent.site_ids[index]}）`).join('、')
    lines.push(`- 你可以操作这些网站：${sites}。网站操作用原生命令工具执行 \`webcli call <站点ID>.<工具名> --参数名=参数值\`；登录由 WeWorker 自动处理，调用前无需检查登录状态。`)
  }
  if (agent.work_dir) {
    lines.push(`- 你的工作目录是 \`${agent.work_dir}\`。像在本目录下运行的 Claude 一样完成用户的工作；目录中的 CLAUDE.md、AGENTS.md 等说明文件（如有）先读取并遵守。`)
  }
  const skills = input.availableSkills ?? agent.skill_names ?? []
  if (skills.length) {
    // Load once per conversation: a later turn sees the earlier load in its own
    // context or in the replayed "已加载的 Skill 说明", so it must not reload.
    lines.push(`- 本对话中第一次处理请求前，用 Skill 工具加载专属 Skill「${skills.join('」「')}」，按其中的知识、步骤和约束执行；上下文里已有它们的完整说明（包括“已加载的 Skill 说明”）时直接使用，不要重复加载。`)
    lines.push('- 用户明确要求“记住/修改规则、偏好或领域知识”时，或你发现 Skill 内容过时/有误并已向用户说明、得到确认后，用 mcp__weworker__update_agent_skill 更新对应 Skill：传入完整的新 SKILL.md 和一句话 change_summary，并在回复中复述改了什么；其余情况不要更新 Skill。')
  }
  return lines.join('\n')
}

export function buildAgentChatOptions(input: {
  agent: DedicatedAgentRecord
  /** Set for inbound WeCom turns; only the pairing owner can manage tasks. */
  actorUserId?: string
  /** Set by the scheduler, enabling only this task's explicit message targets. */
  taskId?: string
  runtimeSkillsDir?: string
  agentsRoot?: string
  libraryDir?: string
  /** Installed Adapter ids; defaults to the live Adapter registry. */
  knownSiteIds?: string[]
}): WecomProfileChatOptions {
  const synced = syncAgentSkills(input.agent, {
    runtimeSkillsDir: input.runtimeSkillsDir,
    agentsRoot: input.agentsRoot,
    libraryDir: input.libraryDir,
  })
  const availableSkills = (input.agent.skill_names ?? []).filter((name) => synced.skills.includes(name))
  return {
    isolatedClaudeConfigDir: synced.claudeConfigDir,
    appendSystemPrompt: buildAgentSystemPrompt({ agent: input.agent, availableSkills }),
    agentCwd: input.agent.work_dir || undefined,
    extraToolGuard: createWorkspaceToolGuard(input.agent.site_ids ?? [], input.knownSiteIds ?? [...parseAllAdapters().keys()], [
      'mcp__weworker__list_agent_notification_targets',
      'mcp__weworker__create_agent_scheduled_task',
      'mcp__weworker__update_agent_skill',
      ...(input.taskId ? ['mcp__weworker__send_agent_message'] : []),
    ]),
    extraDisallowedTools: [...WORKSPACE_AGENT_DISALLOWED_TOOLS],
    mcpServerOverride: buildMcpServer({
      channelPermissionMode: 'full',
      dedicatedAgent: {
        agentId: input.agent.id,
        ownerUserId: input.agent.owner_user_id,
        actorUserId: input.actorUserId,
        taskId: input.taskId,
      },
    }),
  }
}

export function removeAgentRuntime(agentId: string, root = getDedicatedAgentsRoot()): void {
  const dir = path.dirname(getAgentClaudeConfigDir(agentId, root))
  fs.rmSync(dir, { recursive: true, force: true })
}
