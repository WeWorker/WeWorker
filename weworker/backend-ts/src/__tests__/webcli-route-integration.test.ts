import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ entry: '' }))
vi.mock('../webcli-path.js', () => ({ resolveWebcliEntry: () => fixture.entry }))
import { runWebcliRoute } from '../webcli-route.js'

const cliRoot = fileURLToPath(new URL('../../../../webcli/', import.meta.url))
let directory: string
let server: http.Server | undefined
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-real-route-'))
  fixture.entry = process.env.WEBCLI_ROUTE_TEST_ENTRY || path.join(cliRoot, 'index.js')
  for (const [name, value] of Object.entries({ WEWORKER_PACKAGED: '', WEBCLI_LOCAL_ROUTE: '0', WEBCLI_D3_URL: '',
    WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(directory, 'builtin'),
    WEWORKER_USER_ADAPTERS_DIR: path.join(directory, 'user'), WEBCLI_ADAPTERS_DIR: path.join(directory, 'user'),
    WEWORKER_ADAPTER_DATA_DIR: path.join(directory, 'data'),
  })) vi.stubEnv(name, value)
  const { installAdapter } = await import(pathToFileURL(path.join(cliRoot, 'adapter-install-store.js')).href)
  installAdapter({ origin: { kind: 'local' }, files: new Map([
    ['manifest.json', JSON.stringify({ schema_version: 2, name: 'example.com', version: '1.0.0',
      description: 'Public fixture', match: ['example.com'], commands: ['search', 'detail'].map(id => ({
        id, runtime: 'extension', module: `extension/commands/${id}.js`, description: id,
        schema: { type: 'object', properties: {} },
      })) })],
    ['extension/commands/search.js', 'throw new Error("Recommendation must not execute tools")'],
    ['extension/commands/detail.js', 'throw new Error("Recommendation must not execute tools")'],
  ]) })
})
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('runs the real CLI using the selected catalog and passes literal user text to the decision service', async () => {
  const requests: Array<Record<string, any>> = []
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => {
      const keys = Object.keys((q as { criteria: object }).criteria)
      return [id, { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.95 : 0.05])) }]
    }))
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ answers }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  vi.stubEnv('WEBCLI_D3_URL', `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)
  const request = '--help search "quoted text"; $variable\nnext line'
  expect(await runWebcliRoute(request)).toMatchObject({ status: 'recommended', result: { callCommand: 'webcli call example.com.search' } })
  expect(requests).toHaveLength(1)
  expect(requests[0].state).toBe(`用户需求: ${request}`)
  expect(Object.keys(requests[0].questions.q_c0.criteria)).toEqual(['example.com.search', 'example.com.detail'])
})

it('recognizes the real CLI missing-service diagnostic without exposing URLs or raw errors', async () => {
  expect(await runWebcliRoute('search public projects')).toEqual({ status: 'failed', reason: 'not_configured', error: 'WEBCLI_D3_URL 未配置。' })
})

it('never recommends an explicitly disabled Adapter', async () => {
  const { selectAdapter } = await import(pathToFileURL(path.join(cliRoot, 'adapter-install-store.js')).href)
  selectAdapter('example.com', 'disabled')
  expect(await runWebcliRoute('search')).toEqual({ status: 'failed', reason: 'no_commands', error: '当前没有可用于路由的命令。' })
})
