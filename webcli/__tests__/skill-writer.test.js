import { describe, it, expect } from 'vitest'
import { generateCustomSkillSkillContent, generateSkillContent } from '../skill-writer.js'

describe('generateCustomSkillSkillContent', () => {
  it('writes editor markdown verbatim without wrapping', () => {
    const markdown = [
      '本技能所需文件 `run.bat` 位于 {{skill.path}} 下。',
      '',
      '---',
      'name: "test.send.email"',
      'description: "测试 skill"',
      'allowed-tools: Bash(webcli *)',
      '---',
      '',
      '## 操作步骤',
      '',
      '1. 执行 run.bat',
    ].join('\n')

    const content = generateCustomSkillSkillContent(
      { id: 'ai-platform.example.com', name: 'ai-platform.example.com' },
      { name: 'test.send.email', markdown },
    )

    expect(content).toBe(`${markdown}\n`)
    expect(content).not.toContain('User-defined skill for')
    expect(content).not.toContain('No direct `webcli call`')
  })

  it('returns empty string for missing markdown', () => {
    const content = generateCustomSkillSkillContent(
      { id: 'ai-platform.example.com', name: 'ai-platform.example.com' },
      { name: 'test.send.email', markdown: '   ' },
    )
    expect(content).toBe('')
  })

  it('documents direct execution without requiring the target page first', () => {
    const content = generateSkillContent(
      { id: 'itsm.example.com', name: 'ITSM', description: 'ITSM', match: ['itsm.example.com'], requires_auth: true },
      [{
        name: 'itsm.example.com.list_tickets',
        description: '列表查询',
        directCapable: true,
        executionMode: 'direct',
        params: [],
      }],
    )

    expect(content).toContain('Execution: type=api, runtime=background')
    expect(content).toContain('Execution: mode=direct')
    expect(content).toContain('can run without opening the target website first')
    expect(content).toContain('WeWorker handles login')
    expect(content).toContain('do not check login first')
  })

  it('treats manifest API background execution metadata as direct', () => {
    const content = generateSkillContent(
      { id: 'itsm.example.com', name: 'ITSM', description: 'ITSM', match: ['itsm.example.com'] },
      [{
        name: 'itsm.example.com.ls',
        description: '列表查询',
        execution: { type: 'api', runtime: 'background' },
        params: [],
      }],
    )

    expect(content).toContain('Execution: type=api, runtime=background')
    expect(content).toContain('Execution: mode=direct')
  })
})
