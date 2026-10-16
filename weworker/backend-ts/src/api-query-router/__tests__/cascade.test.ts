/**
 * 18 行级联的规划器单测（design §2）。
 *
 * 这里守的是**顺序**与**失败后走向**——两者都是「漏判免费、误判致命」里「致命」那一半的载体：
 * 顺序错一层，宽泛正则就会先于特化卡片命中；失败走向错一次，就会在已经派发过一个错工具之后
 * 继续猜第二个。所以下面的断言全部是「层级序列」和「onFailure」的显式断言。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  advanceAfterFailure,
  isLayerSkipped,
  planCascade,
  type CascadeLayer,
  type CascadeMatchers,
  type CascadePlan,
  type CascadeStep,
} from '../cascade.js'
import type { ScenarioOptOutHit, ScenarioPlanHit } from '../scenario-routes.js'

function planHit(overrides: Partial<ScenarioPlanHit> = {}): ScenarioPlanHit {
  return {
    adapter: 'example.com',
    scenarioId: 'flow',
    terminalKey: 'terminal',
    input: {},
    slotValues: [],
    ...overrides,
  }
}

function optOut(overrides: Partial<ScenarioOptOutHit> = {}): ScenarioOptOutHit {
  return { adapter: 'example.com', scenarioId: 'card', reason: '写操作', ...overrides }
}

/** 全部「未命中」的基线；各用例只打开自己关心的层。 */
function matchers(overrides: Partial<CascadeMatchers> = {}): CascadeMatchers {
  return {
    route: () => null,
    scenario: {
      matchDirect: () => null,
      matchPlanDirect: () => null,
      match: () => null,
      matchPlan: () => null,
      matchOptOut: () => null,
    },
    template: () => null,
    pattern: () => null,
    plan: () => null,
    shortcut: () => null,
    alias: () => null,
    ...overrides,
  }
}

function guards(overrides: Record<string, unknown> = {}) {
  return {
    isDiscussion: () => false,
    isFollowUp: () => false,
    mentionsAdapter: () => true,
    isAliasPrefixed: () => false,
    isRoutableTool: () => true,
    ...overrides,
  } as Parameters<typeof planCascade>[1]['guards']
}

function layers(plan: CascadePlan): CascadeLayer[] {
  return plan.steps.map((step) => step.layer)
}

function findStep(plan: CascadePlan, layer: CascadeLayer): CascadeStep {
  const step = plan.steps.find((item) => item.layer === layer)
  if (!step) throw new Error(`layer ${layer} missing; steps=${layers(plan).join(',')}`)
  return step
}

const tool = (name: string, args: Record<string, unknown> = {}) => ({ tool: name, args })

