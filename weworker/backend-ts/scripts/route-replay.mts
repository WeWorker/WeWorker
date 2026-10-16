/**
 * 智能路由配置 · 自动回归（把人工逐条测试变成一条命令）。
 *
 * 用例源就是给人看的那份文档 `docs/router-config-manual-testcases.md`——单一事实来源，
 * 文档改了脚本自动跟着变，不会出现「清单和脚本两张皮」。
 *
 * 两种模式：
 *   npx tsx scripts/route-replay.mts            # 纯规划（毫秒级，不碰网络）：验命中层、工具、参数、渲染方式
 *   npx tsx scripts/route-replay.mts --live     # 真派发（走 webcli，每条数秒）：验工具跑不跑得通、结果正不正常
 *
 * 每条用例都给出五件事，并附上实际输出作为证据：
 *   ① 是否命中路由（命中 / 未命中落回 LLM / 被硬门拦下）
 *   ② 命中第几层  ③ 命中的工具与渲染方式  ④ 结果是否正常（正常 / 报错原因 / 落盘指针 / 空结果）
 *   ⑤ 耗时（规划耗时 = 路由判定本身的开销；整条耗时含派发与渲染）
 *
 * 常用参数：
 *   --only 1,2,3        只跑指定编号
 *   --only 3.1          只跑某一节（前缀匹配）
 *   --json              额外产出机器可读结果
 *
 * 报告落在 `<仓库根>/.scratch-router/route-replay-<mode>.md`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executeRoutePlan,
  planRouteDecision,
  type RouteExecutionContext,
} from '../src/api-query-router/index.js'
import { runWebcliCall } from '../src/webcli-runner.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const DOC = path.join(REPO_ROOT, 'docs', 'router-config-manual-testcases.md')
const OUT_DIR = path.join(REPO_ROOT, '.scratch-router')
/** 报告里每条证据最多留多少行（完整结果仍在内存里参与判定，只是报告截断） */
const EVIDENCE_MAX_LINES = 26

/** 级联层的中文名（报告里给人看） */
const LAYER_NAME: Record<string, string> = {
  route: '层 P 关键词直连',
  scenario: '第 0 层 结构化直连',
  scenarioPlan: '第 0 层 结构化多跳',
  template: 'Tier -2 manifest 模板',
  pattern: 'Tier -1 提示词配置',
  plan: '层 9 多跳计划',
  shortcut: '第 11 层 话术快捷',
  alias: '第 11 层 `!` 别名',
  'llm-classify': '第 12 层 词法召回',
}

// ── 用例解析 ────────────────────────────────────────────────────────────────

type Expectation =
  | { kind: 'route'; tool: string; args: string }
  | { kind: 'plan'; planId: string }
  | { kind: 'fallback'; why: string }

type Case = {
  n: number
  section: string
  input: string
  expect: Expectation
  history?: unknown[]
}

