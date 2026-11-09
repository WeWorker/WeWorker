import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

function fixture({ packaged = true, platform = 'win32', occupied = false, missing = false, healthError = false } = {}) {
  const source = fs.readFileSync(new URL('../managers.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export class BridgeManager'), source.indexOf('export class NodeManager')).replace('export class', 'class')
  const calls = [], timers = [], stopped = []
  const spawn = (exe, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => { stopped.push(child); queueMicrotask(() => child.emit('exit', 0)) }
    calls.push({ exe, args: Array.from(args), options, child })
    return child
  }
  const Manager = vm.runInNewContext(`${body}; BridgeManager`, {
    path, __dirname: path.resolve('fixture/electron'), fs: { mkdirSync() {}, existsSync: () => !missing }, os: { tmpdir: () => '/tmp' },
    process: { platform, env: {}, execPath: 'untrusted-path-electron', resourcesPath: path.resolve('fixture/resources') },
    app: { isPackaged: packaged }, spawn,
    utilityProcess: { fork: (...args) => spawn(...args) },
    adapterEnvironment: () => ({ ELECTRON_RUN_AS_NODE: '1', WEWORKER_BUILD_PROFILE: 'fixture' }),
    readOpenBrowserAllowedOriginsEnv: () => '', isPortOccupied: async () => occupied,
    waitForPort: async () => { if (healthError) throw Error('not ready') },
    killOwnersOfPort: async () => {}, formatProcessExitCode: String,
    setTimeout: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer },
    clearTimeout: timer => { timer.cancelled = true },
  })
  return { manager: new Manager(() => {}), calls, timers, stopped }
}
test('Windows starts only the packaged Node runtime and compiled Bridge', async () => {
  const { manager, calls } = fixture()
  await manager.start()
  assert.equal(manager.getStatus(), 'running')
  assert.equal(calls[0].exe, path.resolve('fixture/resources/node-runtime/node.exe'))
  assert.ok(calls[0].args.includes(path.resolve('fixture/resources/bridge/bridge.cjs')))
  assert.deepEqual(calls[0].args.slice(-2), ['service', 'start'])
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(calls[0].options.env.WEWORKER_BUILD_PROFILE, 'fixture')
  assert.equal(calls[0].options.windowsHide, true)
  await manager.start()
  assert.equal(calls.length, 1)
})
test('missing packaged runtime fails without falling back to system Node', async () => {
  const { manager, calls } = fixture({ missing: true })
  await assert.rejects(manager.start(), /Bundled Node runtime is missing/)
  assert.equal(calls.length, 0)
  assert.equal(manager.getStatus(), 'error')
})
test('occupied port is not started or stopped by this manager', async () => {
  const { manager, calls, stopped } = fixture({ occupied: true })
  await manager.start()
  assert.equal(manager.getStatus(), 'port_in_use')
  await manager.stop()
  assert.equal(calls.length, 0); assert.equal(stopped.length, 0)
})
test('health failure is not reported as ready', async () => {
  const { manager } = fixture({ healthError: true })
  await manager.start()
  assert.equal(manager.getStatus(), 'error')
  await manager.stop()
})
test('owned process stops once; abnormal exit schedules restart and quit cancels it', async () => {
  const { manager, calls, timers, stopped } = fixture()
  await manager.start(); await manager.stop()
  assert.equal(stopped.length, 1); assert.equal(manager.getStatus(), 'stopped')
  await manager.start()
  calls[1].child.emit('exit', 1)
  const restart = timers.find(t => t.delay === 1000)
  assert.ok(restart)
  await manager.stop()
  assert.equal(restart.cancelled, true)
})
test('development uses the bundle carrying build-time provider configuration; macOS keeps utility process', async () => {
  const dev = fixture({ packaged: false }); await dev.manager.start()
  assert.ok(dev.calls[0].args.includes(path.resolve('fixture/build/webcli-dist/webcli.cjs')))
  const mac = fixture({ platform: 'darwin' }); await mac.manager.start()
  assert.equal(mac.calls[0].exe, path.resolve('fixture/resources/bridge/bridge.cjs'))
})
