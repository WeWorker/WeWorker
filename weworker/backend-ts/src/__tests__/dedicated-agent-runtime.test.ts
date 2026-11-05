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
  site_id: 'example.com',
  skill_name: 'inventory-helper',
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

  it('mirrors the selected skills into an isolated config dir and removes stale ones', () => {
    const staleDir = path.join(getAgentClaudeConfigDir('agent0001', agentsRoot), 'skills', 'unrelated-public')
    fs.mkdirSync(staleDir, { recursive: true })
    const synced = syncAgentSkills(agent(), { runtimeSkillsDir, agentsRoot, libraryDir })
    const skillsDir = path.join(synced.claudeConfigDir, 'skills')
    expect(fs.readdirSync(skillsDir).sort()).toEqual(['inventory-helper', 'orders-checklist', 'webcli', 'webcli-example.com'])
    expect(fs.readFileSync(path.join(skillsDir, 'inventory-helper', 'reference', 'fields.md'), 'utf8')).toBe('SKU, quantity\n')
    expect(synced.missingPrivateSkill).toBe(false)

    // A second sync with the same sources keeps the copy; an edit is picked up.
    const skillFile = path.join(libraryDir, 'inventory-helper', 'SKILL.md')
    fs.writeFileSync(skillFile, '---\nname: inventory-helper\ndescription: "updated"\n---\n\nUpdated body for staging\n')
    syncAgentSkills(agent(), { runtimeSkillsDir, agentsRoot, libraryDir })
    expect(fs.readFileSync(path.join(skillsDir, 'inventory-helper', 'SKILL.md'), 'utf8')).toContain('Updated body')
  })

  it('reports a missing chosen skill and omits the load instruction', () => {
    const options = buildAgentChatOptions({
      agent: agent({ skill_name: 'missing-skill' }),
      siteName: 'Example',
      runtimeSkillsDir,
      agentsRoot,
      libraryDir,
      knownSiteIds: ['example.com', 'example.org'],
    })
    expect(options.isolatedClaudeConfigDir).toBe(getAgentClaudeConfigDir('agent0001', agentsRoot))
    expect(options.appendSystemPrompt).not.toContain('missing-skill')
    expect(options.extraDisallowedTools).toContain('Write')
    expect(options.extraToolGuard?.('Bash', { command: 'webcli call example.org.search' }).behavior).toBe('deny')
    expect(options.extraToolGuard?.('Bash', { command: 'webcli call example.com.search' }).behavior).toBe('allow')
  })

  it('builds a focused system prompt', () => {
    const prompt = buildAgentSystemPrompt({ agent: agent(), siteName: 'Example', privateSkillAvailable: true })
    expect(prompt).toContain('WeWorker Bot')
    expect(prompt).toContain('example.com')
    expect(prompt).toContain('inventory-helper')
    expect(prompt).toContain('webcli call example.com.<工具名>')
    expect(prompt).toContain('调用前不要执行 `open_browser` 或登录状态检查')
    expect(prompt).toContain('Host-managed Extension Adapter')
    // The private Skill is loaded once per conversation, not on every turn.
    expect(prompt).toContain('本对话中第一次处理请求前')
    expect(prompt).toContain('不要重复加载')
    expect(prompt).not.toContain('每个会话处理第一个请求前')
    // Unrecoverable errors must not trigger blind waits or retries.
    expect(prompt).toContain('webcli trace')
    expect(prompt).toContain('不要 Start-Sleep')
    expect(prompt).toContain('主动消息工具')
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
