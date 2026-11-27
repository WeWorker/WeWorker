#!/usr/bin/env node
/**
 * 巡检执行器 CLI。
 *
 * 用法：
 *   node webcli/patrol/index.js [--json] [--html] [--only <adapterId>] [--concurrency 4]
 *                               [--timeout 20] [--update-baseline] [--list]
 *
 * 退出码：0 全绿（含未覆盖） / 1 有失败 / 2 脚本自身异常（含用法错误、--only 不存在）
 *
 * 巡检产物（latest.json / runs/）落盘在用户级 `~/.webcli/patrol/`，不入仓；
 * 基线（baselines/）只存形状，入仓可评审。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASELINE_VERSION, buildBaseline, diffBaselinePlan, loadBaseline, saveBaseline } from './baseline.js'
import { classifyConnectivity, evaluateTool } from './classify.js'
import { buildPatrolList, indexSamples } from './enumerate.js'
import { createDefaultEnsureLogin } from './ensure-login.js'
import { buildPatrolEnv, probeTool, runWithConcurrency, summarizeProbe, WEBCLI_DIR } from './probe.js'
import { buildReport, formatTextReport } from './report.js'
import { renderHtmlReport } from './html-report.js'
import { diffShape, extractShape } from './shape.js'

const REPO_ROOT = resolve(WEBCLI_DIR, '..')

/**
 * adapterId 入口白名单：adapterId 会被拼进基线文件路径（`loadBaseline`），也来自
 * 命令行 `--only`。只放行安全字符集，防止路径穿越与非法文件名——与 bridge.js 的
 * SAFE_ADAPTER_ID_RE 同款。
 */
const SAFE_ADAPTER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** 巡检运行产物目录（用户级，不入仓）。home 可注入供测试。 */
export function patrolStateDir({ home = homedir() } = {}) {
  return join(home, '.webcli', 'patrol')
}

export function parsePatrolArgs(argv) {
  const options = { json: false, html: false, only: null, concurrency: 4, timeoutMs: 20_000, updateBaseline: false, list: false, usageError: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--html') options.html = true
    else if (arg === '--list') options.list = true
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--only') {
      const value = argv[++i]
      // 缺值（或值是下一个 flag——adapterId 永不以 -- 开头）是用法错误，不是"全量巡检"
      if (value === undefined || value.startsWith('--')) options.usageError = '用法: --only 需要一个 adapterId'
      else options.only = value.split(',').map((item) => item.trim()).filter(Boolean)
    }
    // concurrency = 跨 adapter 并发数；同一 adapter 内命令严格串行（spec §关键约束 4：
    // 同站并发会争抢共享浏览器页面，"打爆站点"）。
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(argv[++i]) || 4)
    else if (arg === '--timeout') options.timeoutMs = Math.max(1, Number(argv[++i]) || 20) * 1000
  }
  return options
}

/** 读取 e2e-cases/ 下所有样本清单（既有资产，人工维护了参数与安全跑法）。 */
function loadSampleManifests() {
  const dir = join(WEBCLI_DIR, 'e2e-cases')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => [name, JSON.parse(readFileSync(join(dir, name), 'utf8'))])
}

/** 枚举某个 adapter 的全部工具（`loadExtensionAdapters()` 的条目自带 tools 数组）。 */
async function loadTools(adapterId) {
  const { loadExtensionAdapters } = await import('../adapter-cli.js')
  const adapters = await loadExtensionAdapters()
  const target = adapters.find((adapter) => adapter.id === adapterId)
  if (!target) return []
  return (target.tools ?? [])
    .map((tool) => (typeof tool === 'string' ? tool : tool.name))
    .filter(Boolean)
    .map((tool) => ({ tool }))
}

/**
 * 登录态失效整站转未覆盖，不算失败（spec 验收 5）。evaluateTool 把一切连通失败判成
 * failed；编排层在此只把 login_required 重定性为 uncovered——站点要求登录不是"站坏了"。
 * permission_denied / timeout / error 维持 failed（spec 只豁免登录态）。
 */
export function mapLoginUncovered(row) {
  if (row.verdict === 'failed' && row.kind === 'login_required') {
    return { ...row, verdict: 'uncovered', details: { ...row.details, reason: 'login_required' } }
  }
  return row
}

/**
 * 从结构化结果里提取业务错误文本:parsed.error 可能是字符串(如「需要登录
 * ITSM工单:…」)或 {code,message} 对象,统一 String 化(对象优先取 message,
 * 没有 message 兜底 JSON.stringify)、折叠空白后截 200 字符;无 error 或空文本
 * 返回 null——成功行不携带噪音。
 */
