const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const net = require('node:net')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { startDevApp } = require('../start-dev-app.cjs')

function childProcess() {
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('close', null) }
  return child
}

function options(extra = {}) {
  return {
    host: new EventEmitter(), env: {},
    spawnProcess: () => { throw new Error('Renderer must use its listening server address') },
    ...extra,
  }
}

test('occupied renderer port starts Electron with the actual listening address', async t => {
  const holder = net.createServer(() => assert.fail('must not probe a foreign service over HTTP'))
  await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => holder.close(resolve)))
  const occupied = holder.address().port
  let renderer
  let selectedPort
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [require('node:path').resolve(__dirname, '../../renderer')] })).href)
  const host = new EventEmitter()
  await startDevApp(options({
    host, env: { WEWORKER_RENDERER_PORT: String(occupied) },
    createRenderer: async config => {
      renderer = await createServer({
        ...config, configFile: false, logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { ...config.server, watch: null },
      })
      return renderer
    },
    launchElectron: ({ env }) => {
      const address = renderer.httpServer.address()
      selectedPort = address.port
      assert.notEqual(selectedPort, occupied)
      assert.equal(env.WEWORKER_RENDERER_DEV_URL, `http://127.0.0.1:${selectedPort}`)
      const child = childProcess()
      setImmediate(() => child.emit('close', 7))
      return child
    },
  }))
  assert.ok(selectedPort > 0)
  assert.equal(holder.listening, true)
  assert.equal(renderer.httpServer.listening, false)
  assert.equal(host.exitCode, 7)
  assert.equal(host.listenerCount('SIGTERM'), 0)
})

test('failed renderer startup closes its server and never launches Electron', async () => {
  let closed = false
  await assert.rejects(startDevApp(options({
    createRenderer: async () => ({
      listen: async () => { throw new Error('fixture bind failure') },
      close: async () => { closed = true },
    }),
    launchElectron: () => assert.fail('must not launch before listening'),
  })), /fixture bind failure/)
  assert.equal(closed, true)
})

test('cancellation during renderer startup never launches Electron', async () => {
  const host = new EventEmitter()
  let closed = false
  await startDevApp(options({
    host,
    createRenderer: async () => ({
      listen: async () => { host.emit('SIGTERM') },
      close: async () => { closed = true },
    }),
    launchElectron: () => assert.fail('must not launch after cancellation'),
  }))
  assert.equal(closed, true)
  assert.equal(host.listenerCount('SIGTERM'), 0)
})

test('Electron spawn failure releases the renderer and propagates the error', async () => {
  let closed = false
  await assert.rejects(startDevApp(options({
    createRenderer: async () => ({
      listen: async () => {},
      httpServer: { address: () => ({ port: 45123 }) },
      close: async () => { closed = true },
    }),
    launchElectron: () => {
      const child = childProcess()
      setImmediate(() => child.emit('error', new Error('fixture executable failure')))
      return child
    },
  })), /fixture executable failure/)
  assert.equal(closed, true)
})

test('invalid renderer ports fail before starting any service', async () => {
  for (const value of ['', '-1', '65536', 'invalid', '1.5']) {
    await assert.rejects(startDevApp(options({
      env: { WEWORKER_RENDERER_PORT: value },
      createRenderer: () => assert.fail('must reject invalid port first'),
    })), /renderer port/i)
  }
})

test('a port taken after probing uses the final listening address', async t => {
  let holder
  t.after(async () => {
    if (holder?.listening) await new Promise(resolve => holder.close(resolve))
  })
  const { createServer } = await import(pathToFileURL(require.resolve('vite', { paths: [require('node:path').resolve(__dirname, '../../renderer')] })).href)
  let renderer
  await startDevApp(options({
    env: { WEWORKER_RENDERER_PORT: '0' },
    createRenderer: async config => {
      holder = net.createServer(() => assert.fail('must not query the new port holder'))
      await new Promise(resolve => holder.listen(config.server.port, '127.0.0.1', resolve))
      renderer = await createServer({
        ...config, configFile: false, logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { ...config.server, watch: null },
      })
      return renderer
    },
    launchElectron: ({ env }) => {
      const port = renderer.httpServer.address().port
      assert.notEqual(port, holder.address().port)
      assert.equal(env.WEWORKER_RENDERER_DEV_URL, 'http://127.0.0.1:' + port)
      const child = childProcess()
      setImmediate(() => child.emit('close', 0))
      return child
    },
  }))
  assert.equal(holder.listening, true)
})

test('termination after Electron launch stops the child and closes the renderer', async () => {
  const host = new EventEmitter()
  let closed = false
  const child = childProcess()
  await startDevApp(options({
    host,
    createRenderer: async () => ({
      listen: async () => {},
      httpServer: { address: () => ({ port: 45123 }) },
      close: async () => { closed = true },
    }),
    launchElectron: () => {
      setImmediate(() => host.emit('SIGTERM'))
      return child
    },
  }))
  assert.equal(child.killed, true)
  assert.equal(closed, true)
  assert.equal(host.listenerCount('SIGTERM'), 0)
})
