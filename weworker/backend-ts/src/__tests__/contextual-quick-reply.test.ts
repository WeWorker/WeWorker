import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tryContextualQuickReply } from '../contextual-quick-reply.js'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  displayCommit: vi.fn(),
  currentDisplay: vi.fn(),
}))
vi.mock('../desktop-webcli-context.js', () => ({
  currentDesktopDisplay: mocks.currentDisplay,
  recordWebcliReceipt: vi.fn(),
  commitDeliveredDisplay: mocks.displayCommit,
  clearDesktopDisplay: vi.fn(),
}))
vi.mock('../api-query-router/tool-catalog.js', () => ({
  getCatalog: () => ({
    byName: new Map([['arxiv.org.paper', {
      name: 'arxiv.org.paper', adapterId: 'arxiv.org', direct: true, safety: 'read', requiresConfirmation: false,
      parameters: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
    }]]),
    adapterIds: new Set(['arxiv.org']),
  }),
  isReadOnlyTool: (tool: { safety?: string; requiresConfirmation?: boolean }) => tool.safety === 'read' && tool.requiresConfirmation !== true,
}))
vi.mock('../api-query-router/generic-renderer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../api-query-router/generic-renderer.js')>()
  return { ...actual, renderGeneric: (raw: string) => raw === '{"rows":[]}' ? '' : actual.renderGeneric(raw) }
})
vi.mock('../works-store.js', () => ({ appendMessage: vi.fn() }))
vi.mock('../work-log-file.js', () => ({ appendWorkLog: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../webcli-path.js', () => ({ resolveWebcliEntry: () => 'webcli-entry.js' }))
vi.mock('../webcli-runner.js', () => ({
  runWebcliCallEx: mocks.execute,
  WebcliTimeoutError: class WebcliTimeoutError extends Error {},
}))

const display = {
  contextId: 'ctx-1', epoch: 'e1', revision: 5, roundId: 'round-1', snapshotId: 'snap-1',
  displayVersion: 'dv-1', orderedEntityRefs: ['ref-1', 'ref-2'], identities: ['id-alpha', 'id-beta'],
  completeness: 'complete' as const, turnId: 't0', registeredAt: Date.now(),
}

const step = (args: Record<string, unknown> = { id: '2401.00002' }) => ({
  stepId: 's1', tool: 'arxiv.org.paper', args,
  invocation: { command: 'call', tool: 'arxiv.org.paper', args, decision: 'd1', step: 's1' },
})

function resolvedEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextProtocolVersion: 1, kind: 'resolved', decisionId: 'd1', roundId: 'round-2',
    executionEligibility: 'read_only_allowed',
    selection: { snapshotId: 'snap-1', sourceRoundId: 'round-1', displayVersion: 'dv-1', entityRefs: ['ref-2'], actionId: 'detail' },
    steps: [step()],
    context: { id: 'ctx-1', epoch: 'e1', revision: 6 },
    ...overrides,
  }
}

const routeWith = (envelope: unknown) => vi.fn().mockResolvedValue({ stdout: JSON.stringify({ contextProtocolVersion: 1, context: { id: 'ctx-1', epoch: 'e1' }, ...(envelope as object) }), stderr: '' })

function run(input: Partial<Parameters<typeof tryContextualQuickReply>[0]> = {}) {
  return tryContextualQuickReply({
    message: '查看第二条', workId: 'work', turnId: 't1', chatStartTime: 0,
    send: vi.fn(),
    route: input.route ?? routeWith(resolvedEnvelope()),
    ...input,
  })
}

beforeEach(() => {
  mocks.execute.mockReset().mockImplementation(async (_tool: string, _args: string, _work: string | null | undefined, options: { onReceipt?: (r: unknown) => void }) => {
    options.onReceipt?.({ contextProtocolVersion: 1, contextId: 'ctx-1', epoch: 'e1', decisionId: 'd1', stepId: 's1', roundId: 'round-2', toolOutcome: 'read_success', contextPersistence: 'committed' })
    return '{"rows":[{"id":"2401.00002","title":"Second paper"}]}'
  })
  mocks.displayCommit.mockReset().mockResolvedValue(true)
  mocks.currentDisplay.mockReset().mockReturnValue(display)
})

describe('contextual quick reply', () => {
  it('executes exactly one bound read call and answers without any agent', async () => {
    const send = vi.fn()
    const persist = vi.fn()
    const outcome = await run({ send, persistAssistantMessage: persist, enabledAdapterIds: new Set(['arxiv.org']) })
    expect(outcome.handled).toBe(true)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute).toHaveBeenCalledWith('arxiv.org.paper', '{"id":"2401.00002"}', 'work',
      expect.objectContaining({ timeoutMs: 3_000, context: { contextId: 'ctx-1', decisionId: 'd1', stepId: 's1' } }))
    const turnEnd = send.mock.calls.map(([event]) => event).find(event => (event as { type: string }).type === 'turn_end')
    expect(turnEnd).toMatchObject({ routeSource: 'contextual-quick-reply', routeTool: 'arxiv.org.paper', llmMs: 0 })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(mocks.displayCommit).toHaveBeenCalledWith('work', 't1', expect.stringContaining('Second paper'), expect.any(Object))
  })

  it('keeps the deterministic ordinal path free of the decision model subprocess', async () => {
    // 「查看第二条」由 WebCLI 确定性解析；route 子进程必须带 --context 且不触发 choice。
    const route = vi.fn().mockResolvedValue({ stdout: JSON.stringify(resolvedEnvelope()), stderr: '' })
    await run({ route, enabledAdapterIds: new Set(['arxiv.org']) })
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ contextId: 'ctx-1', message: '查看第二条', timeoutMs: 3_000 }))
  })

  it('never dispatches when the route subprocess fails or times out', async () => {
    const outcome = await run({ route: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { killed: true })), enabledAdapterIds: new Set(['arxiv.org']) })
    expect(outcome.handled).toBe(false)
    expect(outcome.forAgent).toMatchObject({ attempted: true, kind: 'route_failed', reasonCode: 'decision_timeout' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('hands multi-step, write-eligible, stale-display and invalid-arg plans to the agent', async () => {
    const multiStep = step()
    const cases: Array<[Record<string, unknown>, string]> = [
      [resolvedEnvelope({ steps: [multiStep, { ...multiStep, stepId: 's2', invocation: { ...multiStep.invocation, step: 's2' } }] }), 'not_single_step'],
      [resolvedEnvelope({ executionEligibility: 'write_allowed' }), 'not_read_only'],
      [resolvedEnvelope({ selection: { snapshotId: 'snap-old', sourceRoundId: 'round-0', displayVersion: 'dv-old', entityRefs: ['ref-2'] } }), 'stale_display'],
      [resolvedEnvelope({ steps: [step({ id: 42 })] }), 'invalid_arguments'],
      [resolvedEnvelope({ selection: { snapshotId: 'snap-1', sourceRoundId: 'round-1', displayVersion: 'dv-1', entityRefs: ['ref-1', 'ref-2'] } }), 'not_current_object'],
    ]
    for (const [envelope, reason] of cases) {
      const outcome = await run({ route: routeWith(envelope), enabledAdapterIds: new Set(['arxiv.org']) })
      expect(outcome.handled, reason).toBe(false)
      expect(outcome.forAgent).toMatchObject({ attempted: true, kind: 'resolved', reasonCode: reason })
    }
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not treat needs_input as a client question; passes the reference to the agent', async () => {
    const outcome = await run({ route: routeWith({
      kind: 'needs_input', reasonCode: 'source_ambiguous_or_unavailable', clarificationId: 'c1',
      question: '请选择引用哪份列表；序号按该列表已登记的展示顺序解释。', options: [],
    }) })
    expect(outcome.handled).toBe(false)
    expect(outcome.forAgent).toMatchObject({ attempted: true, kind: 'needs_input', question: expect.stringContaining('列表') })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('reuses the single-turn recommendation attached to an unrelated result', async () => {
    const singleTurn = { kind: 'routed', site: { adapterId: 'arxiv.org' }, command: { name: 'search' }, callCommand: 'webgo call arxiv.org.search' }
    const outcome = await run({ route: routeWith({ kind: 'unrelated', reasonCode: 'independent_query', singleTurnRoute: singleTurn }) })
    expect(outcome.precomputedRecommendation).toMatchObject({ status: 'recommended' })
    expect(outcome.forAgent).toMatchObject({ attempted: true, kind: 'unrelated' })
  })

  it('degrades with a bounded trusted result when the read succeeds but cannot render', async () => {
    mocks.execute.mockImplementation(async (_tool: string, _args: string, _work: string | null | undefined, options: { onReceipt?: (r: unknown) => void }) => {
      options.onReceipt?.({ contextProtocolVersion: 1, contextId: 'ctx-1', epoch: 'e1', decisionId: 'd1', stepId: 's1', roundId: 'round-2', toolOutcome: 'read_success', contextPersistence: 'committed' })
      return '{"rows":[]}'
    })
    const outcome = await run({ enabledAdapterIds: new Set(['arxiv.org']) })
    expect(outcome.handled).toBe(false)
    expect(outcome.forAgent?.kind).toBe('resolved')
    expect(outcome.forAgent?.resultText).toEqual(expect.any(String))
    expect(outcome.forAgent?.resultText!.length).toBeLessThanOrEqual(8_000)
    expect(mocks.displayCommit).not.toHaveBeenCalled()
  })

  it('skips entirely when the process holds no verified display', async () => {
    mocks.currentDisplay.mockReturnValue(null)
    const outcome = await run({})
    expect(outcome.handled).toBe(false)
    expect(outcome.forAgent).toBeUndefined()
  })

  it('stops before the call when the 8s budget is already exhausted', async () => {
    let ticks = 0
    const outcome = await run({
      enabledAdapterIds: new Set(['arxiv.org']),
      now: () => { ticks += 1; return ticks <= 1 ? 0 : 8_000 },
    })
    expect(outcome.forAgent).toMatchObject({ kind: 'resolved', reasonCode: 'budget_exhausted' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('does not answer when the receipt does not confirm read success', async () => {
    mocks.execute.mockImplementation(async (_tool: string, _args: string, _work: string | null | undefined, options: { onReceipt?: (r: unknown) => void }) => {
      options.onReceipt?.({ contextId: 'ctx-1', toolOutcome: 'failed', contextPersistence: 'committed' })
      return '{"error":"Fixture failure"}'
    })
    const outcome = await run({ enabledAdapterIds: new Set(['arxiv.org']) })
    expect(outcome.handled).toBe(false)
    expect(outcome.forAgent).toMatchObject({ kind: 'resolved', reasonCode: 'unconfirmed_read' })
  })

  it.each([false, true])('consumes arXiv decisions (mock provider: %s)', async useModel => {
    const cli = (file: string) => import(new URL('../../../../webcli/' + file, import.meta.url).href)
    const [{ routeContext }, { loadContextCatalog, captureResult }, model, { choose }] = await Promise.all([
      cli('context-router.js'), cli('context-profile.js'), cli('context-model.js'), cli('context-choice.js'),
    ])
    const catalog = await loadContextCatalog()
    const state = model.newState(Date.now())
    const now = Date.now()
    model.beginRound(state, null, now)
    const rows = [{ id: '2401.00001', title: 'First paper' }, { id: '2401.00002', title: 'Second paper' }]
    const snapshot = captureResult(state, { tool: 'arxiv.org.search', args: {}, raw: useModel ? rows.slice(1) : rows,
      exitCode: 0, now, catalog, roundId: state.activeRound.roundId })
    model.commitRound(state)
    const refs = snapshot.entities.map((entity: { entityRef: string }) => entity.entityRef)
    const registered = model.registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision,
      roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId, order: refs, completeness: 'unknown', delivered: true })
    mocks.currentDisplay.mockReturnValue({ ...display, epoch: state.sessionEpoch, snapshotId: snapshot.snapshotId,
      roundId: snapshot.sourceRoundId, displayVersion: registered.version, orderedEntityRefs: refs })
    const provider = vi.fn((stateText: string, criteria: Record<string, string>) => choose(stateText, criteria, {
      predict: async () => {
        const others = Object.keys(criteria).filter(key => key !== 'ACTION_1')
        return { answers: { selection: { type: 'choice', choice: 'ACTION_1',
          probabilities: { ACTION_1: 0.97, ...Object.fromEntries(others.map(key => [key, 0.03 / others.length])) } } } }
      },
    }))
    const message = useModel ? '我想进一步了解这篇论文的详细信息' : '查看第二条'
    const route = async () => {
      const envelope = await routeContext(state, message, { catalog, now, provider })
      envelope.context.id = display.contextId
      mocks.execute.mockImplementationOnce(async (_tool, _args, _work, options) => {
        options.onReceipt({ contextProtocolVersion: 1, contextId: display.contextId, epoch: state.sessionEpoch,
          decisionId: envelope.decisionId, stepId: 's1', roundId: envelope.roundId, toolOutcome: 'read_success' })
        return JSON.stringify(rows.slice(1))
      })
      return { stdout: JSON.stringify(envelope), stderr: '' }
    }
    expect(await run({ message, route, enabledAdapterIds: new Set(['arxiv.org']), persistAssistantMessage: vi.fn() })).toEqual({ handled: true })
    expect(provider).toHaveBeenCalledTimes(useModel ? 1 : 0)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mocks.execute.mock.calls[0][1])).toEqual({ id: '2401.00002' })
  })

  it('keeps a disabled adapter out of the quick path', async () => {
    const outcome = await run({ enabledAdapterIds: new Set(['other.org']) })
    expect(outcome.forAgent).toMatchObject({ kind: 'resolved', reasonCode: 'tool_not_eligible' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
})
