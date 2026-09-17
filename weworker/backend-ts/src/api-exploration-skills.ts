import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_EXPLORATION_SKILL_BUNDLE_VERSION = '2026-09-01.v1'

export const API_EXPLORATION_SKILL_IDS = [
  'usage',
  'discovery',
  'strategy-selection',
  'action-probing',
  'field-decoding',
  'verification',
  'autofix',
] as const

export type ApiExplorationSkillId = typeof API_EXPLORATION_SKILL_IDS[number]

interface SkillRegistryEntry {
  id: ApiExplorationSkillId
  name: string
  directory: string
  loadWhen: string
  derivedFrom: string[]
}

interface SkillRegistryFile {
  schemaVersion: number
  bundleVersion: string
  upstream: {
    project: string
    version: string
    license: string
    copyright: string
  }
  skills: SkillRegistryEntry[]
}

export interface ApiExplorationSkill {
  id: ApiExplorationSkillId
  name: string
  description: string
  version: string
  loadWhen: string
  content: string
  source: {
    project: string
    version: string
    license: string
    copyright: string
    derivedFrom: string[]
    modified: true
  }
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
let cachedRegistry: SkillRegistryFile | null = null
let cachedRoot = ''
const cachedSkills = new Map<ApiExplorationSkillId, ApiExplorationSkill>()

function resolveBuiltInSkillsRoot(): string {
  const candidates = [
    path.resolve(MODULE_DIR, '../api-exploration-skills'),
    path.resolve(MODULE_DIR, 'api-exploration-skills'),
  ]
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'registry.json')))
  if (!root) throw new Error('内置 API 探索 Skill 资源缺失')
  return root
}

function assertRegistry(value: unknown): SkillRegistryFile {
  if (!value || typeof value !== 'object') throw new Error('内置 API 探索 Skill Registry 无效')
  const registry = value as Partial<SkillRegistryFile>
  if (registry.schemaVersion !== 1 || registry.bundleVersion !== API_EXPLORATION_SKILL_BUNDLE_VERSION) {
    throw new Error('内置 API 探索 Skill Registry 版本不匹配')
  }
  if (!registry.upstream || registry.upstream.project !== 'OpenCLI' || registry.upstream.license !== 'Apache-2.0') {
    throw new Error('内置 API 探索 Skill 来源信息无效')
  }
  if (!Array.isArray(registry.skills)) throw new Error('内置 API 探索 Skill 列表无效')
  const ids = registry.skills.map((entry) => entry?.id)
  if (JSON.stringify(ids) !== JSON.stringify(API_EXPLORATION_SKILL_IDS)) {
    throw new Error('内置 API 探索 Skill 列表与代码不匹配')
  }
  for (const entry of registry.skills) {
    if (!entry.name || !entry.directory || !entry.loadWhen || !Array.isArray(entry.derivedFrom)) {
      throw new Error('内置 API 探索 Skill 元数据不完整')
    }
    if (entry.directory !== entry.name || !/^weworker-api-[a-z0-9-]+$/.test(entry.directory)) {
      throw new Error('内置 API 探索 Skill 目录不合法')
    }
  }
  return registry as SkillRegistryFile
}

function loadRegistry(): { root: string; registry: SkillRegistryFile } {
  const root = resolveBuiltInSkillsRoot()
  if (cachedRegistry && cachedRoot === root) return { root, registry: cachedRegistry }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'))
  } catch {
    throw new Error('内置 API 探索 Skill Registry 无法读取')
  }
  cachedRoot = root
  cachedRegistry = assertRegistry(parsed)
  cachedSkills.clear()
  return { root, registry: cachedRegistry }
}

function parseSkillMarkdown(raw: string): { name: string; description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('内置 API 探索 Skill 缺少有效 frontmatter')
  const metadata = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    metadata.set(key, value)
  }
  const name = metadata.get('name') || ''
  const description = metadata.get('description') || ''
  const content = match[2].trim()
  if (!name || !description || !content) throw new Error('内置 API 探索 Skill 内容不完整')
  return { name, description, content }
}

export function listApiExplorationSkills(): Array<Omit<ApiExplorationSkill, 'content'>> {
  const { registry } = loadRegistry()
  return registry.skills.map((entry) => {
    const skill = getApiExplorationSkill(entry.id)
    const { content: _content, ...metadata } = skill
    return metadata
  })
}

export function getApiExplorationSkill(id: ApiExplorationSkillId): ApiExplorationSkill {
  const cached = cachedSkills.get(id)
  if (cached) return structuredClone(cached)
  const { root, registry } = loadRegistry()
  const entry = registry.skills.find((item) => item.id === id)
  if (!entry) throw new Error('未知的内置 API 探索 Skill')
  let parsed: ReturnType<typeof parseSkillMarkdown>
  try {
    parsed = parseSkillMarkdown(fs.readFileSync(path.join(root, entry.directory, 'SKILL.md'), 'utf8'))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('内置 API 探索 Skill')) throw error
    throw new Error('内置 API 探索 Skill 无法读取')
  }
  if (parsed.name !== entry.name) throw new Error('内置 API 探索 Skill 名称不匹配')
  const skill: ApiExplorationSkill = {
    id,
    name: entry.name,
    description: parsed.description,
    version: registry.bundleVersion,
    loadWhen: entry.loadWhen,
    content: parsed.content,
    source: {
      ...registry.upstream,
      derivedFrom: [...entry.derivedFrom],
      modified: true,
    },
  }
  cachedSkills.set(id, skill)
  return structuredClone(skill)
}
