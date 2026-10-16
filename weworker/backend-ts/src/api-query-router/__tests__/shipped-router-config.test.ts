/**
 * 随包路由配置的**逐条验证**（design §6：每条进入 shortcuts / patterns / plans 的规则
 * 必须随附正例集与对抗性负例集，负例精度必须 100% 才允许合入）。
 *
 * 与 `route-eval.test.ts` 的分工：
 * - `route-eval.test.ts` 评测的是 manifest 编译出来的场景路由产物（卡片话术）；
 * - 本文件评测的是人写的四个配置层（`routes` / `aliases` / `shortcuts` / `patterns` / `plans`）。
 *
 * 三条断言：
 *   1. **结构自洽**：每层加载零 reject；引用的工具都在路由面内；`schemaId` 有定义；
 *      plan 终端已在白名单注册；抽参名是工具 schema 的属性。
 *   2. **正例全覆盖**：配置里**每一条**启用条目（patterns 精确到每条规则）都必须被
 *      正例集命中，且命中的层 / 工具 / 参数与预期逐字一致。少一条就红——
 *      这条同时防风「配置写了但没人验证」。
 *   3. **负例零误判**：对抗性负例（近邻改写 / 同站点换意图 / 讨论态 / 缺槽）一个都不派发。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { getRouteEngine, planRouteDecision, resetRouteEngineForTests } from '../index.js'
import { getCatalog } from '../tool-catalog.js'
import { resetScenarioRoutesCacheForTests } from '../scenario-routes.js'
import { loadRouterConfig, resetRouterConfigCacheForTests } from '../../router-config/index.js'
import { renderFromSchema } from '../declarative-renderer.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..', '..', '..')
const ROUTER_CONFIG_DIR = path.join(REPO_ROOT, 'weworker', 'router-config')

type Layer = 'route' | 'alias' | 'shortcut' | 'pattern' | 'plan'

/** 一条正例：配置条目的定位符 + 触发话术 + 预期命中层与参数。 */
type PositiveCase = {
  /** `<层>/<条目键>`；patterns 精确到 `<键>#<规则序号>` */
  entry: string
  message: string
  layer: Layer
  tool?: string
  args?: Record<string, unknown>
  planId?: string
  /** 必须被抽出来的参数名（来自配置声明的抽取器）；只断言存在，不断言值 */
  mustContain?: string[]
}

type NegativeCase = { message: string; why: string; history?: unknown[] }

const Y = 1_700_000_000_000

function planOf(message: string, history?: unknown[]) {
  return planRouteDecision({ message, workId: 'verify', now: Y, history }).plan
}

type Hit = { layer: string; tool?: string; planId?: string; args?: Record<string, unknown> }

/** 参数比对只看键值，不看键序（配置合并/抽取顺序不承载语义）。 */
function normalizedArgs(args: Record<string, unknown> | undefined): string {
  const sorted = Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(Object.fromEntries(sorted))
}

/** 取级联计划里第一个真的会派发工具的步骤。 */
function firstDispatch(message: string, history?: unknown[]): Hit | null {
  const steps = planOf(message, history).steps
  for (const step of steps) {
    if (step.decision.kind === 'tool') {
      return { layer: step.layer, tool: step.decision.tool, args: step.decision.args }
    }
    if (step.decision.kind === 'plan') {
      // 引擎把 PlanHit 归一成 `{adapter, scenarioId, terminalKey, input, slotValues}`，
      // 其中 scenarioId 就是计划 id（与卡片层共用同一决策形状）。
      const hit = step.decision.hit as { scenarioId?: string; plan?: { id?: string } }
      return { layer: step.layer, planId: hit.scenarioId ?? hit.plan?.id }
    }
  }
  return null
}

// ── 正例集：**从配置条目的 `examples` 派生**，测试不再自带一份话术清单 ────────
//
// 历史上这里是一份手写的 56 条清单，与配置文件分居两处，必然漂移（改了配置忘了改这里，
// 或者反过来）。现在唯一事实来源是配置条目自己的 `examples` 字段：
//   - 条目**必须**有非空 `examples`（`validate.ts` 强制），否则整层被拒；
//   - 每条 example 都实跑，断言它命中「本条所在层 + 本条的 tool」；
//   - 固定参数（条目 `args`）与抽参（`extract[].arg`）各自断言，
//     前者必须逐字出现，后者必须真的被抽出来（类型由结构自检另行把守）。

