import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'

test('each app launch shares one fresh exploration identity between managers', () => {
  const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('const servicePorts ='), source.indexOf('let isInstallingUpdate ='))
  const launch = () => {
    let backendId
    let serviceId
    vm.runInNewContext(body, {
      randomBytes, randomUUID, path, __dirname: path.resolve('electron'),
      log() {}, logFile: 'fixture.log', app: { isPackaged: false }, process: {},
      resolveWebwrightHome: () => 'fixture-home', readConfiguredUserFilesDir: () => 'fixture-files',
      BridgeManager: class {}, BrowserControlClient: class {},
      NodeManager: class { constructor(...args) { backendId = args[5] } },
      WebwrightManager: class { constructor(options) { serviceId = options.explorationInstanceId } },
    })
    assert.ok(backendId)
    assert.equal(backendId, serviceId)
    return backendId
  }
  assert.notEqual(launch(), launch())
})

function loadManager(spawn, isPackaged = false, env = {}) {
  const source = fs.readFileSync(new URL('../managers.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export class NodeManager'), source.indexOf('\nfunction waitForPort(')).replace('export class', 'class')
  return vm.runInNewContext(`${body}; NodeManager`, {
    path, URL, __dirname: path.resolve('electron'), process: { env, execPath: 'electron', resourcesPath: path.resolve('fixture-resources') },
    app: { isPackaged }, utilityProcess: { fork: (file, args, options) => spawn(file, args, options) }, randomUUID: () => 'fixture-instance',
    resolveWebwrightHome: () => 'fixture-home', buildWebwrightEnvironment: env => env,
    resolveClaudeCodePath: () => '/weworker-fixtures/claude',
    adapterEnvironment: () => ({ WEWORKER_BUILD_PROFILE: 'fixture' }),
    resolveBackendAvailability: async () => 'free', isPortOccupied: async () => false,
    waitForHttpInstance: async () => {}, spawn, clearTimeout,
  })
}

test('packaged backend receives the host exploration identity', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const Manager = loadManager((_cmd, _args, options) => {
    assert.equal(options.env.WEWORKER_EXPLORATION_INSTANCE_ID, 'exploration-fixture')
    return child
  }, true)
  const manager = new Manager(() => {}, '', '', 'fixture-home', '', 'exploration-fixture')
  await manager.start()
  assert.equal(manager._status, 'running')
})

test('development backend starts without undefined environment variables', async () => {
  let spawned = false
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const Manager = loadManager((cmd, args, options) => {
    spawned = true
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(options.env.WEWORK_PORT, '8765')
    assert.equal(options.env.WEWORKER_EXPLORATION_INSTANCE_ID, 'exploration-fixture')
    assert.equal(options.env.WEWORKER_CLAUDE_CODE_PATH, '/weworker-fixtures/claude')
    assert.equal(options.env.WEWORKER_BUILD_PROFILE, 'fixture')
    assert.ok(args.includes('src/server.ts'))
    return child
  })
  const manager = new Manager(() => {}, '', '', 'fixture-home', '', 'exploration-fixture')
  await manager.start()
  assert.equal(spawned, true)
  assert.equal(manager._status, 'running')
})

test('startup exceptions are logged and leave an error state', async () => {
  const logs = []
  const Manager = loadManager(() => { throw new Error('fixture spawn failure') })
  const manager = new Manager(message => logs.push(message))
  await assert.rejects(manager.start(), /fixture spawn failure/)
  assert.equal(manager._status, 'error')
  assert.equal(manager._starting, false)
  assert.ok(logs.some(message => message.includes('startup failed: fixture spawn failure')))
})

test('backend receives all selected ports and exposes its actual HTTP URL', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const Manager = loadManager((_cmd, _args, options) => {
    assert.equal(options.env.WEWORK_PORT, '48765')
    assert.equal(options.env.WEWORKER_WEBWRIGHT_URL, 'http://127.0.0.1:48766')
    assert.equal(options.env.WEBCLI_BRIDGE_PORT, '43711')
    return child
  })
  const manager = new Manager(() => {}, '', '', 'fixture-home', '', 'fixture-instance', { backend: 48765, exploration: 48766, bridge: 43711 })
  await manager.start()
  assert.equal(manager.getUrl(), 'http://127.0.0.1:48765')
})

test('development backend trusts the actual renderer origin, including alternate ports', async () => {
  for (const [env, expected] of [
    [{ WEWORKER_RENDERER_DEV_URL: 'http://127.0.0.1:5181/' }, 'http://127.0.0.1:5181'],
    [{ WEWORKER_DEV_SERVER_URL: 'http://localhost:5174/preview' }, 'http://localhost:5174'],
    [{ WEWORKER_RENDERER_DEV_URL: 'http://127.0.0.1:5181', WEWORKER_DEV_SERVER_URL: 'http://localhost:5174' }, 'http://127.0.0.1:5181'],
    [{}, 'http://localhost:5173'],
  ]) {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const Manager = loadManager((_cmd, _args, options) => {
      assert.equal(options.env.WEWORKER_RENDERER_ORIGIN, expected)
      return child
    }, false, env)
    await new Manager(() => {}).start()
  }
})
