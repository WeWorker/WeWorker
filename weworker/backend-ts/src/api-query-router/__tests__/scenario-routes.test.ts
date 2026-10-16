/**
 * 第 0 层运行时匹配器与**二次准入**单测。
 *
 * 二次准入（`filterRoutesByCatalog`）是写操作红线的最后一道闸：编译产物是进 git 的文件，
 * 可能因为工具被删 / `safety` 被改 / adapter 被停用而失真。这里逐条断言「失真即丢弃」，
 * 因为一旦漏掉，用户一句卡片话术就会直接触发一个写操作。
 */

import { describe, expect, it } from 'vitest'
import {
  buildScenarioDirectMatcher,
  buildScenarioMatcher,
  buildScenarioOptOutMatcher,
  buildScenarioPlanDirectMatcher,
  buildScenarioPlanMatcher,
  createScenarioMatchers,
  filterRoutesByCatalog,
  parseScenarioDirectPayload,
} from '../scenario-routes.js'
import type { CatalogTool, ToolCatalog } from '../tool-catalog.js'
import type { CompiledScenarioRoute, PlanTerminalsFile } from '../../router-config/types.js'

function route(overrides: Partial<CompiledScenarioRoute> = {}): CompiledScenarioRoute {
  return { adapter: 'example.com', scenarioId: 'card', ...overrides }
}

function catalogTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'example.com.search',
    adapterId: 'example.com',
    description: '',
    parameters: {},
    safety: 'read',
    direct: true,
    requiresConfirmation: false,
    aliases: [],
    ...overrides,
  }
}

function catalog(...tools: CatalogTool[]): ToolCatalog {
  const byName = new Map<string, CatalogTool>()
  for (const tool of tools) byName.set(tool.name, tool)
  return { tools, directTools: tools.filter((tool) => tool.direct), byName, adapterIds: new Set(tools.map((tool) => tool.adapterId)) }
}

describe('filterRoutesByCatalog：过期产物不得复活', () => {
  it('只读可直调工具 → 保留', () => {
    const result = filterRoutesByCatalog([route({ tool: 'search' })], null, catalog(catalogTool()))
    expect(result.routes).toHaveLength(1)
    expect(result.dropped).toEqual([])
  })

  it('工具已删除 → 丢弃', () => {
    const result = filterRoutesByCatalog([route({ tool: 'search' })], null, catalog())
    expect(result.routes).toEqual([])
    expect(result.dropped.join()).toContain('工具不存在')
  })

  it('工具改为不可直调 → 丢弃（页面态工具不得被服务端直呼）', () => {
    const result = filterRoutesByCatalog([route({ tool: 'search' })], null, catalog(catalogTool({ direct: false })))
    expect(result.routes).toEqual([])
    expect(result.dropped.join()).toContain('工具不可直调')
  })

  it('工具改成写操作 / 需二次确认 → 丢弃（§7 红线）', () => {
    const write = filterRoutesByCatalog([route({ tool: 'search' })], null, catalog(catalogTool({ safety: 'write' })))
    expect(write.routes).toEqual([])
    expect(write.dropped.join()).toContain('工具非只读')

    const confirm = filterRoutesByCatalog(
      [route({ tool: 'search' })],
      null,
      catalog(catalogTool({ requiresConfirmation: true })),
    )
    expect(confirm.routes).toEqual([])
    expect(confirm.dropped.join()).toContain('工具非只读')

    const noSafety = filterRoutesByCatalog([route({ tool: 'search' })], null, catalog(catalogTool({ safety: undefined })))
    expect(noSafety.routes).toEqual([])
  })

  it('enabled:false 的条目丢弃（逐条急停开关）', () => {
    const result = filterRoutesByCatalog([route({ tool: 'search', enabled: false })], null, catalog(catalogTool()))
    expect(result.routes).toEqual([])
    expect(result.dropped.join()).toContain('enabled:false')
  })

  it('opt-out 无派发目标，恒保留（它只抑制宽泛层）', () => {
    const result = filterRoutesByCatalog([route({ optout: true, reason: '写操作' })], null, catalog())
    expect(result.routes).toHaveLength(1)
  })

  it('plan 形态按 plan-terminals 白名单解析终点工具后再过同一道门', () => {
    const planTerminals: PlanTerminalsFile = {
      version: 1,
      adapters: { 'example.com': { terminal: { tool: 'search', input: {} } } },
    }
    const ok = filterRoutesByCatalog(
      [route({ plan: { terminal: 'terminal' } })],
      planTerminals,
      catalog(catalogTool()),
    )
    expect(ok.routes).toHaveLength(1)

    const stale = filterRoutesByCatalog([route({ plan: { terminal: 'gone' } })], planTerminals, catalog(catalogTool()))
    expect(stale.routes).toEqual([])
    expect(stale.dropped.join()).toContain('目标工具未解析')
  })

  it('用 `adapter.tool` 全名也能解析（产物两种写法都认）', () => {
    const result = filterRoutesByCatalog([route({ tool: 'example.com.search' })], null, catalog(catalogTool()))
    expect(result.routes).toHaveLength(1)
  })
})