/** 抽参类条目：这些 key 必须由本条声明的抽取器真的抽出来（值不在此断言，防止与引擎自证）。 */
function extractorArgsOf(entry: { extract?: { arg: string }[] }): string[] {
  return (entry.extract ?? []).map((rule) => rule.arg)
}

/** 从配置派生正例集；`bundle` 需已加载。 */
function positiveCasesFromConfig(): PositiveCase[] {
  const cases: PositiveCase[] = []
  const add = (
    entry: string,
    message: string,
    layer: Layer,
    tool: string | undefined,
    args: Record<string, unknown> | undefined,
    extra?: { planId?: string; mustContain?: string[] },
  ): void => {
    cases.push({ entry, message, layer, tool, args, planId: extra?.planId, mustContain: extra?.mustContain })
  }

  for (const entry of bundle.routes.routes ?? []) {
    if (entry.enabled === false) continue
    for (const message of entry.examples ?? []) add(`routes/${entry.id}`, message, 'route', entry.tool, entry.args)
  }
  for (const entry of bundle.aliases.aliases ?? []) {
    if (entry.enabled === false) continue
    for (const message of entry.examples ?? []) add(`aliases/${entry.id}`, message, 'alias', entry.tool, entry.args)
  }
  for (const entry of bundle.shortcuts.shortcuts ?? []) {
    if (entry.enabled === false) continue
    for (const message of entry.examples ?? []) {
      add(`shortcuts/${entry.id}`, message, 'shortcut', entry.tool, entry.args, {
        mustContain: extractorArgsOf(entry),
      })
    }
  }
  for (const [tool, config] of Object.entries(bundle.patterns.configs ?? {})) {
    if (config.enabled === false) continue
    ;(config.patterns ?? []).forEach((rule, index) => {
      for (const message of rule.examples ?? []) {
        add(`patterns/${tool}#${index}`, message, 'pattern', tool, rule.default_args, {
          mustContain: (config.arg_extractors ?? []).map((extractor) => extractor.arg),
        })
      }
    })
  }
  for (const plan of bundle.plans.plans ?? []) {
    if (plan.enabled === false) continue
    for (const message of plan.examples ?? []) {
      add(`plans/${plan.id}`, message, 'plan', undefined, undefined, { planId: plan.id })
    }
  }
  return cases
}

/** beforeAll 加载配置后填充；断言与覆盖度检查都以它为准。 */
let POSITIVE_CASES: PositiveCase[] = []

// ── 负例集：每条都贴着某条规则改写，但语义上不该被任何层认领 ────────────────

