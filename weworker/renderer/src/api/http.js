const DEFAULT_API = 'http://127.0.0.1:8765'
export let API = DEFAULT_API
let backendConnectionPromise

export async function initializeBackendConnection() {
  if (!backendConnectionPromise) {
    backendConnectionPromise = (async () => {
      const address = await window.electronAPI?.getBackendUrl?.()
      if (!address) return
      const url = new URL(address)
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('Invalid backend address')
      }
      API = url.origin
    })().catch(error => { backendConnectionPromise = undefined; throw error })
  }
  return backendConnectionPromise
}

let authTokenPromise

export async function getAuthToken() {
  if (!authTokenPromise) {
    authTokenPromise = Promise.resolve(window.electronAPI?.getHttpAuthToken?.() || '')
  }
  return authTokenPromise
}

function buildBackendUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(String(pathOrUrl))) {
    const url = new URL(pathOrUrl)
    if (![API, DEFAULT_API].includes(url.origin)) throw new Error('Invalid backend request address')
    return API + url.pathname + url.search + url.hash
  }
  return `${API}${String(pathOrUrl).startsWith('/') ? '' : '/'}${pathOrUrl}`
}

/** 网络失败后自动触发主进程网络自检（限频 60s 一次），把拦截层直接写进设置-日志（搜「net-selftest」）。 */
let lastSelftestAt = 0
function triggerNetworkSelftest() {
  if (Date.now() - lastSelftestAt < 60_000) return
  lastSelftestAt = Date.now()
  try { window.electronAPI?.netSelftest?.().catch(() => {}) } catch { /* 无该能力时忽略 */ }
  void runRendererProbe().catch(() => {})
}

/**
 * 渲染进程侧探针（设置-日志搜「renderer-probe」）：直接用原生 fetch 探测后端（不带令牌，401/403 都算通），
 * 与主进程 net-selftest 对照即可定位拦截层：renderer 三项全通 = 偶发；GET 通大 PUT 挂 = 按请求体大小拦渲染进程；
 * 全挂 = 渲染进程网络被整体拦截。探测打到不存在的 skill 名，无任何副作用。
 */
async function runRendererProbe() {
  try {
    console.error(`[renderer-probe] 页面上下文 origin=${window.location?.origin || '未知'} electronAPI=${Boolean(window.electronAPI)} online=${navigator.onLine} ua=${navigator.userAgent}`)
  } catch { /* 上下文收集失败不影响探测 */ }
  const probe = async (label, url, method, body) => {
    let outcome
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body })
      outcome = `HTTP ${res.status}${res.status === 401 ? '（401=未带令牌的正常响应，网络可达）' : ''}`
    } catch (error) {
      outcome = `网络层失败：${error instanceof Error ? error.message : String(error)}`
    }
    console.error(`[renderer-probe] ${label} → ${outcome}`)
    return outcome
  }
  const harmless = `${API}/dedicated-agents/skills/net-selftest-probe`
  await probe('GET /status（小请求）', `${API}/status`, 'GET')
  await probe('PUT 小请求体（1KB）', harmless, 'PUT', 'x'.repeat(1024))
  await probe('PUT 大请求体（33KB）', harmless, 'PUT', 'x'.repeat(33200))
}

/**
 * renderer 网络层失败时的兜底：经主进程（Node 栈）转发同一请求（搜「main-fetch」）。
 * 只处理普通请求/响应；带 signal 或 /events 的流式请求不兜底（主进程缓冲会破坏流）。
 */
async function fetchViaMain(url, method, headers, body) {
  try {
    const result = await window.electronAPI?.mainFetch?.(url, {
      method,
      headers: Object.fromEntries(new Headers(headers || {}).entries()),
      ...(typeof body === 'string' ? { body } : {}),
    })
    if (!result || result.error || typeof result.status !== 'number') return null
    return new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: new Headers(result.headers || {}),
    })
  } catch { return null }
}

export async function backendFetch(pathOrUrl, options = {}) {
  await initializeBackendConnection()
  const token = await getAuthToken()
  const headers = new Headers(options.headers || {})
  if (token) headers.set('X-WeWorker-Auth', token)

  try {
    return await fetch(buildBackendUrl(pathOrUrl), {
      ...options,
      headers,
    })
  } catch (error) {
    // fetch 网络层失败（后端未启动/正在重启/连接被拒）只带 "Failed to fetch" 这种无从下手的文案，
    // 统一转成可操作的提示；AbortError 等其余异常原样上抛。
    if (error instanceof TypeError) {
      // 端口回退场景（默认端口被占、后端落到随机端口）是重要线索，直接写进日志和提示。
      const fallbackNote = API !== DEFAULT_API ? `（后端在备用端口 ${new URL(API).port}，默认端口被占用）` : ''
      const sizeNote = typeof options.body === 'string' ? ` body=${options.body.length}B` : ''
      // 先尝试主进程转发兜底：渲染进程网络被拦但主进程可达时用户无感恢复。
      const streamy = Boolean(options.signal) || String(pathOrUrl).includes('/events')
      if (!streamy) {
        const viaMain = await fetchViaMain(buildBackendUrl(pathOrUrl), options.method || 'GET', headers, options.body)
        if (viaMain) {
          console.error(`[renderer] renderer网络被拦 net-error ${options.method || 'GET'}${sizeNote} ${String(pathOrUrl)} -> ${API}：连接未建立${fallbackNote}；已走主进程转发成功（main-fetch 兜底生效）`)
          return viaMain
        }
      }
      triggerNetworkSelftest()
      // 落一条可搜索的核心日志（设置-日志里搜「后端连接失败」或「net-error」），主进程会转发 renderer 控制台错误。
      console.error(`[renderer] 后端连接失败 net-error ${options.method || 'GET'}${sizeNote} ${String(pathOrUrl)} -> ${API}：连接未建立${fallbackNote}（后端未启动/正在重启/被拦截；主进程转发也未成功）`)
      throw new Error(`无法连接 WeWorker 后端${fallbackNote}，请等待服务启动后重试；若持续出现请查看设置-日志`)
    }
    throw error
  }
}

export async function streamBackendEvents(onEvent, signal, onOpen) {
  const res = await backendFetch('/events', { signal })
  if (!res.ok) {
    throw new Error(`Event stream failed: ${res.status}`)
  }
  onOpen?.()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (!signal?.aborted) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data) continue
      onEvent(data)
    }
  }
}
