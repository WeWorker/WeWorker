#!/usr/bin/env node
/**
 * 巡检执行器 CLI。
 *
 * 用法：
 *   node webcli/patrol/index.js [--json] [--only <adapterId>] [--concurrency 4]
 *                               [--timeout 20] [--update-baseline] [--list]
 *
 * 退出码：0 全绿（含未覆盖） / 1 有失败 / 2 脚本自身异常
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBaseline } from './baseline.js'
import { classifyConnectivity, evaluateTool } from './classify.js'
import { buildPatrolList, indexSamples } from './enumerate.js'
import { createDefaultEnsureLogin } from './ensure-login.js'
import { buildPatrolEnv, probeTool, runWithConcurrency, summarizeProbe, WEBCLI_DIR } from './probe.js'
import { buildReport, formatTextReport } from './report.js'
import { diffShape, extractShape } from './shape.js'

const PATROL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(WEBCLI_DIR, '..')
const RUNS_DIR = join(REPO_ROOT, 'webcli', 'patrol', 'runs')

/**
 * adapterId 入口白名单：adapterId 会被拼进基线/运行产物文件路径（`loadBaseline`、
 * `persistRun`），也来自命令行 `--only`。只放行安全字符集，防止路径穿越与
 * 非法文件名——与 bridge.js 的 SAFE_ADAPTER_ID_RE 同款。
 */
const SAFE_ADAPTER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function parsePatrolArgs(argv) {
  const options = { json: false, only: null, concurrency: 4, timeoutMs: 20_000, updateBaseline: false, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--list') options.list = true
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--only') options.only = argv[++i] ?? null
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

async function patrolAdapter({ adapterId, samples, options, env, ensureLogin }) {
  if (!SAFE_ADAPTER_ID.test(adapterId)) {
    // 非法 adapterId：跳过该站，记一行未覆盖（不计入通过），不让一个坏 id 炸整轮巡检
    return [{ adapterId, tool: '*', verdict: 'uncovered', kind: 'invalid-adapter-id', details: { reason: 'invalid-adapter-id' } }]
  }

  const login = await ensureLogin(adapterId)
  if (!login.ok) {
    const tools = await loadTools(adapterId)
    return tools.map(({ tool }) => ({
      adapterId,
      tool,
      verdict: 'uncovered',
      kind: login.reason,
      details: { reason: login.reason },
    }))
  }

  const tools = await loadTools(adapterId)
  const baseline = loadBaseline(REPO_ROOT, adapterId)
  const list = buildPatrolList({ adapterId, tools, samples, baseline })

  return runWithConcurrency(list, options.concurrency, async (row) => {
    if (row.skipReason) {
      return { adapterId, tool: row.tool, verdict: 'uncovered', kind: row.skipReason, details: { reason: row.skipReason } }
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
    return {
      adapterId,
      tool: row.tool,
      verdict: verdict.verdict,
      kind: verdict.kind,
      details: { ...verdict.details, durationMs: result.durationMs, baselineMissing: connectivity.ok && !baselineEntry },
      parsed: result.parsed,
      sampleSource: row.sample?.source ?? null,
    }
  })
}

async function main() {
  const options = parsePatrolArgs(process.argv.slice(2))
  const env = buildPatrolEnv()
  const manifests = loadSampleManifests()
  const samples = indexSamples(manifests)

  const { loadExtensionAdapters } = await import('../adapter-cli.js')
  const adapters = await loadExtensionAdapters()
  const targetIds = options.only ? [options.only] : adapters.map((adapter) => adapter.id)

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
  const rows = []
  for (const adapterId of targetIds) {
    rows.push(...(await patrolAdapter({ adapterId, samples, options, env, ensureLogin })))
  }
  const finishedAt = new Date().toISOString()

  const previousReport = loadPreviousReport()
  const report = buildReport({ runId, startedAt, finishedAt, rows, siteCount: targetIds.length, previousReport })

  persistRun(report, rows)
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTextReport(report))
  process.exitCode = report.failed > 0 ? 1 : 0
}

function loadPreviousReport() {
  const file = join(REPO_ROOT, 'webcli', 'patrol', 'latest.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function persistRun(report, rows) {
  mkdirSync(RUNS_DIR, { recursive: true })
  writeFileSync(join(RUNS_DIR, `${report.runId}.json`), `${JSON.stringify(rows, null, 2)}\n`, 'utf8')
  writeFileSync(join(REPO_ROOT, 'webcli', 'patrol', 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[patrol] 异常: ${error?.stack ?? error}`)
    process.exitCode = 2
  })
}
