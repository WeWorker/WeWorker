import { describe, expect, it, vi } from 'vitest'
import type { SSEEvent } from '../agent.js'
import { isContextOverflowError, streamWithConversationRecovery, type ConversationRecoveryRequest } from '../context/conversation-recovery.js'

const snapshot = (actual?: number, estimated = 10): SSEEvent => ({
  type: 'context_snapshot',
  context: { version: 1, phase: 'turn_end', actual_input_tokens: actual,
    estimated_total_tokens: estimated, context_limit: 1000, categories: [] },
})
const done: SSEEvent = { type: 'done' }
const overflow: SSEEvent = { type: 'error', content: 'Prompt is too long' }
const compacted: SSEEvent[] = [
  { type: 'context_compaction_start', compaction: { status: 'started' } },
  { type: 'context_compaction_end', compaction: { status: 'completed' } }, done,
]

async function runFixture(streams: SSEEvent[][], signal?: AbortSignal, maxAttempts?: number, compactionOnly = false) {
  const requests: ConversationRecoveryRequest[] = []
  const onCompacted = vi.fn()
  const events: SSEEvent[] = []
  for await (const event of streamWithConversationRecovery({
    workId: 'public-fixture-work', signal, onCompacted, maxAttempts, compactionOnly,
    run: async function* (request) {
      requests.push(request)
      yield* streams[requests.length - 1] || []
    },
  })) events.push(event)
  return { requests, events, onCompacted }
}

