import test from 'node:test'
import assert from 'node:assert/strict'

test('IPC-selected backend handles API calls, legacy URLs and resource URLs', async t => {
  let addressReads = 0
  globalThis.window = { electronAPI: {
    getBackendUrl: async () => { addressReads++; return 'http://127.0.0.1:48765' },
    getHttpAuthToken: async () => 'fixture-launch-token',
  } }
  const http = await import('../api/http.js?alternate-port')
  await http.initializeBackendConnection()
  assert.equal(http.API, 'http://127.0.0.1:48765')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url)
    assert.equal(options.headers.get('X-WeWorker-Auth'), 'fixture-launch-token')
    return Response.json({ ok: true })
  })
  await http.backendFetch('/settings')
  await http.backendFetch('http://127.0.0.1:8765/works')
  assert.deepEqual(requests, ['http://127.0.0.1:48765/settings', 'http://127.0.0.1:48765/works'])
  await assert.rejects(http.backendFetch('https://example.com/settings'), /backend/i)
  assert.equal(addressReads, 1)
})
