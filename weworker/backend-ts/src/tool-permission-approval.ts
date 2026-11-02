import { randomUUID } from 'node:crypto'
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { requestUserChoice, type UserChoiceEvent } from './ask-user-pending.js'
import { redactSensitive } from './http-security.js'
import { createLogger } from './logger.js'

const log = createLogger('tool-permission')

/** Ask in PreToolUse so even SDK auto-approved reads wait for the user. */
export function createAskPreToolUseHook(options: {
  workId: () => string | null
  onAskUser: () => ((event: UserChoiceEvent) => void) | null
  checkAccess: CanUseTool
  signal?: AbortSignal
}): HookCallback {
  return async (input, toolUseId, context) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const respond = (permissionDecision: 'allow' | 'deny', permissionDecisionReason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, permissionDecisionReason },
    })
    const signal = options.signal ? AbortSignal.any([options.signal, context.signal]) : context.signal
    if (signal.aborted) return respond('deny', '用户取消了本次操作')
    try {
      const args = input.tool_input as Record<string, unknown>
      const requestId = randomUUID()
      const access = await options.checkAccess(input.tool_name, args, { signal, toolUseID: toolUseId ?? input.tool_use_id, requestId })
      if (!access || access.behavior === 'deny') return respond('deny', access?.message || '当前操作未获得权限')
      const workId = options.workId()
      const onChoice = options.onAskUser()
      if (!workId || !onChoice) return respond('deny', '当前会话无法请求操作授权')
      const approvedInput = access.updatedInput ?? args
      const answer = await requestUserChoice({
        workId, toolCallId: `permission-${input.tool_use_id}-${requestId}`,
        question: `是否允许本次操作？\n工具：${input.tool_name.replace(/^mcp__weworker__/, '')}\n参数：\n${redactSensitive(JSON.stringify(approvedInput, null, 2))}`,
        options: [{ label: '允许本次' }, { label: '拒绝' }], onChoice, signal,
      })
      const approved = answer === '允许本次' && !signal.aborted
      log.info(`[work:${workId.slice(0, 8)}] tool_confirmation ${input.tool_name} → ${approved ? 'allow' : 'deny'}`)
      return {
        hookSpecificOutput: {
          ...respond(approved ? 'allow' : 'deny', approved ? '用户已确认本次操作' : '用户未批准本次操作').hookSpecificOutput,
          ...(approved ? { updatedInput: approvedInput } : {}),
        },
      }
    } catch {
      return respond('deny', '操作确认失败，本次操作未执行')
    }
  }
}
