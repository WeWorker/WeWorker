import { describe, expect, it, vi } from 'vitest'
import type { DedicatedAgentRecord } from '../dedicated-agents/agent-store.js'

vi.mock('../dedicated-agents/agent-runtime.js', () => ({
  buildAgentChatOptions: vi.fn(() => ({
    isolatedClaudeConfigDir: 'C:/weworker-fixtures/agent0001/claude-config',
    appendSystemPrompt: '## WeWorker Bot',
    agentCwd: 'C:/weworker-fixtures/workspace',
    extraDisallowedTools: ['mcp__weworker__weworker_powershell'],
  })),
}))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))

import { buildDesktopAgentTurnOptions } from '../dedicated-agents/agent-channel.js'
import { isDedicatedAgentOwner } from '../tools.js'

describe('dedicated agent desktop turns', () => {
  it('runs without long-term memory and keeps the agent working directory', () => {
    const options = buildDesktopAgentTurnOptions({
      id: 'agent0001', site_ids: [], skill_names: [], work_dir: 'C:/weworker-fixtures/workspace',
    } as unknown as DedicatedAgentRecord)
    expect(options.memoryEnabled).toBe(false)
    expect(options.isolatedClaudeConfigDir).toBe('C:/weworker-fixtures/agent0001/claude-config')
    expect(options.agentCwd).toBe('C:/weworker-fixtures/workspace')
  })
})

describe('isDedicatedAgentOwner', () => {
  it('treats desktop turns as the local owner even without a paired owner id', () => {
    expect(isDedicatedAgentOwner({ desktop: true, ownerUserId: '' })).toBe(true)
    expect(isDedicatedAgentOwner({ desktop: true, ownerUserId: 'wecom-user', actorUserId: 'someone-else' })).toBe(true)
  })

  it('keeps the IM owner rules for non-desktop turns', () => {
    expect(isDedicatedAgentOwner({ ownerUserId: '' })).toBe(false)
    expect(isDedicatedAgentOwner(undefined)).toBe(false)
    expect(isDedicatedAgentOwner({ ownerUserId: 'wecom-user' })).toBe(true)
    expect(isDedicatedAgentOwner({ ownerUserId: 'wecom-user', actorUserId: 'wecom-user' })).toBe(true)
    expect(isDedicatedAgentOwner({ ownerUserId: 'wecom-user', actorUserId: 'other' })).toBe(false)
  })
})

describe('buildDesktopAgentTurnOptions wiring', () => {
  it('marks the turn as desktop so owner checks pass', async () => {
    const { buildAgentChatOptions } = await import('../dedicated-agents/agent-runtime.js')
    buildDesktopAgentTurnOptions({ id: 'agent0001', site_ids: [], skill_names: [], work_dir: '' } as unknown as DedicatedAgentRecord)
    expect(buildAgentChatOptions).toHaveBeenCalledWith(expect.objectContaining({ desktop: true }))
  })
})
