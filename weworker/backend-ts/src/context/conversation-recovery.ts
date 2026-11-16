import type { SSEEvent } from '../agent.js'
import type { ContentBlock, Message } from '../works-store.js'
import { normalizeCompactionMaxAttempts } from './conversation-compaction.js'

export interface ConversationRecoveryRequest {
  compactionOnly?: boolean
  forceCompaction?: boolean
  response?: Message
  resume?: boolean
  dropOldestHistory?: boolean
}

export function isContextOverflowError(message: string | undefined): boolean {
  return /context.{0,40}(exceed|too (long|large)|overflow)|maximum context (length|window)|too many (input )?tokens|prompt.{0,16}too long|input.{0,24}token.{0,24}(exceed|limit)|上下文.{0,16}(过长|超出|超过|超限)|输入.{0,16}(过长|超出.{0,8}限制)/i.test(message || '')
}

function createResponse(workId: string) {
  const content: ContentBlock[] = []
  const tools = new Map<string, Extract<ContentBlock, { type: 'tool_use' }>>()
  return {
    observe(event: SSEEvent) {
      if (event.type === 'text_delta' && event.content) {
        const last = content.at(-1)
        if (last?.type === 'text') last.text += event.content
        else content.push({ type: 'text', text: event.content })
      } else if (event.type === 'skill_context' && event.skillContext) {
        content.push(event.skillContext)
      } else if (event.id && ['tool_call_start', 'tool_call_result', 'tool_call_image'].includes(event.type)) {
        let tool = tools.get(event.id)
        if (!tool) {
          tool = { type: 'tool_use', id: event.id, name: event.name || 'tool', args: event.args || {}, status: 'running' }
          tools.set(event.id, tool)
          content.push(tool)
        }
        if (event.type === 'tool_call_start') {
          tool.name = event.name || tool.name
          tool.args = event.args ?? tool.args
        } else if (event.type === 'tool_call_result') {
          tool.result = event.result
          tool.status = event.isError ? 'failed' : 'done'
        } else if (event.type === 'tool_call_image') {
          tool.image = event.data
          tool.status = 'done'
        }
      }
    },
    message(): Message | undefined {
      if (!content.length) return undefined
      return {
        id: 'in-flight-response', work_id: workId, role: 'assistant', created_at: '',
        content: content.map(block => block.type === 'tool_use' && block.status === 'running'
          ? { ...block, status: 'cancelled' } : block),
      }
    },
  }
}

// Consumers may stop at `done`, so compaction and recovery must finish before it.
export async function* streamWithConversationRecovery(input: {
  workId: string
  signal?: AbortSignal
  maxAttempts?: number
  compactionOnly?: boolean
  run: (request: ConversationRecoveryRequest) => AsyncGenerator<SSEEvent>
  onCompacted: () => void
}): AsyncGenerator<SSEEvent> {
  const managed = (event: SSEEvent): SSEEvent => event.type === 'context_snapshot' || event.type === 'error'
    ? { ...event, contextRecoveryManaged: true } : event
  const response = createResponse(input.workId)
  let snapshot: SSEEvent['context']
  async function* execute(request: ConversationRecoveryRequest): AsyncGenerator<SSEEvent, {
    overflow?: SSEEvent; error?: SSEEvent; completed: boolean; compaction?: SSEEvent['compaction']
  }> {
    let overflow: SSEEvent | undefined
    let error: SSEEvent | undefined
    let completed = false
    let compaction: SSEEvent['compaction']
    try {
      for await (const event of input.run(request)) {
        if (input.signal?.aborted) break
        if (event.type === 'done') { completed = true; continue }
        if (event.type === 'context_snapshot') snapshot = event.context
        if (event.type === 'context_compaction_end') compaction = event.compaction
        if (event.type === 'error') {
          if (isContextOverflowError(event.content)) overflow = event
          else error = event
          continue
        }
        if (!request.compactionOnly) response.observe(event)
        yield managed(event)
      }
    } catch (failure) {
      const event: SSEEvent = { type: 'error', content: failure instanceof Error ? failure.message : String(failure) }
      if (isContextOverflowError(event.content)) overflow = event
      else error = event
    }
    return { overflow, error, completed, compaction }
  }
  const initial = yield* execute({})
  if (input.signal?.aborted) return
  const actual = snapshot?.actual_input_tokens
  const limit = snapshot?.context_limit
  const thresholdReached = initial.completed && !initial.error && initial.compaction?.status !== 'completed'
    && typeof actual === 'number' && Number.isFinite(actual) && actual > 0
    && typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    && actual / limit >= 0.9
  const summaryNeedsRecovery = input.compactionOnly && initial.compaction?.status === 'failed'
    && (isContextOverflowError(initial.compaction.error)
      || ['no_reduction', 'summary_input_too_large'].includes(initial.compaction.reason || ''))
  let overflow = initial.overflow || (summaryNeedsRecovery
    ? { type: 'error' as const, content: initial.compaction?.error || '上下文超限' } : undefined)
  let terminalError = initial.error
  let failureReason = ''
  if (!terminalError && (overflow || thresholdReached)) {
    const maxAttempts = normalizeCompactionMaxAttempts(input.maxAttempts)
    let attempts = initial.compaction?.strategy === 'summary' ? 1 : 0
    let dropOldest = !!summaryNeedsRecovery
      && ['no_reduction', 'summary_input_too_large'].includes(initial.compaction?.reason || '')
    while (!input.signal?.aborted) {
      if (attempts >= maxAttempts) dropOldest = true
      if (!dropOldest) attempts++
      const result = yield* execute({ forceCompaction: true, compactionOnly: true,
        response: response.message(), ...(dropOldest ? { dropOldestHistory: true } : {}) })
      if (input.signal?.aborted) return
      const compaction = result.compaction
      const reduced = compaction?.status === 'completed'
      const trimReduced = reduced && typeof compaction.before_tokens === 'number'
        && typeof compaction.after_tokens === 'number' && compaction.after_tokens < compaction.before_tokens
      if (reduced) input.onCompacted()
      failureReason = result.error?.content || result.overflow?.content || compaction?.error || ''
      if (result.error) {
        yield { type: 'context_compaction_end', compaction: { ...compaction, status: 'failed', error: failureReason } }
        if (overflow) terminalError = { ...overflow, content: `${overflow.content}\n自动压缩失败：${failureReason}` }
        break
      }
      const summaryOverflow = isContextOverflowError(compaction?.error)
      if (result.overflow || summaryOverflow) {
        // A trim must make measurable progress, even when the provider still rejects it.
        if (dropOldest && !trimReduced) break
        continue
      }
      if (!reduced) {
        if (!dropOldest && (compaction?.status === 'skipped'
          || ['no_reduction', 'summary_input_too_large'].includes(compaction?.reason || ''))) {
          dropOldest = true
          continue
        }
        break
      }
      if (dropOldest && !trimReduced) break
      if (!overflow || input.compactionOnly) {
        overflow = undefined
        break // Manual/proactive compaction must never rerun a user turn.
      }
      const continuation = yield* execute({ response: response.message(), resume: true })
      if (input.signal?.aborted) return
      overflow = continuation.overflow
      terminalError = continuation.error
      if (terminalError || !overflow) break
    }
    if (input.signal?.aborted) return
  }
  if (terminalError) yield managed(terminalError)
  else if (overflow) yield managed({ ...overflow, content: `${overflow.content}\n${failureReason ? `${failureReason}\n` : ''}无法继续缩减历史上下文，请缩小本轮输入或新建对话` })
  yield { type: 'done' }
}
