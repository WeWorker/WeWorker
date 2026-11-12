/**
 * 路由派发的**结果判定**：把「接口报错 / 超时 / 没有内容 / 无法渲染」统一识别成「落回 LLM」，
 * 而不是把一句 `⚠️ 查询失败：…` 当成答案交给用户。
 *
 * 为什么要有这个模块：快速路（`llmMs = 0`）是**无模型兜底**的通道——一旦它把错误文案渲染成
 * 正文，这条回合就结束了，模型没有机会补答，用户也不知道自己看到的不是答案。所以在
 * dispatch 回来的那一刻就必须判出「这不是答案」，让调用方照常走 `streamChat`。
 *
 * 判定口径（与 `generic-renderer` 的渲染分支逐条对齐，避免「渲染当失败、判定当成功」）：
 * 1. **没有内容**：`raw` 为空/全空白（CLI 什么都没吐）→ 没答出来；
 * 2. **错误信封**：`raw` 解析出对象且 `error` 为真值（webcli `--output-format=json` 的错误形状，
 *    见 `webcli/output-format.js` 的 `isErrorEnvelope`），或 `ok: false` / `success: false`；
 * 3. **进程级报错**：非 JSON 输出以 `Error:` 开头 / 含栈帧 / 含网络错误码——这类文本是 CLI 崩溃，
 *    不是工具结果（正常结果一律 JSON，见 `buildCliCallArgs` 强制 `--output-format=json`）。
 *
 * **空数组不算失败**：查询结果为空是「查完了，就是没有」这一事实，必须由渲染层给用户一句
 * 场景化话术（`emptyMessage` / `DEFAULT_EMPTY_ANSWER`），而不是丢掉结果让模型重查一遍。
 * 鉴权失败与接口报错仍是失败——即使它们顺手带了个空数组，也按失败处理（见下面的顺序）。
 *
 * 另外两个失败来源由本模块兜住：
 * - **超时**：dispatch 超过预算（`WEWORKER_API_QUERY_ROUTE_TIMEOUT_MS`，默认 20s）即判超时。
 *   webcli 自己虽有 120s 工具超时，但那意味着用户要干等两分钟才拿到「工具调用超时」；
 *   快速路等不起，超预算就落回模型（模型会自己再调一次工具并看到真实错误）。
 * - **抛错**：dispatch 直接 reject。
 *
 * 一切失败都**不抛给调用方**：`createGuardedDispatch` 抛 `RouteDispatchError`，由路由执行层
 * 捕获并 `return false`（= 落回 LLM）。这是红线「不确定即落回」在执行期的落点。
 */

// 空数组的判定已下移到渲染层（见文件头），本模块不再需要结果形状探测。


/** 路由派发失败的四类来源（日志与测试断言用，不含用户数据）。 */
export type RouteDispatchFailure = 'timeout' | 'thrown' | 'authentication' | 'error_payload' | 'process_error' | 'empty'

export type DispatchOutcome =
  | { ok: true; raw: string; ms: number }
  | { ok: false; kind: RouteDispatchFailure; detail: string; ms: number }

/** 超时预算：env `WEWORKER_API_QUERY_ROUTE_TIMEOUT_MS`；非法/缺省回 20s，0 或负数 = 不设预算。 */
export const ROUTE_DISPATCH_TIMEOUT_ENV = 'WEWORKER_API_QUERY_ROUTE_TIMEOUT_MS'
export const DEFAULT_ROUTE_DISPATCH_TIMEOUT_MS = 20_000

export function resolveDispatchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ROUTE_DISPATCH_TIMEOUT_ENV]
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_ROUTE_DISPATCH_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_ROUTE_DISPATCH_TIMEOUT_MS
  return Math.max(0, Math.floor(value))
}

/** webcli 自己的超时信封（`{ error: "工具调用超时" }`）与常见超时措辞。 */
const TIMEOUT_MESSAGE_RE = /超时|时间到|timed?\s*out|ETIMEDOUT/i
/** 只匹配作为工具结果返回的登录失败文案，不扫描成功结果里的任意字段。 */
const AUTH_MESSAGE_RE = /未登录|请(?:先|重新)?登录|登录态(?:无效|已失效|过期)|authentication credentials were not provided|unauthorized|login required|not logged in/i

/** CLI 崩溃的典型文本（正常结果一律是 JSON，见 `webcli-runner.buildCliCallArgs`）。 */
const PROCESS_ERROR_RES = [
  /^\s*Error:\s/m,
  /^\s+at\s+.+\(.+:\d+:\d+\)\s*$/m,
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_CHILD_PROCESS_STDIO_MAXBUFFER)\b/,
  /UnhandledPromiseRejection|Unhandled 'error' event/,
]

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 空数组却自称还有数据（`count`/`total` > 0）→ 自相矛盾，不能拿去回答「没有数据」。
 * 只看顶层与一层 `data`/`result` 包装，够覆盖 WebCLI 的两种信封，不做深度猜测。
 */
