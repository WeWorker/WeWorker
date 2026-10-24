import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calibrateCompactedContextSnapshot, calibrateContextSnapshot, contextUsagePercent, createContextTokenAnchor, createEmptyContextSnapshot, formatContextTokens, normalizeContextSnapshot, projectIncrementalContextSnapshot } from '../utils/context-snapshot.js'
import { formatContextLimitInput, parseContextLimitInput } from '../utils/context-window.js'
import { useWorksStore } from '../store/works.js'

describe('context snapshot display helpers', () => {
  it('provides a resident empty snapshot before a task has context usage', () => {
    const snapshot = normalizeContextSnapshot(createEmptyContextSnapshot(68000))

    assert.equal(snapshot.displayed_total_tokens, 0)
    assert.equal(snapshot.context_limit, 68000)
    assert.equal(contextUsagePercent(snapshot), 0)
    assert.equal(snapshot.categories.length, 8)
  })

  it('normalizes categories and clamps usage to the context limit', () => {
    const snapshot = normalizeContextSnapshot({
      phase: 'turn_end',
      estimated_total_tokens: 300000,
      context_limit: 200000,
      actual_input_tokens: 4200,
      categories: [
        { id: 'conversation', scope: 'work', estimated_tokens: 1200 },
        { id: 'unknown', estimated_tokens: 999 },
      ],
      compaction: {
        mode: 'conversation_only',
        before_tokens: 900,
        after_tokens: 300,
        summarized_message_count: 4,
        retained_message_count: 2,
      },
    })

    assert.equal(snapshot.categories.length, 1)
    assert.equal(snapshot.phase, 'turn_end')
    assert.equal(snapshot.actual_input_tokens, 4200)
    assert.equal(snapshot.compaction.mode, 'conversation_only')
    assert.equal(snapshot.compaction.before_tokens, 900)
    assert.equal(contextUsagePercent(snapshot), 100)
  })

  it('calibrates category display values to the provider total', () => {
    const snapshot = normalizeContextSnapshot({
      estimated_total_tokens: 100,
      context_limit: 1000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 70 },
        { id: 'conversation', scope: 'work', estimated_tokens: 30 },
      ],
    })
    const calibrated = calibrateContextSnapshot(snapshot, 250)

    assert.equal(calibrated.token_source, 'provider_calibrated')
    assert.equal(calibrated.displayed_total_tokens, 250)
    assert.equal(calibrated.categories[0].calibrated_tokens + calibrated.categories[1].calibrated_tokens, 250)
    assert.equal(contextUsagePercent(calibrated), 25)
  })

  it('derives compressed conversation tokens from a new provider total', () => {
    const before = calibrateContextSnapshot(normalizeContextSnapshot({
      estimated_total_tokens: 1000,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300 },
      ],
    }), 900)
    const after = normalizeContextSnapshot({
      estimated_total_tokens: 700,
      context_limit: 2000,
      compaction: {
        mode: 'conversation_only',
        before_tokens: 1000,
        after_tokens: 500,
        summarized_message_count: 4,
        retained_message_count: 2,
      },
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    })
    const calibrated = calibrateCompactedContextSnapshot(after, 650, createContextTokenAnchor(before))

    assert.equal(calibrated.categories.find((item) => item.id === 'rules').calibrated_tokens, 630)
    assert.equal(calibrated.categories.find((item) => item.id === 'conversation').calibrated_tokens, 20)
    assert.equal(calibrated.displayed_total_tokens, 650)
  })

  it('projects request-start usage from the previous real turn plus the delta', () => {
    const previousTurnEnd = normalizeContextSnapshot({
      phase: 'turn_end',
      estimated_total_tokens: 1000,
      actual_input_tokens: 900,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300 },
      ],
    })
    const requestStart = normalizeContextSnapshot({
      estimated_total_tokens: 1200,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    })
    const projected = projectIncrementalContextSnapshot(requestStart, previousTurnEnd.actual_input_tokens, previousTurnEnd.estimated_total_tokens)

    assert.equal(projected.displayed_total_tokens, 1100)
    assert.equal(Math.round(contextUsagePercent(projected)), 55)
  })

  it('does not project below the previous provider total when local estimation drops', () => {
    const requestStart = normalizeContextSnapshot({
      estimated_total_tokens: 850,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 150 },
      ],
    })

    const projected = projectIncrementalContextSnapshot(requestStart, 900, 1000)

    assert.equal(projected.displayed_total_tokens, 900)
  })

  it('uses a provider anchor even when the prior snapshot is still request-start', () => {
    const previousRequestStart = normalizeContextSnapshot({
      phase: 'request_start',
      estimated_total_tokens: 1000,
      actual_input_tokens: 900,
      token_source: 'provider_calibrated',
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300 },
      ],
    })
    const nextRequestStart = normalizeContextSnapshot({
      phase: 'request_start',
      estimated_total_tokens: 1200,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    })

    const projected = projectIncrementalContextSnapshot(
      nextRequestStart,
      previousRequestStart.actual_input_tokens,
      previousRequestStart.estimated_total_tokens,
    )

    assert.equal(projected.displayed_total_tokens, 1100)
  })

  it('derives the non-conversation anchor when category calibration is absent', () => {
    const anchor = createContextTokenAnchor(normalizeContextSnapshot({
      phase: 'request_start',
      estimated_total_tokens: 1000,
      actual_input_tokens: 900,
      token_source: 'provider_calibrated',
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300 },
      ],
    }))

    assert.equal(anchor.non_conversation_tokens, 630)
  })

  it('keeps an already calibrated request-start snapshot exact', () => {
    useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
    const snapshot = {
      phase: 'request_start',
      estimated_total_tokens: 1200,
      actual_input_tokens: 1050,
      token_source: 'provider_calibrated',
      displayed_total_tokens: 1050,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700, calibrated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500, calibrated_tokens: 350 },
      ],
    }

    useWorksStore.getState().setContextSnapshot('work-1', snapshot)

    assert.equal(useWorksStore.getState().contextSnapshots['work-1'].displayed_total_tokens, 1050)
    assert.equal(useWorksStore.getState().contextTokenAnchors['work-1'].non_conversation_tokens, 700)
    useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
  })

  it('resets the old provider anchor after a compaction probe', () => {
    const before = calibrateContextSnapshot(normalizeContextSnapshot({
      phase: 'turn_end',
      estimated_total_tokens: 1000,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300 },
      ],
    }), 900)
    const compacted = normalizeContextSnapshot({
      phase: 'request_start',
      estimated_total_tokens: 700,
      context_limit: 2000,
      compaction: {
        mode: 'conversation_only',
        before_tokens: 1000,
        after_tokens: 500,
        summarized_message_count: 4,
        retained_message_count: 2,
      },
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    })
    const recalibrated = calibrateCompactedContextSnapshot(compacted, 650, createContextTokenAnchor(before))

    assert.equal(recalibrated.displayed_total_tokens, 650)
    assert.equal(Math.round(contextUsagePercent(recalibrated)), 33)
  })

  it('uses the compaction probe usage in the works store', () => {
    useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
    useWorksStore.getState().setContextSnapshot('work-1', {
      phase: 'turn_end',
      estimated_total_tokens: 1000,
      actual_input_tokens: 900,
      token_source: 'provider_calibrated',
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700, calibrated_tokens: 630 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300, calibrated_tokens: 270 },
      ],
    })
    useWorksStore.getState().setContextSnapshot('work-1', {
      phase: 'request_start',
      estimated_total_tokens: 700,
      context_limit: 2000,
      compaction: {
        mode: 'conversation_only',
        before_tokens: 1000,
        after_tokens: 500,
        summarized_message_count: 4,
        retained_message_count: 2,
      },
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    })
    useWorksStore.getState().setContextUsage('work-1', {
      total_input_tokens: 650,
      kind: 'post_compaction_probe',
    })

    const snapshot = useWorksStore.getState().contextSnapshots['work-1']
    assert.equal(snapshot.displayed_total_tokens, 650)
    assert.equal(snapshot.categories.find((item) => item.id === 'conversation').calibrated_tokens, 20)
    useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
  })

  it('ignores cumulative normal query usage for context display', () => {
    useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
    useWorksStore.getState().setContextSnapshot('work-1', {
      phase: 'turn_end',
      estimated_total_tokens: 1200,
      context_limit: 2000,
      displayed_total_tokens: 1200,
      token_source: 'estimated',
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    })

    useWorksStore.getState().setContextUsage('work-1', { total_input_tokens: 173900 })

    const snapshot = useWorksStore.getState().contextSnapshots['work-1']
    assert.equal(snapshot.displayed_total_tokens, 1200)
    assert.equal(snapshot.token_source, 'estimated')
    assert.equal(snapshot.categories.find((item) => item.id === 'rules').calibrated_tokens, undefined)
    useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
  })

  it('keeps the provider anchor in the works store across request-start snapshots', () => {
    useWorksStore.setState({ contextSnapshots: {} })
    const first = {
      phase: 'request_start',
      estimated_total_tokens: 1000,
      actual_input_tokens: 900,
      token_source: 'provider_calibrated',
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 300 },
      ],
    }
    const second = {
      phase: 'request_start',
      estimated_total_tokens: 1200,
      context_limit: 2000,
      categories: [
        { id: 'rules', scope: 'runtime', estimated_tokens: 700 },
        { id: 'conversation', scope: 'work', estimated_tokens: 500 },
      ],
    }

    useWorksStore.getState().setContextSnapshot('work-1', first)
    useWorksStore.getState().setContextSnapshot('work-1', second)

    assert.equal(useWorksStore.getState().contextSnapshots['work-1'].displayed_total_tokens, 1100)
    useWorksStore.setState({ contextSnapshots: {} })
  })

  it('formats token counts for compact UI labels', () => {
    assert.equal(formatContextTokens(456), '456')
    assert.equal(formatContextTokens(8600), '8.60K')
    assert.equal(formatContextTokens(17100), '17.1K')
    assert.equal(formatContextTokens(1000000), '1M')
    assert.equal(formatContextTokens(1500000), '1.5M')
  })

  it('parses preset and custom context window values', () => {
    assert.equal(parseContextLimitInput('128K'), 128000)
    assert.equal(parseContextLimitInput('1M'), 1000000)
    assert.equal(parseContextLimitInput('1.5M'), 1500000)
    assert.equal(parseContextLimitInput('1000000'), null)
    assert.equal(parseContextLimitInput('1G'), null)
    assert.equal(parseContextLimitInput('nope'), null)
    assert.equal(formatContextLimitInput(1000000), '1M')
  })
})