/** 去掉反引号与首尾空白 */
function unquote(raw: string): string {
  return raw.trim().replace(/`/g, '').trim()
}

/** 清单里有的单元格是「`消息`（补充说明）」：说明不是消息的一部分，得剥掉。 */
function stripComment(raw: string): string {
  return unquote(raw).replace(/[（(][^）)]*[）)]\s*$/, '').trim()
}

export function parseCases(markdown: string): Case[] {
  const cases: Case[] = []
  let section = ''
  for (const line of markdown.split(/\r?\n/)) {
    // `###` 是可选的节号（3.1 / 3.2 …）；`##` 是章（三、正例 / 四、负例），
    // 必须一并重置节号——否则负例章的表会继承上一节的节号，被 `--only 3.5` 误抓进来。
    const heading = /^(#{2,3})\s+(\S+)/.exec(line)
    if (heading) {
      section = heading[1] === '###' ? heading[2] : `§${heading[2].replace(/[、：:].*$/, '')}`
      continue
    }
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    if (cells.length < 3) continue
    const n = Number(cells[0])
    if (!Number.isInteger(n)) continue // 表头与分隔行

    // 负例表只有三列，第三列是「为什么不该命中」
    if (cells.length === 3) {
      cases.push({
        n, section, input: stripComment(cells[1]),
        expect: { kind: 'fallback', why: cells[2] },
      })
      continue
    }
    const input = stripComment(cells[1])
    if (section.startsWith('3.5')) {
      cases.push({ n, section, input, expect: { kind: 'plan', planId: unquote(cells[2]) } })
      continue
    }
    cases.push({
      n, section, input,
      expect: { kind: 'route', tool: unquote(cells[2]), args: unquote(cells[3] ?? '') },
    })
  }
  return cases.sort((a, b) => a.n - b.n)
}

// 真实会话历史的形状：content 是块数组，追问态判定按块读文本
const FOLLOW_UP_HISTORY = [
  { role: 'user', content: [{ type: 'text', text: '今日头条热榜' }] },
  { role: 'assistant', content: [{ type: 'text', text: '为你找到 20 条热榜。' }] },
]

// ── 结果模型 ────────────────────────────────────────────────────────────────

type Verdict = 'PASS' | 'FAIL' | 'SKIP'

type Hop = {
  /** 工具名；`open_browser` 是派发前的开页准备，不是查询本身 */
  tool: string
  args: string
  raw: string
}

type Result = {
  n: number
  section: string
  input: string
  verdict: Verdict
  /** 这一条到底有没有走快速路由：命中 / 未命中（落回 LLM）/ 硬门（被闸门拦下） */
  hit: Hit
  /** 命中第几层（未命中为「—」） */
  layer: string
  tool: string
  render: string
  /** 结果是否正常：正常（N 行数据）/ 报错原因 / 落盘指针 / 空结果 / 未执行 */
  health: string
  /** 实际输出，作为证据（纯规划模式为空） */
  evidence: string
  /** 每一跳的原始输出（多跳计划尤其需要：第一跳错则第二跳必然错）；纯规划与未派发时为空 */
  hops?: Hop[]
  /** 规划（路由判定）耗时 ms——路由层本身的开销，与站点快慢无关 */
  planMs: number
  /** 本条用例的墙钟耗时 ms：纯规划=判定耗时；真派发=判定+派发+渲染 */
  ms: number
  notes: string[]
}

type Hit = '命中' | '未命中' | '硬门'

/** runCaseInner 的产物：命中/耗时三个字段由外层统一补齐，内层不必每个出口都写一遍。 */
type CaseOutcome = Omit<Result, 'hit' | 'planMs' | 'ms'>

/**
 * 这一条有没有走快速路由——报告里最先要看的那个字。
 * 判定只看「有没有被某一层认领」，不看结果好不好：执行回落（未登录/工具报错）仍算命中，
 * 那是「命中了但没拿到数据」，与「压根没命中」是两种完全不同的故障。
 */
function hitLabel(item: { layer: string; tool: string }): Hit {
  if (item.layer.startsWith('硬门')) return '硬门'
  if (!item.tool || item.tool === '—' || item.layer === '未命中' || item.layer === '—') return '未命中'
  return '命中'
}

function canonical(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

function firstDispatched(plan: { steps: any[] }) {
  return plan.steps.find((step) => step.decision?.kind === 'tool' || step.decision?.kind === 'plan') ?? null
}

function layerLabel(layer: string | undefined): string {
  if (!layer) return '—'
  return LAYER_NAME[layer] ?? layer
}

/** 从渲染正文判断这次路由「结果正不正常」——命中了但拿不到数据，对用户就是没答案。 */
function inspectText(text: string): { health: string; ok: boolean } {
  const failure = /⚠️ 查询失败：(.+)/.exec(text)
  if (failure) return { health: `工具报错：${failure[1].slice(0, 80)}`, ok: false }
  if (text.includes('结果过大已落盘')) return { health: '落盘指针：用户看不到数据', ok: false }
  if (/⚠️ 查询返回为空|没有取到|未查询到相关数据/.test(text)) return { health: '空结果', ok: false }
  const rows = text.split('\n').filter((line) => line.trim().startsWith('|')).length
  if (rows > 2) return { health: `正常（${rows - 2} 行数据）`, ok: true }
  // 单对象结果渲染成 kv 列表（如 HN 用户档案：karma/created），同样是正常结果——
  // 只认表格会让这类「有数据但无表格」的命中被判成异常。
  const fields = text.split('\n').filter((line) => /^\s*-\s+\*\*.+\*\*:\s*\S/.test(line)).length
  if (fields) return { health: `正常（${fields} 项字段）`, ok: true }
  return { health: '无可读内容（既无表格也无字段）', ok: false }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

type Options = { live: boolean; only: string[]; json: boolean }

function parseArgv(argv: string[]): Options {
  const only: string[] = []
  let live = false
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--live') live = true
    else if (arg === '--json') json = true
    else if (arg === '--only') only.push(...(argv[index + 1] ?? '').split(',').map((v) => v.trim()).filter(Boolean))
    else if (arg.startsWith('--only=')) only.push(...arg.slice(7).split(',').map((v) => v.trim()).filter(Boolean))
  }
  return { live, only, json }
}

function selected(all: Case[], only: string[]): Case[] {
  if (!only.length) return all
  return all.filter((item) => only.some((spec) => String(item.n) === spec || item.section.startsWith(spec)))
}

/** 中文按两格宽对齐，避免等宽字体里表格歪掉 */
function pad(text: string, width: number): string {
  let shown = 0
  for (const char of text) shown += /[一-鿿　-〿＀-￯]/.test(char) ? 2 : 1
  return text + ' '.repeat(Math.max(0, width - shown))
}

function trimEvidence(text: string, maxLines = EVIDENCE_MAX_LINES): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return [...lines.slice(0, maxLines), `…（共 ${lines.length} 行，此处截断）`].join('\n')
}

async function main(): Promise<void> {
  const options = parseArgv(process.argv.slice(2))
  if (!fs.existsSync(DOC)) {
    console.error(`找不到用例清单：${DOC}`)
    process.exit(2)
  }
  const all = parseCases(fs.readFileSync(DOC, 'utf8'))
  const cases = selected(all, options.only)
  if (!cases.length) {
    console.error(`--only ${options.only.join(',')} 没有匹配到任何用例`)
    process.exit(2)
  }

  const positives = cases.filter((item) => item.expect.kind !== 'fallback').length
  console.log(
    `${options.live ? '真派发' : '纯规划'}模式 ｜ 用例 ${cases.length} 条（正例 ${positives} / 负例 ${cases.length - positives}）`,
  )
  if (options.live) console.log('真派发每条要等一次 webcli 往返（数秒），请勿中断……\n')

  // 先把配置加载/编译的冷启动成本吃掉，否则它会整笔算进第一条的耗时里，把平均值带偏。
  planRouteDecision({ message: '__replay_warmup__', workId: 'replay-warmup', now: Date.now() })

  const results: Result[] = []
  for (const item of cases) {
    const result = await runCase(item, options)
    results.push(result)
    console.log(
      `[${result.verdict}] #${String(item.n).padStart(3)} ${pad(result.input, 34)} ${pad(result.hit, 8)} ` +
        `层：${pad(result.layer, 20)} ${pad(result.tool, 28)} ${result.render} ` +
        `｜ ⏱ ${result.ms}ms（判定 ${result.planMs}ms）｜ 结果：${result.health}`,
    )
    for (const note of result.notes) console.log(`          ${note}`)
    for (const [index, hop] of (result.hops ?? []).entries()) {
      const kind = hop.tool === 'open_browser' ? '开页准备' : `第 ${index + 1} 跳`
      console.log(`          ${kind} ${hop.tool} ${hop.args} → ${hopStatus(hop.raw)}`)
    }
    if (options.live && result.evidence && !result.evidence.startsWith('（')) {
      console.log(`          输出首行：${firstMeaningfulLine(result.evidence).slice(0, 110)}`)
    }
  }

  const failed = results.filter((item) => item.verdict === 'FAIL')
  const skipped = results.filter((item) => item.verdict === 'SKIP')
  console.log(
    `\n合计 ${results.length} 条：通过 ${results.filter((r) => r.verdict === 'PASS').length}，失败 ${failed.length}，需人工确认 ${skipped.length}`,
  )
  /** 本该落回 LLM 的用例编号——用来把「预期未命中」与「正例漏判」分开算 */
  const fallbackNs = new Set(cases.filter((item) => item.expect.kind === 'fallback').map((item) => item.n))
  printLayerSummary(results, fallbackNs)
  writeReport(results, options, fallbackNs)
  if (options.json) {
    const jsonPath = path.join(OUT_DIR, `route-replay-${options.live ? 'live' : 'dry'}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8')
    console.log(`机器可读结果：${jsonPath}`)
  }
  process.exit(failed.length ? 1 : 0)
}

function printLayerSummary(results: Result[], fallbackNs: Set<number>): void {
  const byLayer = new Map<string, number>()
  for (const item of results) byLayer.set(item.layer, (byLayer.get(item.layer) ?? 0) + 1)
  console.log('\n按命中层统计：')
  for (const [layer, count] of [...byLayer.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(layer, 22)} ${count} 条`)
  }

  // 命中/耗时总览：一眼看出「多少条真的走了快速路由」与「最慢的几条是谁」。
  // 负例**本该未命中**，所以未命中数高不代表有问题（判定列 PASS/FAIL 才是对错）；
  // 真正要盯的是「正例里未命中的条数」——那是漏判，会走一次 LLM。
  const hit = results.filter((item) => item.hit === '命中').length
  const gate = results.filter((item) => item.hit === '硬门').length
  const missedExpected = results.filter((item) => item.hit !== '命中' && fallbackNs.has(item.n)).length
  const missedUnexpected = results.filter((item) => item.hit !== '命中' && !fallbackNs.has(item.n)).length
  console.log(
    `\n是否命中：命中 ${hit} 条 ｜ 未命中 ${results.length - hit} 条（其中负例预期未命中 ${missedExpected} 条、` +
      `正例却未命中 ${missedUnexpected} 条）｜ 被硬门拦下 ${gate} 条`,
  )
  console.log(
    `耗时：整条平均 ${mean(results.map((item) => item.ms)).toFixed(1)}ms ｜ ` +
      `路由判定平均 ${mean(results.map((item) => item.planMs)).toFixed(2)}ms（配置已预热，冷启动不计入）`,
  )
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3)
  if (slowest.length > 1) {
    console.log(`最慢 3 条：${slowest.map((item) => `#${item.n}(${item.ms}ms)`).join('、')}`)
  }

  const attention = results.filter((item) => item.verdict !== 'PASS')
  if (attention.length) {
    console.log('\n需要看的条目：')
    for (const item of attention) console.log(`  #${item.n} ${item.input} —— ${item.health}`)
  }
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

/** 统一补齐「是否命中 + 耗时」：所有出口都经这里，不靠每个 return 自觉带上。 */
async function runCase(item: Case, options: Options): Promise<Result> {
  const started = Date.now()
  const timing = { planMs: 0 }
  const outcome = await runCaseInner(item, options, timing)
  return { ...outcome, hit: hitLabel(outcome), planMs: timing.planMs, ms: Date.now() - started }
}

async function runCaseInner(item: Case, options: Options, timing: { planMs: number }): Promise<CaseOutcome> {
  const workId = `replay-${item.n}`
  const logs: string[] = []
  const history = item.n === 90 ? FOLLOW_UP_HISTORY : item.history

  let plan: { steps: any[]; blocked?: { gate?: string } }
  try {
    const planStarted = Date.now()
    plan = planRouteDecision({ message: item.input, workId, history, log: (msg) => logs.push(msg) }).plan
    timing.planMs = Date.now() - planStarted
  } catch (error) {
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'FAIL',
      layer: '—', tool: '—', render: '—', health: '规划抛错', evidence: '',
      notes: [error instanceof Error ? error.message : String(error)],
    }
  }

  const dispatched = firstDispatched(plan)
  const notes: string[] = []

  // ── 负例：不得被任何层认领 ──
  if (item.expect.kind === 'fallback') {
    if (dispatched) {
      return {
        n: item.n, section: item.section, input: item.input, verdict: 'FAIL',
        layer: layerLabel(dispatched.layer), tool: dispatched.decision.tool ?? '—',
        render: '—', health: '误判：本应落回模型', evidence: '',
        notes: [`预期落回模型，理由：${item.expect.why}`],
      }
    }
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'PASS',
      layer: plan.blocked?.gate ? `硬门 ${plan.blocked.gate}` : '未命中',
      tool: '—', render: '—',
      health: '落回模型（预期：交给 LLM，不短路）',
      evidence: `（正例/负例判定：本条不应派发任何工具。规划结果 steps=${plan.steps.length}` +
        `${plan.blocked?.gate ? `，被硬门 ${plan.blocked.gate} 拦下` : ''}）`,
      notes,
    }
  }

  // ── 正例：必须命中 ──
  if (!dispatched) {
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'FAIL',
      layer: '—', tool: '—', render: '—', health: '漏判：没有任何层认领', evidence: '',
      notes: logs.slice(-3),
    }
  }
  const decision = dispatched.decision
  const layer = layerLabel(dispatched.layer)
  const tool = decision.tool ?? (item.expect.kind === 'plan' ? item.expect.planId : '—')
  const render = decision.render?.schemaId ? `声明式表格 ${decision.render.schemaId}` : '通用表格'

  if (item.expect.kind === 'route' && decision.kind === 'tool' && decision.tool !== item.expect.tool) {
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'FAIL',
      layer, tool: String(tool), render, health: `工具不符：期望 ${item.expect.tool}`,
      evidence: `（命中 ${dispatched.layer} 层，但认领的工具是 ${decision.tool}）`, notes,
    }
  }
  if (item.expect.kind === 'route' && item.expect.args && decision.args) {
    const expected = canonical(JSON.parse(item.expect.args))
    const actual = canonical(decision.args)
    if (expected !== actual) notes.push(`参数不符：期望 ${item.expect.args}，实际 ${actual}`)
  }
  if (item.expect.kind === 'plan' && decision.kind !== 'plan') {
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'FAIL',
      layer, tool: String(tool), render, health: `期望两跳计划，实际单跳 ${decision.tool}`, evidence: '', notes,
    }
  }

  // 纯规划模式只验配置：结果是否正常要靠真派发才知道
  if (!options.live) {
    return {
      n: item.n, section: item.section, input: item.input,
      verdict: notes.length ? 'FAIL' : 'PASS',
      layer, tool: String(tool), render,
      health: notes.length ? '配置不符（见下）' : '未执行（纯规划模式：只验配置，不调站点）',
      evidence: `（命中 ${dispatched.layer} 层，参数 ${canonical(decision.args ?? decision.input ?? {})}${decision.render?.schemaId ? `，渲染 schema=${decision.render.schemaId}` : ''}）`,
      notes,
    }
  }

  // ── 真派发 ──
  const events: any[] = []
  // 逐跳记录：多跳计划只有第一跳的输出能解释第二跳为什么失败，必须留证。
  const hops: Hop[] = []
  const recordingDispatch = async (tool: string, argsJson: string, id: string): Promise<string> => {
    const raw = await runWebcliCall(tool, argsJson, id)
    hops.push({ tool, args: argsJson, raw })
    return raw
  }
  const ctx: RouteExecutionContext = {
    message: item.input, workId, turnId: `${workId}-turn`, chatStartTime: Date.now(),
    send: (event) => events.push(event), log: (msg) => logs.push(msg),
  }
  let handled = false
  try {
    handled = await executeRoutePlan(plan as never, ctx, {
      persistAssistantMessage: () => {},
      dispatch: recordingDispatch,
    })
  } catch (error) {
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'FAIL',
      layer, tool: String(tool), render, health: '执行抛错', evidence: '',
      notes: [error instanceof Error ? error.message : String(error)],
    }
  }
  const text = events.find((event) => event.type === 'text_delta')?.content ?? ''
  const turnEnd = events.find((event) => event.type === 'turn_end')
  if (!handled || !text) {
    return {
      n: item.n, section: item.section, input: item.input, verdict: 'SKIP',
      layer, tool: String(tool), render,
      health: '命中但执行回落（多为未登录／工具报错），按设计交给 LLM',
      evidence: '（落回模型，无渲染结果）',
      hops,
      notes: [...notes, ...logs.filter((line) => /fallback|failed|not resolvable/.test(line)).slice(-2)],
    }
  }

  const { health, ok } = inspectText(text)
  return {
    n: item.n, section: item.section, input: item.input,
    verdict: notes.length ? 'FAIL' : ok ? 'PASS' : 'SKIP',
    layer, tool: String(tool), render,
    health: `${health} ｜ ${text.length} 字符 ｜ exec ${turnEnd?.execMs ?? '?'}ms ｜ ${turnEnd?.steps ?? '?'} 步`,
    evidence: text,
    hops,
    notes,
  }
}

