/**
 * Skills used by dedicated agents.
 *
 * - private: stored in the agent skill library; only dedicated agents see them.
 * - public:  stored in the runtime skills dir; the main chat and 「Adapter、Skill 与场景」 see them too.
 *
 * Names are unique across both locations, so an agent references a skill by name.
 */
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDirectory } from '../config.js'
import { getRuntimeSkillsDir } from '../runtime-skills-dir.js'
import { DedicatedAgentError, normalizeSkillName } from './agent-store.js'

export type SkillScope = 'private' | 'public'

/** Bundled skills that are not user knowledge. */
export const BUILTIN_SKILLS = new Set(['webcli', 'personal-codewords', 'complex-task-planner'])
const MAX_SKILL_BYTES = 200_000

export interface SkillLocations {
  runtimeSkillsDir?: string
  libraryDir?: string
}

export function getAgentSkillLibraryDir(): string {
  return process.env.WEWORKER_AGENT_SKILL_LIBRARY_DIR
    || path.join(getConfigDirectory(), 'dedicated-agents', 'skill-library')
}

function roots(locations: SkillLocations = {}): Record<SkillScope, string> {
  return {
    private: locations.libraryDir ?? getAgentSkillLibraryDir(),
    public: locations.runtimeSkillsDir ?? getRuntimeSkillsDir(),
  }
}

function hasSkillFile(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SKILL.md'))
}

/** Private library first, then the public runtime skills dir. */
export function locateSkill(name: string, locations: SkillLocations = {}): { scope: SkillScope; dir: string } | null {
  if (!name) return null
  const all = roots(locations)
  for (const scope of ['private', 'public'] as const) {
    const dir = path.join(all[scope], name)
    if (hasSkillFile(dir)) return { scope, dir }
  }
  return null
}

function existsAnywhere(name: string, locations: SkillLocations): boolean {
  const all = roots(locations)
  return fs.existsSync(path.join(all.private, name)) || fs.existsSync(path.join(all.public, name))
}

export function listTakenSkillNames(locations: SkillLocations = {}): Set<string> {
  const names = new Set<string>()
  for (const root of Object.values(roots(locations))) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name)
      }
    } catch {
      // Missing directory.
    }
  }
  return names
}

export function readSkillDescription(markdown: string): string {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const line = frontmatter.split(/\r?\n/).find((entry) => /^\s*description\s*:/.test(entry)) ?? ''
  return line.replace(/^\s*description\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '')
}

export interface AgentSkillEntry {
  name: string
  description: string
  scope: SkillScope
}

/** User skills an agent can use (bundled and Adapter-managed skills excluded). */
export function listAgentSkills(locations: SkillLocations = {}): AgentSkillEntry[] {
  const all = roots(locations)
  const result = new Map<string, AgentSkillEntry>()
  for (const scope of ['private', 'public'] as const) {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(all[scope], { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || BUILTIN_SKILLS.has(entry.name) || entry.name.startsWith('webcli')) continue
      if (result.has(entry.name)) continue
      const file = path.join(all[scope], entry.name, 'SKILL.md')
      if (!fs.existsSync(file)) continue
      try {
        result.set(entry.name, { name: entry.name, description: readSkillDescription(fs.readFileSync(file, 'utf8')), scope })
      } catch {
        // Unreadable skill: skip.
      }
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function readAgentSkill(name: string, locations: SkillLocations = {}): { name: string; scope: SkillScope; markdown: string } {
  const safe = normalizeSkillName(name)
  const located = locateSkill(safe, locations)
  if (!located) throw new DedicatedAgentError('Skill 不存在', 404)
  return { name: safe, scope: located.scope, markdown: fs.readFileSync(path.join(located.dir, 'SKILL.md'), 'utf8') }
}

function assertSize(markdown: string): void {
  if (Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_BYTES) throw new DedicatedAgentError('Skill 内容过长')
}

export function createAgentSkill(name: string, markdown: string, scope: SkillScope, locations: SkillLocations = {}): { name: string; scope: SkillScope } {
  const safe = normalizeSkillName(name)
  if (!safe) throw new DedicatedAgentError('请填写 Skill 名称')
  if (BUILTIN_SKILLS.has(safe)) throw new DedicatedAgentError(`「${safe}」是内置 Skill 名称，请换一个`)
  if (existsAnywhere(safe, locations)) throw new DedicatedAgentError(`Skill「${safe}」已存在，请换一个名称`, 409)
  assertSize(markdown)
  const dir = path.join(roots(locations)[scope], safe)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown)
  return { name: safe, scope }
}

export function createAgentSkillPackage(
  name: string,
  markdown: string,
  files: Map<string, Buffer>,
  scope: SkillScope,
  locations: SkillLocations = {},
): { name: string; scope: SkillScope } {
  const safe = normalizeSkillName(name)
  if (!safe) throw new DedicatedAgentError('请填写 Skill 名称')
  if (BUILTIN_SKILLS.has(safe)) throw new DedicatedAgentError(`「${safe}」是内置 Skill 名称，请换一个`)
  if (existsAnywhere(safe, locations)) throw new DedicatedAgentError(`Skill「${safe}」已存在，请换一个名称`, 409)
  assertSize(markdown)
  const root = roots(locations)[scope]
  fs.mkdirSync(root, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(root, '.skill-import-'))
  try {
    fs.writeFileSync(path.join(temporary, 'SKILL.md'), markdown)
    const seen = new Set<string>()
    for (const [relativePath, content] of files) {
      const normalized = normalizePackageResourcePath(relativePath)
      if (!normalized || seen.has(normalized)) throw new DedicatedAgentError(`Skill 包含无效或重复资料路径：${relativePath}`)
      seen.add(normalized)
      const destination = path.join(temporary, ...normalized.split('/'))
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, content)
    }
    fs.renameSync(temporary, path.join(root, safe))
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  return { name: safe, scope }
}

function normalizePackageResourcePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return ''
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return ''
  const normalized = parts.join('/')
  if (normalized === 'SKILL.md' || normalized === 'SKILL.md.disabled') return ''
  return normalized
}

export function updateAgentSkill(name: string, markdown: string, locations: SkillLocations = {}): { name: string; scope: SkillScope } {
  const safe = normalizeSkillName(name)
  const located = locateSkill(safe, locations)
  if (!located) throw new DedicatedAgentError('Skill 不存在', 404)
  assertSize(markdown)
  fs.writeFileSync(path.join(located.dir, 'SKILL.md'), markdown)
  return { name: safe, scope: located.scope }
}

/** Move a skill (with its resources) between the private library and the public skills dir. */
export function moveAgentSkill(name: string, scope: SkillScope, locations: SkillLocations = {}): { name: string; scope: SkillScope } {
  const safe = normalizeSkillName(name)
  const located = locateSkill(safe, locations)
  if (!located) throw new DedicatedAgentError('Skill 不存在', 404)
  if (located.scope === scope) return { name: safe, scope }
  if (BUILTIN_SKILLS.has(safe)) throw new DedicatedAgentError('内置 Skill 不能移动')
  const target = path.join(roots(locations)[scope], safe)
  if (fs.existsSync(target)) throw new DedicatedAgentError(`目标位置已有同名 Skill「${safe}」`, 409)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(located.dir, target)
  } catch {
    // Different volume or locked directory: copy, then remove the source.
    fs.cpSync(located.dir, target, { recursive: true })
    fs.rmSync(located.dir, { recursive: true, force: true })
  }
  return { name: safe, scope }
}
