/**
 * Update history and version archive for dedicated-agent skills.
 *
 * Every skill write — from the desktop editor or from a conversation turn —
 * archives the previous SKILL.md and appends a history entry, so updates are
 * auditable and a bad rewrite can be rolled back. Both live outside the skill
 * directories on purpose: they must not be mirrored into agent runtimes (that
 * would change the sync fingerprint) and must not ship as skill resources.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigDirectory } from '../config.js'
import { DedicatedAgentError, normalizeSkillName } from './agent-store.js'
import type { DedicatedAgentRecord } from './agent-store.js'
import { normalizeSkillMarkdown } from './skill-author.js'
import { locateSkill, updateAgentSkill, type SkillLocations, type SkillScope } from './skill-library.js'

export type SkillUpdateSource = 'conversation' | 'desktop'

export interface SkillUpdateRecord {
  id: string
  skill_name: string
  scope: SkillScope
  source: SkillUpdateSource
  actor: string
  agent_id: string
  agent_name: string
  summary: string
  updated_at: string
  archived_to: string | null
}

export interface SkillUpdateLocations extends SkillLocations {
  versionsRoot?: string
  historyFile?: string
}

const MAX_HISTORY_ENTRIES = 50
const MAX_ARCHIVED_VERSIONS = 5

function getVersionsRoot(): string {
  return process.env.WEWORKER_SKILL_VERSIONS_DIR
    || path.join(getConfigDirectory(), 'dedicated-agents', 'skill-versions')
}

function getHistoryFile(): string {
  return process.env.WEWORKER_SKILL_UPDATES_FILE
    || path.join(getConfigDirectory(), 'dedicated-agents', 'skill-updates.json')
}

/** Newest first; unreadable or malformed history files read as empty. */
export function listSkillUpdates(options: SkillUpdateLocations = {}): SkillUpdateRecord[] {
  const file = options.historyFile ?? getHistoryFile()
  let entries: unknown
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry): entry is SkillUpdateRecord => !!entry && typeof (entry as SkillUpdateRecord).skill_name === 'string')
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
}

function appendHistory(record: SkillUpdateRecord, options: SkillUpdateLocations): void {
  const file = options.historyFile ?? getHistoryFile()
  const entries = listSkillUpdates(options)
  entries.unshift(record)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(entries.slice(0, MAX_HISTORY_ENTRIES), null, 2))
}

/** Save the outgoing SKILL.md under the versions root and prune old copies. */
function archiveSkillVersion(name: string, markdown: string, options: SkillUpdateLocations): string {
  const root = path.join(options.versionsRoot ?? getVersionsRoot(), name)
  fs.mkdirSync(root, { recursive: true })
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const file = `${stamp}.md`
  fs.writeFileSync(path.join(root, file), markdown)
  const versions = fs.readdirSync(root).filter((entry) => entry.endsWith('.md')).sort()
  for (const stale of versions.slice(0, Math.max(0, versions.length - MAX_ARCHIVED_VERSIONS))) {
    fs.rmSync(path.join(root, stale), { force: true })
  }
  return file
}

export interface UpdateSkillWithHistoryInput {
  name: string
  markdown: string
  source: SkillUpdateSource
  actor: string
  agentId?: string
  agentName?: string
  summary: string
  locations?: SkillUpdateLocations
}

export interface UpdateSkillWithHistoryResult {
  changed: boolean
  name: string
  scope: SkillScope
  markdown: string
  update: SkillUpdateRecord | null
}

/**
 * Write a skill and record where the change came from. The frontmatter name is
 * forced to the skill's directory name (same normalization as the desktop
 * editor), and an identical rewrite is a no-op: no archive, no history entry.
 */
export function updateSkillWithHistory(input: UpdateSkillWithHistoryInput): UpdateSkillWithHistoryResult {
  const safe = normalizeSkillName(input.name)
  if (!safe) throw new DedicatedAgentError('请填写 Skill 名称')
  const locations = input.locations ?? {}
  const located = locateSkill(safe, locations)
  if (!located) throw new DedicatedAgentError('Skill 不存在', 404)

  const current = fs.readFileSync(path.join(located.dir, 'SKILL.md'), 'utf8')
  const next = normalizeSkillMarkdown(input.markdown, safe)
  if (next === current) {
    return { changed: false, name: safe, scope: located.scope, markdown: current, update: null }
  }

  const archivedTo = archiveSkillVersion(safe, current, locations)
  const updated = updateAgentSkill(safe, next, locations)
  const record: SkillUpdateRecord = {
    id: randomUUID(),
    skill_name: updated.name,
    scope: updated.scope,
    source: input.source,
    actor: String(input.actor || input.source),
    agent_id: input.agentId ?? '',
    agent_name: input.agentName ?? '',
    summary: input.summary.trim().slice(0, 500) || '更新了 Skill 内容',
    updated_at: new Date().toISOString(),
    archived_to: archivedTo,
  }
  appendHistory(record, locations)
  return { changed: true, name: updated.name, scope: updated.scope, markdown: next, update: record }
}

export interface SkillUpdatedEvent {
  type: 'agent_skill_updated'
  agentId: string
  agentName: string
  skillName: string
  scope: SkillScope
  summary: string
  updatedAt: string
  updatedBy: 'conversation'
}

export interface ApplySkillUpdateInput {
  /** The agent whose conversation asked for the update. */
  agent: Pick<DedicatedAgentRecord, 'id' | 'name' | 'enabled' | 'skill_names' | 'owner_user_id'>
  /** The WeCom user talking to the agent, when the turn came from a channel. */
  actorUserId?: string
  skillName: string
  markdown: string
  changeSummary: string
  locations?: SkillUpdateLocations
}

export type ApplySkillUpdateOutcome =
  | { ok: true; skillName: string; scope: SkillScope; changed: boolean; summary: string; event: SkillUpdatedEvent | null }
  | { ok: false; error: string }

/**
 * Conversation-driven skill update for a dedicated agent: only the owner may
 * rewrite, only one of the agent's own skills may be rewritten. Returns the
 * SSE event payload when the content actually changed.
 */
export function applyConversationSkillUpdate(input: ApplySkillUpdateInput): ApplySkillUpdateOutcome {
  const agent = input.agent
  if (!agent.enabled) return { ok: false, error: 'WeWorker Bot 不存在或已停用' }
  if (agent.owner_user_id && input.actorUserId && input.actorUserId !== agent.owner_user_id) {
    return { ok: false, error: '只有WeWorker Bot 的主人可以更新专属 Skill' }
  }
  let safeName = ''
  try {
    safeName = normalizeSkillName(input.skillName)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!safeName) return { ok: false, error: '请填写 Skill 名称' }
  if (!(agent.skill_names ?? []).includes(safeName)) {
    return { ok: false, error: `「${safeName}」不是本WeWorker Bot 加载的专属 Skill，不能更新` }
  }
  try {
    const result = updateSkillWithHistory({
      name: safeName,
      markdown: input.markdown,
      source: 'conversation',
      actor: agent.owner_user_id || 'owner',
      agentId: agent.id,
      agentName: agent.name,
      summary: input.changeSummary,
      locations: input.locations,
    })
    const summary = result.update?.summary ?? '内容无变化'
    const event = result.update ? {
      type: 'agent_skill_updated' as const,
      agentId: agent.id,
      agentName: agent.name,
      skillName: result.name,
      scope: result.scope,
      summary: result.update.summary,
      updatedAt: result.update.updated_at,
      updatedBy: 'conversation' as const,
    } : null
    return { ok: true, skillName: result.name, scope: result.scope, changed: result.changed, summary, event }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
