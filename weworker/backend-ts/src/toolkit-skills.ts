/**
 * 已毕业 toolkit skill 识别（`docs/intelligent_routing_design.md` §2 第 16 行「毕业管线」）。
 *
 * 网站探索agent的 Toolkit 固化成包后会安装到 `getUserDirectory()/.claude/skills/<id>/`
 * （`manifest.json` 声明 `adapter_type:"toolkit"` + `allowed_domains` + `tools` schema）。
 * 本模块让路由层（siteGate 候选 / 预注入）认识这些**已毕业站点**：它们回到第3层并预注入
 * toolkit 工具清单，不再被第4层重复探索。
 *
 * 边界：只读 `<user_directory>/.claude/skills/`——与 Electron 注入的 `weworker_USER_FILES_DIR`
 * 同一条许可路径（`agent.ts` 的 skillRoots 已在此读取）；不触碰设置文件、数据库或其它 WeWorker 数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { StaticToolDef } from './adapter-parser.js'
import { getUserDirectory } from './config.js'
import { formatSiteToolkitPrompt, type SiteToolkit } from './site-gate.js'

export interface ToolkitSkill {
  id: string
  name: string
  /** `allowed_domains` 小写归一；兼作 siteGate 的 `match` 候选。 */
  hosts: string[]
  /** 已映射为 `StaticToolDef` 形状（toolkit 走本地 Toolkit Runtime，无扩展页面依赖）。 */
  tools: StaticToolDef[]
}

export interface ToolkitSkillsDeps {
  skillsDir?: string
}

interface ToolkitManifest {
  id?: string
  name?: string
  adapter_type?: string
  allowed_domains?: unknown
  tools?: Array<{
    id?: string
    name?: string
    description?: string
    parameters_schema?: Record<string, unknown>
  }>
}

/** 扫描目录下的 toolkit manifest；坏条目跳过，绝不抛（识别失败 = 视为未毕业，回第4层）。 */
function scanToolkitSkills(skillsDir: string): ToolkitSkill[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: ToolkitSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(skillsDir, entry.name, 'manifest.json')
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ToolkitManifest
      if (manifest?.adapter_type !== 'toolkit') continue
      const hosts = [
        ...new Set(
          (Array.isArray(manifest.allowed_domains) ? manifest.allowed_domains : [])
            .map((host) => String(host || '').trim().toLowerCase())
            .filter(Boolean),
        ),
      ]
      if (!hosts.length) continue
      const id = String(manifest.id || entry.name)
      const tools: StaticToolDef[] = (manifest.tools ?? [])
        .filter((tool) => tool && typeof tool.name === 'string' && tool.name)
        .map((tool) => ({
          name: String(tool.name),
          description: String(tool.description ?? ''),
          parameters: tool.parameters_schema ?? {},
          // toolkit 走本地 Toolkit Runtime（`webcli call` 直接执行），与 direct 组同语义。
          directCapable: true,
          executionMode: 'direct',
        }))
      result.push({ id, name: String(manifest.name || id), hosts, tools })
    } catch {
      // 坏 JSON / 缺字段：跳过该 skill。
    }
  }
  return result
}

const toolkitSkillsCache = new Map<string, { skills: ToolkitSkill[]; at: number }>()
const TOOLKIT_SKILLS_TTL_MS = 5 * 60_000

export function clearToolkitSkillsCache(): void {
  toolkitSkillsCache.clear()
}

/** 列出已安装的 toolkit skill（TTL 5 分钟缓存；安装/变更后靠过期自动刷新）。 */
export function listToolkitSkills(deps: ToolkitSkillsDeps = {}): ToolkitSkill[] {
  const skillsDir = deps.skillsDir ?? path.join(getUserDirectory(), '.claude', 'skills')
  const cached = toolkitSkillsCache.get(skillsDir)
  if (cached && Date.now() - cached.at < TOOLKIT_SKILLS_TTL_MS) return cached.skills
  const skills = scanToolkitSkills(skillsDir)
  toolkitSkillsCache.set(skillsDir, { skills, at: Date.now() })
  return skills
}

/** siteGate 候选形状（`matchSiteAdapter` 只读 id/name/match）。 */
export function toolkitGateCandidates(skills: ToolkitSkill[]): Array<{ id: string; name: string; match: string[] }> {
  return skills.map((skill) => ({ id: skill.id, name: skill.name, match: skill.hosts }))
}

/** 预注入：toolkit 工具清单 → 与 adapter 站点同构的速查 prompt（复用 `formatSiteToolkitPrompt`）。 */
export function resolveToolkitSkillPrompt(skill: ToolkitSkill): SiteToolkit {
  return formatSiteToolkitPrompt({ name: skill.name, match: skill.hosts }, skill.tools)
}
