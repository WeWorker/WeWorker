import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  WEBWRIGHT_URL,
  WebwrightManager,
  buildWebwrightEnvironment,
  resolveWebwrightHome,
  resolveWeWorkerUserFilesDir,
} from '../webwright-manager.js'

function createChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM') }
  return child
}

function sourceHealth() {
  return {
    ok: true,
    instance_id: 'exploration-fixture',
    version: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    mode: 'source',
    bind: '127.0.0.1',
    port: '8766',
  }
}

test('selected exploration port is used by spawn, identity check and model snapshot', async () => {
  const child = createChild()
  child.stdin.on('finish', () => child.emit('exit', 0, null))
  const manager = new WebwrightManager({
    repoRoot: '/repo', ports: { backend: 48765, exploration: 48766, bridge: 43711 },
    checkPort: async port => { assert.equal(port, 48766); return false },
    spawnProcess: (_command, args, options) => {
      assert.equal(args[args.indexOf('--port') + 1], '48766')
      assert.equal(options.env.WEWORKER_MODEL_CONFIG_URL, 'http://127.0.0.1:48765/internal/webwright/model-config')
      assert.equal(options.env.WEBCLI_BRIDGE_PORT, '43711')
      return child
    },
    fetchHealth: async url => {
      assert.equal(url, 'http://127.0.0.1:48766/api/health')
      return { ok: true, json: async () => ({ ...sourceHealth(), port: 48766 }) }
    },
  })
  await manager.start()
  assert.equal(manager.getStatus(), 'running')
  await manager.stop()
})

test('Webwright browser URL is fixed to loopback port 8766', () => {
  assert.equal(WEBWRIGHT_URL, 'http://127.0.0.1:8766')
})

test('Webwright data home is namespaced under the WeWorker data root', () => {
  const homeDir = path.resolve('test-home')
  const webwrightHome = resolveWebwrightHome(homeDir)
  assert.equal(webwrightHome, path.join(homeDir, '.weworker', 'webwright'))
  assert.deepEqual(
    buildWebwrightEnvironment({ WEBWRIGHT_HOME: '/legacy/path', KEEP: 'yes' }, webwrightHome),
    { WEBWRIGHT_HOME: webwrightHome, KEEP: 'yes' },
  )
  assert.throws(() => buildWebwrightEnvironment({}, 'relative/path'), /absolute/)
})

test('WeWorker user files directory uses the configured absolute path', () => {
  const homeDir = path.resolve('test-home')
  assert.equal(
    resolveWeWorkerUserFilesDir(homeDir),
    path.join(homeDir, '.weworker', 'user-files'),
  )
  assert.equal(
    resolveWeWorkerUserFilesDir(homeDir, path.resolve('custom-user-files')),
    path.resolve('custom-user-files'),
  )
  assert.throws(
    () => resolveWeWorkerUserFilesDir(homeDir, 'relative/path'),
    /absolute/,
  )
})

test('port conflict does not spawn or terminate another process', async () => {
  let spawnCount = 0
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    webwrightHome: path.resolve('test-home/.weworker/webwright'),
    userFilesDir: path.resolve('test-home/.weworker/user-files'),
    checkPort: async () => true,
    spawnProcess: () => { spawnCount += 1 },
  })
  await manager.start()
  assert.equal(manager.getStatus(), 'port_in_use')
  assert.equal(spawnCount, 0)
  await manager.stop()
  assert.equal(manager.getStatus(), 'stopped')
})

test('development start uses source command and reaches running', async () => {
  const child = createChild()
  let invocation
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    webwrightHome: path.resolve('test-home/.weworker/webwright'),
    userFilesDir: path.resolve('test-home/.weworker/user-files'),
    checkPort: async () => false,
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      return child
    },
    fetchHealth: async () => ({ ok: true, json: async () => sourceHealth() }),
  })
  await manager.start()
  assert.equal(manager.getStatus(), 'running')
  assert.equal(invocation.command, 'uv')
  assert.ok(Array.isArray(invocation.args))
  assert.ok(invocation.args.includes('run'))
  const projectIdx = invocation.args.indexOf('--project')
  assert.notEqual(projectIdx, -1)
  assert.equal(invocation.args[projectIdx + 1], path.join('/repo', 'components', 'webwright'))
  assert.ok(invocation.args.includes('webwright-server'))
  assert.equal(invocation.options.env.WEBWRIGHT_HOME, path.resolve('test-home/.weworker/webwright'))
  assert.equal(invocation.options.env.WEWORKER_USER_FILES_DIR, path.resolve('test-home/.weworker/user-files'))
  assert.equal(invocation.options.shell, false)
  assert.equal(invocation.options.stdio[0], 'pipe')

  const exitPromise = manager.stop()
  child.emit('exit', 0, null)
  await exitPromise
  assert.equal(manager.getStatus(), 'stopped')
})

