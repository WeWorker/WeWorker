import { describe, expect, it, vi } from 'vitest'
import { planCascade, type CascadeInput, type PlanCascadeDeps } from '../api-query-router/cascade.js'

const cardTool = 'example.com.card'
const otherTool = 'example.com.other'

function deps(): PlanCascadeDeps {
  return {
    matchers: {
      route: vi.fn(() => null),
      scenario: {
        matchDirect: vi.fn(() => ({ tool: cardTool, args: { limit: 2 } })),
        matchPlanDirect: vi.fn(() => null),
        match: vi.fn(() => null),
        matchPlan: vi.fn(() => null),
        matchOptOut: vi.fn(() => null),
      },
      template: vi.fn(() => null),
      pattern: vi.fn(() => null),
      plan: vi.fn(() => null),
      shortcut: vi.fn(() => null),
      alias: vi.fn(() => null),
    },
    guards: {
      isDiscussion: () => false,
      isFollowUp: () => false,
      mentionsAdapter: () => true,
      isAliasPrefixed: (text: string) => text.startsWith('!'),
      isRoutableTool: () => true,
    },
  }
}

const card: NonNullable<CascadeInput['scenarioPayload']> = { adapterId: 'example.com', scenarioId: 'read', slots: {} }
const input = (message: string, scenarioPayload: CascadeInput['scenarioPayload'] = card): CascadeInput =>
  ({ message, scenarioPayload, workId: 'fixture', now: 0 })

describe('card rendering declaration', () => {
  it('a structured card inherits the schema its tool declares in patterns', () => {
    const d = deps()
    d.schemaForTool = vi.fn((tool: string) => (tool === cardTool ? 'example-list' : undefined))
    const plan = planCascade(input('列出示例'), d)
    expect(plan.steps[0]).toMatchObject({
      layer: 'scenario-a',
      decision: { kind: 'tool', tool: cardTool, args: { limit: 2 }, render: { schemaId: 'example-list' } },
    })
  })

  it('never borrows a schema declared for a different tool', () => {
    const d = deps()
    d.schemaForTool = vi.fn((tool: string) => (tool === otherTool ? 'wrong' : undefined))
    const decision = planCascade(input('列出示例'), d).steps[0].decision as { render?: { schemaId?: string } }
    expect(decision.render?.schemaId).toBeUndefined()
  })

  it('keeps a text-matched card ahead of pattern and inherits the same schema', () => {
    const d = deps()
    d.matchers.scenario.match = vi.fn(() => ({ tool: cardTool, args: { limit: 2 } }))
    d.schemaForTool = vi.fn((tool: string) => (tool === cardTool ? 'example-list' : undefined))
    const plan = planCascade({ ...input('列出示例'), scenarioPayload: null }, d)
    expect(plan.steps.find((step) => step.layer === 'scenario')).toMatchObject({
      decision: { kind: 'tool', tool: cardTool, render: { schemaId: 'example-list' } },
    })
  })

  it('leaves rendering untouched when no schema is declared for the card tool', () => {
    const plan = planCascade(input('列出示例'), deps())
    const decision = plan.steps[0].decision as { render?: { schemaId?: string } }
    expect(decision.render).toEqual({})
  })
})