const NEGATIVE_CASES: NegativeCase[] = [
  // 层 P 关键词：语义相近但站点词不成立
  { message: '维基百科的热门条目和随机条目的差别', why: '关键词层：归一化后不含任何配置关键词' },
  { message: '维基百科的随机条目功能怎么用', why: '讨论态 + 关键词不成立（中间有「的」「功能」）' },
  { message: '帮我看看有没有类似 36氪 的资讯站点', why: '「36氪资讯」不成立' },
  { message: 'hn最新版本是哪一版', why: '「hn最新」不再作为裸关键词' },

  // 话术层：同站点换意图 / 缺槽
  { message: '帮我在 GitHub 搜索相关仓库', why: '站点裸词不得命中（github 只认 trending 类话术）' },
  { message: '帮我查看 GitHub 仓库的信息', why: '站点裸词不得命中' },
  { message: 'github 上有什么热门仓库', why: '「github 热门仓库」正则要求站点词与动作词相邻' },
  { message: 'github 仓库信息', why: '缺动作词' },
  { message: 'v2ex 上有什么好玩的话题', why: '无列表动作词' },
  { message: 'v2ex 节点列表里哪个节点最活跃', why: '提问式用法：列表动作词被负向词挡住' },
  { message: 'v2ex 主题列表', why: '「主题」后必须有数字 id' },
  { message: 'v2ex 用户功能有哪些', why: '用户名必须是拉丁名字' },
  { message: 'arxiv 上有什么关于 RAG 的论文', why: '缺动作词（有什么不是检索动词）' },
  { message: 'arxiv 主页', why: '缺动作词' },
  { message: 'arxiv 搜索功能怎么用', why: '讨论态' },

  // 提示词层：复合名词不得被切成检索词
  { message: '维基百科搜索引擎', why: '「搜索」后无分隔符，不得把「引擎」当检索词' },
  { message: '维基百科搜索功能怎么用', why: '负向词 + 讨论态' },
  { message: '维基百科词条数量有多少', why: '「词条」后无分隔符 + 负向词' },
  { message: '维基百科条目和随机条目的区别', why: '讨论态语义，非摘要请求' },
  { message: '微信读书搜索引擎怎么优化', why: '「搜索」后无分隔符' },
  { message: 'hn 用户功能有哪些', why: '用户名必须是拉丁名字' },
  { message: 'hn 帖子', why: '缺数字 id' },
  { message: 'hn search 功能在哪', why: '「search」缺 for/冒号' },

  // 计划层：入口正则必须自身收敛
  { message: '维基百科', why: '缺主题槽位' },
  { message: 'wikipedia', why: '缺主题槽位' },
  { message: '维基百科 简介', why: '入口负向词命中' },
  { message: '微信读书《三体》好看吗', why: '计划入口要求检索动词' },

  // 空别名：`!` 前缀但无人承接 → 阻断而非降级
  { message: '!nosuchcommand', why: '别名未命中时整轮阻断，不得落到宽泛层猜' },

  // 与卡片评测集重叠的关键负例（回归保护）
  { message: '搜索邮件', why: '过短，无站点词' },
  { message: '搜索最近收到的邮件', why: '无站点词' },
  { message: 'search my inbox for invoices received this month', why: '英文改写，无站点词' },
  { message: '你能做什么', why: '能力询问' },
  { message: '帮我把 v2ex 的账单导出来', why: '写操作意图不得进路由面' },

  // 讨论态 / 追问态
  { message: '这个系统支持哪些适配器', why: '讨论态' },
  { message: '智能路由是怎么工作的', why: '讨论态' },
  { message: '那第二个呢', why: '追问态', history: [{ role: 'assistant', content: '为你找到 3 条结果' }] },
]

// ── 渲染层：声明式 schema 的数据来源 ────────────────────────────────────────

/** 配置条目上的渲染声明 → 声明的 schemaId（非声明式渲染一律视为未声明）。 */
function schemaIdOf(render: { type?: string; schemaId?: string } | undefined): string | undefined {
  return render?.type === 'schema' ? render.schemaId : undefined
}

/** schemaId → 它的数据来源（adapter 目录 + adapter 内部的工具名）。 */
const SCHEMA_SOURCE: Record<string, { adapter: string; tool: string }> = {
  'v2ex-topic-list': { adapter: 'v2ex.com', tool: 'hot' },
  'v2ex-node-topics': { adapter: 'v2ex.com', tool: 'node' },
  'v2ex-node-list': { adapter: 'v2ex.com', tool: 'nodes' },
  'arxiv-papers': { adapter: 'arxiv.org', tool: 'search' },
  'toutiao-hot-list': { adapter: 'toutiao.com', tool: 'hot' },
}

/**
 * 从 adapter 自己的 `extension/internal/opencli.js` 里读出该工具的列声明。
 * 这是**非循环**的对照物：列名由 adapter 作者声明，不是本配置抄来的。
 */
function declaredColumns(adapter: string, tool: string): string[] | null {
  const file = path.join(REPO_ROOT, 'adapters', adapter, 'extension', 'internal', 'opencli.js')
  if (!fs.existsSync(file)) return null
  const text = fs
    .readFileSync(file, 'utf-8')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  let cursor = 0
  while (true) {
    const start = text.indexOf('cli({', cursor)
    if (start < 0) return null
    let end = text.indexOf('  });', start)
    if (end < 0) end = text.indexOf('});', start)
    if (end < 0) return null
    const block = text.slice(start, end + 5)
    cursor = end + 3
    if (/name:\s*"([^"]+)"/.exec(block)?.[1] !== tool) continue
    const columns = /columns:\s*\[([^\]]*)\]/.exec(block)?.[1]
    if (!columns) return null
    return columns
      .split(',')
      .map((raw) => raw.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  }
}

