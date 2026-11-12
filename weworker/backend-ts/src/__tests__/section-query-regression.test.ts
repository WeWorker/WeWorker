import { describe, expect, it, vi } from 'vitest'
import { renderGeneric } from '../api-query-router/generic-renderer.js'
import { renderFromSchema } from '../api-query-router/declarative-renderer.js'
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
    expect(md).not.toContain('经查询，没有符合条件的数据')
  })

  it('escapes cells, respects columns and skips malformed sections', () => {
    const md = renderGeneric(JSON.stringify({ sections: [null, 5, [], { title: 'Rules', columns: ['rule'], rows: [{ rule: '`name` | value\nnext', hidden: 'omit' }] }, { title: 'Empty', content: '' }] }))
    expect(md).toContain('`name` \\| value next')
    expect(md).not.toContain('omit')
    // 空分节直接跳过：既不堆「无」，也不把空话术当正文
    expect(md).not.toContain('## Empty')
    expect(renderGeneric(JSON.stringify({ sections: [{ rows: [{ id: 1 }] }] }))).toContain('| id |')
  })

  it('keeps an empty group visible with a short marker instead of dropping it', () => {
    const schema = {
      title: '到期工单',
      sections: [
        { title: '安全单', dataSource: 'groups.security.items', columns: [{ type: 'text' as const, key: 'id', title: '工单号' }] },
        { title: '问题单', dataSource: 'groups.event.items', columns: [{ type: 'text' as const, key: 'id', title: '工单号' }] },
        { title: '事件单', dataSource: 'groups.incident.items', emptyMessage: '当前暂无事件单', columns: [{ type: 'text' as const, key: 'id', title: '工单号' }] },
      ],
    }
    const mixed = renderFromSchema(
      schema,
      { groups: { security: { items: [{ id: 'S1' }] }, event: { items: [] }, incident: { items: [] } } },
      { now: new Date('2026-10-23T00:00:00Z') },
    )
    // 有数据的分组照常出表；空分组保留标题 + 一句说明，用户能看出「这一类查了、确实没有」
    expect(mixed).toContain('### 安全单（1 条）')
    expect(mixed).toContain('### 问题单\n\n无')
    expect(mixed).toContain('### 事件单\n\n当前暂无事件单')

    // 接口没返回这个分组字段 ≠ 查了没有：不凭空造一节「无」
    const missing = renderFromSchema(schema, { groups: { security: { items: [{ id: 'S1' }] } } }, { now: new Date() })
    expect(missing).toContain('### 安全单（1 条）')
    expect(missing).not.toContain('### 问题单')

    // 整份都没有数据 → 收敛成一句总述，不堆一屏「无」
    const allEmpty = renderFromSchema(
      { ...schema, emptyMessage: '经查询，期限内没有到期的工单。' },
      { groups: { security: { items: [] }, event: { items: [] }, incident: { items: [] } } },
      { now: new Date() },
    )
    expect(allEmpty).toBe('### 到期工单\n\n经查询，期限内没有到期的工单。')
  })

  it('preserves error/large-output handling and renders rehydrated sections', () => {
    expect(renderGeneric(JSON.stringify({ ...result, error: 'fixture failure' }))).toContain('查询失败')
    const pointer = JSON.stringify({ type: 'large_output', file: 'fixture.json' })
    expect(renderGeneric(pointer)).toContain('结果过大已落盘')
    expect(renderGeneric(pointer, undefined, undefined, { rehydrate: () => JSON.stringify(result) })).toContain(result.sections[1].content)
    expect(renderGeneric(JSON.stringify({ items: [] }))).toContain('经查询，没有符合条件的数据。')
    expect(renderGeneric(JSON.stringify({ items: [{ id: 1 }] }))).toContain('| id |')
  })

  it('never renders an unparseable cache blob as a key/value answer', () => {
    // 落盘内容读不出 JSON 时 `readCacheResult` 会兜底成 `{_rawText}`；渲染层必须把它当成
    // 「没有可展示内容」（空正文 → 调用方落回模型），而不是一行被截断的 `- **_rawText**: {…`
    const blob = JSON.stringify({ _rawText: '{\n  "availabilityNotice": "",\n  "count": 9,\n  "rooms": [' })
    expect(renderGeneric(blob)).toBe('')
    expect(renderGeneric(blob, '企业微信会议室')).toBe('')
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