describe('层级顺序（design §2 行 1~17）', () => {
  it('全层齐备时严格按 层P → 0A → 0B → Tier-2 → 0B话术 → Tier-1 → plan → alias → shortcut → llm 排列', () => {
    const plan = planCascade(
      { message: '随便', workId: 'w', now: 0, scenarioPayload: { adapterId: 'example.com', scenarioId: 'card' } },
      {
        matchers: matchers({
          route: () => ({ ...tool('routeTool'), id: 'r1' }),
          scenario: {
            matchDirect: () => tool('directTool'),
            matchPlanDirect: () => planHit({ adapter: 'a', scenarioId: 'p' }),
            match: () => tool('phraseTool'),
            matchPlan: () => planHit({ adapter: 'b', scenarioId: 'p2' }),
            matchOptOut: () => null,
          },
          template: () => ({ ...tool('templateTool'), id: 't1' }),
          pattern: () => ({ ...tool('patternTool'), confidence: 0.9 }),
          plan: () => ({ hit: planHit() }),
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
          shortcut: () => ({ ...tool('shortcutTool'), id: 's1', schemaId: 'schema' }),
          llmClassify: () => ({ ...tool('llmTool'), confidence: 0.95 }),
        }),
        guards: guards(),
        llmClassifyEnabled: true,
      },
    )
    expect(layers(plan)).toEqual([
      'route',
      'scenario-a',
      'scenario-a-plan',
      'template',
      'scenario',
      'scenario',
      'pattern',
      'plan',
      'alias',
      'shortcut',
      'llm-classify',
    ])
  })

  it('硬约束①：第 0 层话术必须早于 Tier -1（宽泛正则会吃掉特化卡片句）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => tool('phraseTool'),
            matchPlan: () => null,
            matchOptOut: () => null,
          },
          pattern: () => ({ ...tool('patternTool'), confidence: 0.9 }),
        }),
        guards: guards(),
      },
    )
    expect(layers(plan).indexOf('scenario')).toBeLessThan(layers(plan).indexOf('pattern'))
  })

  it('硬约束②：Tier -2 在硬门之后、`!` 别名让位之前', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          template: () => ({ ...tool('templateTool'), id: 't1' }),
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
        }),
        guards: guards(),
      },
    )
    expect(layers(plan)).toEqual(['template', 'alias'])
  })

  it('`!` 前缀时 Tier -2 让位（用户显式点名优先于模板直达）', () => {
    const plan = planCascade(
      { message: '!a.b.c', workId: 'w', now: 0 },
      {
        matchers: matchers({
          template: () => ({ ...tool('templateTool'), id: 't1' }),
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
        }),
        guards: guards({ isAliasPrefixed: () => true }),
      },
    )
    expect(layers(plan)).toEqual(['alias'])
  })

  it('别名排在短路之前：显式点名优先于作者写的通用守卫', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
          shortcut: () => ({ ...tool('shortcutTool'), id: 's1' }),
        }),
        guards: guards(),
      },
    )
    expect(layers(plan)).toEqual(['alias', 'shortcut'])
  })

  it('层 P 命中即排在最前（配置路由是最高优先级）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          route: () => ({ ...tool('routeTool'), id: 'r1' }),
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => tool('phraseTool'),
            matchPlan: () => null,
            matchOptOut: () => null,
          },
        }),
        guards: guards(),
      },
    )
    expect(layers(plan)).toEqual(['route', 'scenario'])
  })
})

describe('硬门（讨论态 / 追问态 / 别名门）', () => {
  it('讨论态：steps 为空且标记 gate，任何层都不得抢答', () => {
    const plan = planCascade(
      { message: '这个系统怎么工作的', workId: 'w', now: 0 },
      {
        matchers: matchers({
          pattern: () => ({ ...tool('patternTool'), confidence: 1 }),
          route: () => ({ ...tool('routeTool'), id: 'r1' }),
        }),
        guards: guards({ isDiscussion: () => true }),
      },
    )
    expect(plan.steps).toEqual([])
    expect(plan.blocked).toEqual({ gate: 'discussion' })
  })

  it('追问态：同上，回指词 + 近窗路由结果不得被重跑吞掉', () => {
    const plan = planCascade(
      { message: '那第二个呢', workId: 'w', now: 0 },
      {
        matchers: matchers({ plan: () => ({ hit: planHit() }) }),
        guards: guards({ isFollowUp: () => true }),
      },
    )
    expect(plan.steps).toEqual([])
    expect(plan.blocked).toEqual({ gate: 'follow_up' })
  })

  it('`!` 前缀豁免两道硬门（显式指令不被守卫拦下）', () => {
    const plan = planCascade(
      { message: '!a.b.c', workId: 'w', now: 0 },
      {
        matchers: matchers({ alias: () => ({ ...tool('aliasTool'), id: 'a1' }) }),
        guards: guards({ isDiscussion: () => true, isFollowUp: () => true, isAliasPrefixed: () => true }),
      },
    )
    expect(plan.blocked).toBeUndefined()
    expect(layers(plan)).toEqual(['alias'])
  })

  it('别名门：`!` 开头却无任何别名匹配 → 整条 blocked，绝不降级到宽泛层猜', () => {
    const plan = planCascade(
      { message: '!不存在的工具', workId: 'w', now: 0 },
      {
        matchers: matchers({
          pattern: () => ({ ...tool('patternTool'), confidence: 1 }),
          shortcut: () => ({ ...tool('shortcutTool'), id: 's1' }),
        }),
        guards: guards({ isAliasPrefixed: () => true }),
      },
    )
    expect(plan.blocked).toEqual({ gate: 'alias_gate' })
    expect(plan.steps.some((step) => step.layer === 'pattern')).toBe(false)
  })
})

