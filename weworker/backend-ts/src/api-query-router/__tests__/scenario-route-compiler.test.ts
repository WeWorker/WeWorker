/**
 * 卡片话术路由编译器单测：规则 ①~⑥ 与三形态互斥。
 *
 * 这层的错法有两种代价完全不同：漏编译一条 → 卡片静默不生效（用户看不到变化，可容忍）；
 * 编出一条不该有的 → 用错答案短路模型（致命）。所以下面**每一条 error 都单独断言**，
 * 而不是只断言「有错」。
 */

import { describe, expect, it } from 'vitest'
import {
  buildCompileInputFromManifest,
  compileScenarioRoutes,
  routeShape,
  shadowingLint,
  type CompileAdapterInput,
} from '../scenario-route-compiler.js'
import type { CompiledScenarioRoute, PlanTerminalsFile } from '../../router-config/types.js'

const DIRECT_TOOL = {
  name: 'search',
  safety: 'read',
  requiresConfirmation: false,
  execution: { type: 'api', runtime: 'background' },
  parameters: {
    properties: { keyword: { type: 'string' }, limit: { type: 'integer' }, scope: { enum: ['all', 'title'] } },
    required: ['keyword'],
  },
}

function input(scenarios: unknown[], tools: unknown[] = [DIRECT_TOOL]): CompileAdapterInput {
  return {
    adapterId: 'example.com',
    scenarios: scenarios as CompileAdapterInput['scenarios'],
    tools: tools as CompileAdapterInput['tools'],
  }
}

function card(id: string, prompts: string[], route: unknown) {
  return { id, title: id, prompts: prompts.map((text) => ({ text })), route }
}

/** 产物类型里 `patterns` / `args` 可选；测试已断言编译无错，这里收紧供断言使用。 */
function onlyRoute(routes: readonly CompiledScenarioRoute[], index = 0) {
  const route = routes[index]
  if (!route) throw new Error(`route ${index} missing`)
  return { ...route, patterns: route.patterns ?? [], args: route.args ?? {} }
}

describe('routeShape：三形态互斥判定', () => {
  it('三种合法形态各自可判定', () => {
    expect(routeShape({ tool: 'search' })).toBe('tool')
    expect(routeShape({ plan: { terminal: 'search-flow' } })).toBe('plan')
    expect(routeShape({ direct: false, reason: 'x' })).toBe('optout')
  })

  it('混用或全空返回 null（不是「取第一个」）', () => {
    expect(routeShape({ tool: 'search', direct: false })).toBeNull()
    expect(routeShape({ tool: 'search', plan: { terminal: 't' }, direct: false })).toBeNull()
    expect(routeShape({})).toBeNull()
    expect(routeShape(undefined)).toBeNull()
  })
})

