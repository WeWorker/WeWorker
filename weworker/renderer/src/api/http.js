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
      triggerNetworkSelftest()
      // 落一条可搜索的核心日志（设置-日志里搜「后端连接失败」或「net-error」），主进程会转发 renderer 控制台错误。
      console.error(`[renderer] 后端连接失败 net-error ${options.method || 'GET'} ${String(pathOrUrl)} -> ${API}：连接未建立${fallbackNote}（后端未启动/正在重启/被拦截）`)
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
