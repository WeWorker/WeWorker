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

export async function backendFetch(pathOrUrl, options = {}) {
  await initializeBackendConnection()
  const token = await getAuthToken()
  const headers = new Headers(options.headers || {})
  if (token) headers.set('X-WeWorker-Auth', token)

  return fetch(buildBackendUrl(pathOrUrl), {
    ...options,
    headers,
  })
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