export function extractParsedError(parsed, { max = 200 } = {}) {
  const error = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.error : undefined
  if (error == null) return null
  const text = typeof error === 'string' ? error : error.message ?? JSON.stringify(error)
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, max) : null
}

/**
 * 从本站结果行收集基线候选：只收「连通 ok + 有样本 + parsed 非 null」的行
 * （uncovered 未跑、连通失败与坏 JSON 无从建形状）。条目为首跑自建（fixture 优先
 * 是后续子项目的注入点，本期未接）。
 */
export function collectBaselineEntries(rows, { now = null } = {}) {
  return rows
    .filter((row) => row.verdict !== 'uncovered' && row.parsed != null && row.sampleSource)
    .map((row) => ({
      tool: row.tool,
      entry: buildBaseline({ tool: row.tool, parsed: row.parsed, sampleSource: row.sampleSource, updatedAt: now, updatedBy: 'patrol' }),
    }))
}

/**
 * 合并旧基线生成新基线与变更预览。旧基线的工具**全量保留**（本轮没探到的工具
 * 不算"移除"——探针只跑有样本的命令，按次全量覆盖会误删历史基线），
 * 本轮采到的条目按工具覆盖写入。
 */
export function planBaselineUpdate(oldBaseline, entries, { now = null } = {}) {
  const tools = { ...(oldBaseline?.tools ?? {}) }
  for (const { tool, entry } of entries) tools[tool] = entry
  const newBaseline = { version: BASELINE_VERSION, updatedAt: now, updatedBy: 'patrol', tools }
  const plan = diffBaselinePlan(oldBaseline, newBaseline)
  return { newBaseline, plan }
}

const planChanged = (plan) => plan.added.length + plan.changed.length + plan.removed.length > 0

async function patrolAdapter({ adapterId, samples, options, env, ensureLogin, now = null }) {
  if (!SAFE_ADAPTER_ID.test(adapterId)) {
    // 非法 adapterId：跳过该站，记一行未覆盖（不计入通过），不让一个坏 id 炸整轮巡检
    return {
      rows: [{ adapterId, tool: '*', verdict: 'uncovered', kind: 'invalid-adapter-id', details: { reason: 'invalid-adapter-id' } }],
      baselineUpdate: null,
    }
  }

  const login = await ensureLogin(adapterId)
  if (!login.ok) {
    const tools = await loadTools(adapterId)
    return {
      rows: tools.map(({ tool }) => ({
        adapterId,
        tool,
        verdict: 'uncovered',
        kind: login.reason,
        details: { reason: login.reason },
      })),
      baselineUpdate: null,
    }
  }

  const tools = await loadTools(adapterId)
  const baseline = loadBaseline(REPO_ROOT, adapterId)
  const list = buildPatrolList({ adapterId, tools, samples, baseline })

  // 同 adapter 内命令严格串行（spec §关键约束 4）——共享浏览器页面独占，
  // 并发会互相争抢页面（"页面正在被其他任务使用"）。跨 adapter 并发由编排层控制。
  const rows = []
  for (const row of list) {
    if (row.skipReason) {
      rows.push({ adapterId, tool: row.tool, verdict: 'uncovered', kind: row.skipReason, details: { reason: row.skipReason } })
      continue
    }

    const raw = await probeTool({ tool: row.tool, args: row.sample?.args }, { env, timeoutMs: options.timeoutMs })
    const result = summarizeProbe(raw)
    const connectivity = classifyConnectivity(result)

    const baselineEntry = baseline?.tools?.[row.tool]
    let shapeDiff = null
    let emptiedPaths = []
    if (connectivity.ok && baselineEntry && result.parsed !== null) {
      shapeDiff = diffShape(baselineEntry.shape, extractShape(result.parsed))
      emptiedPaths = shapeDiff.emptied
    }

    const verdict = evaluateTool({ connectivity, shapeDiff, emptiedPaths })
    rows.push(mapLoginUncovered({
      adapterId,
      tool: row.tool,
      verdict: verdict.verdict,
      kind: verdict.kind,
      // 可诊断性:真实执行过的行携带真实错误文本(stderr 尾部/业务 error 消息),
      // 报告不再只见 reason:"error"。skipReason/uncovered 行不经此路径,不携带。
      details: {
        ...verdict.details,
        durationMs: result.durationMs,
        baselineMissing: connectivity.ok && !baselineEntry,
        stderrTail: result.stderrTail ? String(result.stderrTail).slice(-200) : null,
        parsedError: extractParsedError(result.parsed),
      },
      parsed: result.parsed,
      sampleSource: row.sample?.source ?? null,
    }))
  }

  const entries = collectBaselineEntries(rows, { now })
  const baselineUpdate = entries.length > 0 ? planBaselineUpdate(baseline, entries, { now }) : null
  return { rows, baselineUpdate }
}

