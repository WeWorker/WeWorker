import { describe, expect, it } from 'vitest'
import {
  DesktopRouteCandidateStore, normalizeObservedQuestion,
  type DesktopCandidateTurn,
} from '../desktop-route-candidates.js'

const input = (overrides: Partial<DesktopCandidateTurn> = {}): DesktopCandidateTurn => ({
  source: 'desktop', workspaceKey: 'workspace-a', workId: 'work-a', turnId: 'turn-a',
  question: 'List available records?', directRoute: { status: 'miss' },
  plainQuestion: true, eligibleAgentTurn: true, ...overrides,
})

function observe(store: DesktopRouteCandidateStore, overrides: Partial<DesktopCandidateTurn> = {}) {
  const turn = store.begin(input(overrides))!
  turn.event({ type: 'tool_call_start', id: 'call-1', name: 'Bash', args: {} })
  turn.event({ type: 'tool_call_start', id: 'call-1', name: 'Bash', args: {
    command: 'webcli call sample.read --args-file C:/secret-path',
  } })
  turn.structuredIdentity({ source: 'backend_execution_receipt', toolUseId: 'call-1', adapterId: 'sample', toolId: 'read' })
  turn.event({ type: 'tool_call_result', id: 'call-1', result: 'private response not stored', isError: false })
  return turn
}

function observeVerified(store: DesktopRouteCandidateStore, overrides: Partial<DesktopCandidateTurn> = {},
  receiptOverrides: Record<string, unknown> = {}) {
  const turn = store.begin(input(overrides))!
  turn.event({ type: 'tool_call_start', id: 'call-verified', name: 'weworker_read_query', args: { untrusted: 'ignore' } })
  turn.verifiedExecution({ adapterId: 'sample', toolId: 'read', toolUseId: 'call-verified',
    args: { query: { limit: 2, filter: ['public'] } }, businessSuccess: true, ...receiptOverrides })
  turn.event({ type: 'tool_call_result', id: 'call-verified', result: { private: 'never persist' }, isError: false })
  return turn
}

const finish = { completed: true, finalAnswerVisible: true, cancelled: false }

