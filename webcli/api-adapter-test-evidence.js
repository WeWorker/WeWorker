import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShippedApiInventory } from './api-adapter-certification.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(moduleDir, '..')

const SAFETY_PATTERN = /confirm|confirmation|dry[- ]run|guard|protect|before auth|before (?:fetch|request)|without (?:fetch|request)|no (?:fetch|request)|确认|预览|阻断/i
const ERROR_PATTERN = /error|auth|login|invalid|missing|reject|fail|permission|ambiguous|timeout|malformed|错误|失败|拒绝|缺少|无权限|登录|超时/i
const CERTIFICATION_TEST_FILES = [
  'api-adapter-confirmation-guards.test.mjs',
  'api-adapter-failure-smoke.test.mjs',
  'api-adapter-runtime-registration.test.mjs',
  'api-adapter-success-smoke.test.mjs',
]

export function classifyTestTitle(title) {
  if (SAFETY_PATTERN.test(title)) return 'safety'
  if (ERROR_PATTERN.test(title)) return 'error'
  return 'success'
}

function certificationCategory(file) {
  if (file === 'api-adapter-success-smoke.test.mjs') return 'success'
  if (file === 'api-adapter-failure-smoke.test.mjs') return 'error'
  if (file === 'api-adapter-confirmation-guards.test.mjs') return 'safety'
  return null
}

export function parseNodeTestOutput(output, file) {
  const results = []
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([✔✖])\s+(.+?)\s+\([\d.]+ms\)\s*$/)
    if (!match) continue
    results.push({
      file,
      title: match[2],
      category: certificationCategory(file) || classifyTestTitle(match[2]),
      status: match[1] === '✔' ? 'PASS' : 'FAIL',
    })
  }
  return results
}

function summarizeCategory(results, category) {
  const matching = results.filter((result) => result.category === category)
  if (matching.some((result) => result.status === 'FAIL')) return 'FAIL'
  if (matching.some((result) => result.status === 'PASS')) return 'PASS'
  return 'UNTESTED'
}

function toolTokens(tool) {
  return [tool.name]
    .filter((token) => typeof token === 'string' && token.length > 0)
    .map((token) => token.toLowerCase())
}

function isRelevantTest(result, tool) {
  const title = result.title.toLowerCase()
  return toolTokens(tool).some((token) => title.includes(token))
}

function summarizeToolCategory(results, category) {
  const matching = results.filter((result) => result.category === category)
  const certification = matching.filter((result) => CERTIFICATION_TEST_FILES.includes(result.file))
  return summarizeCategory(certification.length > 0 ? certification : matching, category)
}

function requiredCategories(tool) {
  const categories = ['success', 'error']
  if (tool.requiresConfirmation || ['mutating', 'high_risk'].includes(tool.safety)) categories.push('safety')
  return categories
}

export async function collectApiAdapterTestEvidence({
  repoRoot = defaultRepoRoot,
  timeoutMs = 30000,
  includeExistingTests = true,
} = {}) {
  const inventory = await loadShippedApiInventory({ repoRoot })
  const testFiles = [...new Set([
    ...CERTIFICATION_TEST_FILES,
    ...(includeExistingTests
      ? inventory.adapters.flatMap((adapter) => adapter.tools.flatMap((tool) => tool.testFiles))
      : []),
  ])].sort()
  const fileRuns = []
  const testResults = []

  for (const file of testFiles) {
    const run = spawnSync(process.execPath, ['--test', join('extension', 'test', file)], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
    })
    const output = `${run.stdout || ''}${run.stderr || ''}`
    const parsed = parseNodeTestOutput(output, file)
    testResults.push(...parsed)
    fileRuns.push({
      file,
      status: run.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : (run.status === 0 ? 'PASS' : 'FAIL'),
      testCount: parsed.length,
      passedTestCount: parsed.filter((result) => result.status === 'PASS').length,
      failedTestCount: parsed.filter((result) => result.status === 'FAIL').length,
    })
  }

  const adapters = inventory.adapters.map((adapter) => ({
    id: adapter.id,
    tools: adapter.tools.map((tool) => {
      const matchedTests = testResults.filter((result) => isRelevantTest(result, tool))
      const coverage = {
        success: summarizeToolCategory(matchedTests, 'success'),
        error: summarizeToolCategory(matchedTests, 'error'),
        safety: summarizeToolCategory(matchedTests, 'safety'),
      }
      const required = requiredCategories(tool)
      const requiredStatuses = required.map((category) => coverage[category])
      const mockStatus = requiredStatuses.includes('FAIL')
        ? 'FAIL'
        : (requiredStatuses.every((status) => status === 'PASS') ? 'PASS' : 'INCOMPLETE')
      return {
        name: tool.name,
        catalogId: tool.catalogId,
        safety: tool.safety,
        requiresConfirmation: tool.requiresConfirmation,
        requiredCategories: required,
        coverage,
        mockStatus,
        matchedTests,
      }
    }),
  }))
  const tools = adapters.flatMap((adapter) => adapter.tools)

  return {
    schemaVersion: 1,
    scope: inventory.scope,
    adapterCount: adapters.length,
    toolCount: tools.length,
    fileRunSummary: {
      total: fileRuns.length,
      passed: fileRuns.filter((run) => run.status === 'PASS').length,
      failed: fileRuns.filter((run) => run.status === 'FAIL').length,
      timedOut: fileRuns.filter((run) => run.status === 'TIMEOUT').length,
    },
    mockSummary: {
      passed: tools.filter((tool) => tool.mockStatus === 'PASS').length,
      failed: tools.filter((tool) => tool.mockStatus === 'FAIL').length,
      incomplete: tools.filter((tool) => tool.mockStatus === 'INCOMPLETE').length,
      successUntested: tools.filter((tool) => tool.coverage.success === 'UNTESTED').length,
      errorUntested: tools.filter((tool) => tool.coverage.error === 'UNTESTED').length,
      safetyUntested: tools.filter((tool) => tool.requiredCategories.includes('safety') && tool.coverage.safety === 'UNTESTED').length,
    },
    fileRuns,
    adapters,
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const evidence = await collectApiAdapterTestEvidence({
    includeExistingTests: !process.argv.includes('--certification-only'),
  })
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  if (evidence.mockSummary.failed > 0 || evidence.mockSummary.incomplete > 0) process.exitCode = 1
}