async function main() {
  const options = parsePatrolArgs(process.argv.slice(2))
  if (options.usageError) {
    console.error(`[patrol] ${options.usageError}`)
    process.exitCode = 2
    return
  }

  const env = buildPatrolEnv()
  const manifests = loadSampleManifests()
  const samples = indexSamples(manifests)

  const { loadExtensionAdapters } = await import('../adapter-cli.js')
  const adapters = await loadExtensionAdapters()
  if (options.only?.length) {
    const missing = options.only.filter((id) => !adapters.some((adapter) => adapter.id === id))
    if (missing.length) {
      console.error(`[patrol] 未找到 adapter: ${missing.join(', ')}（用 --list 查看已装清单）`)
      process.exitCode = 2
      return
    }
  }
  const targetIds = options.only?.length ? options.only : adapters.map((adapter) => adapter.id)

  if (options.list) {
    for (const id of targetIds) {
      const tools = await loadTools(id)
      for (const { tool } of tools) console.log(`${id}\t${tool}`)
    }
    return
  }

  const ensureLogin = createDefaultEnsureLogin({
    sessionStore: null,
    probeStatus: async () => true, // 子项目 2 落地前：假定登录态可用，由连通层兜底
  })

  const runId = `patrol-${Date.now()}`
  const startedAt = new Date().toISOString()
  // 跨 adapter 并发 ≤ concurrency;同 adapter 内命令严格串行(每站一条串行链)
  const stationResults = await runWithConcurrency(targetIds, options.concurrency, async (adapterId) => {
    const stationStartedAt = new Date().toISOString()
    const { rows, baselineUpdate } = await patrolAdapter({ adapterId, samples, options, env, ensureLogin, now: stationStartedAt })
    return { adapterId, rows, baselineUpdate }
  })
  const rows = []
  const baselineUpdates = []
  for (const station of stationResults) {
    rows.push(...station.rows)
    if (station.baselineUpdate && planChanged(station.baselineUpdate.plan)) {
      baselineUpdates.push({ adapterId: station.adapterId, ...station.baselineUpdate })
    }
  }
  const finishedAt = new Date().toISOString()

  const previousReport = loadPreviousReport()
  const report = buildReport({ runId, startedAt, finishedAt, rows, siteCount: targetIds.length, previousReport })

  // 基线变更预览（spec:--update-baseline 前先打印）走 stderr，JSON 模式的 stdout 保持纯 JSON
  for (const { adapterId, newBaseline, plan } of baselineUpdates) {
    console.error(`[baseline] ${adapterId}: 新增 ${plan.added.length} / 变化 ${plan.changed.length}${plan.removed.length ? ` / 移除 ${plan.removed.length}` : ''}`)
    for (const tool of plan.added) console.error(`  + ${tool}`)
    for (const tool of plan.changed) console.error(`  ~ ${tool}`)
    if (options.updateBaseline) {
      saveBaseline(REPO_ROOT, adapterId, newBaseline)
      console.error(`[baseline] ${adapterId}: 已写入 webcli/patrol/baselines/${adapterId}.json`)
    }
  }
  if (baselineUpdates.length > 0 && !options.updateBaseline) {
    console.error('基线变更未写入，重跑加 --update-baseline')
  }

  persistRun(report, rows)
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTextReport(report))
  if (options.html) writeHtmlReport(report)
  process.exitCode = report.failed > 0 ? 1 : 0
}

function loadPreviousReport({ home } = {}) {
  const file = join(patrolStateDir({ home }), 'latest.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function persistRun(report, rows, { home } = {}) {
  const stateDir = patrolStateDir({ home })
  const runsDir = join(stateDir, 'runs')
  mkdirSync(runsDir, { recursive: true })
  writeFileSync(join(runsDir, `${report.runId}.json`), `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  writeFileSync(join(stateDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

/**
 * HTML 报告(单文件自包含)落盘在用户级 reports/,与 runs/ 同层,不入仓。
 * 提示走 stderr——--json 模式的 stdout 必须保持纯 JSON(与上方基线预览同一纪律)。
 */
export function writeHtmlReport(report, { home = homedir() } = {}) {
  const reportsDir = join(patrolStateDir({ home }), 'reports')
  mkdirSync(reportsDir, { recursive: true })
  const filePath = join(reportsDir, `${report.runId}.html`)
  writeFileSync(filePath, renderHtmlReport(report), 'utf8')
  console.error(`[patrol] HTML 报告: ${filePath}`)
  return filePath
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[patrol] 异常: ${error?.stack ?? error}`)
    process.exitCode = 2
  })
}
