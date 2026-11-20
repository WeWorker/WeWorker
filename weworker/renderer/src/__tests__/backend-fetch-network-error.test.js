import test from 'node:test'
import assert from 'node:assert/strict'

test('network-level fetch failures become actionable Chinese errors', async t => {
  globalThis.window = { electronAPI: {
    getBackendUrl: async () => 'http://127.0.0.1:48765',
    getHttpAuthToken: async () => 'fixture-token',
  } }
  const http = await import('../api/http.js?network-error')
  await http.initializeBackendConnection()

  // 后端未启动/重启中：Chromium 只报 "Failed to fetch"，用户无从下手。
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(http.backendFetch('/dedicated-agents/skills'), /无法连接 WeWorker 后端/)

  // 中止等其余异常原样上抛，调用方（如事件流）依赖其错误类型。
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('fixture', 'AbortError') })
  await assert.rejects(http.backendFetch('/events'), (error) => error.name === 'AbortError')
})
