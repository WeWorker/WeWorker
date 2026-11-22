import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildAgentChatOptions,
  buildAgentSystemPrompt,
  getAgentClaudeConfigDir,
  removeAgentRuntime,
  resolveAgentSkillNames,
  syncAgentSkills,
} from '../dedicated-agents/agent-runtime.js'
import type { DedicatedAgentRecord } from '../dedicated-agents/agent-store.js'
import {
  createAgentSkill,
  createAgentSkillPackage,
  listAgentSkills,
  locateSkill,
  moveAgentSkill,
  readAgentSkill,
  updateAgentSkill,
} from '../dedicated-agents/skill-library.js'

function writeSkill(root: string, name: string, extra: Record<string, string> = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${name} skill"\n---\n\n# ${name}\n`)
  for (const [file, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  return dir
}

const agent = (overrides: Partial<DedicatedAgentRecord> = {}): DedicatedAgentRecord => ({
  id: 'agent0001',
  name: 'Example Operations Assistant',
  description: 'Handles routine work on example.com',
  site_ids: ['example.com'],
  skill_names: ['inventory-helper'],
  work_dir: '',
  examples: [],
  enabled: true,
  access_mode: 'owner_only',
  wecom: { bot_id: 'placeholder-bot', secret_enc: 'placeholder' },
  owner_user_id: 'owner-user',
  pairing_code: '',
  work_ids: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('dedicated agent runtime and skill library', () => {
  let root = ''
  let runtimeSkillsDir = ''
  let libraryDir = ''
  let agentsRoot = ''

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-agent-runtime-'))
    runtimeSkillsDir = path.join(root, 'claude-config', 'skills')
    libraryDir = path.join(root, 'skill-library')
    agentsRoot = path.join(root, 'agents')
    writeSkill(runtimeSkillsDir, 'webcli')
    writeSkill(runtimeSkillsDir, 'webcli-example.com')
    writeSkill(runtimeSkillsDir, 'webcli-example.org')
    writeSkill(runtimeSkillsDir, 'orders-checklist', { '.weworker-custom-skill.json': JSON.stringify({ siteId: 'example.com' }) })
    writeSkill(runtimeSkillsDir, 'other-site-notes', { '.weworker-custom-skill.json': JSON.stringify({ siteId: 'example.org' }) })
    writeSkill(runtimeSkillsDir, 'unrelated-public')
    writeSkill(libraryDir, 'inventory-helper', { 'reference/fields.md': 'SKU, quantity\n' })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('selects only the base, site, site-custom and chosen skills', () => {
    expect(resolveAgentSkillNames(agent(), runtimeSkillsDir, libraryDir).sort()).toEqual([
      'inventory-helper', 'orders-checklist', 'webcli', 'webcli-example.com',
    ])
  })

  it('combines every chosen site and drops website skills when no site is selected', () => {
    const multi = resolveAgentSkillNames(
      agent({ site_ids: ['example.com', 'example.org'], skill_names: [] }),
      runtimeSkillsDir,
      libraryDir,
    ).sort()
    expect(multi).toEqual([
      'orders-checklist', 'other-site-notes', 'webcli', 'webcli-example.com', 'webcli-example.org',
    ])
    const plain = resolveAgentSkillNames(agent({ site_ids: [], skill_names: ['inventory-helper'] }), runtimeSkillsDir, libraryDir)
    expect(plain).toEqual(['inventory-helper'])
  })

  it('mirrors the selected skills into an isolated config dir and removes stale ones', () => {
    const staleDir = path.join(getAgentClaudeConfigDir('agent0001', agentsRoot), 'skills', 'unrelated-public')
    fs.mkdirSync(staleDir, { recursive: true })
    const synced = syncAgentSkills(agent(), { runtimeSkillsDir, agentsRoot, libraryDir })
    const skillsDir = path.join(synced.claudeConfigDir, 'skills')
    expect(fs.readdirSync(skillsDir).sort()).toEqual(['inventory-helper', 'orders-checklist', 'webcli', 'webcli-example.com'])
    expect(fs.readFileSync(path.join(skillsDir, 'inventory-helper', 'reference', 'fields.md'), 'utf8')).toBe('SKU, quantity\n')
    expect(synced.missingPrivateSkills).toEqual([])

    // A second sync with the same sources keeps the copy; an edit is picked up.
    const skillFile = path.join(libraryDir, 'inventory-helper', 'SKILL.md')
    fs.writeFileSync(skillFile, '---\nname: inventory-helper\ndescription: "updated"\n---\n\nUpdated body for staging\n')
    syncAgentSkills(agent(), { runtimeSkillsDir, agentsRoot, libraryDir })
    expect(fs.readFileSync(path.join(skillsDir, 'inventory-helper', 'SKILL.md'), 'utf8')).toContain('Updated body')
  })

  it('reports missing chosen skills and keeps the agent usable without them', () => {
    const synced = syncAgentSkills(agent({ skill_names: ['inventory-helper', 'missing-skill'] }), {
      runtimeSkillsDir,
      agentsRoot,
      libraryDir,
    })
    expect(synced.missingPrivateSkills).toEqual(['missing-skill'])
    expect(synced.skills).toContain('inventory-helper')
    expect(synced.skills).not.toContain('missing-skill')
  })

  it('builds chat options with a working directory, file tools and scoped webcli', () => {
    const workDir = path.join(root, 'workspace')
    fs.mkdirSync(workDir, { recursive: true })
    const options = buildAgentChatOptions({
      agent: agent({ site_ids: ['example.com'], skill_names: [], work_dir: workDir }),
      runtimeSkillsDir,
      agentsRoot,
      libraryDir,
      knownSiteIds: ['example.com', 'example.org'],
    })
    expect(options.isolatedClaudeConfigDir).toBe(getAgentClaudeConfigDir('agent0001', agentsRoot))
    expect(options.agentCwd).toBe(workDir)
    expect(options.extraDisallowedTools).not.toContain('Write')
    expect(options.extraDisallowedTools).not.toContain('Edit')
    expect(options.extraToolGuard?.('Write', { file_path: 'notes.txt' })).toEqual({ behavior: 'allow' })
    expect(options.extraToolGuard?.('PowerShell', { command: 'Get-ChildItem -Recurse' })).toEqual({ behavior: 'allow' })
    expect(options.extraToolGuard?.('Bash', { command: 'webcli call example.org.search' }).behavior).toBe('deny')
    expect(options.extraToolGuard?.('Bash', { command: 'git pull && webcli call example.com.search' })).toEqual({ behavior: 'allow' })
    // Agent 身份以数据形式随回合传递；回合的工具服务器（带 userMedia 出口）
    // 由 streamChat 统一构建，Bot 对话里的 send_file_to_user 不再拿不到出口。
    expect(options.dedicatedAgent).toMatchObject({ agentId: 'agent0001', ownerUserId: 'owner-user' })
    expect(options.mcpServerOverride).toBeUndefined()
  })

  it('leaves agentCwd unset for directory-less agents', () => {
    const options = buildAgentChatOptions({
      agent: agent({ site_ids: [], skill_names: [], work_dir: '' }),
      runtimeSkillsDir,
      agentsRoot,
      libraryDir,
      knownSiteIds: [],
    })
    expect(options.agentCwd).toBeUndefined()
    expect(options.appendSystemPrompt).toContain('WeWorker Bot')
    expect(options.appendSystemPrompt).not.toContain('webcli')
    expect(options.extraToolGuard?.('Bash', { command: 'webcli call example.com.search' }).behavior).toBe('deny')
  })

  it('builds a compact system prompt for sites, directory and skills', () => {
    const workDir = 'C:\\weworker-fixtures\\workspace'
    const prompt = buildAgentSystemPrompt({
      agent: agent({ site_ids: ['example.com', 'example.org'], work_dir: workDir }),
      siteNames: ['Example', 'Org'],
      availableSkills: ['inventory-helper'],
    })
    expect(prompt).toContain('WeWorker Bot')
    expect(prompt).toContain('你可以操作这些网站：Example（example.com）、Org（example.org）')
    expect(prompt).toContain('webcli call <站点ID>.<工具名>')
    expect(prompt).toContain(workDir)
    expect(prompt).toContain('CLAUDE.md')
    expect(prompt).toContain('inventory-helper')
    // The private Skill is loaded once per conversation, not on every turn.
    expect(prompt).toContain('本对话中第一次处理请求前')
    expect(prompt).toContain('不要重复加载')
    // Old focused-agent restrictions are gone.
    expect(prompt).not.toContain('一次一条')
    expect(prompt).not.toContain('只处理本网站')
    expect(prompt).not.toContain('Start-Sleep')
    expect(prompt).not.toContain('open_browser')
  })

  it('builds a minimal prompt for a plain agent without sites, directory or skills', () => {
    const prompt = buildAgentSystemPrompt({
      agent: agent({ site_ids: [], skill_names: [], work_dir: '', description: '' }),
      siteNames: [],
      availableSkills: [],
    })
    expect(prompt).toContain('WeWorker Bot')
    expect(prompt).toContain('先给结论')
    expect(prompt).not.toContain('你可以操作这些网站')
    expect(prompt).not.toContain('工作目录')
    expect(prompt).not.toContain('Skill 工具')
  })

  it('rejects unsafe agent ids and removes the runtime directory', () => {
    expect(() => getAgentClaudeConfigDir('../escape', agentsRoot)).toThrow('Invalid agent id')
    syncAgentSkills(agent(), { runtimeSkillsDir, agentsRoot, libraryDir })
    removeAgentRuntime('agent0001', agentsRoot)
    expect(fs.existsSync(path.join(agentsRoot, 'agent0001'))).toBe(false)
  })

  it('keeps new skills private by default and moves them on request', () => {
    const locations = { runtimeSkillsDir, libraryDir }
    expect(createAgentSkill('staging-helper', '---\nname: staging-helper\n---\n\nbody\n', 'private', locations)).toEqual({ name: 'staging-helper', scope: 'private' })
    expect(locateSkill('staging-helper', locations)?.scope).toBe('private')
    expect(() => createAgentSkill('staging-helper', 'x', 'private', locations)).toThrow('已存在')
    expect(() => createAgentSkill('unrelated-public', 'x', 'private', locations)).toThrow('已存在')
    expect(() => createAgentSkill('webcli', 'x', 'private', locations)).toThrow()

    expect(moveAgentSkill('staging-helper', 'public', locations)).toEqual({ name: 'staging-helper', scope: 'public' })
    expect(fs.existsSync(path.join(runtimeSkillsDir, 'staging-helper', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(libraryDir, 'staging-helper'))).toBe(false)

    updateAgentSkill('staging-helper', '---\nname: staging-helper\n---\n\nnew body\n', locations)
    expect(readAgentSkill('staging-helper', locations)).toMatchObject({ scope: 'public' })
    expect(readAgentSkill('staging-helper', locations).markdown).toContain('new body')

    const names = listAgentSkills(locations).map((skill) => skill.name)
    expect(names).toContain('staging-helper')
    expect(names).toContain('inventory-helper')
    expect(names).not.toContain('webcli')
    expect(names).not.toContain('webcli-example.com')
  })

  it('writes imported packages atomically and refuses unsafe resource paths', () => {
    const locations = { runtimeSkillsDir, libraryDir }
    createAgentSkillPackage('pack-helper', '---\nname: pack-helper\n---\n\nbody\n', new Map([['docs/a.txt', Buffer.from('a')]]), 'private', locations)
    expect(fs.readFileSync(path.join(libraryDir, 'pack-helper', 'docs', 'a.txt'), 'utf8')).toBe('a')

    expect(() => createAgentSkillPackage('bad-helper', 'x', new Map([['../escape.txt', Buffer.from('x')]]), 'private', locations)).toThrow('无效')
    expect(fs.existsSync(path.join(libraryDir, 'bad-helper'))).toBe(false)
    expect(fs.readdirSync(libraryDir).some((entry) => entry.startsWith('.skill-import-'))).toBe(false)
  })
})