describe('desktop-only volatile candidate observation', () => {
  it('requires an actual ordinary desktop miss and untouched standalone question', () => {
    const store = new DesktopRouteCandidateStore()
    for (const overrides of [
      { source: 'desktop' as const, directRoute: { status: 'failed' as const, reason: 'authentication_required' } },
      { directRoute: { status: 'skipped' as const, reason: 'gate_history' } },
      { plainQuestion: false }, { eligibleAgentTurn: false }, { workspaceKey: '' },
      { question: ' ' }, { source: 'channel' as 'desktop' },
    ]) expect(store.begin(input(overrides))).toBeNull()
    expect(store.list('workspace-a')).toEqual([])
  })

  it('does not parse Shell text or treat exit-success as structured execution proof', () => {
    const store = new DesktopRouteCandidateStore()
    const turn = store.begin(input())!
    turn.event({ type: 'tool_call_start', id: 'shell-1', name: 'Bash', args: {
      command: 'webcli call sample.read; webcli call sample.write --token placeholder-secret',
    } })
    turn.event({ type: 'tool_call_result', id: 'shell-1', result: 'successful-looking result', isError: false })
    expect(turn.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
    expect(store.list('workspace-a')).toEqual([])
  })

  it('only records a narrow unverified identity with no args, response, or shell text', () => {
    const store = new DesktopRouteCandidateStore()
    const turn = observe(store)
    const candidate = turn.finish({ completed: true, finalAnswerVisible: true, cancelled: false })!
    expect(candidate).toMatchObject({
      question: 'List available records?', tool: { adapterId: 'sample', toolId: 'read' },
      status: 'needs_safe_test', evidence: 'identity_only_unverified', runnableArgs: null,
      workId: 'work-a', turnId: 'turn-a', toolUseId: 'call-1',
    })
    expect(JSON.stringify(candidate)).not.toMatch(/secret-path|private response|command|placeholder-secret/)
    expect(store.list('workspace-b')).toEqual([])
    const list = store.list('workspace-a')
    list[0].tool.toolId = 'write'
    expect(store.list('workspace-a')[0].tool.toolId).toBe('read')
    expect(turn.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
  })

  it('rejects extra calls, unknown result IDs and mismatched receipts', () => {
    const store = new DesktopRouteCandidateStore()
    const multiple = observe(store)
    multiple.event({ type: 'tool_call_start', id: 'call-2', name: 'Bash' })
    expect(multiple.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
    const unmatched = observe(store)
    unmatched.event({ type: 'tool_call_result', id: 'unknown', isError: false })
    expect(unmatched.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
    const mismatched = store.begin(input())!
    mismatched.event({ type: 'tool_call_start', id: 'call-1', name: 'Bash' })
    mismatched.structuredIdentity({ source: 'backend_execution_receipt', toolUseId: 'call-2', adapterId: 'sample', toolId: 'read' })
    expect(mismatched.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
  })

  it('ignores recommendation events but never treats them as execution evidence', () => {
    const store = new DesktopRouteCandidateStore()
    const turn = observe(store)
    turn.event({ type: 'tool_call_start', id: 'webcli-route-1', name: 'webcli_route' })
    turn.event({ type: 'tool_call_result', id: 'webcli-route-1', result: 'recommended', isError: false })
    expect(turn.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).not.toBeNull()
    const recommendationOnly = store.begin(input({ question: 'Another question?' }))!
    recommendationOnly.event({ type: 'tool_call_start', id: 'webcli-route-2', name: 'webcli_route' })
    expect(recommendationOnly.finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
  })

  it('drops incomplete, cancelled, errored or image-bearing turns', () => {
    for (const status of ['incomplete', 'cancelled', 'no-answer', 'errored', 'image'] as const) {
      const store = new DesktopRouteCandidateStore()
      const turn = observe(store)
      if (status === 'errored') turn.event({ type: 'error' })
      if (status === 'image') turn.event({ type: 'tool_call_image', id: 'call-1' })
      expect(turn.finish({ completed: status !== 'incomplete', cancelled: status === 'cancelled', finalAnswerVisible: status !== 'no-answer' })).toBeNull()
    }
  })

  it('records receipt-verified read-only calls while keeping fixed arguments private', () => {
    const store = new DesktopRouteCandidateStore()
    const source = { query: { limit: 2, filter: ['public'] } }
    const turn = store.begin(input())!
    turn.event({ type: 'tool_call_start', id: 'call-verified', name: 'weworker_read_query',
      args: { query: 'malicious SDK args not used' } })
    turn.verifiedExecution({ adapterId: 'sample', toolId: 'read', toolUseId: 'call-verified',
      args: source, businessSuccess: true })
    source.query.limit = 999
    source.query.filter.push('mutated')
    turn.event({ type: 'tool_call_result', id: 'call-verified', isError: false, result: 'secret-result' })
    const candidate = turn.finish(finish)!
    expect(candidate).toMatchObject({ verification: 'verified', evidence: 'verified_read_query',
      status: 'needs_safe_test', runnableArgs: {}, tool: { adapterId: 'sample', toolId: 'read' } })
    expect(JSON.stringify(store.list('workspace-a'))).not.toMatch(/limit|filter|secret-result|malicious/)
    expect(store.getVerified('workspace-b', candidate.id)).toBeNull()
    const privateCandidate = store.getVerified('workspace-a', candidate.id)!
    expect(privateCandidate.args).toEqual({ query: { limit: 2, filter: ['public'] } })
    ;(privateCandidate.args.query as { limit: number }).limit = 1000
    expect(store.getVerified('workspace-a', candidate.id)!.args).toEqual({ query: { limit: 2, filter: ['public'] } })
    expect(store.consumeVerified('workspace-b', candidate.id)).toBeNull()
    expect(store.consumeVerified('workspace-a', candidate.id)!.args).toEqual({ query: { limit: 2, filter: ['public'] } })
    expect(store.consumeVerified('workspace-a', candidate.id)).toBeNull()
    expect(store.list('workspace-a')).toEqual([])
  })

  it('refuses to promote shell identity or false, mismatched and competing receipt claims', () => {
    const store = new DesktopRouteCandidateStore()
    const legacy = observe(store).finish(finish)!
    expect(legacy.verification).toBe('identity_only_unverified')
    expect(store.getVerified('workspace-a', legacy.id)).toBeNull()
    for (const receipt of [{ businessSuccess: false }, { toolUseId: 'other' }, { adapterId: 'bad id' }]) {
      expect(observeVerified(store, { question: `Rejected ${JSON.stringify(receipt)}` }, receipt).finish(finish)).toBeNull()
    }
    const wrongName = store.begin(input({ question: 'Wrong SDK name' }))!
    wrongName.event({ type: 'tool_call_start', id: 'call-verified', name: 'Bash' })
    wrongName.verifiedExecution({ adapterId: 'sample', toolId: 'read', toolUseId: 'call-verified',
      args: {}, businessSuccess: true })
    wrongName.event({ type: 'tool_call_result', id: 'call-verified' })
    expect(wrongName.finish(finish)).toBeNull()
    const extra = observeVerified(store, { question: 'Extra tool call' })
    extra.event({ type: 'tool_call_start', id: 'another', name: 'Other' })
    expect(extra.finish(finish)).toBeNull()
    const recommendation = observeVerified(store, { question: 'Extra recommendation' })
    recommendation.event({ type: 'tool_call_start', id: 'webcli-route-1', name: 'webcli_route' })
    expect(recommendation.finish(finish)).toBeNull()
    const failure = observeVerified(store, { question: 'Tool error' })
    failure.event({ type: 'tool_call_result', id: 'call-verified', isError: true })
    expect(failure.finish(finish)).toBeNull()
  })

  it('keeps each workspace isolated and refuses to overwrite same normalized question', () => {
    const store = new DesktopRouteCandidateStore()
    expect(normalizeObservedQuestion('A B?')).toBe('ab?')
    expect(normalizeObservedQuestion('A B!')).not.toBe(normalizeObservedQuestion('A B?'))
    expect(observe(store).finish({ completed: true, finalAnswerVisible: true, cancelled: false })).not.toBeNull()
    expect(observe(store, { question: 'list available RECORDS?' }).finish({ completed: true, finalAnswerVisible: true, cancelled: false })).toBeNull()
    expect(observe(store, { workspaceKey: 'workspace-b' }).finish({ completed: true, finalAnswerVisible: true, cancelled: false })).not.toBeNull()
    expect(store.list('workspace-a')).toHaveLength(1)
    expect(store.list('workspace-b')).toHaveLength(1)
  })
})
