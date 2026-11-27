import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATROL_DIR = dirname(fileURLToPath(import.meta.url))
export const WEBCLI_DIR = resolve(PATROL_DIR, '..')
export const CLI_ENTRY = join(WEBCLI_DIR, 'index.js')

export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TIMEOUT_MS = 20_000

/** probeTool 返回的 stderrTail 上限(环形丢弃旧行,只留尾部)。 */
export const STDERR_TAIL_MAX = 800

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
export function probeTool({ tool, args }, { env, timeoutMs = DEFAULT_TIMEOUT_MS, cliEntry = CLI_ENTRY } = {}) {
  const argv = [cliEntry, 'call', tool]
  if (args && Object.keys(args).length > 0) argv.push('--args', JSON.stringify(args))
  argv.push('-v')

  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(process.execPath, argv, { cwd: WEBCLI_DIR, env: env ?? buildPatrolEnv(), windowsHide: true })
    // 按 utf8 解码后再拼接：中文内容（如京东搜索结果）在管道块边界被截断时，
    // Buffer 直拼会产生 U+FFFD 乱码 → JSON.parse 失败误判；setEncoding 让
    // Node 的 StringDecoder 持有不完整字节序列直到下一块，拼接无损。
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // stderr 尾部留存:巡检行只存 reason="error" 时,traceback 的真实原因(最后
    // 一行异常消息)全部丢失,报告不可诊断。环形丢弃旧行只留尾部 ~800 字节,
    // 与 toolkit-runner.js 的 stderrTail 同款(chunk 按 utf8 字节数记账)。
    const stderrChunks = []
    let stderrBytes = 0
    const stderrTail = () => stderrChunks.join('').trim().slice(-STDERR_TAIL_MAX)

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      stderrChunks.push(chunk)
      stderrBytes += Buffer.byteLength(chunk)
      while (stderrBytes > STDERR_TAIL_MAX && stderrChunks.length > 1) {
        stderrBytes -= Buffer.byteLength(stderrChunks[0])
        stderrChunks.shift()
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      stderr += error.message
      stderrChunks.push(error.message)
      resolvePromise({ exitCode: null, stdout, stderr, stderrTail: stderrTail(), timedOut: false, durationMs: Date.now() - started })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, stderrTail: stderrTail(), timedOut, durationMs: Date.now() - started })
    })
  })
}