describe('shared Backend conversation recovery', () => {
  it('uses the latest provider input total at 90 percent even when local estimates are small', async () => {
    const { events, requests, onCompacted } = await runFixture([[snapshot(900), done], compacted])
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ compactionOnly: true, forceCompaction: true })
    expect(events.at(-1)).toEqual(done)
    expect(events.filter(event => event.type === 'done')).toHaveLength(1)
    expect(events[0]).toMatchObject({ contextRecoveryManaged: true })
    expect(onCompacted).toHaveBeenCalledOnce()
  })

  it.each([undefined, 0, 899, Number.NaN, Number.POSITIVE_INFINITY])('does not compact from estimates or invalid provider usage: %s', async actual => {
    const { requests } = await runFixture([[snapshot(actual, 9999), done]])
    expect(requests).toHaveLength(1)
  })

  it('does not compact a second time after successful SDK compaction', async () => {
    const { requests } = await runFixture([[...compacted.slice(0, -1), snapshot(950), done]])
    expect(requests).toHaveLength(1)
  })

  it('recovers once and carries partial text and completed tool results into the continuation', async () => {
    const original: SSEEvent[] = [
      { type: 'text_delta', content: 'Already checked the status.' },
      { type: 'tool_call_start', id: 'completed', name: 'example.update', args: { id: 'public-example' } },
      { type: 'tool_call_result', id: 'completed', result: 'update completed' },
      { type: 'tool_call_start', id: 'unfinished', name: 'example.verify', args: {} },
      overflow, done,
    ]
    const { requests, events } = await runFixture([original, compacted, [{ type: 'text_delta', content: 'Continued.' }, done]])
    expect(requests).toHaveLength(3)
    expect(requests[2]).toMatchObject({ resume: true, response: { role: 'assistant', content: [
      { type: 'text', text: 'Already checked the status.' },
      expect.objectContaining({ id: 'completed', status: 'done', result: 'update completed' }),
      expect.objectContaining({ id: 'unfinished', status: 'cancelled' }),
    ] } })
    expect(events.filter(event => event.type === 'tool_call_start' && event.id === 'completed')).toHaveLength(1)
    expect(events.filter(event => event.type === 'done')).toHaveLength(1)
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('summarizes up to three times while continuations still overflow', async () => {
    const { requests, events } = await runFixture([[overflow, done], compacted, [overflow, done], compacted,
      [overflow, done], compacted, [done]])
    expect(requests.filter(request => request.compactionOnly && !request.dropOldestHistory)).toHaveLength(3)
    expect(requests.filter(request => request.resume)).toHaveLength(3)
    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(events.filter(event => event.type === 'done')).toHaveLength(1)
  })

  it.each(['failed', 'skipped'] as const)('reports overflow if summary is %s and never retries original tools', async status => {
    const { requests, events, onCompacted } = await runFixture([[overflow, done], [
      { type: 'context_compaction_end', compaction: { status, error: 'Public fixture summary error' } }, done,
    ]])
    expect(requests).toHaveLength(status === 'skipped' ? 3 : 2)
    expect(onCompacted).not.toHaveBeenCalled()
    expect(events.find(event => event.type === 'error')).toMatchObject({
      content: expect.stringContaining('Prompt is too long'), contextRecoveryManaged: true,
    })
  })

  it('preserves a successful answer if proactive compaction fails', async () => {
    const { events } = await runFixture([[{ type: 'text_delta', content: 'Final answer' }, snapshot(950), done], [
      { type: 'context_compaction_end', compaction: { status: 'failed', error: 'Public fixture failure' } }, done,
    ]])
    expect(events[0]).toMatchObject({ content: 'Final answer' })
    expect(events.at(-1)).toEqual(done)
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('does not recover network or permission failures', async () => {
    const { events, requests } = await runFixture([[{ type: 'error', content: 'Permission denied' }, snapshot(950), done]])
    expect(requests).toHaveLength(1)
    expect(events.find(event => event.type === 'error')).toMatchObject({ content: 'Permission denied' })
  })

  it('does not compact or retry after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const { requests } = await runFixture([[overflow, done]], controller.signal)
    expect(requests).toHaveLength(1)
  })

  it('also recovers a thrown provider overflow before a done event', async () => {
    const controller = new AbortController()
    let requests = 0
    const events: SSEEvent[] = []
    for await (const event of streamWithConversationRecovery({
      workId: 'public-fixture-work', signal: controller.signal, onCompacted() {},
      run: async function* (request) {
        requests++
        if (requests === 1) throw new Error('Prompt is too long')
        if (request.compactionOnly) yield* compacted
        else yield done
      },
    })) events.push(event)
    expect(requests).toBe(3)
    expect(events.at(-1)).toEqual(done)
  })

  it('cancels an active summary without starting another model turn', async () => {
    const controller = new AbortController()
    let requests = 0
    for await (const _event of streamWithConversationRecovery({
      workId: 'public-fixture-work', signal: controller.signal, onCompacted() {},
      run: async function* (request) {
        requests++
        if (request.compactionOnly) {
          controller.abort()
          throw new DOMException('Public cancellation', 'AbortError')
        }
        yield overflow
      },
    })) { /* consume lifecycle events */ }
    expect(requests).toBe(2)
  })

  it.each(['max_tokens exceeds the output token limit', 'token rate limit exceeded', 'network failed'])('does not mistake unrelated errors for overflow: %s', error => {
    expect(isContextOverflowError(error)).toBe(false)
  })

  const trimmed: SSEEvent[] = [{ type: 'context_compaction_end', compaction: {
    status: 'completed', strategy: 'drop_oldest', before_tokens: 100, after_tokens: 50,
  } }, done]

  it('uses the configured summary cap then drops oldest history until accepted', async () => {
    const { requests, events } = await runFixture([[overflow, done], compacted, [overflow, done],
      [...trimmed.slice(0, -1), overflow, done], trimmed, [done]], undefined, 1)
    expect(requests.filter(request => request.compactionOnly && !request.dropOldestHistory)).toHaveLength(1)
    expect(requests.filter(request => request.dropOldestHistory)).toHaveLength(2)
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('counts an initial automatic summary toward the configured cap', async () => {
    const { requests } = await runFixture([[{ type: 'context_compaction_end', compaction: {
      status: 'completed', strategy: 'summary',
    } }, overflow, done], trimmed, [done]], undefined, 1)
    expect(requests[1]).toMatchObject({ dropOldestHistory: true })
  })

  it('retries summary-request overflow within the cap before trimming', async () => {
    const rejected: SSEEvent[] = [{ type: 'context_compaction_end', compaction: {
      status: 'failed', reason: 'summary_failed', error: 'Prompt is too long',
    } }, done]
    const { requests, events } = await runFixture([[overflow, done], rejected, rejected, rejected, trimmed, [done]])
    expect(requests.filter(request => request.compactionOnly && !request.dropOldestHistory)).toHaveLength(3)
    expect(requests[4]).toMatchObject({ dropOldestHistory: true })
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('does not accept a summary whose validation probe still overflows', async () => {
    const { requests } = await runFixture([[overflow, done], [...compacted.slice(0, -1), overflow, done], compacted, [done]])
    expect(requests[2]).toMatchObject({ compactionOnly: true })
    expect(requests[3]).toMatchObject({ resume: true })
  })

  it('never reruns a completed turn when proactive validation overflows', async () => {
    const { requests, events } = await runFixture([[snapshot(950), done], [...compacted.slice(0, -1), overflow, done], trimmed], undefined, 1)
    expect(requests.some(request => request.resume)).toBe(false)
    expect(requests[2]).toMatchObject({ dropOldestHistory: true })
    expect(events.at(-1)).toEqual(done)
  })

  it('stops once no removable history remains', async () => {
    const { events, requests } = await runFixture([[overflow, done], compacted, [overflow, done],
      [{ type: 'context_compaction_end', compaction: { status: 'skipped' } }, done]], undefined, 1)
    expect(requests).toHaveLength(4)
    expect(events.find(event => event.type === 'error')?.content).toContain('无法继续缩减')
  })

  it('stops a trim that reports completion without a smaller context', async () => {
    const { requests, events } = await runFixture([[overflow, done], compacted, [overflow, done],
      [{ type: 'context_compaction_end', compaction: {
        status: 'completed', before_tokens: 100, after_tokens: 100,
      } }, overflow, done]], undefined, 1)
    expect(requests).toHaveLength(4)
    expect(events.find(event => event.type === 'error')?.content).toContain('无法继续缩减')
  })

  it('preserves new partial outputs across repeated continuations', async () => {
    const { requests } = await runFixture([[{ type: 'text_delta', content: 'First result.' }, overflow, done], compacted,
      [{ type: 'text_delta', content: 'Second result.' }, overflow, done], compacted, [done]])
    expect(requests[4].response?.content).toContainEqual({ type: 'text', text: 'First result.Second result.' })
  })

  it('recovers manual compaction overflow without starting a user turn', async () => {
    const { requests, events } = await runFixture([[{ type: 'context_compaction_end', compaction: {
      status: 'completed', strategy: 'summary',
    } }, overflow, done], trimmed], undefined, 1, true)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ dropOldestHistory: true, compactionOnly: true })
    expect(requests.some(request => request.resume)).toBe(false)
    expect(events.some(event => event.type === 'error')).toBe(false)
  })

  it('recovers manual summary-request overflow and a non-reducing summary', async () => {
    for (const reason of ['summary_failed', 'no_reduction'] as const) {
      const { requests, events } = await runFixture([[{ type: 'context_compaction_end', compaction: {
        status: 'failed', strategy: 'summary', reason, error: reason === 'summary_failed' ? 'Prompt is too long' : 'No reduction',
      } }, done], trimmed], undefined, 1, true)
      expect(requests[1]).toMatchObject({ dropOldestHistory: true, compactionOnly: true })
      expect(events.some(event => event.type === 'error')).toBe(false)
    }
  })
})
