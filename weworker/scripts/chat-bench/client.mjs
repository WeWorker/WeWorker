// HTTP + SSE 客户端：通过本机后端 (默认 127.0.0.1:8765) 驱动真实对话链路。
// 全部复用后端既有端点，不 import 后端内部模块。
// token 为空时后端放行（self 模式，http-security.ts:23）；remote 模式需传 X-WeWorker-Auth。

export function createClient({ base, token }) {
  const buildHeaders = (extra) => {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) }
    if (token) h['X-WeWorker-Auth'] = token
    return h
  }

  async function json(path, opts = {}) {
    const res = await fetch(`${base}${path}`, { ...opts, headers: buildHeaders(opts.headers) })
    if (!res.ok) {
      const detail = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${detail.detail || ''}`)
    }
    // DELETE 等可能无 body
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  return {
    base,
    token,

    // —— 靶子状态 / 预检 ——
    getStatus: () => json('/status').catch(() => null),
    getSettings: () => json('/settings'),
    // 探活走 provider probe（`server.ts` 的 POST /settings/provider/probe，target=weworker）。
    // 曾经写成 `/settings/test`——那个端点不存在，预检对任何后端都必然 404。
    // provider 必填：空串会被 build 白名单直接拒（400 Provider '' is not allowed in this build）。
    testProvider: (provider) =>
      json('/settings/provider/probe', {
        method: 'POST',
        body: JSON.stringify({ provider, target: 'weworker' }),
      }),

    // —— 用例源 / 分析 ——
    testPrompts: () => json('/health-check/test-prompts'),
    analyze: (workId, siteId) =>
      json('/health-check/analyze', { method: 'POST', body: JSON.stringify({ workId, siteId }) }),

    // —— work 生命周期 ——
    createWork: () => json('/works', { method: 'POST', body: '{}' }),
    setTitle: (workId, title) =>
      json(`/works/${workId}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    getWork: (workId) => json(`/works/${workId}`),
    deleteWork: (workId) => json(`/works/${workId}`, { method: 'DELETE' }),

    /** 应答交互确认门（plan tier 的 user_choice）。镜像 ChatView 的 POST /works/:id/user-choice。 */
    answerChoice: (workId, answer) =>
      json(`/works/${workId}/user-choice`, { method: 'POST', body: JSON.stringify({ answer }) }),

    /**
     * 发送对话并消费 SSE。onEvent 收到每个解析后的事件。
     * 镜像 renderer/src/api/backend.js:10-53 的行解析逻辑。
     * @returns {Promise<{ok:boolean, error?:string, timedOut?:boolean}>}
     */
    async sendChat(workId, message, { onEvent, timeout = 180000 } = {}) {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
      try {
        const res = await fetch(`${base}/works/${workId}/chat`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({ message }),
          signal: controller.signal,
        })
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ detail: res.statusText }))
          return { ok: false, error: `chat HTTP ${res.status}: ${detail.detail || ''}` }
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const data = line.slice(6).trim()
            if (data === '[DONE]') return { ok: true }
            try { onEvent(JSON.parse(data)) } catch { /* 忽略畸形行 */ }
          }
        }
        return { ok: true }
      } catch (e) {
        if (e.name === 'AbortError') return { ok: false, timedOut }
        return { ok: false, error: e.message }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
