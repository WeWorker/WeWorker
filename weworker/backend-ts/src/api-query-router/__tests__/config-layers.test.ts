/**
 * 配置化各层的增删改与热重载单测（design §6 P2）。
 *
 * 验收口径来自用户需求：「基于配置文件手动改动维护后，可以及时生效」，且
 * **配置项只对当前配置里存在的 adapter 生效**。所以下面分两段：
 *
 *   A. 各层匹配器（纯函数）：把增 / 删 / 改 / 越界 / 坏条目的语义钉死；
 *   B. 端到端：往临时配置目录写文件 → 引擎当次即生效（不重启），删掉即失效，
 *      坏配置只让该层降级而不影响其它层。
 *
 * 所有工具名从**当前 catalog** 动态取，不写死具体 adapter，避免公开基线一变就红。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildAliasMatcher, isAliasPrefixed, listAliasTexts } from '../aliases.js'
import { buildPatternMatcher } from '../patterns.js'
import { buildPlanMatcher } from '../plan-dag.js'
import { buildRouteMatcher, configuredToolsOf, normalizeRouteText, routeMatches } from '../routes-layer.js'
import { buildShortcutMatcher } from '../shortcuts.js'
import { planRouteDecision, resetRouteEngineForTests } from '../index.js'
import { getCatalog } from '../tool-catalog.js'
import { resetRouterConfigCacheForTests } from '../../router-config/index.js'
import type { PatternsFile, PlanEntry, RouteEntry, ShortcutEntry } from '../../router-config/types.js'

const silent = (): void => {}

// ── A. 层 P：配置路由（别名全等 / 关键词包含）────────────────────────────────

describe('层 P 匹配器', () => {
  const entry = (overrides: Partial<RouteEntry> = {}): RouteEntry => ({
    id: 'r1',
    tool: 'example.com.search',
    match: { aliases: ['查一下'], keywords: ['检索'] },
    ...overrides,
  })

  it('别名按归一化全等，关键词按包含（两者粒度不同）', () => {
    expect(routeMatches(entry(), '查一下')).toBe(true)
    expect(routeMatches(entry(), '  查一下  ')).toBe(true)
    expect(routeMatches(entry(), '帮我查一下')).toBe(false)
    expect(routeMatches(entry(), '帮我检索发票')).toBe(true)
    expect(routeMatches(entry(), '查')).toBe(false)
  })

  it('归一化去全部空白并小写，但不做其它模糊匹配', () => {
    expect(normalizeRouteText('  A  B ')).toBe('ab')
    // 内部空白也算等价：卡片话术带空格，配置里按原文抄写必须能命中
    expect(routeMatches({ id: 'x', tool: 't', match: { keywords: ['AB'] } }, 'a b')).toBe(true)
    // 但仅限空白差异，不做前缀/模糊匹配
    expect(routeMatches({ id: 'x', tool: 't', match: { keywords: ['abc'] } }, 'ab')).toBe(false)
  })

  it('增：新增条目立即可命中；改：换了词后旧词不再命中', () => {
    expect(buildRouteMatcher([entry()])('查一下')?.tool).toBe('example.com.search')
    expect(buildRouteMatcher([entry({ match: { aliases: ['瞧瞧'] } })])('查一下')).toBeNull()
    expect(buildRouteMatcher([entry({ match: { aliases: ['瞧瞧'] } })])('瞧瞧')?.tool).toBe('example.com.search')
  })

  it('删：空列表 / null / 未命中一律返回 null（不抛异常）', () => {
    expect(buildRouteMatcher([])('查一下')).toBeNull()
    expect(buildRouteMatcher(null)('查一下')).toBeNull()
    expect(buildRouteMatcher(undefined)('查一下')).toBeNull()
    expect(buildRouteMatcher([entry()])('随便说点什么')).toBeNull()
  })

  it('禁用条目与无条件的条目都不参与', () => {
    expect(buildRouteMatcher([entry({ enabled: false })])('查一下')).toBeNull()
    expect(buildRouteMatcher([{ id: 'x', tool: 't' }])('查一下')).toBeNull()
    expect(buildRouteMatcher([{ id: 'x', tool: 't', match: { aliases: ['a'], keywords: ['b'] } }])('a')?.id).toBe('x')
  })

  it('configuredToolsOf 汇总手写层工具名（供编译期规则 ④ 冲突告警）', () => {
    expect([...configuredToolsOf([entry(), entry({ id: 'r2', tool: 'example.com.list' })])]).toEqual([
      'example.com.search',
      'example.com.list',
    ])
    expect([...configuredToolsOf(null)]).toEqual([])
  })
})

// ── 第 11 层：`!` 别名（只认全等，不做包含）─────────────────────────────────

describe('! 别名层', () => {
  it('`!` 前缀判定', () => {
    expect(isAliasPrefixed('  !查')).toBe(true)
    expect(isAliasPrefixed('查!')).toBe(false)
    expect(isAliasPrefixed('')).toBe(false)
  })

  it('别名默认由 id 推断，显式 alias 优先', () => {
    const matcher = buildAliasMatcher([
      { id: 'repos', tool: 'example.com.list-repos' },
      { id: 'a2', tool: 'example.com.search', alias: '!查' },
    ])
    expect(matcher('!repos')?.tool).toBe('example.com.list-repos')
    expect(matcher('!查')?.tool).toBe('example.com.search')
    expect(listAliasTexts([{ id: 'repos', tool: 't' }])).toEqual(['!repos'])
  })

  it('只认全等：多打一个字就落空（用户显式点名不得被模糊匹配顶替）', () => {
    const matcher = buildAliasMatcher([{ id: 'repos', tool: 'example.com.list-repos' }])
    expect(matcher('!repos')).not.toBeNull()
    expect(matcher('!repos 一下')).toBeNull()
    expect(matcher('repos')).toBeNull()
  })

  it('删：条目移除后 `!repos` 不再命中；禁用条目等同移除', () => {
    expect(buildAliasMatcher([{ id: 'repos', tool: 't', enabled: false }])('!repos')).toBeNull()
    expect(buildAliasMatcher([])('!repos')).toBeNull()
    expect(buildAliasMatcher(null)('!repos')).toBeNull()
  })

  it('改：换 id 后旧别名失效、新别名生效', () => {
    expect(buildAliasMatcher([{ id: 'saved', tool: 't' }])('!repos')).toBeNull()
    expect(buildAliasMatcher([{ id: 'saved', tool: 't' }])('!saved')?.tool).toBe('t')
  })
})

// ── Tier -1：提示词配置 ─────────────────────────────────────────────────────

describe('Tier -1 提示词层', () => {
  const config = (entry: Record<string, unknown>): PatternsFile => ({
    version: '1',
    configs: { 'example.com.search': entry as never },
  })

  it('正则命中 + 权重决定置信度', () => {
    const matcher = buildPatternMatcher(config({ patterns: [{ type: 'regex', expression: '搜索(.+)', weight: 0.9 }] }))
    expect(matcher('搜索发票')?.confidence).toBe(0.9)
  })

  it('未过门槛（缺省 0.8）视为未命中，绝不硬派发', () => {
    const matcher = buildPatternMatcher(config({ patterns: [{ type: 'regex', expression: '搜索', weight: 0.5 }] }))
    expect(matcher('搜索发票')).toBeNull()
    expect(buildPatternMatcher(config({ patterns: [{ type: 'regex', expression: '搜索', weight: 0.5 }] }), { minConfidence: 0.4 })('搜索发票')).not.toBeNull()
  })

  it('keyword 支持 any / all / phrase 三种粒度', () => {
    const any = buildPatternMatcher(config({ patterns: [{ type: 'keyword', keywords: ['发票', '对账'] }] }))
    expect(any('看看发票')).not.toBeNull()
    const all = buildPatternMatcher(config({ patterns: [{ type: 'keyword', keywords: ['发票', '对账'], match_mode: 'all' }] }))
    expect(all('看看发票')).toBeNull()
    expect(all('看看发票并对账')).not.toBeNull()
    const phrase = buildPatternMatcher(config({ patterns: [{ type: 'keyword', keywords: ['发票', '对账'], match_mode: 'phrase' }] }))
    expect(phrase('发票对账')).not.toBeNull()
    expect(phrase('对账发票')).toBeNull()
  })

  it('负向优先：命中负向即整条不参与（防宽泛正则误伤）', () => {
    const matcher = buildPatternMatcher(
      config({ patterns: [{ type: 'regex', expression: '发票' }], negative_patterns: ['删除'] }),
    )
    expect(matcher('帮我发票')).not.toBeNull()
    expect(matcher('删除发票')).toBeNull()
  })

  it('arg_extractors 抽参并做类型转换与 min/max 钳制', () => {
    const matcher = buildPatternMatcher(
      config({
        patterns: [{ type: 'keyword', keywords: ['发票'] }],
        default_args: { limit: 10 },
        arg_extractors: [{ regex: '前(\\d+)条', arg: 'limit', type: 'integer', min: 1, max: 50 }],
      }),
    )
    expect(matcher('看发票前3条')?.args).toEqual({ limit: 3 })
    expect(matcher('看发票前999条')?.args).toEqual({ limit: 50 })
    expect(matcher('看发票')?.args).toEqual({ limit: 10 })
  })

  it('抽参失败不产出该参数（不猜），非法正则只丢自己', () => {
    const matcher = buildPatternMatcher(
      config({
        patterns: [{ type: 'keyword', keywords: ['发票'] }],
        arg_extractors: [
          { regex: '前(\\d+)条', arg: 'limit', type: 'boolean' },
          { regex: '([', arg: 'bad' },
        ],
      }),
    )
    expect(matcher('看发票前3条')?.args).toEqual({})
    expect(matcher('看发票')).not.toBeNull()
  })

  it('作用域过滤：不在当前 adapter 集合里的工具名直接跳过', () => {
    const matcher = buildPatternMatcher(config({ patterns: [{ type: 'regex', expression: '发票' }] }), {
      allowedTools: new Set(['other.com.search']),
    })
    expect(matcher('看发票')).toBeNull()
  })

  it('删 / 空配置：匹配器恒返回 null，不抛异常', () => {
    expect(buildPatternMatcher(null)('看发票')).toBeNull()
    expect(buildPatternMatcher({ version: '1', configs: {} })('看发票')).toBeNull()
  })
})

// ── 第 11 层：守卫式短路 ────────────────────────────────────────────────────

describe('短路层', () => {
  const entry = (overrides: Partial<ShortcutEntry> = {}): ShortcutEntry => ({
    id: 's1',
    tool: 'example.com.search',
    patterns: { positive: ['发票'] },
    ...overrides,
  })

  it('priority 大者优先（配置顺序之外还有显式优先级）', () => {
    const matcher = buildShortcutMatcher([
      entry({ id: 'low', priority: 1 }),
      entry({ id: 'high', priority: 10, tool: 'example.com.list' }),
    ])
    expect(matcher('发票')?.id).toBe('high')
  })

  it('负向优先：命中负向的条目整条跳过，落到下一条', () => {
    const matcher = buildShortcutMatcher([
      entry({ id: 'guarded', priority: 10, patterns: { positive: ['发票'], negative: ['删除'] } }),
      entry({ id: 'fallback', priority: 1, tool: 'example.com.list' }),
    ])
    expect(matcher('删除发票')?.id).toBe('fallback')
    expect(matcher('查看发票')?.id).toBe('guarded')
  })

  it('抽参：正则命中但取不出合法值 → 整条否决（不猜）；正则未命中 → 该参数缺省，条目仍生效', () => {
    const matcher = buildShortcutMatcher([
      // 用 `(.+?)` 而非 `(\d+)`：正则会命中「前很多条」，但取不出整数，才能验到否决分支
      entry({ extract: [{ regex: '前(.+?)条', arg: 'limit', type: 'integer', max: 50 }] }),
    ])
    expect(matcher('查看发票前3条')?.args).toEqual({ limit: 3 })
    expect(matcher('查看发票前999条')?.args).toEqual({ limit: 50 }) // 钳制
    expect(matcher('查看发票前很多条')).toBeNull() // 正则命中但非整数 → 整条否决
    expect(matcher('查看发票')?.args).toEqual({}) // 正则未命中：参数缺省，条目照常命中
  })

  it('字符串型规则配了 min/max 视为配置错误，直接不产出（不静默忽略）', () => {
    const matcher = buildShortcutMatcher([
      entry({ extract: [{ regex: '前(\\d+)条', arg: 'limit', min: 1 }] }),
    ])
    expect(matcher('查看发票前3条')).toBeNull()
  })

  it('增删改：换词即生效，禁用/空列表即失效', () => {
    expect(buildShortcutMatcher([entry({ patterns: { positive: ['对账'] } })])('发票')).toBeNull()
    expect(buildShortcutMatcher([entry({ patterns: { positive: ['对账'] } })])('对账')?.tool).toBe('example.com.search')
    expect(buildShortcutMatcher([entry({ enabled: false })])('发票')).toBeNull()
    expect(buildShortcutMatcher([])('发票')).toBeNull()
    expect(buildShortcutMatcher(null)('发票')).toBeNull()
  })

  it('render 指到 schema 时带出 schemaId（执行期换渲染器）', () => {
    const matcher = buildShortcutMatcher([entry({ render: { type: 'schema', schemaId: 'invoice-table' } })])
    expect(matcher('发票')?.render).toEqual({ type: 'schema', schemaId: 'invoice-table' })
  })
})

// ── 层 9：多跳锚点 DAG ─────────────────────────────────────────────────────

describe('层 9 多跳计划', () => {
  const plan = (overrides: Partial<PlanEntry> = {}): PlanEntry => ({
    id: 'invoice-flow',
    adapterId: 'example.com',
    entry: { positive: ['下载(?<month>.+?)的发票'], terminal: 'download' },
    terminals: [{ key: 'download', tool: 'example.com.download' }],
    ...overrides,
  })

  it('入口正则命中 → 具名捕获组作为 input', () => {
    const hit = buildPlanMatcher([plan()]).match('下载本月的发票')
    expect(hit?.terminalKey).toBe('download')
    expect(hit?.input).toEqual({ month: '本月' })
  })

  it('入口负向优先，命中即跳过该计划', () => {
    const matcher = buildPlanMatcher([plan({ entry: { positive: ['发票'], negative: ['删除'], terminal: 'download' } })])
    expect(matcher.match('删除发票')).toBeNull()
    expect(matcher.match('查看发票')).not.toBeNull()
  })

  it('缺 terminal / 入口指向不存在的 terminal → 整条丢弃（不做半条链路）', () => {
    expect(buildPlanMatcher([plan({ terminals: [] })]).plans).toEqual([])
    expect(buildPlanMatcher([plan({ entry: { positive: ['x'], terminal: 'missing' } })]).plans).toEqual([])
  })

  it('非法入口正则只丢该条正则，计划本身仍在', () => {
    const matcher = buildPlanMatcher([plan({ entry: { positive: ['(['], terminal: 'download' } })])
    expect(matcher.plans).toHaveLength(1)
    expect(matcher.match('随便')).toBeNull()
  })

  it('findForAdapter 供 manifest `route.plan` 形态反查归属计划', () => {
    const matcher = buildPlanMatcher([plan()])
    expect(matcher.findForAdapter('example.com')?.id).toBe('invoice-flow')
    expect(matcher.findForAdapter('other.com')).toBeUndefined()
  })

  it('增删改：改入口词即换命中；禁用/空列表即整体失效', () => {
    expect(buildPlanMatcher([plan({ entry: { positive: ['导出发票'], terminal: 'download' } })]).match('下载本月的发票')).toBeNull()
    expect(buildPlanMatcher([plan({ enabled: false })]).plans).toEqual([])
    expect(buildPlanMatcher([]).plans).toEqual([])
    expect(buildPlanMatcher(null).plans).toEqual([])
  })
})

// ── B. 端到端：改文件即生效，坏配置只降级该层 ────────────────────────────────

describe('端到端：改配置文件后无需重启即生效', () => {
  const tempDirs: string[] = []
  let configDir = ''
  /** 从当前 catalog 动态取工具，避免写死具体 adapter */
  let routableTool = ''
  let writeTool = ''
  const previousEnv: Record<string, string | undefined> = {}

  function write(name: string, value: unknown): void {
    fs.writeFileSync(path.join(configDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  }

  function ask(message: string) {
    return planRouteDecision({ message, workId: 'layer-test', now: 1_700_000_000_000, log: silent })
  }

  function stepTool(message: string, layer: string): string | undefined {
    const step = ask(message).plan.steps.find((item) => item.layer === layer)
    return step && step.decision.kind === 'tool' ? step.decision.tool : undefined
  }

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-config-layers-'))
    tempDirs.push(dir)
    configDir = dir

    for (const key of ['WEWORKER_ROUTER_CONFIG_DIR', 'WEWORKER_ROUTER_CONFIG_USER_DIR', 'WEWORKER_SCENARIO_ROUTE', 'WEWORKER_API_QUERY_ROUTE']) {
      previousEnv[key] = process.env[key]
    }
    process.env.WEWORKER_ROUTER_CONFIG_DIR = configDir
    // 用户层钉到空目录：开发者本机的覆盖配置不得改变结论
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-config-layers-user-'))
    tempDirs.push(userDir)
    process.env.WEWORKER_ROUTER_CONFIG_USER_DIR = userDir
    delete process.env.WEWORKER_SCENARIO_ROUTE
    delete process.env.WEWORKER_API_QUERY_ROUTE

    write('manifest.json', { schemaVersion: 1, layers: {} })
    write('scenario-routes.json', { version: 2, routes: [] })

    const catalog = getCatalog()
    routableTool = catalog.tools.find((tool) => tool.direct && tool.safety === 'read' && !tool.requiresConfirmation)!.name
    writeTool = (catalog.tools.find((tool) => tool.safety === 'write' || tool.requiresConfirmation) ?? catalog.tools[0]).name
  })

  beforeEach(() => {
    resetRouterConfigCacheForTests()
    resetRouteEngineForTests()
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetRouterConfigCacheForTests()
    resetRouteEngineForTests()
    while (tempDirs.length) {
      const dir = tempDirs.pop()!
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响断言
      }
    }
  })

  it('层 P：增 / 改 / 删 分别当次生效（不重启）', () => {
    // 增（`examples` 是校验器强制项：条目必须自带一条「应当命中本条」的原文）
    write('routes.json', { routes: [{ id: 'direct', tool: routableTool, match: { aliases: ['层P直达'] }, examples: ['层P直达'] }] })
    resetRouterConfigCacheForTests()
    expect(stepTool('层P直达', 'route')).toBe(routableTool)

    // 改：换了词，旧词立即失效
    write('routes.json', { routes: [{ id: 'direct', tool: routableTool, match: { aliases: ['层P直达改'] }, examples: ['层P直达改'] }] })
    resetRouterConfigCacheForTests()
    expect(stepTool('层P直达', 'route')).toBeUndefined()
    expect(stepTool('层P直达改', 'route')).toBe(routableTool)

    // 删
    write('routes.json', { routes: [] })
    resetRouterConfigCacheForTests()
    expect(stepTool('层P直达改', 'route')).toBeUndefined()
    expect(ask('层P直达改').plan.steps).toEqual([])
  })

  it('红线：配置指向写操作工具也不进路由面（配置不能突破只读准入）', () => {
    write('routes.json', { routes: [{ id: 'w', tool: writeTool, match: { aliases: ['写操作别名'] }, examples: ['写操作别名'] }] })
    resetRouterConfigCacheForTests()
    expect(stepTool('写操作别名', 'route')).toBeUndefined()
    expect(ask('写操作别名').plan.steps).toEqual([])
    write('routes.json', { routes: [] })
  })

  it('第 11 层：别名与短路各自增删改即生效', () => {
    write('aliases.json', { aliases: [{ id: 'saved', tool: routableTool, alias: '!我的别名', examples: ['!我的别名'] }] })
    write('shortcuts.json', {
      shortcuts: [
        {
          id: 'short',
          tool: routableTool,
          priority: 5,
          patterns: { positive: ['短路触发词'] },
          examples: [`短路触发词 ${routableTool.split('.')[0]}`],
        },
      ],
    })
    resetRouterConfigCacheForTests()
    expect(stepTool('!我的别名', 'alias')).toBe(routableTool)
    // 短路要过 adapter 关键词门，故消息里带上 adapter 名
    const adapter = routableTool.split('.')[0]
    expect(stepTool(`短路触发词 ${adapter}`, 'shortcut')).toBe(routableTool)

    // 改别名词 → 旧词落空，`!` 开头无匹配即整条拦截（不降级猜）
    write('aliases.json', { aliases: [{ id: 'saved', tool: routableTool, alias: '!我的别名二', examples: ['!我的别名二'] }] })
    resetRouterConfigCacheForTests()
    const blocked = ask('!我的别名')
    expect(blocked.plan.steps).toEqual([])
    expect(blocked.plan.blocked).toEqual({ gate: 'alias_gate' })
    expect(stepTool('!我的别名二', 'alias')).toBe(routableTool)

    // 删
    write('aliases.json', { aliases: [] })
    write('shortcuts.json', { shortcuts: [] })
    resetRouterConfigCacheForTests()
    expect(ask(`短路触发词 ${adapter}`).plan.steps).toEqual([])
  })

  it('渲染声明（schemaId）必须一路带到规划结果：层 P / 别名 / 短路', () => {
    // 三层都能在配置里写 render；写进去不等于生效——历史上两次缺陷都是「配置解析对了、
    // 校验通过了，但构造决策时把 render 丢了」，表现只是「命中了却渲染成通用表格」，无日志。
    const render = { type: 'schema', schemaId: 'test-schema' }
    const alias = { id: 'a', tool: routableTool, alias: '!别名渲染', render, examples: ['!别名渲染'] }
    const shortcut = {
      id: 's',
      tool: routableTool,
      priority: 5,
      patterns: { positive: ['短路渲染词'] },
      render,
      examples: [`短路渲染词 ${routableTool.split('.')[0]}`],
    }
    const adapter = routableTool.split('.')[0]

    const schemaOf = (message: string, layer: string): string | undefined => {
      const step = ask(message).plan.steps.find((item) => item.layer === layer)
      return step && step.decision.kind === 'tool' ? step.decision.render?.schemaId : undefined
    }

    write('routes.json', { routes: [{ id: 'r', tool: routableTool, match: { aliases: ['层P渲染'] }, render, examples: ['层P渲染'] }] })
    write('aliases.json', { aliases: [alias] })
    write('shortcuts.json', { shortcuts: [shortcut] })
    resetRouterConfigCacheForTests()
    expect(schemaOf('层P渲染', 'route')).toBe('test-schema')
    expect(schemaOf('!别名渲染', 'alias')).toBe('test-schema')
    expect(schemaOf(`短路渲染词 ${adapter}`, 'shortcut')).toBe('test-schema')

    // 不声明时回到通用渲染——声明不得从别的层「漏」过来
    write('routes.json', { routes: [{ id: 'r', tool: routableTool, match: { aliases: ['层P渲染'] }, examples: ['层P渲染'] }] })
    write('aliases.json', { aliases: [{ id: 'a', tool: routableTool, alias: '!别名渲染', examples: ['!别名渲染'] }] })
    write('shortcuts.json', { shortcuts: [{ ...shortcut, render: undefined }] })
    resetRouterConfigCacheForTests()
    expect(schemaOf('层P渲染', 'route')).toBeUndefined()
    expect(schemaOf('!别名渲染', 'alias')).toBeUndefined()
    expect(schemaOf(`短路渲染词 ${adapter}`, 'shortcut')).toBeUndefined()

    write('routes.json', { routes: [] })
    write('aliases.json', { aliases: [] })
    write('shortcuts.json', { shortcuts: [] })
  })

  it('Tier -1：改提示词即生效；命中后失败策略是 stop（不再往下猜）', () => {
    write('patterns.json', {
      version: '1',
      configs: {
        [routableTool]: { patterns: [{ type: 'keyword', keywords: ['宽泛提示词'], weight: 0.9, examples: ['宽泛提示词'] }] },
      },
    })
    resetRouterConfigCacheForTests()
    const step = ask('宽泛提示词').plan.steps.find((item) => item.layer === 'pattern')
    expect(step?.decision.kind === 'tool' && step.decision.tool).toBe(routableTool)
    expect(step?.onFailure).toEqual({ action: 'stop', reason: 'pattern_failed' })

    // 改词
    write('patterns.json', {
      version: '1',
      configs: { [routableTool]: { patterns: [{ type: 'keyword', keywords: ['宽泛提示词二'], weight: 0.9, examples: ['宽泛提示词二'] }] } },
    })
    resetRouterConfigCacheForTests()
    expect(ask('宽泛提示词').plan.steps).toEqual([])
    expect(ask('宽泛提示词二').plan.steps.some((item) => item.layer === 'pattern')).toBe(true)

    // 删
    write('patterns.json', { version: '1', configs: {} })
    resetRouterConfigCacheForTests()
    expect(ask('宽泛提示词二').plan.steps).toEqual([])
  })

  it('坏配置只让该层降级，不抛异常也不影响其它层', () => {
    write('routes.json', { routes: [{ id: 'direct', tool: routableTool, match: { aliases: ['仍然可用'] }, examples: ['仍然可用'] }] })
    // 非法正则：该层应被加载期拦下，或被逐条丢弃——两种都不得波及其它层
    // （`examples` 给足，让这一层被拒的原因只剩「非法正则」本身）
    write('patterns.json', {
      version: '1',
      configs: { [routableTool]: { patterns: [{ type: 'regex', expression: '(', examples: ['随便说点什么'] }] } },
    })
    resetRouterConfigCacheForTests()
    expect(() => ask('仍然可用')).not.toThrow()
    expect(stepTool('仍然可用', 'route')).toBe(routableTool)
    expect(ask('随便说点什么').plan.steps).toEqual([])

    // 整文件 JSON 解析失败：只告警，层退化为空，其余层照旧
    fs.writeFileSync(path.join(configDir, 'aliases.json'), '{ 这不是 JSON', 'utf-8')
    resetRouterConfigCacheForTests()
    expect(() => ask('仍然可用')).not.toThrow()
    expect(stepTool('仍然可用', 'route')).toBe(routableTool)

    write('routes.json', { routes: [] })
    write('patterns.json', { version: '1', configs: {} })
    write('aliases.json', { aliases: [] })
  })
})
