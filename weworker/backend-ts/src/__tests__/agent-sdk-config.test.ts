import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const agentSource = fs.readFileSync(path.resolve(__dirname, '../agent.ts'), 'utf8')

describe('agent SDK security config', () => {
  it('derives tool policy, filesystem guard, and sandbox settings from the channel mode', () => {
    expect(agentSource).toContain('createUnifiedToolGuard(channelPermissionMode)')
    expect(agentSource).toContain('createWeWorkerToolPolicy(channelPermissionMode)')
    expect(agentSource).toContain('const agentCwd = ensureAgentWorkingDirectory()')
    expect(agentSource).toContain('buildAgentFilesystemSettings(agentCwd, channelPermissionMode)')
    expect(agentSource).toContain('const policyDecision = await toolPolicy(toolName, input, context)')
    expect(agentSource).toContain('const filesystemDecision = await filesystemToolGuard(toolName, input as Record<string, unknown>)')
    expect(agentSource).toContain('if (opts.permissionMode === \'default\' && (toolName === \'Edit\' || toolName === \'Write\'))')
    expect(agentSource).toContain("options: [{ label: '允许本次' }, { label: '拒绝' }]")
    expect(agentSource).toContain('return filesystemDecision')
    expect(agentSource).toContain('canUseTool,')
    expect(agentSource).toContain("permissionMode: opts.permissionMode ?? 'default'")
    expect(agentSource).toContain("'bypassPermissions'")
    expect(agentSource).toContain('allowDangerouslySkipPermissions: true')
    expect(agentSource).toContain("channelPermissionMode === 'no_bash'")
    expect(agentSource).toContain("'WebFetch'")
    expect(agentSource).toContain("'AskUserQuestion'")
    expect(agentSource).toContain("WEWORKER_ADAPTERS_DIR: path.join(getUserDirectory(), '.claude', 'skills')")
  })

  it('keeps conversation compaction isolated from runtime and long-term context', () => {
    expect(agentSource).toContain('summarizeConversationOnly')
    expect(agentSource).toContain("tools: []")
    expect(agentSource).toContain('persistSession: false')
    expect(agentSource).toContain("type: 'context_compaction_start'")
    expect(agentSource).toContain("type: 'context_compaction_end'")
    expect(agentSource).toContain('systemPrompt: contextAssembly.sdk.system_prompt')
  })

  it('keeps post-compaction usage probing read-only and non-persistent', () => {
    expect(agentSource).toContain('probeContextUsage')
    expect(agentSource).toContain("kind: 'post_compaction_probe'")
    expect(agentSource).toContain("canUseTool: async () => ({ behavior: 'deny'")
    expect(agentSource).toContain("permissionMode: 'dontAsk'")
    expect(agentSource).toContain('persistSession: false')
    expect(agentSource).toContain('post-compaction usage probe failed')
  })

  it('injects the memory reminder before each next model request', () => {
    expect(agentSource).toContain('const memoryUserPromptSubmitHook: HookCallback')
    expect(agentSource).toContain('const memoryPostToolBatchHook: HookCallback')
    expect(agentSource).toContain('UserPromptSubmit: [{ hooks: [memoryUserPromptSubmitHook] }]')
    expect(agentSource).toContain('PostToolBatch: [{ hooks: [memoryPostToolBatchHook] }]')
    expect(agentSource).not.toContain('PostToolUse: [{ hooks: [memoryPostToolUseHook] }]')
    expect(agentSource).toContain('additionalContext: MEMORY_USER_TURN_REMINDER')
    expect(agentSource).toContain("log.info('memory_reminder_injected'")
    expect(agentSource).toContain("log.info('memory_reminder_observed'")
  })

  it('logs and propagates conversation compaction summary failures', () => {
    expect(agentSource).toContain("log.error('conversation compaction summary failed'")
    expect(agentSource).toContain("log.error('conversation compaction summary request failed'")
    expect(agentSource).toContain('providerErrors')
    expect(agentSource).toContain('throw new Error(`对话压缩摘要失败：${detail}`)')
  })
})
