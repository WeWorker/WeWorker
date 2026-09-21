import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {
  formatProcessExitCode,
  isPortOccupied,
  isStandaloneWeWorkerBackend,
  probeHttpJson,
  waitForHttpInstance,
} from '../local-service.js'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('waitForHttpInstance only accepts the backend process that was just spawned', async () => {
  let requests = 0
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-weworker-auth'], 'secret-token')
    requests += 1
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      backend_instance_id: requests >= 2 ? 'expected-instance' : 'stale-instance',
    }))
  })
  const port = await listen(server)
  try {
    await waitForHttpInstance(
      `http://127.0.0.1:${port}/status`,
      1500,
      'secret-token',
      'expected-instance',
    )
    assert.ok(requests >= 2)
  } finally {
    await close(server)
  }
})

test('waitForHttpInstance rejects a healthy response from a stale backend', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ backend_instance_id: 'stale-instance' }))
  })
  const port = await listen(server)
  try {
    await assert.rejects(
      waitForHttpInstance(`http://127.0.0.1:${port}/status`, 350, '', 'expected-instance'),
      /instance stale-instance/,
    )
  } finally {
    await close(server)
  }
})

test('isPortOccupied reports listening and released ports', async () => {
  const server = http.createServer((_request, response) => response.end('ok'))
  const port = await listen(server)
  assert.equal(await isPortOccupied(port), true)
  await close(server)
  assert.equal(await isPortOccupied(port), false)
})

test('probeHttpJson identifies a standalone WeWorker development backend', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-weworker-auth'], 'desktop-token')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      service: 'weworker-backend',
      runtime_mode: 'standalone',
      backend_instance_id: '',
    }))
  })
  const port = await listen(server)
  try {
    const payload = await probeHttpJson(`http://127.0.0.1:${port}`, 500, 'desktop-token')
    assert.equal(isStandaloneWeWorkerBackend(payload), true)
  } finally {
    await close(server)
  }
})

test('managed or unrelated services are not adopted as standalone development backends', () => {
  assert.equal(isStandaloneWeWorkerBackend({
    service: 'weworker-backend',
    runtime_mode: 'managed',
    backend_instance_id: 'managed-1',
  }), false)
  assert.equal(isStandaloneWeWorkerBackend({
    service: 'other-service',
    runtime_mode: 'standalone',
    backend_instance_id: '',
  }), false)
  assert.equal(isStandaloneWeWorkerBackend(null), false)
})

test('Electron startup guards against duplicate app and backend instances', () => {
  const mainSource = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  const managerSource = fs.readFileSync(new URL('../managers.js', import.meta.url), 'utf8')
  const backendSource = fs.readFileSync(new URL('../../backend-ts/src/server.ts', import.meta.url), 'utf8')

  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/)
  assert.match(managerSource, /resolveBackendAvailability\(/)
  assert.match(managerSource, /external_running/)
  assert.match(managerSource, /WEWORKER_BACKEND_INSTANCE_ID/)
  assert.match(managerSource, /WEWORKER_RENDERER_ORIGIN: process\.env\.WEWORKER_DEV_SERVER_URL/)
  assert.doesNotMatch(managerSource, /WEWORKER_CLAUDE_CODE_PATH: claudeCodePath/)
  assert.match(managerSource, /waitForHttpInstance/)
  assert.match(managerSource, /\[bridge\] exited unexpectedly; restarting/)
  assert.match(managerSource, /--report-on-fatalerror/)
  assert.match(backendSource, /backend_instance_id: BACKEND_INSTANCE_ID/)
  assert.match(backendSource, /service: 'weworker-backend'/)
})

test('formatProcessExitCode explains Windows fail-fast exit codes', () => {
  assert.equal(
    formatProcessExitCode(3221226505),
    '3221226505 (0xc0000409: fail-fast / stack buffer overrun (often a native or V8 fatal error))',
  )
})
