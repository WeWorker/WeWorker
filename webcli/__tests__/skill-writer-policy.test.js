import { describe, expect, it } from 'vitest'
import { generateSkillContent } from '../skill-writer.js'

describe('adapter skill writer security policy', () => {
  it('generates skills that only allow webcli call commands', () => {
    const skill = generateSkillContent(
      { id: 'expense.example.com', name: 'ExpenseDemo', description: 'cost', match: ['expense.example.com'] },
      [{ name: 'expense.example.com.check_login_status', description: 'check', params: [] }],
    )

    expect(skill).toContain('allowed-tools: Bash(webcli call *)')
    expect(skill).not.toContain('allowed-tools: Bash(webcli *)')
  })
})