describe('buildScenarioMatcher：话术锚定', () => {
  const routes = [
    route({
      tool: 'search',
      slotNames: ['关键词'],
      promptTemplates: ['帮我在示例站搜索${关键词}'],
      patterns: [{ regex: '^帮我在示例站搜索(?<s0>.+)$', flags: 'i' }],
      args: { keyword: { slot: 's0', type: 'string' } },
    }),
  ]

  it('命中即装配参数，confidence=1、source=scenario', () => {
    const hit = buildScenarioMatcher(routes)('帮我在示例站搜索开源项目')
    expect(hit).toEqual({ tool: 'search', args: { keyword: '开源项目' }, confidence: 1, source: 'scenario' })
  })

  it('归一化后匹配：用户多打的空格不影响命中', () => {
    const hit = buildScenarioMatcher(routes)('  帮我在示例站 搜索 开源项目  ')
    expect(hit?.args).toEqual({ keyword: '开源项目' })
  })

  it('自由话术不命中（卡片句是锚定全等，不是关键词包含）', () => {
    expect(buildScenarioMatcher(routes)('帮我搜一下开源项目')).toBeNull()
    expect(buildScenarioMatcher(routes)('')).toBeNull()
  })

  it('guardNegative 命中即整条否决', () => {
    const guarded = [{ ...routes[0], guardNegative: ['删除'] }]
    expect(buildScenarioMatcher(guarded)('帮我在示例站搜索删除的仓库')).toBeNull()
    expect(buildScenarioMatcher(guarded)('帮我在示例站搜索仓库')).not.toBeNull()
  })

  it('enum / 类型强转失败视为未命中（宁漏判不误判）', () => {
    const typed = [
      route({
        tool: 'search',
        patterns: [{ regex: '^搜索(?<s0>.+?)(?<s1>\\d+)$', flags: 'i' }],
        args: { keyword: { slot: 's0', type: 'string' }, limit: { slot: 's1', type: 'integer', enum: ['10', '20'] } },
      }),
    ]
    expect(buildScenarioMatcher(typed)('搜索项目10')?.args).toEqual({ keyword: '项目', limit: 10 })
    expect(buildScenarioMatcher(typed)('搜索项目99')).toBeNull()
  })

  it('禁用的条目与非法正则都不会参与匹配', () => {
    const broken = [
      route({ tool: 'a', enabled: false, patterns: [{ regex: '^x$' }] }),
      route({ scenarioId: 'bad', tool: 'b', patterns: [{ regex: '([' }] }),
    ]
    expect(buildScenarioMatcher(broken)('x')).toBeNull()
  })

  it('plan 形态不会被单工具匹配器误当成工具命中', () => {
    const planRoute = route({ plan: { terminal: 'terminal' }, patterns: [{ regex: '^x$' }] })
    expect(buildScenarioMatcher([planRoute])('x')).toBeNull()
  })
})

