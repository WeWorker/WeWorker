import { describe, expect, it, vi } from 'vitest'
import type { DedicatedAgentRecord } from '../dedicated-agents/agent-store.js'

vi.mock('../dedicated-agents/agent-runtime.js', () => ({
  buildAgentChatOptions: () => ({
    isolatedClaudeConfigDir: 'C:/weworker-fixtures/agent0001/claude-config',
    appendSystemPrompt: '## WeWorker Bot',
    extraDisallowedTools: ['Write'],
  }),
}))
vi.mock('../adapter-parser.js', () => ({ parseAllAdapters: () => new Map() }))

import { buildDesktopAgentTurnOptions } from '../dedicated-agents/agent-channel.js'

describe('dedicated agent desktop turns', () => {
  it('runs without long-term memory', () => {
    const options = buildDesktopAgentTurnOptions({ id: 'agent0001', site_id: 'example.com' } as DedicatedAgentRecord)
    expect(options.memoryEnabled).toBe(false)
    expect(options.isolatedClaudeConfigDir).toBe('C:/weworker-fixtures/agent0001/claude-config')
  })
})
