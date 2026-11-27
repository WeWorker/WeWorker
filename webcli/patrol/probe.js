import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATROL_DIR = dirname(fileURLToPath(import.meta.url))
export const WEBCLI_DIR = resolve(PATROL_DIR, '..')
export const CLI_ENTRY = join(WEBCLI_DIR, 'index.js')

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 子进程环境：继承当前环境，但固定三处。
 * - WEBCLI_METRICS=off / WEBCLI_METRICS_UPLOAD=off：巡检不写本地 metrics、不上报
 *   batch metrics（否则每次探活都会污染 errdetail 统计，与修复管线同样的自激问题）
 * - 删除 WEBCLI_METRICS_ENDPOINT：避免 stats 类命令依赖外部端点
 */
export function buildPatrolEnv(base = process.env) {
  const env = { ...base, WEBCLI_METRICS: 'off', WEBCLI_METRICS_UPLOAD: 'off' }
  delete env.WEBCLI_METRICS_ENDPOINT
  return env
}

/** 固定并发度的任务池，结果按输入顺序返回。 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 从 stdout 里剥掉服务启动 banner，取首个 JSON 对象/数组。 */
export function parseToolOutput(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    if (start === -1) return null
    const candidate = trimmed.slice(start)
    try {
      return JSON.parse(candidate)
    } catch {
      return null
    }
  }
}

export function summarizeProbe(raw) {
  return { ...raw, parsed: parseToolOutput(raw.stdout) }
}

/** 执行一条命令，返回原始结果（不做判定）。 */
export function probeTool({ tool, args }, { env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const argv = [CLI_ENTRY, 'call', tool]
  if (args && Object.keys(args).length > 0) argv.push('--args', JSON.stringify(args))
  argv.push('-v')

  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(process.execPath, argv, { cwd: WEBCLI_DIR, env: env ?? buildPatrolEnv(), windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false, durationMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - started })
    })
  })
}