describe('buildScenarioPlanMatcher：多跳入口', () => {
  const routes = [
    route({
      scenarioId: 'flow',
      slotNames: ['关键词'],
      plan: { terminal: 'search-flow', input: { keyword: { slot: 's0', type: 'string' } } },
      patterns: [{ regex: '^发起流程(?<s0>.+)$', flags: 'i' }],
    }),
  ]

  it('装配 terminal 输入并记录槽位原值（供日志与审计）', () => {
    const hit = buildScenarioPlanMatcher(routes)('发起流程月度报表')
    expect(hit).toEqual({
      adapter: 'example.com',
      scenarioId: 'flow',
      terminalKey: 'search-flow',
      input: { keyword: '月度报表' },
      slotValues: [{ name: '关键词', raw: '月度报表' }],
    })
  })

  it('opt-out 条目不会被 plan 匹配器收进来（形态互斥）', () => {
    const optout = route({ optout: true, reason: 'r', patterns: [{ regex: '^x$' }] })
    expect(buildScenarioPlanMatcher([optout])('x')).toBeNull()
  })
})

describe('buildScenarioOptOutMatcher：抑制下层', () => {
  it('锚定命中返回卡片身份与理由', () => {
    const routes = [route({ scenarioId: 'like', optout: true, reason: '写操作', patterns: [{ regex: '^点赞(?<s0>.+)$', flags: 'i' }] })]
    expect(buildScenarioOptOutMatcher(routes)('点赞这个视频')).toEqual({
      adapter: 'example.com',
      scenarioId: 'like',
      reason: '写操作',
    })
  })

  it('带 tool 的条目不会被当成 opt-out（否则会误抑制一个正常直连）', () => {
    const routes = [route({ tool: 'search', patterns: [{ regex: '^x$' }] })]
    expect(buildScenarioOptOutMatcher(routes)('x')).toBeNull()
  })
})

describe('形态 A：重建比对一致性门', () => {
  const routes = [
    route({
      scenarioId: 'search-card',
      tool: 'search',
      slotNames: ['关键词'],
      promptTemplates: ['帮我在示例站搜索${关键词}'],
      patterns: [{ regex: '^帮我在示例站搜索(?<s0>.+)$', flags: 'i' }],
      args: { keyword: { slot: 's0', type: 'string' } },
    }),
  ]

  it('payload 槽位重填后与消息逐字相等 → 放行，参数取自槽位', () => {
    const hit = buildScenarioDirectMatcher(routes)(
      { adapterId: 'example.com', scenarioId: 'search-card', slots: { 关键词: '开源项目' } },
      '帮我在示例站搜索开源项目',
    )
    expect(hit).toEqual({ tool: 'search', args: { keyword: '开源项目' }, confidence: 1, source: 'scenario-a' })
  })

  it('消息被用户改过（与重填不一致）→ 不放行，落回形 B / LLM', () => {
    const hit = buildScenarioDirectMatcher(routes)(
      { adapterId: 'example.com', scenarioId: 'search-card', slots: { 关键词: '开源项目' } },
      '帮我在示例站搜索别的项目',
    )
    expect(hit).toBeNull()
  })

  it('payload 缺槽位 → 哨兵注入使重建文本必然不等（fail-closed）', () => {
    const hit = buildScenarioDirectMatcher(routes)(
      { adapterId: 'example.com', scenarioId: 'search-card' },
      '帮我在示例站搜索开源项目',
    )
    expect(hit).toBeNull()
  })

  it('未知 scenarioId / 已禁用条目 → 不放行', () => {
    expect(
      buildScenarioDirectMatcher(routes)({ adapterId: 'example.com', scenarioId: 'unknown' }, '随便'),
    ).toBeNull()
    expect(
      buildScenarioDirectMatcher([{ ...routes[0], enabled: false }])(
        { adapterId: 'example.com', scenarioId: 'search-card', slots: { 关键词: 'x' } },
        '帮我在示例站搜索x',
      ),
    ).toBeNull()
  })

  it('plan 形态走 plan 直连匹配器，且参数类型强转同样把关', () => {
    const planRoutes = [
      route({
        scenarioId: 'flow-card',
        slotNames: ['关键词', '条数'],
        promptTemplates: ['来${条数}条${关键词}'],
        plan: { terminal: 't', input: { keyword: { slot: 's0', type: 'string' }, limit: { slot: 's1', type: 'integer' } } },
        patterns: [{ regex: '^来(?<s1>.+?)条(?<s0>.+)$', flags: 'i' }],
      }),
    ]
    const hit = buildScenarioPlanDirectMatcher(planRoutes)(
      { adapterId: 'example.com', scenarioId: 'flow-card', slots: { 关键词: '报表', 条数: '5' } },
      '来5条报表',
    )
    expect(hit).toMatchObject({ terminalKey: 't', input: { keyword: '报表', limit: 5 } })

    const bad = buildScenarioPlanDirectMatcher(planRoutes)(
      { adapterId: 'example.com', scenarioId: 'flow-card', slots: { 关键词: '报表', 条数: 'x' } },
      '来x条报表',
    )
    expect(bad).toBeNull()
  })
})