it('calibrates normal context only from the latest request, not cumulative billing', () => {
  useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
  useWorksStore.getState().setContextSnapshot('fixture-work', {
    phase: 'request_start', estimated_total_tokens: 500, context_limit: 2000,
    categories: [{ id: 'conversation', scope: 'work', estimated_tokens: 500 }],
  })
  useWorksStore.getState().setContextUsage('fixture-work', { total_input_tokens: 9000, context_input_tokens: 600 })
  assert.equal(useWorksStore.getState().contextSnapshots['fixture-work'].displayed_total_tokens, 600)
  useWorksStore.getState().setContextUsage('fixture-work', { total_input_tokens: 12000 })
  assert.equal(useWorksStore.getState().contextSnapshots['fixture-work'].displayed_total_tokens, 600)
  useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
})


it('keeps unknown calibration values null and uses local estimates', () => {
  const snapshot = normalizeContextSnapshot({ estimated_total_tokens: 120, displayed_total_tokens: null, actual_input_tokens: null, categories: [{ id: 'conversation', estimated_tokens: 120, calibrated_tokens: null }] })
  assert.equal(snapshot.actual_input_tokens, null)
  assert.equal(snapshot.categories[0].calibrated_tokens, null)
  assert.equal(snapshot.displayed_total_tokens, 120)
  assert.equal(createContextTokenAnchor(snapshot), null)
  assert.equal(normalizeContextSnapshot(snapshot).categories[0].calibrated_tokens, null)
})

