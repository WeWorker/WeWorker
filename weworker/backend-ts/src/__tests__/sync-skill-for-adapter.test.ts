import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { syncSkillForAdapter } from '../skill-generator.js'
import type { ParsedAdapter } from '../adapter-parser.js'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-test-'))
}

function makeAdapter(overrides?: Partial<ParsedAdapter>): ParsedAdapter {
  return {
    id: 'test-adapter',
    name: 'Test Adapter',
    description: 'A test adapter',
    match: ['test.com'],
    gateAliases: [],
    homepageUrl: 'https://test.com/',
    tools: [
      {
        name: 'test.com.do_thing',
        description: 'Does a thing',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    testPrompts: [],
    requiresAuth: false,
    authCheckTool: null,
    hidden: false,
    defaultEnabled: true,
    detailDescription: '',
    registryScenarios: [],
    icon: 'globe',
    promptVarDisplay: {},
    ...overrides,
  }
}

describe('syncSkillForAdapter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes SKILL.md when enabled', () => {
    const adapter = makeAdapter()
    syncSkillForAdapter(adapter, true, { skillsDir: tmpDir })

    const skillPath = path.join(tmpDir, 'test-adapter', 'SKILL.md')
    expect(fs.existsSync(skillPath)).toBe(true)

    const content = fs.readFileSync(skillPath, 'utf-8')
    expect(content).toContain('Test Adapter')
    expect(content).toContain('test.com.do_thing')
  })

  it('creates directories recursively', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested', 'skills')
    const adapter = makeAdapter()
    syncSkillForAdapter(adapter, true, { skillsDir: nestedDir })

    const skillPath = path.join(nestedDir, 'test-adapter', 'SKILL.md')
    expect(fs.existsSync(skillPath)).toBe(true)
  })

  it('removes skill directory when disabled', () => {
    const adapter = makeAdapter()
    // First create it
    syncSkillForAdapter(adapter, true, { skillsDir: tmpDir })
    expect(fs.existsSync(path.join(tmpDir, 'test-adapter'))).toBe(true)

    // Then disable it
    syncSkillForAdapter(adapter, false, { skillsDir: tmpDir })
    expect(fs.existsSync(path.join(tmpDir, 'test-adapter'))).toBe(false)
  })

  it('does nothing when disabling a non-existent adapter', () => {
    const adapter = makeAdapter()
    // Should not throw
    syncSkillForAdapter(adapter, false, { skillsDir: tmpDir })
    expect(fs.existsSync(path.join(tmpDir, 'test-adapter'))).toBe(false)
  })

  it('updates SKILL.md.disabled content without renaming when user disabled', () => {
    const adapter = makeAdapter()
    const adapterDir = path.join(tmpDir, 'test-adapter')
    const disabledPath = path.join(adapterDir, 'SKILL.md.disabled')

    // Simulate user having manually disabled the skill
    fs.mkdirSync(adapterDir, { recursive: true })
    fs.writeFileSync(disabledPath, 'old content', 'utf-8')

    syncSkillForAdapter(adapter, true, { skillsDir: tmpDir })

    // SKILL.md.disabled should be updated with new content
    expect(fs.existsSync(disabledPath)).toBe(true)
    const content = fs.readFileSync(disabledPath, 'utf-8')
    expect(content).toContain('Test Adapter')
    expect(content).not.toBe('old content')

    // SKILL.md should NOT exist (disabled state preserved)
    const skillPath = path.join(adapterDir, 'SKILL.md')
    expect(fs.existsSync(skillPath)).toBe(false)
  })

  it('overwrites existing SKILL.md with updated content', () => {
    const adapter = makeAdapter()
    syncSkillForAdapter(adapter, true, { skillsDir: tmpDir })

    // Update adapter and sync again
    const updated = makeAdapter({ name: 'Updated Adapter' })
    syncSkillForAdapter(updated, true, { skillsDir: tmpDir })

    const skillPath = path.join(tmpDir, 'test-adapter', 'SKILL.md')
    const content = fs.readFileSync(skillPath, 'utf-8')
    expect(content).toContain('Updated Adapter')
  })

  it('documents direct tools without requiring a browser or login preflight', () => {
    const adapter = makeAdapter({
      requiresAuth: true,
      authCheckTool: 'test.com.check_login_status',
      tools: [{
        name: 'test.com.list_items',
        description: 'Lists items',
        parameters: { type: 'object', properties: {}, required: [] },
        directCapable: true,
        executionMode: 'direct',
      }],
    })

    syncSkillForAdapter(adapter, true, { skillsDir: tmpDir })
    const content = fs.readFileSync(path.join(tmpDir, 'test-adapter', 'SKILL.md'), 'utf-8')

    expect(content).toContain('Execution: type=api, runtime=background')
    expect(content).toContain('Execution: mode=direct')
    expect(content).toContain('must be called without opening the website or checking login first')
    expect(content).toContain('Do not call `open_browser` or a login-check tool before direct tools')
    expect(content).not.toContain('Always use `open_browser`')
  })
})
