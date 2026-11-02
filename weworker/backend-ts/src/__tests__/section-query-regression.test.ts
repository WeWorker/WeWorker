import { describe, expect, it, vi } from 'vitest'
import { renderGeneric } from '../api-query-router/generic-renderer.js'
import { buildCompactSummary } from '../webcli-result-project.js'
import { planCascade, type PlanCascadeDeps } from '../api-query-router/cascade.js'
import { executeRoutePlan, tryIntelligentQueryRoute, type RouteEngine } from '../api-query-router/index.js'
import { isSequentialRequest } from '../api-query-router/gates.js'
import { emptyRouterConfigBundle } from '../router-config/types.js'

const tool = 'example.com.sql_rules'
const result = {
  sections: [
    { title: 'SQL rules', columns: ['rule'], rows: [{ rule: 'Keep each statement on one line.' }, { rule: 'Always include required options. '.repeat(8) }] },
    { title: 'Examples', content: '```sql\nSELECT 1;\n```' },
    { title: 'Workflow', content: '1. Create a job.\n2. Start after confirmation.\n3. Read the result.' },
  ],
}

function dependencies(): PlanCascadeDeps {
  return {
    matchers: {
      route: vi.fn(() => null), template: vi.fn(() => null),
      scenario: { matchDirect: vi.fn(() => null), matchPlanDirect: vi.fn(() => null), match: vi.fn(() => null), matchPlan: vi.fn(() => null), matchOptOut: vi.fn(() => null) },
      pattern: vi.fn(() => ({ tool, args: {}, confidence: 1 })),
      plan: vi.fn(() => null), shortcut: vi.fn(() => null), alias: vi.fn(() => null),
    },
    guards: { isDiscussion: () => false, isFollowUp: () => false, mentionsAdapter: () => true, isAliasPrefixed: (message) => message.startsWith('!'), isRoutableTool: () => true },
  }
}

function engine(deps: PlanCascadeDeps): RouteEngine {
  return { matchers: deps.matchers, routableTools: new Set([tool]), bundle: emptyRouterConfigBundle(), plans: [], signature: 'fixture', describe: 'fixture' }
}

describe('section result rendering', () => {
  it('preserves all rules, SQL examples and workflow content before schema fallback', () => {
    const lookupSchema = vi.fn()
    const md = renderGeneric(JSON.stringify(result), undefined, { schemaId: 'unused' }, { lookupSchema })
    for (const section of result.sections) {
      expect(md).toContain(`## ${section.title}`)
      if (section.content) expect(md).toContain(section.content)
      for (const row of section.rows ?? []) expect(md).toContain(row.rule)
    }
    expect(lookupSchema).not.toHaveBeenCalled()
    expect(md).not.toContain('未查询到相关数据')
  })

  it('escapes cells, respects columns and skips malformed sections', () => {
    const md = renderGeneric(JSON.stringify({ sections: [null, 5, [], { title: 'Rules', columns: ['rule'], rows: [{ rule: '`name` | value\nnext', hidden: 'omit' }] }, { title: 'Empty', content: '' }] }))
    expect(md).toContain('`name` \\| value next')
    expect(md).not.toContain('omit')
    expect(md).toContain('## Empty\n\n（无数据）')
    expect(renderGeneric(JSON.stringify({ sections: [{ rows: [{ id: 1 }] }] }))).toContain('| id |')
  })

  it('preserves error/large-output handling and renders rehydrated sections', () => {
    expect(renderGeneric(JSON.stringify({ ...result, error: 'fixture failure' }))).toContain('查询失败')
    const pointer = JSON.stringify({ type: 'large_output', file: 'fixture.json' })
    expect(renderGeneric(pointer)).toContain('结果过大已落盘')
    expect(renderGeneric(pointer, undefined, undefined, { rehydrate: () => JSON.stringify(result) })).toContain(result.sections[1].content)
    expect(renderGeneric(JSON.stringify({ items: [] }))).toContain('未查询到相关数据')
    expect(renderGeneric(JSON.stringify({ items: [{ id: 1 }] }))).toContain('| id |')
  })

  it('keeps section content in capped summaries', () => {
    expect(buildCompactSummary(result)).toContain(result.sections[1].content)
    expect(buildCompactSummary(result)).toContain('rule=')
    const mixed = { sections: [{ content: 'text', rows: [{ id: 1 }] }] }
    expect(buildCompactSummary(mixed)).toContain('text')
    expect(buildCompactSummary(mixed)).toContain('id=1')
    expect(buildCompactSummary({ sections: [{ content: 'x'.repeat(9000) }] })).toContain('已截断')
  })
})