/** 一跳的态度：报错就把原因带出来，大结果说明落了盘，其余报字符数。 */
function hopStatus(raw: string): string {
  const failure = /⚠️\s*查询失败：(.+)/.exec(raw) ?? /"error"\s*:\s*"([^"]{1,120})/.exec(raw)
  if (failure) return `✗ ${failure[1]}`
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'large_output') {
      return `落盘指针（count=${(parsed as { count?: number }).count ?? '?'}）`
    }
  } catch {
    // 非 JSON（纯文本结果）按字符数报
  }
  return `✓ ${raw.length} 字符`
}

/** 证据里的第一行有内容的话，抄到控制台方便直接看 */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && trimmed !== '```') return trimmed
  }
  return ''
}

function writeReport(results: Result[], options: Options, fallbackNs: Set<number>): void {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const mode = options.live ? '真派发' : '纯规划'
  const byLayer = new Map<string, number>()
  for (const item of results) byLayer.set(item.layer, (byLayer.get(item.layer) ?? 0) + 1)
  const hit = results.filter((item) => item.hit === '命中').length
  const missedUnexpected = results.filter((item) => item.hit !== '命中' && !fallbackNs.has(item.n)).length
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5)

  const lines = [
    `# 路由配置自动回归报告（${mode}）`,
    '',
    `- 时间：${stamp}`,
    `- 用例源：\`docs/router-config-manual-testcases.md\``,
    `- 结果：通过 ${results.filter((r) => r.verdict === 'PASS').length} / 失败 ${results.filter((r) => r.verdict === 'FAIL').length} / 需人工确认 ${results.filter((r) => r.verdict === 'SKIP').length}`,
    `- 是否命中路由：命中 ${hit} / 未命中 ${results.length - hit}（其中**正例却未命中 ${missedUnexpected} 条**，需查；负例预期未命中 ${results.length - hit - missedUnexpected} 条）`,
    `- 耗时：整条平均 ${mean(results.map((item) => item.ms)).toFixed(1)}ms ｜ 路由判定平均 ${mean(results.map((item) => item.planMs)).toFixed(2)}ms`,
    `- 说明：每条都给出「是否命中路由 → 命中第几层 → 命中什么工具 → 结果正不正常 → 耗时」，并在文末附上**实际输出原文**作为证据。`,
    '',
    '## 一、逐条结果总览',
    '',
    '| # | 输入 | 是否命中路由 | 命中层 | 命中工具 | 渲染 | 耗时(ms) | 其中判定(ms) | 结果是否正常 | 判定 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (item) =>
        `| ${item.n} | \`${item.input}\` | ${item.hit} | ${item.layer} | ${item.tool} | ${item.render} | ` +
        `${item.ms} | ${item.planMs} | ${item.health.replace(/\|/g, '\\|')} | ${item.verdict} |`,
    ),
    '',
    '## 二、按命中层统计',
    '',
    '| 层 | 条数 |',
    '| --- | --- |',
    ...[...byLayer.entries()].sort((a, b) => b[1] - a[1]).map(([layer, count]) => `| ${layer} | ${count} |`),
    '',
    '### 最慢的 5 条（整条耗时）',
    '',
    '| # | 输入 | 是否命中路由 | 整条(ms) | 其中判定(ms) | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...slowest.map(
      (item) => `| ${item.n} | \`${item.input}\` | ${item.hit} | ${item.ms} | ${item.planMs} | ${item.health.replace(/\|/g, '\\|')} |`,
    ),
    '',
  ]

  const attention = results.filter((item) => item.verdict !== 'PASS')
  if (attention.length) {
    lines.push('## 三、需要人工看的条目', '')
    for (const item of attention) {
      lines.push(`- #${item.n} \`${item.input}\`（${item.hit} · ${item.layer} · ${item.tool}）：${item.health}`)
      for (const note of item.notes) lines.push(`  - ${note}`)
    }
    lines.push('')
  }

  lines.push('## 四、实际输出证据（逐条原文）', '')
  for (const item of results) {
    lines.push(
      `### #${item.n} \`${item.input}\``,
      '',
      `是否命中路由：**${item.hit}** ｜ 命中层：**${item.layer}** ｜ 工具：\`${item.tool}\` ｜ 渲染：${item.render}`,
      '',
      `耗时：整条 ${item.ms}ms（其中路由判定 ${item.planMs}ms）｜ 结果：${item.health}`,
      '',
    )
    if (item.evidence) {
      lines.push('```text', trimEvidence(item.evidence), '```')
    } else {
      lines.push('（无输出）')
    }
    if (item.hops?.length) {
      lines.push('', '派发轨迹（每一跳的原始返回）：', '')
      for (const hop of item.hops) {
        lines.push(
          `- \`${hop.tool}\` 参数 \`${hop.args}\` → ${hopStatus(hop.raw)}`,
          '',
          '```text',
          trimEvidence(hop.raw, 12),
          '```',
          '',
        )
      }
    }
    lines.push('')
  }

  // 分节跑时每节写自己的报告，避免后一节覆盖前一节（全量跑则不带后缀）
  const suffix = options.only.length ? `-${options.only.join('+').replace(/[^\w.+-]/g, '')}` : ''
  const target = path.join(OUT_DIR, `route-replay-${options.live ? 'live' : 'dry'}${suffix}.md`)
  fs.writeFileSync(target, lines.join('\n'), 'utf8')
  console.log(`报告（含逐条输出证据）：${target}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
