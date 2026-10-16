/**
 * 路由评测集（design §6 P1 的 CI 硬门）。
 *
 * 评测的核心不是「命中率」，而是**负例零误判**：漏判只是落回 LLM（等于今天的行为），
 * 误判则是用错误答案短路模型。所以这里把两类断言分开：
 *
 *   1. 正例自洽：产物里每条路由用它自己的话术模板（填样本值）必须能命中它自己。
 *      这一条同时是**防空转保险**——如果引擎没加载到产物，正例全挂，评测不会「因为没有规则
 *      而全部通过」。
 *   2. 负例零误判（硬门）：对抗性负例（近邻改写 / 跨站替换 / 缺槽 / 讨论态 / 追问态 / 英文）
 *      必须**一个都不命中**任何派发层，且不得触发卡片抑制。
 *
 * 评测输入固定指向仓库内的公开基线（根 `adapters/` + `weworker/router-config/`），
 * 并显式钉住用户层目录，避免开发者本机的覆盖配置影响结论。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createScenarioMatchers,
  loadScenarioRoutes,
  resetScenarioRoutesCacheForTests,
} from '../scenario-routes.js'
import { planRouteDecision, resetRouteEngineForTests } from '../index.js'
import { buildCompileInputFromManifest, compileScenarioRoutes, renderSample } from '../scenario-route-compiler.js'
import { listManifestDirs } from '../scenario-route-cli.js'
import { parseJsonc } from '../../router-config/jsonc.js'
import type { CompiledScenarioRoute, PlanTerminalsFile } from '../../router-config/types.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
/** `src/api-query-router/__tests__` → 仓库根 */
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..', '..', '..')
const ADAPTERS_DIR = path.join(REPO_ROOT, 'adapters')
const ROUTER_CONFIG_DIR = path.join(REPO_ROOT, 'weworker', 'router-config')

/** 样本值：占位符名自身（未配变量时的展示形态）+ 拉丁 / 中文 / 数字。 */
const EVAL_SAMPLES = ['示例值', 'Example_Project', '98765']

export type NegativeCase = { message: string; why: string; history?: unknown[] }
export type EvalFailure = { message: string; why: string; detail: string }
export type EvalReport = {
  routeCount: number
  positiveChecked: number
  negativeChecked: number
  failures: EvalFailure[]
  /** 非故障的信息项：同一 adapter 内多条卡片共用同一话术（互相遮蔽但不派发，语义等价） */
  notes: string[]
}

function runtimeRoutes(): CompiledScenarioRoute[] {
  const { routes } = compileFromManifests()
  // 评测必须跑在**运行时真正加载的那份产物**上（已过二次准入），而不是 manifest 直编结果。
  return routes.length ? loadScenarioRoutes() : []
}

/** 直接从根 `adapters/` 编译：用于校验「产物与源一致」（`--check` 的测试内等价物）。 */
export function compileFromManifests(): ReturnType<typeof compileScenarioRoutes> {
  const inputs = listManifestDirs(ADAPTERS_DIR).map(({ dirName, manifestPath }) =>
    buildCompileInputFromManifest(dirName, JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))),
  )
  return compileScenarioRoutes(inputs, {
    planTerminals: readJson(path.join(ROUTER_CONFIG_DIR, 'plan-terminals.json')) as PlanTerminalsFile | null,
  })
}

