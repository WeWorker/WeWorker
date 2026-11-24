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

/** stderr 上 `WEBCLI_CONTEXT` 回执的可信子集字段；未知字段原样保留，不做语义承诺。 */
export interface WebcliContextReceipt {
  contextProtocolVersion?: unknown
  contextId: string
  contextState?: string
  historyAvailable?: boolean
  epoch?: string
  revision?: number
  roundId?: string | null
  decisionId?: string | null
  stepId?: string | null
  snapshotId?: string | null
  operationId?: string | null
  displayManifest?: {
    orderedEntityRefs?: string[]
    completeness?: string
    capturedCount?: number
    resultCount?: number
    markdown?: string
  } | null
  displayState?: string
  toolOutcome?: string
  contextPersistence?: string
  retryDisposition?: string
  reasonCode?: string
  [key: string]: unknown
}

/** 桌面多轮关联控制：要么 --new-context，要么 --context [＋decision/step 关联]。 */
export interface WebcliCallContextControl {
  newContext?: boolean
  contextId?: string
  decisionId?: string
  stepId?: string
}

export type WebcliCallExOptions = WebcliCallOptions & {
  context?: WebcliCallContextControl
  onReceipt?: (receipt: WebcliContextReceipt) => void
  signal?: AbortSignal
}

function contextControlFlags(context: WebcliCallContextControl | undefined): string[] {
  if (!context) return []
  if (context.newContext) return ['--new-context']
  if (!context.contextId) return []
  const flags = ['--context', context.contextId]
  if (context.decisionId && context.stepId) flags.push('--context-decision', context.decisionId, '--context-step', context.stepId)
  return flags
}

/** 只认最后一行 `WEBCLI_CONTEXT ` 回执；解析失败视为无回执，绝不把 stderr 当业务结果。 */
export function parseWebcliContextReceipt(stderr: string): WebcliContextReceipt | null {
  const line = stderr.split(/\r?\n/).reverse().find(candidate => candidate.startsWith('WEBCLI_CONTEXT '))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice('WEBCLI_CONTEXT '.length)) as WebcliContextReceipt
    return parsed && typeof parsed === 'object' && typeof parsed.contextId === 'string' ? parsed : null
  } catch {
    return null
  }
}

async function spawnWebcli(cliArgs: string[], timeoutMs?: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const isPackaged = !!process.env.WEWORKER_PACKAGED
  const nodeBin = isPackaged ? (process.env.WEWORKER_EXEC_PATH || process.execPath) : 'node'
  const { stdout, stderr } = await execFileAsync(nodeBin, [resolveWebcliEntry(), ...cliArgs], {
    env: {
      ...process.env,
      ...(isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      WEWORKER_ALLOWED_OPEN_BROWSER_ORIGINS: getOpenBrowserAllowedOrigins().join(','),
      WEBCLI_EMBEDDED: '1', // 桌面端内嵌 webcli:关闭版本自检与 npm 升级(随应用更新)
      WEBCLI_CLI_NAME: 'webgo', // 桌面端内嵌统一品牌:运行时输出/help 显示 webgo(WebGo)
    },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGTERM' as const } : {}),
    ...(signal ? { signal } : {}),
  })
  return { stdout, stderr }
}

function throwIfTimeout(toolName: string, timeoutMs: number | undefined, error: unknown): void {
  const e = error as { killed?: boolean; signal?: string }
  if (timeoutMs && (e?.killed === true || e?.signal === 'SIGTERM')) throw new WebcliTimeoutError(toolName, timeoutMs)
}

/**
 * 带多轮关联的 `webcli call`：业务 stdout 与 `WEBCLI_CONTEXT` 回执分流。
 * 业务输出合同与 `runWebcliCall` 一致（含大结果落盘指针）；回执只经 `onReceipt` 旁路交付，
 * 绝不混入业务结果。没有 context 控制时标志位为空，行为等价 runWebcliCall（除回执旁路）。
 */
export async function runWebcliCallEx(
  toolName: string,
  argsJson: string | undefined,
  workId: string | null | undefined,
  options: WebcliCallExOptions = {},
): Promise<string> {
  const cliArgs = ['call', toolName, '--output-format=json', ...contextControlFlags(options.context)]
  if (argsJson !== undefined && argsJson !== '') cliArgs.push('--args', argsJson)
  let result: { stdout: string; stderr: string }
  try {
    result = await spawnWebcli(cliArgs, options.timeoutMs, options.signal)
  } catch (error) {
    throwIfTimeout(toolName, options.timeoutMs, error)
    // 业务失败（exitCode 1 等）仍会带完整 stdout/stderr；缓冲溢出与信号终止才是真不可信。
    const e = error as { code?: string; stdout?: unknown; stderr?: unknown; signal?: unknown }
    if (options.signal?.aborted || e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e?.signal) throw error
    result = {
      stdout: typeof e?.stdout === 'string' ? e.stdout : '',
      stderr: typeof e?.stderr === 'string' ? e.stderr : '',
    }
    if (!result.stdout && !result.stderr) throw error
  }
  const receipt = parseWebcliContextReceipt(result.stderr)
  if (receipt) options.onReceipt?.(receipt)
  const output = (result.stdout || '').trim()
  if (!output) {
    throw new Error(`webcli call produced no output: ${toolName}`)
  }
  return offloadIfLarge(toolName, output, workId) ?? output
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
  const cliArgs = buildCliCallArgs(toolName, argsJson)
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : undefined

  let output: string
  try {
    const { stdout, stderr } = await spawnWebcli(cliArgs, timeoutMs)
    output = (stdout || stderr || '').trim()
  } catch (e: any) {
    // 超时被 SIGTERM 杀掉：半截 stdout 不可信，直接抛超时，别把残缺输出当结果缓存/渲染。
    if (timeoutMs && (e?.killed === true || e?.signal === 'SIGTERM')) throw new WebcliTimeoutError(toolName, timeoutMs)
    // 缓冲溢出、或子进程被信号杀掉时，stdout 只可能是残片。残片仍是「像结果」的文本，
    // 大结果还会被落盘缓存，最后渲染成半截 JSON —— 宁可让这次调用失败落回模型。
    if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e?.signal) throw e
    output = (e.stdout || e.stderr || '').trim()
    if (!output) throw e
  }
  // 大结果落盘，避免整份超大文本内联给大模型触发超限截断/重试。
  const pointer = offloadIfLarge(toolName, output, workId)
  return pointer ?? output
}
