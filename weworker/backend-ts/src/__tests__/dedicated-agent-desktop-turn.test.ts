import { describe, expect, it, vi } from 'vitest'
import type { DedicatedAgentRecord } from '../dedicated-agents/agent-store.js'

vi.mock('../dedicated-agents/agent-runtime.js', () => ({
  buildAgentChatOptions: () => ({
    isolatedClaudeConfigDir: 'C:/weworker-fixtures/agent0001/claude-config',
    appendSystemPrompt: '## WeWorker Bot',
    agentCwd: 'C:/weworker-fixtures/workspace',
    extraDisallowedTools: ['mcp__weworker__weworker_powershell'],
  }),
}))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))

import { buildDesktopAgentTurnOptions } from '../dedicated-agents/agent-channel.js'

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
