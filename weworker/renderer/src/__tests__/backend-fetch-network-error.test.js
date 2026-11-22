import test from 'node:test'
import assert from 'node:assert/strict'

test('network-level fetch failures become actionable Chinese errors', async t => {
  const selftestCalls = []
  globalThis.window = { electronAPI: {
    getBackendUrl: async () => 'http://127.0.0.1:48765',
    getHttpAuthToken: async () => 'fixture-token',
    netSelftest: async () => selftestCalls.push('invoked'),
  } }
  const http = await import('../api/http.js?network-error')
  await http.initializeBackendConnection()

  // 后端未启动/重启中：Chromium 只报 "Failed to fetch"，用户无从下手。
  const errors = []
  const restoreError = console.error; console.error = (...args) => errors.push(args.join(' '))
  t.after(() => { console.error = restoreError })
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(http.backendFetch('/dedicated-agents/skills'), /无法连接 WeWorker 后端/)
  // 网络失败必须落可搜索日志（主进程转发 renderer error 后在设置-日志可见）。
  assert.ok(errors.some((line) => line.includes('后端连接失败') && line.includes('net-error') && line.includes('/dedicated-agents/skills')), 'logs searchable backend-connection failure')
  // 并自动触发主进程网络自检（把拦截层写进日志，搜「net-selftest」）。
  assert.equal(selftestCalls.length, 1, 'network failure triggers the main-process selftest')

  // 中止等其余异常原样上抛，调用方（如事件流）依赖其错误类型。
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('fixture', 'AbortError') })
  await assert.rejects(http.backendFetch('/events'), (error) => error.name === 'AbortError')
})
