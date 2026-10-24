import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildContextAssembly,
  buildEnabledSkillIndex,
  estimateContextTokens,
  splitSystemPromptForContext,
} from '../context-assembly.js'
import { DEFAULT_CONTEXT_LIMIT, parseContextLimit } from '../context-window.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('context assembly', () => {
  it('keeps conversation separate from long-term memory in the SDK request', () => {
    const systemPrompt = 'style rules\n---\nYou are WeWorker.\nNever expose secrets.'
    const result = buildContextAssembly({
      systemPrompt,
      identityPrompt: 'You are WeWorker.',
      prompt: 'User: continue',
      toolDefinitions: 'Read\nWrite',
      skillIndex: 'webcli: website operations',
      mcpDynamicTools: 'ask_user: request a choice',
    })

    expect(result.sdk.system_prompt).toBe(systemPrompt)
    expect(result.sdk.prompt).toBe('User: continue')
    expect(result.runtime.system_prompt).toBe('You are WeWorker.')
    expect(result.runtime.rules).not.toContain('You are WeWorker.')
    expect(result.snapshot.categories.find((item) => item.id === 'conversation')?.estimated_tokens).toBeGreaterThan(0)
    expect(result.snapshot.estimated_total_tokens).toBe(
      result.snapshot.categories.reduce((sum, item) => sum + item.estimated_tokens, 0),
    )
    expect(result.snapshot.context_limit).toBe(DEFAULT_CONTEXT_LIMIT)
  })

  it('places recalled memory in the system prompt instead of the compressible conversation', () => {
    const result = buildContextAssembly({
      systemPrompt: 'system rules',
      identityPrompt: 'missing',
      prompt: 'User: continue',
      recalledMemory: 'workflow memory',
    })

    expect(result.sdk.system_prompt).toContain('[相关长期记忆]\nworkflow memory')
    expect(result.sdk.prompt).toBe('User: continue')
    expect(result.snapshot.categories.find((item) => item.id === 'long_term_memory')?.estimated_tokens).toBeGreaterThan(0)
  })

  it('falls back to classifying the full system prompt as rules when identity is absent', () => {
    expect(splitSystemPromptForContext('rules only', 'missing')).toEqual({
      system_prompt: '',
      rules: 'rules only',
    })
  })

  it('estimates Chinese and Latin text deterministically', () => {
    expect(estimateContextTokens('测试')).toBe(2)
    expect(estimateContextTokens('abcdefgh')).toBe(2)
    expect(estimateContextTokens('')).toBe(0)
  })

  it('parses context window presets and rejects invalid values', () => {
    expect(parseContextLimit('200K')).toBe(200_000)
    expect(parseContextLimit('1M')).toBe(1_000_000)
    expect(parseContextLimit('1.5M')).toBe(1_500_000)
    expect(parseContextLimit('1000000')).toBeNull()
    expect(parseContextLimit('1G')).toBeNull()
    expect(parseContextLimit('invalid')).toBeNull()
  })

  it('indexes enabled SKILL.md files without reading disabled skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-context-skills-'))
    tempDirs.push(root)
    fs.mkdirSync(path.join(root, 'enabled'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'enabled', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Run demo workflows\n---\n# Details',
    )
    fs.mkdirSync(path.join(root, 'disabled'), { recursive: true })
    fs.writeFileSync(path.join(root, 'disabled', 'SKILL.md.disabled'), '# Disabled')

    expect(buildEnabledSkillIndex(root)).toBe('demo-skill: Run demo workflows')
  })
})
