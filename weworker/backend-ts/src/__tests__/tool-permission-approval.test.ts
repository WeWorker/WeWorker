import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { createAskPreToolUseHook } from '../tool-permission-approval.js'
import { getPendingAskUser, hasPendingAskUser, resolvePendingAskUser, USER_CHOICE_TIMEOUT_MS } from '../ask-user-pending.js'

const workId = 'public-confirmation-work'
const allow: CanUseTool = async (_name, input) => ({ behavior: 'allow', updatedInput: input })
const invoke = (hook: ReturnType<typeof createAskPreToolUseHook>, toolName: string, args: Record<string, unknown> = {}) => hook({
  hook_event_name: 'PreToolUse', session_id: 'fixture-session', transcript_path: '', cwd: path.resolve('/example/workspace'),
  tool_name: toolName, tool_input: args, tool_use_id: 'fixture-tool',
}, 'fixture-tool', { signal: new AbortController().signal })

afterEach(() => {
  while (hasPendingAskUser(workId)) resolvePendingAskUser(workId, '拒绝', getPendingAskUser(workId)!.toolCallId)
  vi.useRealTimers()
})

describe('per-operation tool approval', () => {
  it.each(['Read', 'Edit', 'Write', 'NotebookEdit', 'Skill', 'TodoWrite', 'PowerShell', 'Bash', 'mcp__weworker__create_scheduled_task'])(
    'waits for an explicit answer before allowing %s', async toolName => {
      const onChoice = vi.fn()
      const hook = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => onChoice, checkAccess: allow })
      let settled = false
      const decision = invoke(hook, toolName, { command: 'webcli call example.com.read' }).then(value => { settled = true; return value })
      await vi.waitFor(() => expect(onChoice).toHaveBeenCalledOnce())
      expect(settled).toBe(false)
      const choice = onChoice.mock.calls[0][0]
      expect(choice.question).toContain(toolName.replace(/^mcp__weworker__/, ''))
      expect(choice.question).toContain('webcli call example.com.read')
      expect(resolvePendingAskUser(workId, '允许本次', choice.id)).toBe(true)
      await expect(decision).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } })
    },
  )

  it('does not reuse an approval for another tool invocation', async () => {
    const events: string[] = []
    const hook = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => event => { events.push(event.id) }, checkAccess: allow })
    const first = invoke(hook, 'Read')
    const second = invoke(hook, 'PowerShell')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    resolvePendingAskUser(workId, '允许本次', events[0])
    await expect(first).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } })
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(resolvePendingAskUser(workId, '允许本次', events[0])).toBe(false)
    resolvePendingAskUser(workId, '拒绝', events[1])
    await expect(second).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  it('denies a cancelled operation and removes its pending approval', async () => {
    const abort = new AbortController()
    const hook = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => () => {}, checkAccess: allow, signal: abort.signal })
    const decision = invoke(hook, 'Write')
    await vi.waitFor(() => expect(hasPendingAskUser(workId)).toBe(true))
    abort.abort()
    await expect(decision).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(hasPendingAskUser(workId)).toBe(false)
  })

  it('denies unanswered operations instead of treating a timeout as approval', async () => {
    vi.useFakeTimers()
    const hook = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => () => {}, checkAccess: allow })
    const decision = invoke(hook, 'PowerShell')
    await vi.advanceTimersByTimeAsync(USER_CHOICE_TIMEOUT_MS + 1)
    await expect(decision).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(hasPendingAskUser(workId)).toBe(false)
  })

  it('does not offer approval for operations blocked by configured access rules', async () => {
    const onChoice = vi.fn()
    const hook = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => onChoice,
      checkAccess: async () => ({ behavior: 'deny', message: 'Fixture path is blacklisted' }) })
    await expect(invoke(hook, 'Read')).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(onChoice).not.toHaveBeenCalled()
  })

  it('fails closed when the confirmation UI is unavailable or the guard throws', async () => {
    const unavailable = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => null, checkAccess: allow })
    await expect(invoke(unavailable, 'PowerShell')).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    const broken = createAskPreToolUseHook({ workId: () => workId, onAskUser: () => () => {}, checkAccess: async () => { throw new Error('Fixture failure') } })
    await expect(invoke(broken, 'PowerShell')).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(hasPendingAskUser(workId)).toBe(false)
  })
})