describe('opt-out：只抑制宽泛启发层', () => {
  it('抑制 Tier -1 与 Tier 2，但不抑制确定性层（plan / 别名 / 短路 / 模板）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => null,
            matchPlan: () => null,
            matchOptOut: () => optOut(),
          },
          template: () => ({ ...tool('templateTool'), id: 't1' }),
          pattern: () => ({ ...tool('patternTool'), confidence: 1 }),
          plan: () => ({ hit: planHit() }),
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
          llmClassify: () => ({ ...tool('llmTool'), confidence: 1 }),
        }),
        guards: guards(),
        llmClassifyEnabled: true,
      },
    )
    expect(plan.suppressed).toEqual(['pattern', 'llm-classify'])
    expect(layers(plan)).toEqual(['template', 'plan', 'alias'])
  })

  it('`!` 前缀时不做 opt-out 抑制（显式指令优先）', () => {
    const plan = planCascade(
      { message: '!a.b.c', workId: 'w', now: 0 },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => null,
            matchPlan: () => null,
            matchOptOut: () => optOut(),
          },
          pattern: () => ({ ...tool('patternTool'), confidence: 1 }),
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
        }),
        guards: guards({ isAliasPrefixed: () => true }),
      },
    )
    expect(plan.suppressed).toEqual([])
    expect(layers(plan)).toEqual(['pattern', 'alias'])
  })
})

describe('失败后走向（每层必须显式声明）', () => {
  it('Tier -1 失败 → stop（不再往下猜，落回 LLM）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          pattern: () => ({ ...tool('patternTool'), confidence: 0.9 }),
          plan: () => ({ hit: planHit() }),
        }),
        guards: guards(),
      },
    )
    expect(findStep(plan, 'pattern').onFailure).toEqual({ action: 'stop', reason: 'pattern_failed' })
  })

  it('形态 A 命中后失败 → 继续但剪掉 Tier -1（卡片已认领该消息，换工具作答比落回更糟）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0, scenarioPayload: { adapterId: 'example.com', scenarioId: 'c' } },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => tool('directTool'),
            matchPlanDirect: () => null,
            match: () => null,
            matchPlan: () => null,
            matchOptOut: () => null,
          },
        }),
        guards: guards(),
      },
    )
    expect(findStep(plan, 'scenario-a').onFailure).toEqual({ action: 'continue', prune: ['pattern'] })
  })

  it('形态 B（话术）同样剪掉 Tier -1', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => tool('phraseTool'),
            matchPlan: () => null,
            matchOptOut: () => null,
          },
        }),
        guards: guards(),
      },
    )
    expect(findStep(plan, 'scenario').onFailure).toEqual({ action: 'continue', prune: ['pattern'] })
  })

  it('Tier -2 模板失败 → 继续（逐字全等无推断，失败就是没命中）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({ template: () => ({ ...tool('templateTool'), id: 't1' }) }),
        guards: guards(),
      },
    )
    expect(findStep(plan, 'template').onFailure).toEqual({ action: 'continue' })
  })

  it('plan / 别名 / 短路 / 层P 失败 → stop（各有更强依据，失败即落回）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          route: () => ({ ...tool('routeTool'), id: 'r1' }),
          plan: () => ({ hit: planHit() }),
          alias: () => ({ ...tool('aliasTool'), id: 'a1' }),
          shortcut: () => ({ ...tool('shortcutTool'), id: 's1' }),
        }),
        guards: guards(),
      },
    )
    for (const layer of ['route', 'plan', 'alias', 'shortcut'] as const) {
      expect(findStep(plan, layer).onFailure.action).toBe('stop')
    }
  })

  it('advanceAfterFailure：stop 不再走下游，continue 把剪枝层登记进集合', () => {
    const pruned = new Set<CascadeLayer>()
    expect(advanceAfterFailure({ layer: 'pattern', decision: null as never, onFailure: { action: 'stop', reason: 'x' } }, pruned)).toEqual({ stop: true })
    expect(advanceAfterFailure({ layer: 'scenario', decision: null as never, onFailure: { action: 'continue', prune: ['pattern'] } }, pruned)).toEqual({ stop: false })
    expect([...pruned]).toEqual(['pattern'])
  })

  it('isLayerSkipped：规划期抑制与执行期剪枝都会跳过', () => {
    const plan: CascadePlan = { steps: [], suppressed: ['pattern'] }
    expect(isLayerSkipped('pattern', plan, new Set())).toBe(true)
    expect(isLayerSkipped('llm-classify', plan, new Set(['llm-classify']))).toBe(true)
    expect(isLayerSkipped('plan', plan, new Set())).toBe(false)
  })
})

