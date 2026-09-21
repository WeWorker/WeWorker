import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import test from 'node:test'

function loadManager(spawn) {
  const source = fs.readFileSync(new URL('../managers.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export class NodeManager'), source.indexOf('\nfunction waitForPort(')).replace('export class', 'class')
  return vm.runInNewContext(`${body}; NodeManager`, {
    path, __dirname: path.resolve('electron'), process: { env: {}, execPath: 'electron' },
    app: { isPackaged: false }, randomUUID: () => 'fixture-instance',
    resolveWebwrightHome: () => 'fixture-home', buildWebwrightEnvironment: () => ({}),
    resolveBackendAvailability: async () => 'free', isPortOccupied: async () => false,
    waitForHttpInstance: async () => {}, spawn, clearTimeout,
  })
}

test('development backend starts without undefined environment variables', async () => {
  let spawned = false
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const Manager = loadManager((cmd, args, options) => {
    spawned = true
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(options.env.WEWORK_PORT, '8765')
    assert.ok(args.includes('src/server.ts'))
    return child
  })
  const manager = new Manager(() => {})
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
