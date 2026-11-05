import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { createUnifiedToolGuard } from './user-directory-access.js'

/** Runs even when acceptEdits or an SDK allow rule would skip canUseTool. */
export function createWorkspacePreToolUseHook(workspaceDirectory: string): HookCallback {
  const guard = createUnifiedToolGuard('workspace', workspaceDirectory)
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const decision = await guard(input.tool_name, input.tool_input as Record<string, unknown>)
    if (decision.behavior !== 'deny') {
      if (decision.updatedInput) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: decision.updatedInput,
          },
        }
      }
      return {}
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.message,
      },
    }
  }
}
