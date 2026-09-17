import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShippedApiInventory } from '../api-adapter-certification.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const webcliDir = resolve(scriptDir, '..')
const repoRoot = resolve(webcliDir, '..')
const defaultOutput = join(repoRoot, 'artifacts', 'api-adapter-certification', 'live-read-results.json')
const READ_CLASSES = new Set(['read', 'sensitive_read'])
const MUTATION_CLASSES = new Set(['mutating', 'high_risk'])
const VALID_SCOPES = new Set(['reads', 'guards', 'dry-runs'])
const SENTINEL = '__webcli_cert_probe_no_match__'

function option(name, fallback = null) {
  const exact = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return exact ? exact.slice(name.length + 3) : fallback
}

function sampleValue(name, schema = {}, scope = 'reads') {
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return sampleValue(name, schema.oneOf[0], scope)
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return sampleValue(name, schema.anyOf[0], scope)
  if (schema.type === 'integer' || schema.type === 'number') return scope === 'reads' ? 0 : Math.max(1, schema.minimum || 1)
  if (schema.type === 'boolean') return false
  if (schema.type === 'array') return scope === 'reads' ? [] : [sampleValue(name, schema.items || { type: 'string' }, scope)]
  if (schema.type === 'object') return {}
  if (schema.format === 'date') return '2026-09-14'
  if (schema.format === 'date-time') return '2026-09-14T00:00:00Z'
  if (/url/i.test(name)) return 'https://example.invalid/__webcli_certification_probe__'
  if (/ip/i.test(name)) return '192.0.2.1'
  if (/date|time/i.test(name)) return '2026-09-14'
  if (/(^|[-_])(id|guid|execid|reqid)$/i.test(name)) return '0'
  return SENTINEL
}

function safeArgs(tool, scope = 'reads') {
  const properties = tool.parameters?.properties || {}
  const args = Object.fromEntries((tool.parameters?.required || []).map((name) => [
    name,
    sampleValue(name, properties[name] || {}, scope),
  ]))
  if (scope === 'reads') {
    for (const name of ['limit', 'pageSize', 'page-size', 'rows', 'length']) {
      if (Object.hasOwn(properties, name) && !Object.hasOwn(args, name)) args[name] = 1
    }
    if (Object.hasOwn(properties, 'page') && !Object.hasOwn(args, 'page')) args.page = 1
  }
  const result = { ...args }
  delete result.__confirmed
  delete result.yes
  if (scope === 'dry-runs') result['dry-run'] = true
  else delete result['dry-run']
  return result
}

function classify(raw, exitCode, timedOut) {
  if (timedOut) return 'TIMEOUT'
  if (exitCode === 0) return 'PASS'
  if (/not found in direct adapter|Tool .* not found|无法从工具名.*提取域名/i.test(raw)) return 'ROUTE_ERROR'
  if (/malformed|invalid json|unexpected token|非 JSON|JSON.*失败/i.test(raw)) return 'RESPONSE_ERROR'
  if (/(?:LOGIN_REQUIRED|AUTH_REQUIRED|UNAUTHORIZED|HTTP 401|未登录|登录态|会话过期|签名无效|重新登录|请登录|请先.*登录|确认已登录|authentication (?:is )?required|credentials were not provided|missing .*cookie)/i.test(raw)) return 'AUTH'
  if (/(?:FORBIDDEN|HTTP 403|无权限|权限不足|没有权限|无对应.*权限|not your productForm)/i.test(raw)) return 'PERMISSION'
  if (/(?:CONFIRMATION_REQUIRED|requires explicit user confirmation|provide confirmation|Use dry-run.*confirmation|需要.*确认)/i.test(raw)) return 'CONFIRMATION_GUARD'
  if (/(?:INVALID_ARGS|MISSING_ARG|Missing required argument|Unknown argument|Invalid value for argument|URL must be|Cannot derive|无法识别链接格式|参数.*(?:错误|必须|缺少))/i.test(raw)) return 'INVALID_ARGS'
  if (/(?:timed out|timeout|超时)/i.test(raw)) return 'TIMEOUT'
  if (/(?:NOT_FOUND|未找到|不存在|不属于|没有匹配|结果为空|没有部署节点|没有构建任务|获取安全工单详情失败)/i.test(raw)) return 'FIXTURE_NOT_FOUND'
  if (/(?:PAGE_CONTEXT_REQUIRED|NO_MATCHING_TAB|requires a page context|Frame with ID .* error page|需要.*页面|页面上下文)/i.test(raw)) return 'PAGE_CONTEXT'
  if (/(?:系统错误|service unavailable|服务异常)/i.test(raw)) return 'SERVICE_ERROR'
  if (/(?:HTTP_ERROR|HTTP [45]\d\d|fetch failed|ECONN|ENOTFOUND|网络)/i.test(raw)) return 'HTTP_ERROR'
  return exitCode === 0 ? 'PASS' : 'ERROR'
}

function resultShape(raw) {
  try {
    const parsed = JSON.parse(raw)
    const result = Object.hasOwn(parsed, 'result') ? parsed.result : parsed
    return {
      json: true,
      topLevelType: Array.isArray(parsed) ? 'array' : typeof parsed,
      resultType: Array.isArray(result) ? 'array' : result === null ? 'null' : typeof result,
      ...(Array.isArray(result) ? { resultCount: result.length } : {}),
      topLevelKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed).filter((key) => !['trace_id', 'error', 'hint'].includes(key)).sort()
        : [],
    }
  } catch {
    return { json: false, topLevelType: 'text', resultType: 'unknown', topLevelKeys: [] }
  }
}

