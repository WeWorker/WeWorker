import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentSkill, readAgentSkill } from '../dedicated-agents/skill-library.js'
import { applyConversationSkillUpdate, listSkillUpdates, updateSkillWithHistory } from '../dedicated-agents/skill-updates.js'

const BODY = (text: string) => `---\nname: mail-helper\ndescription: "mail helper"\n---\n\n${text}\n`

describe('skill update history and version archive', () => {
  let root = ''
  let libraryDir = ''
  let runtimeSkillsDir = ''
  let versionsRoot = ''
  let historyFile = ''
  let locations: { runtimeSkillsDir: string; libraryDir: string; versionsRoot: string; historyFile: string }

  const locationsFixture = () => ({ runtimeSkillsDir, libraryDir, versionsRoot, historyFile })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-skill-updates-'))
    libraryDir = path.join(root, 'skill-library')
    runtimeSkillsDir = path.join(root, 'claude-config', 'skills')
    versionsRoot = path.join(root, 'skill-versions')
    historyFile = path.join(root, 'skill-updates.json')
    locations = locationsFixture()
    createAgentSkill('mail-helper', BODY('v1'), 'private', locations)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('archives the previous version and records a conversation update', () => {
    const result = updateSkillWithHistory({
      name: 'mail-helper',
      markdown: BODY('v2'),
      source: 'conversation',
      actor: 'owner-user',
      agentId: 'agent0001',
      agentName: 'Mail Bot',
      summary: '新增按日期倒序查邮件',
      locations,
    })
    expect(result.changed).toBe(true)
    expect(result.scope).toBe('private')
    expect(readAgentSkill('mail-helper', locations).markdown).toContain('v2')

    const versions = fs.readdirSync(path.join(versionsRoot, 'mail-helper'))
    expect(versions).toHaveLength(1)
    expect(fs.readFileSync(path.join(versionsRoot, 'mail-helper', versions[0]), 'utf8')).toContain('v1')

    const updates = listSkillUpdates(locations)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      skill_name: 'mail-helper',
      scope: 'private',
      source: 'conversation',
      actor: 'owner-user',
      agent_id: 'agent0001',
      agent_name: 'Mail Bot',
      summary: '新增按日期倒序查邮件',
      archived_to: versions[0],
    })
  })

  it('forces the frontmatter name and skips identical rewrites', () => {
    const first = updateSkillWithHistory({
      name: 'mail-helper', markdown: BODY('v2'), source: 'desktop', actor: 'desktop', summary: 'first', locations,
    })
    expect(first.changed).toBe(true)
    // The frontmatter name is forced even when the caller sends another name.
    expect(readAgentSkill('mail-helper', locations).markdown).toMatch(/^---\nname: mail-helper\n/)

    const noop = updateSkillWithHistory({
      name: 'mail-helper', markdown: BODY('v2'), source: 'conversation', actor: 'owner', summary: 'noop', locations,
    })
    expect(noop.changed).toBe(false)
    expect(noop.update).toBeNull()
    expect(fs.readdirSync(path.join(versionsRoot, 'mail-helper'))).toHaveLength(1)
    expect(listSkillUpdates(locations)).toHaveLength(1)
  })

  it('caps archived versions and history entries', () => {
    for (let index = 2; index <= 8; index += 1) {
      updateSkillWithHistory({
        name: 'mail-helper', markdown: BODY(`v${index}`), source: 'desktop', actor: 'desktop',
        summary: `change ${index}`, locations,
      })
    }
    expect(fs.readdirSync(path.join(versionsRoot, 'mail-helper')).length).toBeLessThanOrEqual(5)

    for (let index = 0; index < 60; index += 1) {
      const entries = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as Array<{ id: string; skill_name?: string; updated_at?: string }>
      entries.push({ id: `filler-${index}`, skill_name: 'other', updated_at: '2000-01-01T00:00:00.000Z' })
      fs.writeFileSync(historyFile, JSON.stringify(entries))
      updateSkillWithHistory({
        name: 'mail-helper', markdown: BODY(`filler-${index}`), source: 'desktop', actor: 'desktop',
        summary: 'filler', locations,
      })
    }
    expect(listSkillUpdates(locations).length).toBeLessThanOrEqual(50)
    // Newest first, and the newest entry is a real mail-helper update.
    expect(listSkillUpdates(locations)[0].skill_name).toBe('mail-helper')
  })

  it('rejects unknown skills', () => {
    expect(() => updateSkillWithHistory({
      name: 'missing-helper', markdown: BODY('x'), source: 'conversation', actor: 'owner', summary: 'x', locations,
    })).toThrow('Skill 不存在')
  })

  it('reads an empty or malformed history file as no updates', () => {
    fs.writeFileSync(historyFile, 'not json')
    expect(listSkillUpdates(locations)).toEqual([])
  })

  describe('conversation-driven update', () => {
    const agent = (overrides: Record<string, unknown> = {}) => ({
      id: 'agent0001',
      name: 'Mail Bot',
      enabled: true,
      skill_names: ['mail-helper'],
      owner_user_id: 'owner-user',
      ...overrides,
    })
    const ask = (overrides: Record<string, unknown> = {}) => applyConversationSkillUpdate({
      agent: agent(),
      skillName: 'mail-helper',
      markdown: BODY('v2'),
      changeSummary: '新增按日期倒序查邮件',
      locations,
      ...overrides,
    })

    it('lets the owner rewrite an own skill and returns the SSE event', () => {
      const outcome = ask()
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.changed).toBe(true)
      expect(outcome.skillName).toBe('mail-helper')
      expect(outcome.event).toMatchObject({
        type: 'agent_skill_updated',
        agentId: 'agent0001',
        skillName: 'mail-helper',
        summary: '新增按日期倒序查邮件',
        updatedBy: 'conversation',
      })
      expect(readAgentSkill('mail-helper', locations).markdown).toContain('v2')
      // Desktop turns pass no actor: the desktop user is the owner.
      expect(ask({ actorUserId: undefined }).ok).toBe(true)
    })

    it('rejects non-owner actors, foreign skills, disabled agents and no-op rewrites stay quiet', () => {
      expect(ask({ actorUserId: 'someone-else' })).toMatchObject({ ok: false, error: expect.stringContaining('主人') })
      expect(ask({ skillName: 'other-helper' })).toMatchObject({ ok: false, error: expect.stringContaining('不是本WeWorker Bot 加载的专属 Skill') })
      expect(ask({ agent: agent({ enabled: false }) })).toMatchObject({ ok: false, error: expect.stringContaining('已停用') })
      expect(ask({ skillName: '../escape' })).toMatchObject({ ok: false })

      // An identical rewrite succeeds but emits no event. The stored file
      // always holds the normalized form, so repeat the exact new markdown.
      expect(ask()).toMatchObject({ ok: true, changed: true })
      const quiet = ask()
      expect(quiet).toMatchObject({ ok: true, changed: false })
      if (quiet.ok) expect(quiet.event).toBeNull()
    })
  })
})