function sampleValue(field: string, index: number): unknown {
  if (/url|link|pdf|website/i.test(field)) return `https://example.com/${field}/${index}`
  if (/rank|replies|topics|stars|count|views|value|reading|hot/i.test(field)) return index + 1
  if (/published|created|date|time|updated/i.test(field)) return '2026-10-01T12:00:00Z'
  return `${field}-${index}`
}

// ── 断言 ────────────────────────────────────────────────────────────────────

let bundle: ReturnType<typeof loadRouterConfig>['bundle']

beforeAll(() => {
  process.env.WEWORKER_ROUTER_CONFIG_DIR = ROUTER_CONFIG_DIR
  process.env.WEWORKER_ROUTER_CONFIG_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-shipped-'))
  process.env.WEWORKER_SCENARIO_ROUTE = '1'
  delete process.env.WEWORKER_API_QUERY_ROUTE
  resetScenarioRoutesCacheForTests()
  resetRouterConfigCacheForTests()
  resetRouteEngineForTests()
  bundle = loadRouterConfig({ defaultsDir: ROUTER_CONFIG_DIR }).bundle
  POSITIVE_CASES = positiveCasesFromConfig()
})

describe('随包路由配置：结构自洽', () => {
  it('每一层都加载通过，没有被校验丢弃的层', () => {
    const rejected = bundle.sources.filter((source) => source.rejected)
    expect(rejected.map((source) => `${source.layer}: ${source.rejected}`)).toEqual([])
  })

  it('配置目录里的东西确实来自随包目录（不是内置空结构）', () => {
    expect(bundle.routes.routes?.length).toBeGreaterThan(0)
    expect(bundle.aliases.aliases?.length).toBeGreaterThan(0)
    expect(bundle.shortcuts.shortcuts?.length).toBeGreaterThan(0)
    expect(Object.keys(bundle.patterns.configs ?? {}).length).toBeGreaterThan(0)
    expect(bundle.plans.plans?.length).toBeGreaterThan(0)
    expect(Object.keys(bundle.renderers.schemas ?? {}).length).toBeGreaterThan(0)
  })

  it('引用的工具全部在当前路由面内（存在 + 可直调 + 显式只读）', () => {
    const routable = getRouteEngine().routableTools
    const referenced = new Set<string>()
    for (const entry of bundle.routes.routes ?? []) referenced.add(entry.tool)
    for (const entry of bundle.aliases.aliases ?? []) referenced.add(entry.tool)
    for (const entry of bundle.shortcuts.shortcuts ?? []) referenced.add(entry.tool)
    for (const key of Object.keys(bundle.patterns.configs ?? {})) referenced.add(key)
    for (const plan of bundle.plans.plans ?? []) {
      for (const resolver of plan.resolvers ?? []) referenced.add(resolver.tool)
      for (const terminal of plan.terminals ?? []) referenced.add(terminal.tool)
    }
    const outOfScope = [...referenced].filter((tool) => !routable.has(tool)).sort()
    expect(outOfScope).toEqual([])
  })

  it('shortcut / plan 终端声明的 schemaId 都在 renderers.json 里有定义', () => {
    const schemas = new Set(Object.keys(bundle.renderers.schemas ?? {}))
    const missing: string[] = []
    for (const entry of bundle.shortcuts.shortcuts ?? []) {
      const id = entry.render?.type === 'schema' ? entry.render.schemaId : undefined
      if (id && !schemas.has(id)) missing.push(`shortcuts/${entry.id} → ${id}`)
    }
    for (const plan of bundle.plans.plans ?? []) {
      for (const terminal of plan.terminals ?? []) {
        const id = terminal.render?.type === 'schema' ? terminal.render.schemaId : undefined
        if (id && !schemas.has(id)) missing.push(`plans/${plan.id}#${terminal.key} → ${id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('每个 plan 终端都在 plan-terminals.json 里按 adapterId + key 注册了同名工具', () => {
    const whitelist = bundle.planTerminals.adapters ?? {}
    const mismatched: string[] = []
    for (const plan of bundle.plans.plans ?? []) {
      const adapterId = plan.adapterId ?? ''
      for (const terminal of plan.terminals ?? []) {
        const registered = whitelist[adapterId]?.[terminal.key]
        if (registered?.tool !== terminal.tool) {
          mismatched.push(`${adapterId}/${terminal.key}: 白名单=${registered?.tool ?? '未注册'}，计划=${terminal.tool}`)
        }
      }
    }
    expect(mismatched).toEqual([])
  })

  it('plan 的 needs 都由某个 resolver 产出（不留悬空锚点）', () => {
    const dangling: string[] = []
    for (const plan of bundle.plans.plans ?? []) {
      const produced = new Set((plan.resolvers ?? []).map((resolver) => resolver.produces))
      for (const terminal of plan.terminals ?? []) {
        for (const need of terminal.needs ?? []) {
          // `$k` 也可来自入口具名捕获组，故只在既非锚点又非 input 引用时才判悬空
          if (!produced.has(need)) dangling.push(`${plan.id}:${terminal.key} 需要 ${need}`)
        }
      }
    }
    expect(dangling).toEqual([])
  })

  it('抽参名必须是被调工具 schema 里的属性（避免参数被工具静默拒绝）', () => {
    const byName = getCatalog().byName
    const bad: string[] = []
    const check = (tool: string, arg: string, where: string): void => {
      const properties = (byName.get(tool)?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
      if (!properties || !(arg in properties)) bad.push(`${where}: ${tool} 没有参数 ${arg}`)
    }
    for (const entry of bundle.shortcuts.shortcuts ?? []) {
      for (const rule of entry.extract ?? []) check(entry.tool, rule.arg, `shortcuts/${entry.id}`)
    }
    for (const [tool, config] of Object.entries(bundle.patterns.configs ?? {})) {
      for (const extractor of config.arg_extractors ?? []) check(tool, extractor.arg, `patterns/${tool}`)
      for (const rule of config.patterns ?? []) {
        for (const arg of Object.keys(rule.default_args ?? {})) check(tool, arg, `patterns/${tool}`)
      }
    }
    for (const entry of bundle.routes.routes ?? []) {
      for (const arg of Object.keys(entry.args ?? {})) check(entry.tool, arg, `routes/${entry.id}`)
    }
    for (const entry of bundle.aliases.aliases ?? []) {
      for (const arg of Object.keys(entry.args ?? {})) check(entry.tool, arg, `aliases/${entry.id}`)
    }
    expect(bad).toEqual([])
  })
})

describe('随包路由配置：正例全覆盖', () => {
  /** 配置里所有启用条目的定位符（patterns 精确到每条规则）。 */
  function enabledEntries(): Set<string> {
    const out = new Set<string>()
    for (const entry of bundle.routes.routes ?? []) if (entry.enabled !== false) out.add(`routes/${entry.id}`)
    for (const entry of bundle.aliases.aliases ?? []) if (entry.enabled !== false) out.add(`aliases/${entry.id}`)
    for (const entry of bundle.shortcuts.shortcuts ?? []) if (entry.enabled !== false) out.add(`shortcuts/${entry.id}`)
    for (const [tool, config] of Object.entries(bundle.patterns.configs ?? {})) {
      if (config.enabled === false) continue
      ;(config.patterns ?? []).forEach((_, index) => out.add(`patterns/${tool}#${index}`))
    }
    for (const plan of bundle.plans.plans ?? []) if (plan.enabled !== false) out.add(`plans/${plan.id}`)
    return out
  }

  it('每一条启用条目都被正例集覆盖（配置里没有漏验证的条目）', () => {
    const covered = new Set(POSITIVE_CASES.map((item) => item.entry))
    const missing = [...enabledEntries()].filter((entry) => !covered.has(entry)).sort()
    expect(missing).toEqual([])
  })

  it('正例集里没有指向不存在条目的死用例（派生自配置，仍防条目被删后残留）', () => {
    const enabled = enabledEntries()
    const stale = [...new Set(POSITIVE_CASES.map((item) => item.entry))].filter((entry) => !enabled.has(entry))
    expect(stale).toEqual([])
    // 派生自配置后这条断言不可能因「手写清单过期」而红，但仍要守住「真的有正例」：
    // 若 examples 因为校验被放宽而变为空，正例集会在无人察觉的情况下退化成空表。
    expect(POSITIVE_CASES.length).toBeGreaterThan(0)
  })

  it('每条正例都命中预期层、预期工具与预期参数', () => {
    const failures: string[] = []
    for (const item of POSITIVE_CASES) {
      const hit = firstDispatch(item.message)
      if (!hit) {
        failures.push(`[${item.entry}] 「${item.message}」未被任何层派发`)
        continue
      }
      if (hit.layer !== item.layer) {
        failures.push(`[${item.entry}] 「${item.message}」命中层 ${hit.layer}，预期 ${item.layer}`)
        continue
      }
      if (item.planId !== undefined) {
        if (hit.planId !== item.planId) failures.push(`[${item.entry}] 「${item.message}」命中计划 ${hit.planId}，预期 ${item.planId}`)
        continue
      }
      if (hit.tool !== item.tool) {
        failures.push(`[${item.entry}] 「${item.message}」命中工具 ${hit.tool}，预期 ${item.tool}`)
        continue
      }
      // 固定参数必须逐字出现（值由配置写死，与引擎无关，可作独立断言）；
      // 抽出来的参数只断言「真的抽到了」，值本身由抽取正则决定，不在此自证。
      const actual = (hit.args ?? {}) as Record<string, unknown>
      const mismatched = Object.entries(item.args ?? {}).filter(([key, value]) => actual[key] !== value)
      if (mismatched.length) {
        failures.push(
          `[${item.entry}] 「${item.message}」参数 ${normalizedArgs(actual)}，固定参数应包含 ${normalizedArgs(item.args)}`,
        )
        continue
      }
      const missing = (item.mustContain ?? []).filter((key) => !(key in actual))
      if (missing.length) {
        failures.push(`[${item.entry}] 「${item.message}」未抽出参数 ${missing.join('、')}（实际 ${normalizedArgs(actual)}）`)
      }
    }
    expect(failures).toEqual([])
  })
})

describe('随包路由配置：负例零误判', () => {
  it('对抗性负例一个都不派发工具，也不触发卡片抑制', () => {
    const failures: string[] = []
    for (const item of NEGATIVE_CASES) {
      const plan = planOf(item.message, item.history)
      const dispatched = plan.steps.filter(
        (step) => step.decision.kind === 'tool' || step.decision.kind === 'plan',
      )
      if (dispatched.length) {
        const labels = dispatched.map((step) => `${step.layer}(${step.decision.label})`).join(' → ')
        failures.push(`「${item.message}」(${item.why}) 误派发：${labels}`)
      }
      if (plan.suppressed.length) {
        failures.push(`「${item.message}」(${item.why}) 误触发卡片抑制：${plan.suppressed.join('、')}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('`!` 别名未命中时是阻断，不是降级到宽泛层', () => {
    const plan = planOf('!nosuchcommand')
    expect(plan.steps).toEqual([])
    expect(plan.blocked?.gate).toBe('alias_gate')
  })
})

describe('随包路由配置：渲染层', () => {
  it('每个 schema 都把数据来源登记在案（防止新 schema 绕过验证）', () => {
    const unregistered = Object.keys(bundle.renderers.schemas ?? {}).filter((id) => !(id in SCHEMA_SOURCE))
    expect(unregistered).toEqual([])
  })

  it('同一个工具在各层的渲染声明必须一致（防「别名漏声明 → 同一份数据两种长相」）', () => {
    // 曾出现：`今日头条热榜`（层 P）渲染声明的 4 列表格，`!toutiao`（第 11 层别名）渲染 8 列通用表格。
    // 规则：某工具只要有任意一层声明了 schema，其余各层对它的条目必须声明同一个 schema。
    const declared = new Map<string, string>()
    const perLayer: { layer: string; id: string; tool: string; schemaId?: string }[] = []
    for (const entry of bundle.routes.routes ?? []) {
      perLayer.push({ layer: 'routes', id: entry.id, tool: entry.tool, schemaId: schemaIdOf(entry.render) })
    }
    for (const entry of bundle.shortcuts.shortcuts ?? []) {
      perLayer.push({ layer: 'shortcuts', id: entry.id, tool: entry.tool, schemaId: schemaIdOf(entry.render) })
    }
    for (const entry of bundle.aliases.aliases ?? []) {
      perLayer.push({ layer: 'aliases', id: entry.id, tool: entry.tool, schemaId: schemaIdOf(entry.render) })
    }
    for (const entry of perLayer) {
      if (entry.schemaId) declared.set(entry.tool, entry.schemaId)
    }
    const mismatches = perLayer
      .filter((entry) => declared.has(entry.tool) && entry.schemaId !== declared.get(entry.tool))
      .map((entry) => `${entry.layer}/${entry.id} (${entry.tool}): ${entry.schemaId ?? '未声明'} ≠ ${declared.get(entry.tool)}`)
    expect(mismatches).toEqual([])
  })

  it('声明的列名必须来自 adapter 自己的列声明（防止声明了工具不返回的列）', () => {
    const failures: string[] = []
    for (const [id, source] of Object.entries(SCHEMA_SOURCE)) {
      const schema = bundle.renderers.schemas?.[id]
      if (!schema) {
        failures.push(`${id}: renderers.json 里没有这个 schema`)
        continue
      }
      const declared = declaredColumns(source.adapter, source.tool)
      if (!declared) {
        failures.push(`${id}: 在 ${source.adapter} 里找不到 ${source.tool} 的列声明`)
        continue
      }
      for (const column of schema.columns ?? []) {
        if (!declared.includes(column.key)) {
          failures.push(`${id}: 列 ${column.key} 不在 ${source.adapter}.${source.tool} 的列里（${declared.join(', ')}）`)
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('每个 schema 都能把真实形状的载荷渲染成表格（含链接列与行数截断）', () => {
    const failures: string[] = []
    for (const [id, source] of Object.entries(SCHEMA_SOURCE)) {
      const schema = bundle.renderers.schemas?.[id]
      if (!schema) continue
      const fields = declaredColumns(source.adapter, source.tool) ?? []
      const rows = Array.from({ length: (schema.maxRows ?? 10) + 5 }, (_, index) =>
        Object.fromEntries(fields.map((field) => [field, sampleValue(field, index)])),
      )
      const out = renderFromSchema(schema, rows, { now: new Date('2026-10-14T00:00:00Z') })
      if (!out) {
        failures.push(`${id}: 渲染返回 null（会静默落回通用渲染，声明形同虚设）`)
        continue
      }
      if (!out.includes(String(rows[0].title))) failures.push(`${id}: 输出里没有首行标题`)
      const hasLink = (schema.columns ?? []).some((column) => column.type === 'link')
      if (hasLink && !out.includes('](')) failures.push(`${id}: 链接列没有渲染成 Markdown 链接`)
    }
    expect(failures).toEqual([])
  })
})

describe('随包路由配置：层间不互相遮蔽', () => {
  it('同一站点内两条规则的话术不互相吃掉（各自的正例只命中自己）', () => {
    // 「v2ex 节点 python」（单节点）不得被「节点列表」规则认领，反之亦然
    expect(firstDispatch('v2ex 节点 python')?.tool).toBe('v2ex.com.node')
    expect(firstDispatch('v2ex nodes')?.tool).toBe('v2ex.com.nodes')
    // 提示词层的检索规则不得吃掉摘要规则
    expect(firstDispatch('维基百科搜索 量子力学')?.tool).toBe('wikipedia.org.search')
    expect(firstDispatch('维基百科词条 量子力学')?.tool).toBe('wikipedia.org.summary')
    // 提示词层（先跑）不得吃掉计划层的入口
    expect(firstDispatch('维基百科 量子力学')?.layer).toBe('plan')
    expect(firstDispatch('微信读书《三体》里搜索 黑暗森林')?.layer).toBe('plan')
  })
})