function contradictoryEmptyList(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const visit = (record: Record<string, unknown>): boolean => {
    const arrays = Object.values(record).filter(Array.isArray) as unknown[][]
    if (!arrays.length || arrays.some((array) => array.length > 0)) return false
    const counts = [record.count, record.total]
    return counts.some((value) => (typeof value === 'number' && value > 0)
      || (typeof value === 'string' && Number(value) > 0))
  }
  const root = parsed as Record<string, unknown>
  if (visit(root)) return true
  return ['data', 'result'].some((key) => {
    const nested = root[key]
    return !!nested && typeof nested === 'object' && !Array.isArray(nested)
      && visit(nested as Record<string, unknown>)
  })
}

/**
 * 判一条 dispatch 原始输出是不是「可渲染的答案」。
 * 返回 `null` = 可渲染；否则给失败类别与可读原因。
 */
export function classifyDispatchPayload(raw: string): { kind: RouteDispatchFailure; detail: string } | null {
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  if (!text.trim()) return { kind: 'empty', detail: 'empty payload' }

  const parsed = tryParseJson(text)
  if (parsed !== undefined && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    // WebCLI 可用 { result, trace_id } 包装非对象结果；包装内的错误不能被当作答案。
    if (Object.keys(record).every((key) => key === 'result' || key === 'trace_id') && 'result' in record) {
      return classifyDispatchPayload(typeof record.result === 'string' ? record.result : JSON.stringify(record.result))
    }
    // CLI 错误信封，以及部分 API 在 HTTP 200 下返回的业务错误码，都不是查询结果。
    // 特别是鉴权失败可能只有 code/msg/data，没有 error 或 ok:false。
    const failureValue = record.error
    const failedFlag = record.ok === false || record.success === false
    const apiCode = record.code
    const status = record.status
    const authStatus = record.ok !== true && record.success !== true
      && (status === 401 || status === 403 || status === '401' || status === '403')
    const authMessage = record.msg ?? record.message
    const missingLogin = record.ok !== true && record.success !== true && (record.level === 'error' || record.data == null)
      && typeof authMessage === 'string' && AUTH_MESSAGE_RE.test(authMessage)
    // Only a structured failure may classify an authentication error. A successful
    // business payload can legitimately contain words such as "login required".
    const authCode = record.ok !== true && record.success !== true
      && /^(?:4001|401|403|UNAUTHORIZED|AUTH_ERROR|AUTH_REQUIRED|NOT_LOGGED_IN)$/i.test(String(apiCode ?? ''))
    const authDetail = typeof failureValue === 'string' ? failureValue : authMessage
    const authFailure = authCode || authStatus || (record.ok !== true && record.success !== true && (missingLogin
      || ((failedFlag || !!failureValue) && typeof authDetail === 'string' && AUTH_MESSAGE_RE.test(authDetail))))
    if (failureValue || failedFlag || authStatus || missingLogin || authCode) {
      const message =
        typeof failureValue === 'string'
          ? failureValue
          : failureValue
            ? JSON.stringify(failureValue)
            : String(record.msg ?? record.message ?? apiCode ?? 'failed')
      const kind: RouteDispatchFailure = authFailure ? 'authentication'
        : TIMEOUT_MESSAGE_RE.test(message) ? 'timeout' : 'error_payload'
      return { kind, detail: message.slice(0, 200) }
    }
  }

  // 空数组**不是**派发失败：它是「查完了，确实没有」这一事实，交给渲染层说一句友好话术
  // （见 declarative-renderer 的 DEFAULT_EMPTY_ANSWER）。只有「连内容都没有」（空文本、
  // 错误信封、鉴权、超时、进程报错）才算没答出来、才落回 LLM。
  //
  // 唯一的例外是**自相矛盾**的空结果：自称 count/total > 0 却给了空数组。这种 payload
  // 说不清「到底有没有」，既不能答「没有数据」（可能是分页/筛选把数据切没了），也不能
  // 拿空表当真，一律按没答出来落回模型。
  if (contradictoryEmptyList(parsed)) {
    return { kind: 'empty', detail: 'empty array contradicts a positive count' }
  }

  if (typeof parsed === 'string' && AUTH_MESSAGE_RE.test(parsed)) {
    return { kind: 'error_payload', detail: parsed.slice(0, 200) }
  }
  if (parsed === undefined && AUTH_MESSAGE_RE.test(text) && text.trim().length < 500) {
    return { kind: 'error_payload', detail: text.trim().slice(0, 200) }
  }
  if (PROCESS_ERROR_RES.some((re) => re.test(text))) {
    return { kind: 'process_error', detail: text.trim().slice(0, 200) }
  }
  return null
}

/**
 * 渲染结果是否「什么都没答出来」：去掉标题行、表格分隔行、空白后为空即视为不可渲染。
 *
 * 注意这里**不再按文案白名单**判定「空结果」：空数组会渲染成一句场景化话术
 * （「经查询，没有…」），那是**有效回答**，不能因为它是"没有数据"就丢掉重查。
 * 仍然拦的只有两类：正文为空，以及渲染器自己产出的失败/落盘指针文案。
 */