describe('守卫与准入', () => {
  it('plan / 短路必须点名系统，否则该层跳过（自由话术不得触发多跳）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          plan: () => ({ hit: planHit() }),
          shortcut: () => ({ ...tool('shortcutTool'), id: 's1' }),
        }),
        guards: guards({ mentionsAdapter: () => false }),
      },
    )
    expect(plan.steps).toEqual([])
  })

  it('目标工具不在路由面（被删 / 不可直调 / 非只读）→ 该层视为未命中并继续下游', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => tool('writeTool'),
            matchPlan: () => null,
            matchOptOut: () => null,
          },
          route: () => ({ ...tool('routeTool'), id: 'r1' }),
        }),
        guards: guards({ isRoutableTool: (name: string) => name !== 'writeTool' }),
      },
    )
    expect(layers(plan)).toEqual(['route'])
  })

  it('某一层匹配器抛错 → 当作未命中，其余层照常（单层故障不得让整条级联失效）', () => {
    const log = vi.fn()
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0, log },
      {
        matchers: matchers({
          route: () => {
            throw new Error('boom')
          },
          pattern: () => ({ ...tool('patternTool'), confidence: 1 }),
        }),
        guards: guards(),
      },
    )
    expect(layers(plan)).toEqual(['pattern'])
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('layer route failed: boom')
  })

  it('Tier 2 默认关闭：未注入 matcher 时该层不存在于步骤表', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      { matchers: matchers(), guards: guards(), llmClassifyEnabled: true },
    )
    expect(plan.steps).toEqual([])
  })

  it('Tier 2 即使开启，opt-out 命中时也不执行', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => null,
            matchPlanDirect: () => null,
            match: () => null,
            matchPlan: () => null,
            matchOptOut: () => optOut(),
          },
          llmClassify: () => ({ ...tool('llmTool'), confidence: 1 }),
        }),
        guards: guards(),
        llmClassifyEnabled: true,
      },
    )
    expect(plan.steps).toEqual([])
  })
})

describe('决策载荷', () => {
  it('形态 A 的 source 与标签可追溯到具体卡片（日志不含用户数据）', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0, scenarioPayload: { adapterId: 'example.com', scenarioId: 'card-1' } },
      {
        matchers: matchers({
          scenario: {
            matchDirect: () => tool('directTool', { keyword: 'k' }),
            matchPlanDirect: () => null,
            match: () => null,
            matchPlan: () => null,
            matchOptOut: () => null,
          },
        }),
        guards: guards(),
      },
    )
    const step = findStep(plan, 'scenario-a')
    expect(step.decision).toMatchObject({
      kind: 'tool',
      tool: 'directTool',
      args: { keyword: 'k' },
      source: 'scenario-a',
      label: 'scenario-a example.com:card-1',
    })
  })

  it('短路带 schemaId 渲染线索，来源标记为 override', () => {
    const plan = planCascade(
      { message: 'x', workId: 'w', now: 0 },
      {
        matchers: matchers({ shortcut: () => ({ ...tool('shortcutTool'), id: 's1', schemaId: 'schema-x' }) }),
        guards: guards(),
      },
    )
    expect(findStep(plan, 'shortcut').decision).toMatchObject({ source: 'override', render: { schemaId: 'schema-x' } })
  })
})