function sanitizedErrorSignature(raw) {
  let message = raw
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.error === 'string') message = parsed.error
  } catch {
    // The CLI may have emitted plain stderr; sanitize it below without storing raw text.
  }
  return String(message || '')
    .replace(/https?:\/\/[^\s"']+/gi, '[URL]')
    .replace(/[A-Za-z]:\\[^\r\n"']+/g, '[PATH]')
    .replace(/\b(?:cookie|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/["'][^"'\r\n]{1,160}["']/g, '[VALUE]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[ID]')
    .replace(/\b[0-9a-f]{12,}\b/gi, '[ID]')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function runTool(tool, timeoutMs, scope = 'reads') {
  return new Promise((resolveRun) => {
    const started = Date.now()
    const args = safeArgs(tool, scope)
    const child = spawn(process.execPath, [
      'index.js',
      'call',
      tool.name,
      '--args',
      JSON.stringify(args),
      '--output-format=json',
    ], {
      cwd: webcliDir,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let raw = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { raw += chunk })
    child.stderr.on('data', (chunk) => { raw += chunk })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      const status = classify(raw, code ?? 1, timedOut)
      const expectationMet = scope === 'guards'
        ? status === 'CONFIRMATION_GUARD'
        : scope === 'dry-runs'
          ? !['CONFIRMATION_GUARD', 'ROUTE_ERROR', 'INVALID_ARGS', 'ERROR'].includes(status)
          : !['ROUTE_ERROR', 'INVALID_ARGS'].includes(status)
      resolveRun({
        tool: tool.name,
        adapterId: tool.adapterId,
        safety: tool.safety,
        status,
        exitCode: timedOut ? null : (code ?? 1),
        latencyMs: Date.now() - started,
        fixture: (tool.parameters?.required || []).length > 0 ? 'synthetic-required' : 'default-list',
        scope,
        expectationMet,
        argumentNames: Object.keys(args).sort(),
        ...resultShape(raw),
        ...(status === 'PASS' ? {} : { errorSignature: sanitizedErrorSignature(raw) }),
      })
    })
  })
}

async function main() {
  const scope = option('scope', 'reads')
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`Invalid --scope=${scope}; expected reads, guards, or dry-runs`)
  }
  const scopeOutput = defaultOutput.replace('live-read-results.json', `live-${scope === 'reads' ? 'read' : scope}-results.json`)
  const output = resolve(option('output', scopeOutput))
  await mkdir(dirname(output), { recursive: true })
  const timeoutMs = Math.max(1000, Number(option('timeout-ms', '35000')) || 35000)
  const repeat = Math.max(1, Number(option('repeat', '1')) || 1)
  const onlyTools = new Set((option('tools', '') || '').split(',').map((item) => item.trim()).filter(Boolean))
  const inventory = await loadShippedApiInventory({ repoRoot })
  const tools = inventory.adapters.flatMap((adapter) => adapter.tools.map((tool) => ({ ...tool, adapterId: adapter.id })))
    .filter((tool) => scope === 'reads' ? READ_CLASSES.has(tool.safety) : MUTATION_CLASSES.has(tool.safety))
    .filter((tool) => scope !== 'dry-runs' || Object.hasOwn(tool.parameters?.properties || {}, 'dry-run'))
    .filter((tool) => onlyTools.size === 0 || onlyTools.has(tool.name))
  const unsafe = scope === 'reads' ? tools.filter((tool) => tool.requiresConfirmation) : []
  if (unsafe.length > 0) {
    throw new Error(`Refusing live read run: confirmation-gated tools classified as read: ${unsafe.map((tool) => tool.name).join(', ')}`)
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: `live-extension-api-${scope}-sanitized`,
    callPath: 'webcli call -> Bridge -> Chrome Extension -> Adapter',
    timeoutMs,
    repeat,
    selectedToolCount: tools.length,
    executionCount: tools.length * repeat,
    safetyNotice: scope === 'dry-runs'
      ? 'Only the declared dry-run flag is supplied. No confirmation flag is supplied; raw responses, error messages, credentials, cookies, tokens, paths, and argument values are not persisted.'
      : 'No confirmation or dry-run flag is supplied; raw responses, error messages, credentials, cookies, tokens, paths, and argument values are not persisted.',
    results: [],
    summary: {},
  }
  let executionIndex = 0
  for (const tool of tools) {
    for (let run = 1; run <= repeat; run++) {
      executionIndex += 1
      const result = { ...(await runTool(tool, timeoutMs, scope)), run }
      report.results.push(result)
      report.summary[result.status] = (report.summary[result.status] || 0) + 1
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      process.stdout.write(`[${executionIndex}/${tools.length * repeat}] ${result.tool} run=${run} ${result.status} ${result.latencyMs}ms\n`)
    }
  }
  report.byTool = Object.fromEntries(tools.map((tool) => {
    const results = report.results.filter((result) => result.tool === tool.name)
    const statuses = [...new Set(results.map((result) => result.status))]
    const latencies = results.map((result) => result.latencyMs)
    return [tool.name, {
      statuses,
      expectationMet: results.every((result) => result.expectationMet),
      intermittent: statuses.length > 1,
      latencyMs: {
        min: Math.min(...latencies),
        max: Math.max(...latencies),
        average: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      },
    }]
  }))
  report.expectationFailures = report.results.filter((result) => !result.expectationMet).map((result) => ({
    tool: result.tool,
    run: result.run,
    status: result.status,
  }))
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ output, scope, selectedToolCount: tools.length, executionCount: tools.length * repeat, summary: report.summary, expectationFailureCount: report.expectationFailures.length })}\n`)
  if (report.expectationFailures.length > 0) process.exitCode = 1
}

export { classify, safeArgs }

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
