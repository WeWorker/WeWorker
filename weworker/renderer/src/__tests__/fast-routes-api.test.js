import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listFastRoutes, testFastRouteCandidate, approveFastRouteCandidate,
  ignoreFastRouteCandidate, deleteLocalFastRoute,
} from '../api/fast-routes.js'
import { useWorksStore } from '../store/works.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
useWorksStore.setState({ activeWorkId: 'fixture-work' })
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

test('loads empty candidates and configured routes without triggering a test', async () => {
  globalThis.window = {}
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method || 'GET' })
    return new Response(JSON.stringify({ candidates: [], routes: [] }), { status: 200 })
  }
  assert.deepEqual(await listFastRoutes(), { candidates: [], routes: [] })
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:8765/router/fast-routes?workId=fixture-work', method: 'GET' }])
})

test('test, approve, ignore and local delete use explicit authenticated backend endpoints', async () => {
  globalThis.window = { electronAPI: { getHttpAuthToken: async () => 'fixture-token' } }
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body), token: options.headers.get('X-WeWorker-Auth') })
    return new Response(JSON.stringify({ ok: true, previewMarkdown: 'Fixture preview' }), { status: 200 })
  }
  await testFastRouteCandidate('a/b', ['title'])
  await approveFastRouteCandidate('a/b', ['title'], 'fixture-preview-token', 7)
  await ignoreFastRouteCandidate('a/b')
  await deleteLocalFastRoute('a/b', 7)
  assert.deepEqual(requests.map(({ url, method, body }) => ({ url: url.replace('http://127.0.0.1:8765', ''), method, body })), [
    { url: '/router/fast-routes/candidates/a%2Fb/test?workId=fixture-work', method: 'POST', body: { displayFields: ['title'] } },
    { url: '/router/fast-routes/candidates/a%2Fb/approve?workId=fixture-work', method: 'POST', body: { displayFields: ['title'], previewToken: 'fixture-preview-token', expectedRevision: 7 } },
    { url: '/router/fast-routes/candidates/a%2Fb/ignore?workId=fixture-work', method: 'POST', body: {} },
    { url: '/router/fast-routes/local/a%2Fb?workId=fixture-work', method: 'DELETE', body: { expectedRevision: 7 } },
  ])
})

test('surfaces backend error details instead of treating failures as success', async () => {
  globalThis.window = {}
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: '只读测试失败' }), { status: 422 })
  await assert.rejects(testFastRouteCandidate('candidate'), /只读测试失败/)
})

test('rejects invalid list response shape', async () => {
  globalThis.window = {}
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })
  await assert.rejects(listFastRoutes(), /列表格式无效/)
})
