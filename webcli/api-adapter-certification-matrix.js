import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShippedApiInventory } from './api-adapter-certification.js'
import { collectApiAdapterTestEvidence } from './api-adapter-test-evidence.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(moduleDir, '..')

const CONDITIONAL_READ_STATUSES = new Set([
  'AUTH',
  'FIXTURE_NOT_FOUND',
  'PAGE_CONTEXT',
  'PERMISSION',
])
const ACCEPTABLE_DRY_RUN_STATUSES = new Set([
  'AUTH',
  'FIXTURE_NOT_FOUND',
  'PAGE_CONTEXT',
  'PASS',
  'PERMISSION',
])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadOptionalReport(liveDir, name) {
  const path = join(liveDir, name)
  return existsSync(path) ? readJson(path) : { generatedAt: null, results: [] }
}

function indexLatest(reports) {
  const result = new Map()
  for (const report of reports) {
    for (const entry of report.results || []) result.set(entry.tool, entry)
  }
  return result
}

function normalizeReadStatus(entry) {
  if (!entry) return 'MISSING_LIVE_EVIDENCE'
  if (entry.status === 'ERROR' && /登录|authentication|required|username/i.test(entry.errorSignature || '')) {
    return 'AUTH'
  }
  return entry.status
}

export function certifyReadStatus(status) {
  if (status === 'PASS') return { result: 'PASS', reasonCode: 'LIVE_READ_PASS' }
  if (CONDITIONAL_READ_STATUSES.has(status)) {
    return { result: 'CONDITIONAL', reasonCode: `LIVE_${status}` }
  }
  return { result: 'FAIL', reasonCode: `LIVE_${status}` }
}

export function certifyMutation({ guard, dryRun }) {
  if (!guard || guard.status !== 'CONFIRMATION_GUARD' || guard.expectationMet !== true) {
    return { result: 'FAIL', reasonCode: 'CONFIRMATION_GUARD_FAILED' }
  }
  if (dryRun && (dryRun.expectationMet !== true || !ACCEPTABLE_DRY_RUN_STATUSES.has(dryRun.status))) {
    return { result: 'FAIL', reasonCode: `DRY_RUN_${dryRun.status || 'FAILED'}` }
  }
  return {
    result: 'CONDITIONAL',
    reasonCode: dryRun ? `SAFE_DRY_RUN_${dryRun.status}` : 'PRODUCTION_MUTATION_NOT_AUTHORIZED',
  }
}

function summarize(items, key = 'result') {
  return items.reduce((summary, item) => {
    const value = item[key]
    summary[value] = (summary[value] || 0) + 1
    return summary
  }, {})
}

function aggregateAdapter(tools) {
  if (tools.some((tool) => tool.result === 'FAIL')) return 'FAIL'
  if (tools.some((tool) => tool.result === 'CONDITIONAL')) return 'CONDITIONAL'
  return 'PASS'
}

export async function buildApiAdapterCertificationMatrix({
  repoRoot = defaultRepoRoot,
  liveDir = join(repoRoot, 'artifacts', 'api-adapter-certification'),
  mockEvidence = null,
} = {}) {
  const inventory = await loadShippedApiInventory({ repoRoot })
  const evidence = mockEvidence || await collectApiAdapterTestEvidence({
    repoRoot,
    includeExistingTests: false,
  })
  const mockByTool = new Map(evidence.adapters.flatMap((adapter) => (
    adapter.tools.map((tool) => [tool.name, tool.mockStatus])
  )))

  const readBase = loadOptionalReport(liveDir, 'live-read-results.json')
  const readRegressions = loadOptionalReport(liveDir, 'live-read-regressions.json')
  const repeats = loadOptionalReport(liveDir, 'live-critical-repeats.json')
  const guards = loadOptionalReport(liveDir, 'live-guards-results.json')
  const guardRegressions = loadOptionalReport(liveDir, 'live-guard-regressions.json')
  const dryRuns = loadOptionalReport(liveDir, 'live-dry-runs-results.json')
  const readByTool = indexLatest([readBase, readRegressions])
  const guardByTool = indexLatest([guards, guardRegressions])
  const dryRunByTool = indexLatest([dryRuns])

  const adapters = inventory.adapters.map((adapter) => {
    const tools = adapter.tools.map((tool) => {
      const mockStatus = mockByTool.get(tool.name) || 'INCOMPLETE'
      const isRead = tool.safety === 'read' || tool.safety === 'sensitive_read'
      const readEntry = isRead ? readByTool.get(tool.name) : null
      const guardEntry = isRead ? null : guardByTool.get(tool.name)
      const dryRunEntry = isRead ? null : dryRunByTool.get(tool.name)
      const liveStatus = isRead ? normalizeReadStatus(readEntry) : 'NOT_EXECUTED'
      const certification = isRead
        ? certifyReadStatus(liveStatus)
        : certifyMutation({ guard: guardEntry, dryRun: dryRunEntry })
      const result = mockStatus === 'PASS' ? certification.result : 'FAIL'
      const reasonCode = mockStatus === 'PASS' ? certification.reasonCode : `MOCK_${mockStatus}`
      return {
        name: tool.name,
        safety: tool.safety,
        mockStatus,
        integrationStatus: isRead ? (readEntry?.status || 'MISSING') : (guardEntry?.status || 'MISSING'),
        liveStatus,
        dryRunStatus: dryRunEntry?.status || 'NOT_DECLARED_OR_NOT_RUN',
        repeated: Boolean(repeats.byTool?.[tool.name]),
        intermittent: repeats.byTool?.[tool.name]?.intermittent || false,
        result,
        reasonCode,
      }
    })
    return {
      id: adapter.id,
      name: adapter.name,
      result: aggregateAdapter(tools),
      summary: summarize(tools),
      tools,
    }
  })
  const tools = adapters.flatMap((adapter) => adapter.tools)
  const evidenceTimes = [readBase, readRegressions, repeats, guards, guardRegressions, dryRuns]
    .map((report) => report.generatedAt)
    .filter(Boolean)
    .sort()

  return {
    schemaVersion: 1,
    evidenceThrough: evidenceTimes.at(-1) || null,
    scope: inventory.scope,
    callPath: 'webcli call -> Bridge -> Chrome Extension -> Adapter',
    policy: {
      pass: 'Mock gates pass and an authenticated live read succeeds.',
      conditional: 'Mock and safety gates pass, but live proof is limited by auth, permission, fixture, page context, or mutation authorization.',
      fail: 'A required mock/safety gate fails, live evidence is missing, or the real read has a stable route, argument, timeout, HTTP, service, or response-contract failure.',
    },
    adapterCount: adapters.length,
    toolCount: tools.length,
    summary: {
      adapters: summarize(adapters),
      tools: summarize(tools),
      mock: summarize(tools, 'mockStatus'),
      intermittentTools: tools.filter((tool) => tool.intermittent).length,
    },
    adapters,
  }
}

function option(name, fallback = null) {
  const exact = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return exact ? exact.slice(name.length + 3) : fallback
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const matrix = await buildApiAdapterCertificationMatrix()
  const output = option('output')
  const serialized = `${JSON.stringify(matrix, null, 2)}\n`
  if (output) {
    const outputPath = resolve(output)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, serialized, 'utf8')
  }
  else process.stdout.write(serialized)
  if ((matrix.summary.tools.FAIL || 0) > 0) process.exitCode = 1
}
