import { describe, expect, it } from 'vitest'
import { describeAdapterForSkill } from '../dedicated-agents/skill-author.js'

describe('dedicated Agent Skill author confirmation guidance', () => {
  it('describes write semantics without generic confirmation prompts', () => {
    const description = describeAdapterForSkill({
      id: 'example.com',
      name: 'Example',
      description: 'Example Adapter',
      requiresAuth: true,
      authCheckTool: 'example.com.check-login-status',
      tools: [
        { name: 'example.com.run', description: 'Run a command', parameters: {}, safety: 'write', requiresConfirmation: false },
        { name: 'example.com.delete', description: 'Delete an item', parameters: {}, safety: 'write', requiresConfirmation: true },
      ],
    })

    expect(description).toContain('example.com.run【写操作】')
    expect(description).toContain('example.com.delete【写操作】')
    expect(description).toContain('直接调用用户请求的业务工具')
    expect(description).toContain('仅在用户明确询问登录状态时')
    expect(description).not.toContain('操作前先执行')
    expect(description).not.toContain('执行前先向用户确认')
  })
})