test('configured user files directory and scoped model credentials are passed', async () => {
  const child = createChild()
  let invocation
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    webwrightHome: path.resolve('test-home/.weworker/webwright'),
    userFilesDir: path.resolve('custom-user-files'),
    modelConfigToken: 'model-token',
    explorationInstanceId: 'exploration-fixture',
    checkPort: async () => false,
    spawnProcess: (command, args, options) => {
      invocation = { command, args, options }
      return child
    },
    fetchHealth: async () => ({ ok: true, json: async () => sourceHealth() }),
  })
  await manager.start()
  assert.equal(invocation.options.env.WEWORKER_USER_FILES_DIR, path.resolve('custom-user-files'))
  assert.equal(invocation.options.env.WEWORKER_BRIDGE_URL, undefined)
  assert.equal(invocation.options.env.WEWORKER_BRIDGE_TOKEN, undefined)
  assert.equal(invocation.options.env.WEWORKER_MODEL_CONFIG_URL, 'http://127.0.0.1:8765/internal/webwright/model-config')
  assert.equal(invocation.options.env.WEWORKER_MODEL_CONFIG_TOKEN, 'model-token')
  assert.equal(invocation.options.env.WEWORKER_EXPLORATION_INSTANCE_ID, 'exploration-fixture')
  const stopPromise = manager.stop()
  child.emit('exit', 0, null)
  await stopPromise

})

test('normal stop closes stdin before waiting for process exit', async () => {
  const child = createChild()
  let stdinEnded = false
  child.stdin.on('finish', () => { stdinEnded = true })
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    checkPort: async () => false,
    spawnProcess: () => child,
    fetchHealth: async () => ({ ok: true, json: async () => sourceHealth() }),
  })
  await manager.start()
  const stopPromise = manager.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stdinEnded, true)
  child.emit('exit', 0, null)
  await stopPromise
})

test('packaged health identity mismatch stops the child and stays mismatched', async () => {
  const child = createChild()
  child.stdin.on('finish', () => child.emit('exit', 0, null))
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    resourcesPath: '/resources',
    isPackaged: true,
    checkPort: async () => false,
    spawnProcess: () => child,
    loadRuntime: () => ({
      entrypoint: '/resources/webwright/Webwright',
      manifest: {
        webwright_version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        mode: 'embedded',
      },
    }),
    fetchHealth: async () => ({
      ok: true,
      json: async () => ({ ...sourceHealth(), version: '0.2.0', mode: 'embedded' }),
    }),
  })
  await manager.start()
  assert.equal(manager.getStatus(), 'version_mismatch')
})

test('spawn failure enters error without waiting for the health timeout', async () => {
  const child = createChild()
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    checkPort: async () => false,
    spawnProcess: () => {
      setImmediate(() => child.emit('error', new Error('uv not found')))
      return child
    },
    fetchHealth: async () => { throw new Error('not ready') },
    startTimeoutMs: 30000,
    maxRestartAttempts: 0,
  })
  await manager.start()
  assert.equal(manager.getStatus(), 'error')
})

test('unexpected exit schedules a bounded restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = createChild()
  const second = createChild()
  const children = [first, second]
  let spawnCount = 0
  const manager = new WebwrightManager({
    repoRoot: '/repo',
    checkPort: async () => false,
    explorationInstanceId: 'exploration-fixture',
    spawnProcess: (_command, _args, options) => {
      assert.equal(options.env.WEWORKER_EXPLORATION_INSTANCE_ID, 'exploration-fixture')
      return children[spawnCount++]
    },
    fetchHealth: async () => ({ ok: true, json: async () => sourceHealth() }),
    maxRestartAttempts: 1,
  })
  await manager.start()
  first.emit('exit', 1, null)
  assert.equal(manager.getStatus(), 'error')
  t.mock.timers.tick(1000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawnCount, 2)
  const stopPromise = manager.stop()
  second.emit('exit', 0, null)
  await stopPromise
})