function readJson(filePath: string): unknown {
  try {
    // 必须走 parseJsonc：`plan-terminals.json` 是**带注释的 JSONC**，
    // 用裸 JSON.parse 会抛错，而下面的 catch 会把失败**静默吞成 null**——
    // 白名单于是变成空，编译结果与产物悄悄分叉却永远报绿（公开基线无 route.plan 卡片，正好掩盖）。
    return parseJsonc(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

/** 对抗性负例：每一条都贴着某个卡片话术改写，但**语义上不该被任何层认领**。 */
export const NEGATIVE_CASES: NegativeCase[] = [
  // ── 近邻改写：同意图、不同措辞（锚定全等不应命中） ──────────────────────────
  { message: '帮我在 B 站搜索开源项目', why: '缺尾部锚点「相关视频」' },
  { message: '帮我搜一下 B 站的开源项目相关视频', why: '引导语不同' },
  { message: '在 B 站搜索开源项目相关视频', why: '缺「帮我」前缀' },
  { message: '帮我在B站搜索相关视频', why: '槽位为空' },
  { message: '帮我在小红书搜索好吃的蛋糕', why: '缺尾部锚点「推荐」' },
  { message: '小红书有什么好吃的蛋糕推荐', why: '陈述句而非卡片话术' },
  { message: '帮我在 GitHub 搜索相关仓库', why: '槽位为空' },
  { message: '帮我查看 GitHub 仓库的信息', why: '槽位为空' },
  { message: '查看 microsoft/playwright 仓库信息', why: '缺少卡片前缀' },
  { message: '搜索最近收到的邮件', why: '槽位为空' },
  { message: '搜索邮件', why: '过短，无锚点' },
  { message: '打开QQ邮箱下载我本月收到的发票', why: '缺中文逗号，锚点不闭合' },
  { message: '打开我的QQ邮箱，下载我本月收到的发票', why: '多了「我的」' },
  { message: '帮我在京东再买一个牙膏', why: '缺「我之前买过的」' },
  { message: '我上个月在京东买了个牙膏', why: '陈述句' },
  { message: '帮我看看京东的订单', why: '缺少消费问法' },
  { message: '帮我看看我在京东消费了多少钱', why: '槽位为空' },

  // ── 跨站替换：结构相同但站点不对 ───────────────────────────────────────────
  { message: '帮我看看我这个月在淘宝消费了多少钱', why: '站点替换为淘宝' },
  { message: '帮我在 YouTube 搜索开源项目相关视频', why: '站点替换为 YouTube' },
  { message: '帮我在示例站搜索开源项目相关视频', why: '站点不在当前 adapter 集合内' },

  // ── 自由话术：应当交给模型，不应被卡片层截胡 ───────────────────────────────
  { message: '帮我看看上个月的消费情况', why: '无站点归属' },
  { message: '帮我把这个链接保存一下', why: '无卡片对应' },
  { message: '搜索 my inbox for invoices received this month', why: '中英混写' },
  { message: 'search my inbox for invoices received this month', why: '英文改写' },
  { message: 'help me search Bilibili for open source projects', why: '英文改写' },
  { message: '我想问一下，如果我需要搜索视频的话，应该怎么操作？', why: '元问题式问法' },
  { message: '帮我在B站搜索', why: '截断输入' },

  // ── 讨论态 / 元问题：谈系统而非查数据 ──────────────────────────────────────
  { message: '智能路由是怎么工作的', why: '讨论态' },
  { message: '这个系统支持哪些适配器', why: '讨论态' },
  { message: '你能做什么', why: '能力询问' },
  { message: '帮我看看你的路由规则是怎么配置的', why: '讨论态 + 命中「帮我看看」前缀' },

  // ── 追问态：回指 + 近窗有结果 ──────────────────────────────────────────────
  { message: '那第二个呢', why: '追问态', history: [{ role: 'assistant', content: '为你找到 3 条结果' }] },
  { message: '继续', why: '追问态', history: [{ role: 'assistant', content: '已打开页面' }] },
  { message: '再找一些', why: '追问态', history: [{ role: 'assistant', content: '已搜索完成' }] },
]

/** 跑一遍评测集，返回失败明细（空数组 = 全过）。 */
export function runRouteEval(routes: readonly CompiledScenarioRoute[]): EvalReport {
  const failures: EvalFailure[] = []
  const notes: string[] = []
  const matchers = createScenarioMatchers(routes)
  let positiveChecked = 0

  // ── 1. 正例自洽（同时证明产物已加载、评测非空转）────────────────────────────
  for (const route of routes) {
    const label = `${route.adapter}:${route.scenarioId}`
    const templates = (route.promptTemplates ?? []).filter((template) => typeof template === 'string' && template)
    if (!templates.length) {
      failures.push({ message: label, why: '正例', detail: '产物缺少 promptTemplates，无从自洽校验' })
      continue
    }
    positiveChecked += 1

    // opt-out 不派发任何工具，同一 adapter 内谁先命中语义等价（编译期遮蔽门亦如此判定），
    // 故按「同 adapter 的某条 opt-out 认领」校验；认领者不是自己只记为信息项。
    // 派发形态（tool / plan）必须严格命中自身：被别的卡片吃掉就是真实的错派发。
    let claimedBy: CompiledScenarioRoute | null = null
    for (const template of templates) {
      for (const value of EVAL_SAMPLES) {
        const sample = renderSample(template, value)
        if (route.optout) {
          const hit = matchers.matchOptOut(sample)
          if (hit && hit.adapter === route.adapter) {
            const owner = routes.find((item) => item.adapter === hit.adapter && item.scenarioId === hit.scenarioId)
            claimedBy = owner ?? null
            break
          }
        } else if (route.plan) {
          if (matchers.matchPlan(sample)?.scenarioId === route.scenarioId) claimedBy = route
        } else if (matchers.matchTool(sample)?.tool === route.tool) {
          claimedBy = route
        }
      }
      if (claimedBy) break
    }

    if (!claimedBy) {
      failures.push({
        message: label,
        why: '正例',
        detail: `话术模板填样本值后未命中：${templates.join(' | ')}`,
      })
    } else if (claimedBy !== route) {
      notes.push(`${label} 与 ${claimedBy.adapter}:${claimedBy.scenarioId} 共用同一话术（互不派发，语义等价）`)
    }
  }

  // ── 2. 负例零误判（硬门）──────────────────────────────────────────────────
  for (const { message, why, history } of NEGATIVE_CASES) {
    const direct = [
      ['话术层', matchers.matchTool(message)],
      ['多跳入口', matchers.matchPlan(message)],
      ['卡片抑制', matchers.matchOptOut(message)],
    ].filter(([, hit]) => hit != null)
    if (direct.length) {
      failures.push({
        message,
        why,
        detail: `匹配器误命中：${direct.map(([name]) => name).join('、')}`,
      })
    }

    const { plan } = planRouteDecision({ message, workId: 'eval', now: 1_700_000_000_000, history })
    const dispatched = plan.steps.filter((step) => step.decision.kind === 'tool' || step.decision.kind === 'plan')
    if (dispatched.length) {
      failures.push({
        message,
        why,
        detail: `级联误派发：${dispatched.map((step) => `${step.layer}(${step.decision.label})`).join(' → ')}`,
      })
    }
    if (plan.suppressed.length) {
      failures.push({ message, why, detail: `误触发卡片抑制：${plan.suppressed.join('、')}` })
    }
  }

  return { routeCount: routes.length, positiveChecked, negativeChecked: NEGATIVE_CASES.length, failures, notes }
}

describe('路由评测集（公开基线）', () => {
  beforeAll(() => {
    // 钉住配置来源：本机用户层覆盖不得影响评测结论。
    process.env.WEWORKER_ROUTER_CONFIG_DIR = ROUTER_CONFIG_DIR
    process.env.WEWORKER_ROUTER_CONFIG_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-eval-'))
    process.env.WEWORKER_SCENARIO_ROUTE = '1'
    delete process.env.WEWORKER_API_QUERY_ROUTE
    resetScenarioRoutesCacheForTests()
    resetRouteEngineForTests()
  })

  it('公开基线产物非空（空集会因断言全部落空而产生假绿）', () => {
    expect(fs.existsSync(path.join(ROUTER_CONFIG_DIR, 'scenario-routes.json'))).toBe(true)
    const routes = runtimeRoutes()
    expect(routes.length).toBeGreaterThan(0)
  })

  it('产物与 manifest 源一致（`gen:routes --check` 的测试内等价物）', () => {
    // 先钉住白名单真的被读进来了：`readJson` 的 catch 会把「读不懂」吞成 null，
    // 于是 `--check` 变成拿「空白名单」编译，与产物悄悄分叉却永远报绿。
    // 公开基线目前无 route.plan 卡片，恰好掩盖了这个洞——所以必须显式断言它非空。
    const whitelist = readJson(path.join(ROUTER_CONFIG_DIR, 'plan-terminals.json')) as {
      adapters?: Record<string, unknown>
    } | null
    expect(Object.keys(whitelist?.adapters ?? {}).length).toBeGreaterThan(0)

    const compiled = compileFromManifests()
    expect(compiled.errors).toEqual([])
    const onDisk = readJson(path.join(ROUTER_CONFIG_DIR, 'scenario-routes.json')) as { routes?: unknown } | null
    // 时间戳不进比对：只比语义（同 `--check` 口径）。
    expect(JSON.stringify(onDisk?.routes)).toBe(JSON.stringify(compiled.routes))
  })

  it('负例零误判 + 正例全覆盖', () => {
    const report = runRouteEval(runtimeRoutes())
    // 正例数 == 路由数：确保没有一条路由因为「没有话术可校验」被跳过（假绿通道）。
    expect(report.positiveChecked).toBe(report.routeCount)
    expect(report.failures).toEqual([])
  })
})
