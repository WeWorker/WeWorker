import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWebcliEntry } from './webcli-path.js'
import { getOpenBrowserAllowedOrigins } from './config.js'
import { offloadIfLarge } from './webcli-result-cache.js'

const execFileAsync = promisify(execFile)

/**
 * 将 args 对象序列化为 --key=value CLI 参数数组。
 * - 简单类型（string, number, boolean）直接 --key=value
 * - 复杂类型（数组、嵌套对象）用 JSON 字面量 --key='[...]' / --key='{...}'
 *   （CLI 端 inferType 检测到 {/[ 开头会 JSON.parse）
 * - 数组值如果是简单标量数组，也可走字面量；多元素对象数组同样适用
 */
export function buildCliArgFlags(args: Record<string, unknown>): string[] {
  const flags: string[] = []

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      flags.push(`--${key}=${value}`)
    } else {
      // 数组、嵌套对象等复杂类型用 JSON 字面量
      flags.push(`--${key}=${JSON.stringify(value)}`)
    }
  }

  return flags
}

/**
 * 组装 webcli call 子进程参数。
 * WeWorker 内部一律强制 --output-format=json（大结果缓存/快捷查询/专属 renderer 都 JSON.parse），
 * Markdown 只发生在最终展示层。
 */
export function buildCliCallArgs(toolName: string, argsJson?: string): string[] {
  const cliArgs = ['call', toolName, '--output-format=json']

  if (argsJson !== undefined && argsJson !== '') {
    // 将 args 对象展开为 --key=value（简单类型）或 --key=<JSON字面量>（复杂类型）
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const flags = buildCliArgFlags(args)
        if (flags.length > 0) cliArgs.push(...flags)
      } else {
        // args 不是普通对象（如数组或裸值），走 --args 路径
        cliArgs.push('--args', argsJson)
      }
    } catch {
      // JSON 解析失败（可能是 key=value 字符串），原样传 --args
      cliArgs.push('--args', argsJson)
    }
  }

  return cliArgs
}

/** `webcli call` 的调用选项。目前只有超时：不传 = 不设预算（与历史行为逐字一致）。 */
export type WebcliCallOptions = {
  /** 子进程时限（毫秒）；超时即 SIGTERM 并抛 `WebcliTimeoutError` */
  timeoutMs?: number
}

/** 超时专用错误：调用方（智能路由）据此判成「超时 → 落回 LLM」而不是当成工具结果。 */
export class WebcliTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`webcli call timed out after ${timeoutMs}ms: ${toolName}`)
    this.name = 'WebcliTimeoutError'
  }
}

export async function runWebcliCall(
  toolName: string,
  argsJson?: string,
  workId?: string | null,
  options: WebcliCallOptions = {},
): Promise<string> {
  const isPackaged = !!process.env.WEWORKER_PACKAGED
  const nodeBin = isPackaged
    ? (process.env.WEWORKER_EXEC_PATH || process.execPath)
    : 'node'
  const webcliEntry = resolveWebcliEntry()
  const cliArgs = buildCliCallArgs(toolName, argsJson)
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : undefined

  const env = {
    ...process.env,
    ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: getOpenBrowserAllowedOrigins().join(','),
  }
  let output: string
  try {
    const { stdout, stderr } = await execFileAsync(nodeBin, [webcliEntry, ...cliArgs], {
      env,
      maxBuffer: 10 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGTERM' as const } : {}),
    })
    output = (stdout || stderr || '').trim()
  } catch (e: any) {
    // 超时被 SIGTERM 杀掉：半截 stdout 不可信，直接抛超时，别把残缺输出当结果缓存/渲染。
    if (timeoutMs && (e?.killed === true || e?.signal === 'SIGTERM')) throw new WebcliTimeoutError(toolName, timeoutMs)
    output = (e.stdout || e.stderr || '').trim()
    if (!output) throw e
  }
  // 大结果落盘，避免整份超大文本内联给大模型触发超限截断/重试。
  const pointer = offloadIfLarge(toolName, output, workId)
  return pointer ?? output
}