it('recovers estimates from a zero-calibrated snapshot from an older backend', () => {
  const snapshot = normalizeContextSnapshot({ token_source: 'provider_calibrated', estimated_total_tokens: 120, displayed_total_tokens: 0, actual_input_tokens: 0, categories: [{ id: 'conversation', estimated_tokens: 120, calibrated_tokens: 0 }] })
  assert.equal(snapshot.token_source, 'estimated')
  assert.equal(snapshot.displayed_total_tokens, 120)
  assert.equal(snapshot.categories[0].calibrated_tokens, null)
})

it('does not clear context estimates or create a zero anchor for missing usage', () => {
  const snapshot = normalizeContextSnapshot({ phase: 'request_start', estimated_total_tokens: 120, categories: [{ id: 'conversation', estimated_tokens: 120 }] })
  for (const usage of [null, undefined, 0, -1, NaN]) {
    assert.equal(calibrateContextSnapshot(snapshot, usage).displayed_total_tokens, 120)
    assert.equal(calibrateCompactedContextSnapshot(snapshot, usage, null).displayed_total_tokens, 120)
  }
  useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
  useWorksStore.getState().setContextSnapshot('fixture-work', snapshot)
  useWorksStore.getState().setContextSnapshot('fixture-work', snapshot)
  useWorksStore.getState().setContextUsage('fixture-work', { context_input_tokens: 0 })
  assert.equal(useWorksStore.getState().contextSnapshots['fixture-work'].displayed_total_tokens, 120)
  assert.equal(useWorksStore.getState().contextTokenAnchors['fixture-work'], undefined)
  useWorksStore.setState({ contextSnapshots: {}, contextTokenAnchors: {} })
})