describe('形态一（单工具直连）', () => {
  it('合法声明编译出正则 + 参数装配表 + 槽位名', () => {
    const result = compileScenarioRoutes([
      input([card('search-repo', ['帮我在示例站搜索${关键词}'], { tool: 'search', args: { keyword: '${关键词}' } })]),
    ])
    expect(result.errors).toEqual([])
    const route = result.routes[0]
    expect(route.tool).toBe('search')
    expect(route.slotNames).toEqual(['关键词'])
    expect(route.args).toEqual({ keyword: { slot: 's0', type: 'string' } })
    // 归一化去空白：模板与运行时消息同规则
    expect(onlyRoute(result.routes).patterns[0].regex).toBe('^帮我在示例站搜索(?<s0>.+)$')
  })

  it('① 非只读工具（safety 缺失 / write / 需二次确认）一律 error', () => {
    const missingSafety = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' } })], [
        { ...DIRECT_TOOL, safety: undefined },
      ]),
    ])
    expect(missingSafety.errors.join('\n')).toContain('safety=(缺失)')
    expect(missingSafety.routes).toHaveLength(0)

    const writeTool = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' } })], [{ ...DIRECT_TOOL, safety: 'write' }]),
    ])
    expect(writeTool.errors.join('\n')).toContain('safety=write')

    const confirmTool = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' } })], [
        { ...DIRECT_TOOL, requiresConfirmation: true },
      ]),
    ])
    expect(confirmTool.errors.join('\n')).toContain('需要二次确认')
  })

  it('① 未声明 execution:api/background 的工具不可直调', () => {
    const result = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' } })], [
        { ...DIRECT_TOOL, execution: { type: 'page', runtime: 'content' } },
      ]),
    ])
    expect(result.errors.join('\n')).toContain('未声明 execution.type:api + runtime:background')
  })

  it('① 工具不在 commands 里时明确报错（不是静默跳过）', () => {
    const result = compileScenarioRoutes([input([card('c', ['搜索${k}'], { tool: 'nope', args: {} })])])
    expect(result.errors.join('\n')).toContain('不在本 adapter 的 commands 里')
  })

  it('② args 键必须落在 schema properties 内', () => {
    const result = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}', bogus: '1' } })]),
    ])
    expect(result.errors.join('\n')).toContain('args.bogus 不在 search 的参数表里')
  })

  it('② 必填参数必须覆盖', () => {
    const result = compileScenarioRoutes([input([card('c', ['搜索'], { tool: 'search', args: {} })])])
    expect(result.errors.join('\n')).toContain('必填参数 keyword 未在 route.args 中提供')
  })

  it('② 常量值类型与枚举必须合法（整数 / 枚举各自把关）', () => {
    const badInt = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}', limit: 'abc' } })]),
    ])
    expect(badInt.errors.join('\n')).toContain('常量 "abc" 不符合参数类型/枚举')

    const badEnum = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}', scope: 'nope' } })]),
    ])
    expect(badEnum.errors.join('\n')).toContain('常量 "nope" 不符合参数类型/枚举')

    const goodEnum = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}', scope: 'title' } })]),
    ])
    expect(goodEnum.errors).toEqual([])
    expect(goodEnum.routes[0].args).toMatchObject({ scope: { const: 'title' } })
  })

  it('③ 占位符双向闭合：prompts 有但 args 未引用 → error', () => {
    const result = compileScenarioRoutes([
      input([card('c', ['搜索${k}的${z}'], { tool: 'search', args: { keyword: '${k}' } })]),
    ])
    expect(result.errors.join('\n')).toContain('占位符 ${z} 未被任何 args 引用')
  })

  it('③ args 引用了 prompts 里不存在的占位符 → error', () => {
    const result = compileScenarioRoutes([
      input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${nope}' } })]),
    ])
    expect(result.errors.join('\n')).toContain('引用占位符 ${nope}，但 prompts 中未出现')
  })

  it('④ 与手写层重名只告警，不阻断（卡片更特化、级联在前）', () => {
    const result = compileScenarioRoutes(
      [input([card('c', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' } })])],
      { configuredTools: ['search'] },
    )
    expect(result.errors).toEqual([])
    expect(result.warnings.join('\n')).toContain('同时存在于手写层配置')
  })

  it('enum 参数生成白名单正则，tail 与中段槽位贪婪策略不同', () => {
    const result = compileScenarioRoutes([
      input([
        card('c', ['按${scope}搜索${k}'], { tool: 'search', args: { keyword: '${k}', scope: '${scope}' } }),
      ]),
    ])
    expect(result.errors).toEqual([])
    // 中段槽位非贪婪 + 枚举约束；尾部槽位贪婪
    expect(onlyRoute(result.routes).patterns[0].regex).toBe('^按(?<s0>(?:all|title))搜索(?<s1>.+)$')
  })

  it('同名占位符重复出现时只保留首次捕获（重复命名组会让正则非法）', () => {
    const result = compileScenarioRoutes([
      input([card('c', ['搜索${k}然后比对${k}'], { tool: 'search', args: { keyword: '${k}' } })]),
    ])
    expect(result.errors).toEqual([])
    const regex = onlyRoute(result.routes).patterns[0].regex
    expect(regex).toContain('(?<s0>.+?)')
    expect(regex).toContain('(?:.+)')
    expect(() => new RegExp(regex, 'i')).not.toThrow()
  })
})

describe('形态二（plan 入口）', () => {
  const planTerminals: PlanTerminalsFile = {
    version: 1,
    adapters: {
      'example.com': {
        'search-flow': { tool: 'search', input: { keyword: { type: 'string', required: true } } },
      },
    },
  }

  it('白名单内的终点工具可编译出 plan 形态（无 tool 字段）', () => {
    const result = compileScenarioRoutes(
      [
        input([
          card('s', ['帮我去示例站搜${关键词}'], {
            plan: { terminal: 'search-flow', input: { keyword: '${关键词}' } },
          }),
        ]),
      ],
      { planTerminals },
    )
    expect(result.errors).toEqual([])
    expect(result.routes[0].tool).toBeUndefined()
    expect(result.routes[0].plan).toEqual({ terminal: 'search-flow', input: { keyword: { slot: 's0', type: 'string' } } })
  })

  it('未登记白名单的 terminal 直接 error（不静默放行任意 DAG 入口）', () => {
    const result = compileScenarioRoutes(
      [input([card('s', ['搜${k}'], { plan: { terminal: 'unknown', input: { keyword: '${k}' } } })])],
      { planTerminals },
    )
    expect(result.errors.join('\n')).toContain('不在 plan-terminals.json 的 example.com 白名单')
  })

  it('缺 plan-terminals 时一律报错，杜绝「本地没配就放行」', () => {
    const result = compileScenarioRoutes(
      [input([card('s', ['搜${k}'], { plan: { terminal: 'search-flow', input: { keyword: '${k}' } } })])],
      {},
    )
    expect(result.errors.join('\n')).toContain('不在 plan-terminals.json')
  })

  it('终点工具同样过只读门，input 键与必填键各自校验', () => {
    const notRead = compileScenarioRoutes(
      [input([card('s', ['搜${k}'], { plan: { terminal: 'search-flow', input: { keyword: '${k}' } } })], [
        { ...DIRECT_TOOL, safety: 'write' },
      ])],
      { planTerminals },
    )
    expect(notRead.errors.join('\n')).toContain('终点工具 search safety=write')

    const badKey = compileScenarioRoutes(
      [input([card('s', ['搜${k}'], { plan: { terminal: 'search-flow', input: { keyword: '${k}', other: '1' } } })])],
      { planTerminals },
    )
    expect(badKey.errors.join('\n')).toContain('route.input.other 不在 search-flow 的输入键白名单里')

    const missingRequired = compileScenarioRoutes(
      [input([card('s', ['搜一搜'], { plan: { terminal: 'search-flow', input: {} } })])],
      { planTerminals },
    )
    expect(missingRequired.errors.join('\n')).toContain('必填输入键 keyword 未在 route.input 中提供')
  })
})

describe('形态三（显式不直连）', () => {
  it('合法 optout 产出抑制条目且不带 tool/plan', () => {
    const result = compileScenarioRoutes([
      input([card('o', ['帮我在示例站点赞${视频}'], { direct: false, reason: '写操作，不进路由面' })]),
    ])
    expect(result.errors).toEqual([])
    expect(result.routes[0]).toMatchObject({ optout: true, reason: '写操作，不进路由面' })
    expect(result.routes[0].tool).toBeUndefined()
    expect(result.routes[0].plan).toBeUndefined()
  })

  it('direct:false 缺 reason → error（理由必须写清楚，否则无从复核）', () => {
    const result = compileScenarioRoutes([input([card('o', ['点赞${视频}'], { direct: false })])])
    expect(result.errors.join('\n')).toContain('必须给出 reason')
  })

  it('optout 与 tool 混用 → 无法判定形态', () => {
    const result = compileScenarioRoutes([
      input([card('o', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' }, direct: false, reason: 'x' })]),
    ])
    expect(result.errors.join('\n')).toContain('形态无法判定')
  })
})

describe('规则 ⑤：装饰性卡片变成构建错误', () => {
  it('含 ${} 但无 route 声明 → error', () => {
    const result = compileScenarioRoutes([input([card('c', ['搜索${关键词}'], undefined)])])
    expect(result.errors.join('\n')).toContain('含 ${} 的卡片必须有 route 决策')
  })

  it('不含 ${} 且无 route 的卡片是合法的（纯展示卡片）', () => {
    const result = compileScenarioRoutes([input([card('c', ['打开示例站首页'], undefined)])])
    expect(result.errors).toEqual([])
    expect(result.routes).toHaveLength(0)
  })

  it('route 存在但形态全空 → error', () => {
    const result = compileScenarioRoutes([input([card('c', ['搜索${k}'], {})])])
    expect(result.errors.join('\n')).toContain('形态无法判定')
  })
})

describe('规则 ⑥：遮蔽门', () => {
  it('同 adapter 内样本句被另一条正则吃掉 → error', () => {
    const result = compileScenarioRoutes([
      input(
        [
          card('a', ['搜索${关键词}'], { tool: 'search', args: { keyword: '${关键词}' } }),
          card('b', ['搜索${关键词}相关'], { tool: 'list', args: { keyword: '${关键词}' } }),
        ],
        [DIRECT_TOOL, { ...DIRECT_TOOL, name: 'list' }],
      ),
    ])
    expect(result.errors.join('\n')).toContain('遮蔽')
  })

  it('opt-out 之间互相命中不算歧义（都不派发，语义等价）', () => {
    const lint = shadowingLint([
      {
        adapter: 'example.com',
        scenarioId: 'a',
        optout: true,
        promptTemplates: ['搜索${关键词}'],
        patterns: [{ regex: '^搜索(?<s0>.+)$', flags: 'i' }],
      },
      {
        adapter: 'example.com',
        scenarioId: 'b',
        optout: true,
        promptTemplates: ['搜索${关键词}'],
        patterns: [{ regex: '^搜索(?<s0>.+)$', flags: 'i' }],
      },
    ])
    expect(lint.errors).toEqual([])
  })

  it('跨 adapter 同形只告警（两个站各自的话术本就可能撞型）', () => {
    const lint = shadowingLint([
      {
        adapter: 'example.com',
        scenarioId: 'a',
        tool: 'search',
        promptTemplates: ['搜索${关键词}'],
        patterns: [{ regex: '^搜索(?<s0>.+)$', flags: 'i' }],
      },
      {
        adapter: 'example.org',
        scenarioId: 'b',
        tool: 'search',
        promptTemplates: ['搜索${关键词}'],
        patterns: [{ regex: '^搜索(?<s0>.+)$', flags: 'i' }],
      },
    ])
    expect(lint.errors).toEqual([])
    expect(lint.warnings.join('\n')).toContain('跨 adapter 同形')
  })
})

describe('规则 ③ 的生产者：generate 正则可编译', () => {
  it('特殊字符被转义，不会让正则失效或被注入量词', () => {
    const result = compileScenarioRoutes([
      input([card('c', ['搜索(${k})[a-z]'], { direct: false, reason: 'r' })]),
    ])
    expect(result.errors).toEqual([])
    const { patterns } = onlyRoute(result.routes)
    expect(() => new RegExp(patterns[0].regex, 'i')).not.toThrow()
    expect(new RegExp(patterns[0].regex, 'i').test('搜索(值)[a-z]')).toBe(true)
  })
})

describe('buildCompileInputFromManifest：CLI 直接读 manifest 的口径', () => {
  it('以 commands[].id 为工具名，schema/execution/别名均透传', () => {
    const built = buildCompileInputFromManifest('example.com', {
      id: 'example.com',
      commands: [
        {
          id: 'search',
          safety: 'read',
          requires_confirmation: false,
          execution: { type: 'api', runtime: 'background' },
          schema: { properties: { keyword: { type: 'string' } }, required: ['keyword'] },
          aliases: ['find'],
        },
      ],
      scenarios: [{ id: 's', prompts: [{ text: '搜${k}' }], route: { tool: 'search', args: { keyword: '${k}' } } }],
    })
    expect(built.adapterId).toBe('example.com')
    expect(built.tools[0]).toMatchObject({ name: 'search', safety: 'read', aliases: ['find'] })

    const result = compileScenarioRoutes([built])
    expect(result.errors).toEqual([])
    expect(result.routes).toHaveLength(1)
  })

  it('adapter id 缺失时回落到目录名（目录名就是 adapter 身份）', () => {
    expect(buildCompileInputFromManifest('fallback.example', {}).adapterId).toBe('fallback.example')
  })
})

describe('统计口径', () => {
  it('byShape 三形态各自计数，与 routes 长度一致', () => {
    const result = compileScenarioRoutes([
      input([
        card('t', ['搜索${k}'], { tool: 'search', args: { keyword: '${k}' } }),
        card('o', ['点赞${v}'], { direct: false, reason: 'r' }),
        card('plain', ['打开首页'], undefined),
      ]),
    ])
    expect(result.errors).toEqual([])
    expect(result.stats).toMatchObject({ adapters: 1, scenariosWithRoute: 2, byShape: { tool: 1, plan: 0, optout: 1 } })
  })
})