export function isUnrenderableAnswer(text: string): boolean {
  const body = String(text ?? '')
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/^\s*\|[\s|:-]*\|\s*$/gm, '')
    .trim()
  // The generic renderer can return a human-readable failure or a spill pointer rather
  // than actual data. Neither is a complete answer on a zero-LLM fast path.
  return body.length === 0 || /^⚠️\s*(?:查询失败|查询返回为空|结果过大已落盘)/.test(body)
}

/** 派发失败：路由执行层据此落回 LLM（消息自带类别，日志不用二次解析）。 */
export class RouteDispatchError extends Error {
  constructor(
    public readonly kind: RouteDispatchFailure,
    public readonly tool: string,
    detail: string,
  ) {
    super(`route dispatch ${kind}: ${tool}${detail ? ` — ${detail}` : ''}`)
    this.name = 'RouteDispatchError'
  }
}

export type RouteDispatchFn = (tool: string, argsJson: string, workId: string) => Promise<string>

/** 包过判定层的派发：参数可省（默认 `{}` / 初始化时的 workId），便于单测直接调。 */
export type GuardedDispatchFn = (tool: string, argsJson?: string, workId?: string) => Promise<string>

export type GuardedDispatchOptions = {
  /** 真实派发（缺省由调用方传入 `runWebcliCall` 的包装） */
  dispatch: RouteDispatchFn
  /** 缺省 workId；调用方逐次传入时以传入值为准（`page-prep` / 计划引擎都按自己的口径给） */
  workId: string
  /** 0 / 缺省 = 不设预算 */
  timeoutMs?: number
  log?: (msg: string) => void
  now?: () => number
}

type RaceResult<T> = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' }

/** 给一个可能永不 settle 的 Promise 加预算。超时后任务本身仍被 attach 处理，不会变成未捕获拒绝。 */
function raceWithTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<RaceResult<T>> {
  if (!(timeoutMs > 0)) {
    return task.then(
      (value) => ({ kind: 'value' as const, value }),
      (error) => ({ kind: 'error' as const, error }),
    )
  }
  return new Promise<RaceResult<T>>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    // `unref` 让超时计时器不独自撑住进程（测试/CLI 场景退出更干净）。
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref()
    task.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: 'value', value })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: 'error', error })
      },
    )
  })
}

/**
 * 包一层「预算 + 结果判定」的派发：成功返回原始输出，任何失败都抛 `RouteDispatchError`。
 *
 * 为什么不返回判别式结果：级联的每一层已经有「失败 → 落回/继续」的语义
 * （`cascade.ts` 的 `onFailure`），抛一个自带类别的错误比让每层各自 if 更不容易漏分支。
 * 多跳计划（`anchor-plan.guardedDispatch`）也正是把 dispatch 的抛错收敛成 `PlanFallback`。
 */
export function createGuardedDispatch(options: GuardedDispatchOptions): GuardedDispatchFn {
  const now = options.now ?? Date.now

  return async (tool: string, argsJson = '{}', workId = options.workId): Promise<string> => {
    const started = now()
    const raced = await raceWithTimeout(options.dispatch(tool, argsJson, workId), options.timeoutMs ?? 0)
    const ms = Math.max(0, now() - started)

    if (raced.kind === 'timeout') {
      const detail = `exceeded ${options.timeoutMs}ms budget`
      options.log?.(`route dispatch timeout: ${tool} (${detail})`)
      throw new RouteDispatchError('timeout', tool, detail)
    }
    if (raced.kind === 'error') {
      const detail = raced.error instanceof Error ? raced.error.message : String(raced.error)
      options.log?.(`route dispatch failed: ${tool}: ${detail}`)
      throw new RouteDispatchError('thrown', tool, detail)
    }

    const failure = classifyDispatchPayload(raced.value)
    if (failure) {
      options.log?.(`route dispatch unusable (${failure.kind}): ${tool} — ${failure.detail}`)
      throw new RouteDispatchError(failure.kind, tool, failure.detail)
    }
    return raced.value
  }
}

/** 供测试与诊断：一次派发的完整结果（不抛错版本）。 */
export async function dispatchOnce(options: GuardedDispatchOptions & { tool: string; argsJson?: string }): Promise<DispatchOutcome> {
  const started = (options.now ?? Date.now)()
  let raw: string
  try {
    raw = await createGuardedDispatch(options)(options.tool, options.argsJson ?? '{}')
  } catch (error) {
    const kind = error instanceof RouteDispatchError ? error.kind : 'thrown'
    return {
      ok: false,
      kind,
      detail: error instanceof Error ? error.message : String(error),
      ms: Math.max(0, (options.now ?? Date.now)() - started),
    }
  }
  return { ok: true, raw, ms: Math.max(0, (options.now ?? Date.now)() - started) }
}
