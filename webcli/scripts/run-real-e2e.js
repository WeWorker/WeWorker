#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const WEBCLI_DIR = resolve(SCRIPT_DIR, '..')
const PUBLIC_MANIFEST = join(WEBCLI_DIR, 'e2e-cases', 'public-smoke.json')
const INTERNAL_MANIFEST = join(WEBCLI_DIR, 'e2e-cases', 'new-commands.json')
const LOGIN_PATTERNS = [
  /authentication required/i,
  /login required/i,
  /not logged in/i,
  /missing .*token/i,
  /登录态失效/,
  /未登录/,
  /请先登录/,
  /认证失败/,
]
const PERMISSION_PATTERNS = [
  /no permission/i,
  /permission denied/i,
  /无权限/,
  /权限不足/,
]

function parseArgs(argv) {
  const options = { profile: 'public', timeout: 60_000, suite: 'new' }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') options.profile = argv[++i]
    else if (argv[i] === '--manifest') options.manifest = resolve(argv[++i])
    else if (argv[i] === '--timeout') options.timeout = Number(argv[++i]) * 1000
    else if (argv[i] === '--only') options.only = new Set(argv[++i].split(',').filter(Boolean))
    else if (argv[i] === '--suite') options.suite = argv[++i]
    else if (argv[i] === '--help') options.help = true
  }
  options.manifest ??= options.profile === 'internal' ? INTERNAL_MANIFEST : PUBLIC_MANIFEST
  return options
}

async function loadHistoricalSafeCases(profile) {
  if (profile !== 'internal') return []
  const migrated = JSON.parse(await readFile(join(WEBCLI_DIR, 'wecli-migrated-commands.json'), 'utf8'))
  const catalog = JSON.parse(await readFile(join(WEBCLI_DIR, 'wecli-command-catalog.json'), 'utf8'))
  const catalogById = new Map(catalog.commands.map((command) => [command.id, command]))
  const currentByPublicName = new Map(Object.entries(migrated).map(([id, value]) => [value.publicName, { id, ...catalogById.get(id) }]))
  const resultFiles = [
    join(WEBCLI_DIR, 'e2e-results', 'mixed-migrated-20260625-093719.jsonl'),
    join(WEBCLI_DIR, 'e2e-results', 'verify-missing-20260625-130100.jsonl'),
  ]
  const latestByCommand = new Map()

  for (const resultFile of resultFiles) {
    let content = ''
    try {
      content = await readFile(resultFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const lines = content.split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      const record = JSON.parse(line)
      const current = currentByPublicName.get(record.command)
      if (!current || record.exitCode !== 0) continue
      const safeByCommand = current.safety === 'read' || current.safety === 'sensitive_read'
      const safeByRecordedMode = ['dry-run', 'safe-negative', 'mutating-noop'].includes(record.risk)
      if (!safeByCommand && !safeByRecordedMode) continue
      latestByCommand.set(record.command, {
        id: current.id,
        site: record.site,
        command: record.command,
        safety: current.safety,
        safetyMode: safeByCommand ? 'historical-read-replay' : `historical-${record.risk}`,
        args: record.args ?? {},
      })
    }
  }

  return [...latestByCommand.values()]
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(text))
}

async function runCase(testCase, timeout) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    const result = await execFileAsync(
      process.execPath,
      [join(WEBCLI_DIR, 'index.js'), 'call', testCase.command, '--args', JSON.stringify(testCase.args ?? {}), '-v'],
      { cwd: dirname(WEBCLI_DIR), timeout, maxBuffer: 20 * 1024 * 1024 },
    )
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    stdout = error.stdout ?? ''
    stderr = error.stderr ?? ''
    exitCode = typeof error.code === 'number' ? error.code : 1
  }

  const combined = `${stdout}\n${stderr}`
  let status = 'FAIL'
  if (exitCode === 0) status = 'PASS'
  else if (LOGIN_PATTERNS.some((pattern) => pattern.test(combined))) status = 'LOGIN_REQUIRED'
  else if (PERMISSION_PATTERNS.some((pattern) => pattern.test(combined))) status = 'PERMISSION_DENIED'
  else if (matchesAny(combined, testCase.expectedErrors)) status = 'EXPECTED_SAFE_ERROR'

  return {
    timestamp: startedAt,
    durationMs: Date.now() - started,
    id: testCase.id,
    site: testCase.site,
    command: testCase.command,
    safety: testCase.safety,
    safetyMode: testCase.safetyMode,
    args: testCase.args ?? {},
    status,
    exitCode,
    stdout,
    stderr,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: npm run test:e2e:real -- [--profile public|internal] [--suite new|historical-safe|all] [--manifest file] [--only id1,id2] [--timeout seconds]')
    return
  }

  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'))
  const historicalCases = options.suite === 'historical-safe' || options.suite === 'all' ? await loadHistoricalSafeCases(options.profile) : []
  const newCases = options.suite === 'new' || options.suite === 'all' ? manifest.cases : []
  const cases = [...historicalCases, ...newCases].filter((item) => !options.only || options.only.has(item.id))
  if (cases.length === 0) {
    console.log(JSON.stringify({ outputPath: null, counts: {}, loginSites: [] }, null, 2))
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const outputDir = join(WEBCLI_DIR, 'e2e-results')
  const outputPath = join(outputDir, `${options.suite}-${manifest.name}-${stamp}.jsonl`)
  await mkdir(outputDir, { recursive: true })

  const results = []
  const loginSites = new Set()
  for (const testCase of cases) {
    if (loginSites.has(testCase.site)) {
      const skipped = { timestamp: new Date().toISOString(), id: testCase.id, site: testCase.site, command: testCase.command, status: 'SKIPPED_LOGIN_SITE' }
      results.push(skipped)
      console.log(`[SKIPPED_LOGIN_SITE] ${testCase.id}`)
      continue
    }

    const result = await runCase(testCase, options.timeout)
    results.push(result)
    console.log(`[${result.status}] ${result.id} (${result.durationMs}ms)`)
    if (result.status === 'LOGIN_REQUIRED') loginSites.add(testCase.site)
  }

  await writeFile(outputPath, `${results.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  const counts = Object.fromEntries([...new Set(results.map((item) => item.status))].map((status) => [status, results.filter((item) => item.status === status).length]))
  console.log(JSON.stringify({ outputPath, counts, loginSites: [...loginSites] }, null, 2))
  if (results.some((item) => item.status === 'FAIL')) process.exitCode = 1
}

await main()
