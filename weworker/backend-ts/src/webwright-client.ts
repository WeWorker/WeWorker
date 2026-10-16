/**
 * 网站探索agent 8766 极简客户端 —— 第4层即时执行的转发通道（`docs/intelligent_routing_design.md` §2 第 15 行）。
 * 只覆盖 health / create / get / cancel / SSE 事件流。
 *
 * 约束（对端合同，`components/webwright/src/webwright/server/app.py`）：
 * - Host 只认 127.0.0.1/localhost（Node fetch 默认满足）；无 Origin 头直接放行。
 * - 单活动 worker：并发建任务 → 409 `{error:{code:'busy'}}`。
 * - `/events` 为 SSE（0.75s 轮询落盘产物），收到停态后流自动关闭。
 *
 * 地址只来自本模块常量与 `WEWORKER_WEBWRIGHT_URL`（仅供测试覆盖），**不接受调用方传入的 URL**
 * —— 与「Renderer 不得向主进程传入网站探索agent URL、只允许固定 `openwebwright()` IPC」同一条边界。
 * fetch 全部可注入（测试无网络）。
 */

/** 结构化 Response 子集：测试用 stub 只需实现这些。 */
export interface FetchLike {
  (url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
    body?: AsyncIterable<Uint8Array> | null
  }>
}

export interface WebwrightClientDeps {
  fetchImpl?: FetchLike
  baseUrl?: string
  /** 事件流「建连 + 收到响应头」超时（默认 10s）。仅测试注入小值。 */
  connectTimeoutMs?: number
}

export function getWebwrightBaseUrl(): string {
  return process.env.WEWORKER_WEBWRIGHT_URL || 'http://127.0.0.1:8766'
}

async function requestJson(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
  deps: WebwrightClientDeps = {},
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as FetchLike)
  const response = await doFetch(url, init)
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body }
}

// ─── health（TTL 缓存，含负缓存）───────────────────────────────────────────

let healthCache: { ok: boolean; reason: string; at: number } | null = null
const HEALTH_TTL_MS = 30_000

export function clearWebwrightHealthCache(): void {
  healthCache = null
}

export async function checkWebwrightHealth(deps: WebwrightClientDeps = {}): Promise<{ ok: boolean; reason: string }> {
  const now = Date.now()
  if (healthCache && now - healthCache.at < HEALTH_TTL_MS) return { ok: healthCache.ok, reason: healthCache.reason }
  let result: { ok: boolean; reason: string }
  try {
    const { ok } = await requestJson(
      `${deps.baseUrl ?? getWebwrightBaseUrl()}/api/health`,
      { signal: AbortSignal.timeout(1500) },
      deps,
    )
    result = { ok, reason: ok ? '' : 'health-non-200' }
  } catch (e) {
    result = { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  healthCache = { ...result, at: now }
  return result
}

// ─── 任务 CRUD ────────────────────────────────────────────────────────────

export interface WebwrightTaskView {
  task_id: string
  title?: string
  status: string
  current_step?: number
  last_url?: string
  last_title?: string
  final_response?: string
  error?: string
  error_code?: string
}

interface WebwrightErrorBody {
  error?: { code?: string; message?: string }
}

export type CreateTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; status: number; code: string; message: string }

export async function createWebwrightTask(
  input: { instruction: string; startUrl: string; title?: string },
  deps: WebwrightClientDeps = {},
): Promise<CreateTaskResult> {
  let response: { ok: boolean; status: number; body: unknown }
  try {
    response = await requestJson(
      `${deps.baseUrl ?? getWebwrightBaseUrl()}/api/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instruction: input.instruction,
          start_url: input.startUrl,
          ...(input.title ? { title: input.title } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      },
      deps,
    )
  } catch (e) {
    return { ok: false, status: 0, code: 'network', message: e instanceof Error ? e.message : String(e) }
  }
  if (!response.ok) {
    const err = (response.body as WebwrightErrorBody | null)?.error ?? {}
    return {
      ok: false,
      status: response.status,
      code: String(err.code ?? `http-${response.status}`),
      message: String(err.message ?? ''),
    }
  }
  const taskId = (response.body as { task_id?: string } | null)?.task_id ?? ''
  if (!taskId) return { ok: false, status: response.status, code: 'missing-task-id', message: '响应缺少 task_id' }
  return { ok: true, taskId }
}

export async function fetchWebwrightTask(
  taskId: string,
  deps: WebwrightClientDeps = {},
): Promise<WebwrightTaskView | null> {
  try {
    const { ok, body } = await requestJson(
      `${deps.baseUrl ?? getWebwrightBaseUrl()}/api/tasks/${encodeURIComponent(taskId)}`,
      { signal: AbortSignal.timeout(10_000) },
      deps,
    )
    return ok ? (body as WebwrightTaskView) : null
  } catch {
    return null
  }
}

export async function cancelWebwrightTask(taskId: string, deps: WebwrightClientDeps = {}): Promise<void> {
  try {
    await requestJson(
      `${deps.baseUrl ?? getWebwrightBaseUrl()}/api/tasks/${encodeURIComponent(taskId)}/cancel`,
      { method: 'POST', signal: AbortSignal.timeout(5000) },
      deps,
    )
  } catch {
    // 尽力而为：取消失败不影响回合收尾。
  }
}

// ─── 任务事件流（SSE）─────────────────────────────────────────────────────

export interface WebwrightTaskEvent {
  event: string
  data: Record<string, unknown>
}

/** 从 `/api/tasks/<id>/events` 的响应体逐帧解析 `event:`/`data:` SSE 帧。 */
export async function* readWebwrightSse(
  body: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<WebwrightTaskEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    if (signal?.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseSseFrame(frame)
      if (parsed) yield parsed
      boundary = buffer.indexOf('\n\n')
    }
  }
}

function parseSseFrame(frame: string): WebwrightTaskEvent | null {
  let event = ''
  let dataText = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataText += line.slice(5).trim()
  }
  if (!event) return null
  try {
    const data = dataText ? JSON.parse(dataText) : {}
    return { event, data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {} }
  } catch {
    return { event, data: {} }
  }
}

/** 事件流「建连 + 收到响应头」超时。响应体不受该时限约束，见 openWebwrightTaskEvents。 */
const EVENTS_CONNECT_TIMEOUT_MS = 10_000

/** 打开任务事件流；失败返回 `{ok:false}`（调用方按落回处理）。 */
export async function openWebwrightTaskEvents(
  taskId: string,
  deps: WebwrightClientDeps = {},
): Promise<{ ok: true; events: AsyncGenerator<WebwrightTaskEvent> } | { ok: false; reason: string }> {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as FetchLike)
  // 超时只覆盖「建连 + 收到响应头」。/events 是 SSE 长连接，若把 AbortSignal.timeout() 留在
  // 请求上，信号会在超时后中止响应体——分钟级的探索任务永远收不到停态，表现为回合在
  // 第 10 秒静默中断（2026-10-12 实测 9.99s）。故拿到响应即清计时器。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.connectTimeoutMs ?? EVENTS_CONNECT_TIMEOUT_MS)
  try {
    const response = await doFetch(
      `${deps.baseUrl ?? getWebwrightBaseUrl()}/api/tasks/${encodeURIComponent(taskId)}/events`,
      { signal: controller.signal },
    )
    clearTimeout(timer)
    if (!response.ok || !response.body) return { ok: false, reason: `events-http-${response.status}` }
    return { ok: true, events: readWebwrightSse(response.body) }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