describe('sequential query fallback', () => {
  it.each(['先查看 SQL 规则，再为示例数据库创建查询作业', '查看规则，然后启动作业', '查看规则，接着查询结果', '查看规则，随后执行 SQL'])('%s skips inferred routing without side effects', async (message) => {
    const deps = dependencies()
    const routeEngine = engine(deps)
    const dispatch = vi.fn()
    const send = vi.fn()
    const persistAssistantMessage = vi.fn()
    const plan = planCascade({ message, workId: 'fixture', now: 0 }, deps)
    expect(plan).toMatchObject({ steps: [], blocked: { gate: 'sequential' } })
    expect(deps.matchers.pattern).not.toHaveBeenCalled()
    expect(await tryIntelligentQueryRoute({ message, workId: 'fixture', turnId: 'fixture', chatStartTime: Date.now(), send }, { engine: routeEngine, dispatch, persistAssistantMessage })).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(persistAssistantMessage).not.toHaveBeenCalled()
  })

  it('does not let keyword routes take over one step', () => {
    const deps = dependencies()
    deps.matchers.route = vi.fn(() => ({ id: 'rules', tool, args: {} }))
    expect(planCascade({ message: '先查看规则再创建作业', workId: 'fixture', now: 0 }, deps).blocked?.gate).toBe('sequential')
    expect(deps.matchers.route).not.toHaveBeenCalled()
  })

  it('preserves exact templates without falling through to broad patterns', () => {
    const deps = dependencies()
    deps.matchers.template = () => ({ id: 'exact', tool, args: {} })
    const plan = planCascade({ message: '先查看规则再创建作业', workId: 'fixture', now: 0 }, deps)
    expect(plan.steps.map((step) => step.layer)).toEqual(['template'])
    expect(plan.blocked).toBeUndefined()
    expect(deps.matchers.pattern).not.toHaveBeenCalled()
  })

  it('preserves explicit aliases and single-step queries', async () => {
    expect(isSequentialRequest('查看创建作业的 SQL 使用规则')).toBe(false)
    const deps = dependencies()
    deps.matchers.alias = () => ({ id: 'explicit', tool, args: {} })
    expect(planCascade({ message: '!example.com.sql_rules 先查看规则再创建作业', workId: 'fixture', now: 0 }, deps).steps.some((step) => step.layer === 'alias')).toBe(true)
    const routeEngine = engine(dependencies())
    const plan = planCascade({ message: '查看 SQL 使用规则', workId: 'fixture', now: 0 }, dependencies())
    const dispatch = vi.fn(async () => JSON.stringify(result))
    const send = vi.fn()
    const persistAssistantMessage = vi.fn()
    expect(await executeRoutePlan(plan, { message: '查看 SQL 使用规则', workId: 'fixture', turnId: 'fixture', chatStartTime: Date.now(), send }, { engine: routeEngine, dispatch, persistAssistantMessage })).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(send.mock.calls.map(([event]) => (event as { type: string }).type)).toEqual(['turn_start', 'text_delta', 'turn_end'])
    expect(persistAssistantMessage).toHaveBeenCalledOnce()
  })
})
