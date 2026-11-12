import { describe, expect, it, vi } from 'vitest'
import { planCascade, type PlanCascadeDeps } from '../api-query-router/cascade.js'
import { executeRoutePlan, type RouteEngine } from '../api-query-router/index.js'
import { emptyRouterConfigBundle } from '../router-config/types.js'

const routeTool = 'example.com.route'
const cardTool = 'example.com.card'
const aliasTool = 'example.com.explicit'

function deps(): PlanCascadeDeps {
  return {
    matchers: {
      route: vi.fn(() => ({ id: 'fixed', tool: routeTool, args: { limit: 1 } })),
      scenario: {
        matchDirect: vi.fn(() => ({ tool: cardTool, args: { limit: 2 } })),
        matchPlanDirect: vi.fn(() => null), match: vi.fn(() => null),
        matchPlan: vi.fn(() => null), matchOptOut: vi.fn(() => null),
      },
      template: vi.fn(() => null), pattern: vi.fn(() => null), plan: vi.fn(() => null),
      shortcut: vi.fn(() => null), alias: vi.fn(() => ({ id: 'explicit', tool: aliasTool, args: {} })),
    },
    guards: {
      isDiscussion: () => false, isFollowUp: () => false, mentionsAdapter: () => true,
      isAliasPrefixed: (text) => text.startsWith('!'),
      isRoutableTool: (tool) => tool !== 'example.com.write',
    },
  }
}

const card = { adapterId: 'example.com', scenarioId: 'read', slots: {} }
const input = (message: string, scenarioPayload = card) => ({ message, scenarioPayload, workId: 'fixture', now: 0 })

describe('explicit route priority', () => {
  it('chooses a valid read-only card over a conflicting P route, with no later candidate', () => {
    const d = deps()
    const plan = planCascade(input('列出示例'), d)
    expect(plan.steps.map(step => step.layer)).toEqual(['scenario-a'])
    expect(plan.steps[0].decision).toMatchObject({ kind: 'tool', tool: cardTool, args: { limit: 2 } })
    expect(d.matchers.route).not.toHaveBeenCalled()
  })

  it('dispatches only the validated card, with card args, when P conflicts', async () => {
    const d = deps()
    const plan = planCascade(input('列出示例'), d)
    const dispatch = vi.fn(async () => '{"items":[{"id":"fixture"}]}')
    const send = vi.fn()
    const engine = { matchers: d.matchers, routableTools: new Set([cardTool, routeTool]),
      bundle: emptyRouterConfigBundle(), plans: [], signature: 'fixture', describe: 'fixture' } as RouteEngine
    expect(await executeRoutePlan(plan, { ...input('列出示例'), turnId: 'turn-1', chatStartTime: 0, send },
      { engine, dispatch, persistAssistantMessage: vi.fn() })).toBe(true)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(cardTool, '{"limit":2}', 'fixture')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_end', routeSource: 'scenario-a' }))
  })

  it('preserves the P route when a card is absent, invalid, or not routable', () => {
    for (const cardResult of [null, { tool: 'example.com.write', args: {} }]) {
      const d = deps()
      d.matchers.scenario.matchDirect = vi.fn(() => cardResult)
      expect(planCascade(input('列出示例'), d).steps[0]).toMatchObject({ layer: 'route', decision: { tool: routeTool } })
    }
    const noHint = deps()
    expect(planCascade({ ...input('列出示例'), scenarioPayload: null }, noHint).steps[0].layer).toBe('route')
    expect(noHint.matchers.scenario.matchDirect).not.toHaveBeenCalled()
  })

  it('gives a recognized explicit alias sole priority over card and P', () => {
    const d = deps()
    expect(planCascade(input('!example.com.explicit'), d).steps).toMatchObject([
      { layer: 'alias', decision: { tool: aliasTool } },
    ])
    expect(d.matchers.route).not.toHaveBeenCalled()
    expect(d.matchers.scenario.matchDirect).not.toHaveBeenCalled()
  })

  it('does not guess any route for an unknown or unavailable explicit alias', () => {
    for (const aliasResult of [null, { id: 'write', tool: 'example.com.write', args: {} }]) {
      const d = deps()
      d.matchers.alias = vi.fn(() => aliasResult)
      expect(planCascade(input('!unknown'), d)).toMatchObject({ steps: [], blocked: { gate: 'alias_gate' } })
      expect(d.matchers.route).not.toHaveBeenCalled()
    }
  })

  it('does not let a single-tool card swallow a sequential request', () => {
    const d = deps()
    const plan = planCascade(input('先列出示例再创建任务'), d)
    expect(plan.steps.some(step => step.layer === 'scenario-a')).toBe(false)
    expect(d.matchers.scenario.matchDirect).not.toHaveBeenCalled()
  })

  it('does not promote structured multi-hop hints before per-hop safety validation', () => {
    const d = deps()
    d.matchers.scenario.matchDirect = vi.fn(() => null)
    d.matchers.scenario.matchPlanDirect = vi.fn(() => ({ adapter: 'example.com', scenarioId: 'plan', terminalKey: 'read', input: {}, slotValues: [] }))
    const plan = planCascade(input('列出示例'), d)
    expect(plan.steps.some(step => step.layer === 'scenario-a-plan')).toBe(false)
    expect(plan.steps[0].layer).toBe('route')
    expect(d.matchers.scenario.matchPlanDirect).not.toHaveBeenCalled()
  })
})