describe('parseScenarioDirectPayload：载荷形状校验', () => {
  it('合法载荷取 adapterId/scenarioId 与字符串槽位', () => {
    expect(parseScenarioDirectPayload({ adapterId: 'example.com', scenarioId: 'c', slots: { k: 'v' } })).toEqual({
      adapterId: 'example.com',
      scenarioId: 'c',
      slots: { k: 'v' },
    })
  })

  it('畸形载荷一律静默忽略（它只是路由提示，不是对话内容）', () => {
    expect(parseScenarioDirectPayload(null)).toBeNull()
    expect(parseScenarioDirectPayload('example.com')).toBeNull()
    expect(parseScenarioDirectPayload([])).toBeNull()
    expect(parseScenarioDirectPayload({ scenarioId: 'c' })).toBeNull()
    expect(parseScenarioDirectPayload({ adapterId: '   ', scenarioId: 'c' })).toBeNull()
  })

  it('非字符串槽位被丢弃，超过 16 个槽位整体拒绝（防畸形大载荷）', () => {
    expect(parseScenarioDirectPayload({ adapterId: 'a', scenarioId: 'c', slots: { k: 1, ok: 'v' } })).toMatchObject({
      slots: { ok: 'v' },
    })
    const many: Record<string, string> = {}
    for (let index = 0; index < 17; index += 1) many[`k${index}`] = 'v'
    expect(parseScenarioDirectPayload({ adapterId: 'a', scenarioId: 'c', slots: many })).toBeNull()
  })
})

describe('createScenarioMatchers：一次性装配', () => {
  it('五类匹配器共用同一份产物，各自只认自己的形态', () => {
    const routes = [
      route({
        tool: 'search',
        scenarioId: 'tool-card',
        slotNames: ['k'],
        promptTemplates: ['搜索${k}'],
        patterns: [{ regex: '^搜索(?<s0>.+)$', flags: 'i' }],
        args: { keyword: { slot: 's0', type: 'string' } },
      }),
      route({ scenarioId: 'like', optout: true, reason: '写操作', patterns: [{ regex: '^点赞(?<s0>.+)$', flags: 'i' }] }),
    ]
    const matchers = createScenarioMatchers(routes)

    expect(matchers.routes).toBe(routes)
    expect(matchers.matchTool('搜索项目')?.tool).toBe('search')
    expect(matchers.matchOptOut('点赞视频')?.scenarioId).toBe('like')
    // 形态 A 需要 payload 且消息与重填一致
    expect(
      matchers.matchDirect({ adapterId: 'example.com', scenarioId: 'tool-card', slots: { k: '项目' } }, '搜索项目')?.tool,
    ).toBe('search')
    // 形态 A 的 plan 匹配器不会把 tool 形态收进来
    expect(matchers.matchPlanDirect({ adapterId: 'example.com', scenarioId: 'tool-card', slots: { k: '项目' } }, '搜索项目')).toBeNull()
    expect(matchers.matchPlan('搜索项目')).toBeNull()
  })
})
