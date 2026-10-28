import { test } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import {
  BROWSER_INSTANCE_STORAGE_KEY,
  BrowserHost,
  DedicatedBrowserManager,
  OFFSCREEN_POSITION,
  browserExecutableCandidates,
  buildBrowserArgs,
  createCdpPipe,
  discoverCdpEndpoint,
  extensionBuildDigest,
  findBrowserExecutable,
  readLoadedExtensionBuild,
  loadInstanceToken,
  markExtensionInstance,
  normalizeBrowserMode,
  readBrowserMode,
  resolveBrowserHome,
  writeBrowserMode,
} from '../dedicated-browser.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-browser-test-'))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('CDP discovery rejects a stale file pointing at a different live browser', async () => {
  const { createServer } = await import('node:http')
  const root = tempDir()
  let identity = 'other-browser-page'
  const server = createServer((req, res) => res.end(JSON.stringify(req.url === '/json/list'
    ? [{ id: identity }]
    : { webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fixture` })))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fs.writeFileSync(path.join(root, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/fixture\n`)
  try {
    await assert.rejects(discoverCdpEndpoint(root, 'owned-page', { timeoutMs: 100 }), /无法确认/)
    identity = 'owned-page'
    assert.match(await discoverCdpEndpoint(root, identity), /^ws:\/\/127\.0\.0\.1:/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('concurrent Python leases launch once, do not wait for the extension, and block stop until released', async () => {
  const fixture = manager()
  const host = new BrowserHost({ env: { WEWORKER_BROWSER_MODE: 'dedicated' }, browserHome: fixture.browserHome,
    createManager: () => fixture.instance, isDedicatedConnected: () => false, idleStopMs: 0 })
  const a = { readyState: 1 }, b = { readyState: 1 }
  const pending = host.acquire(a)
  await assert.rejects(host.control('stop'), /正在执行/)
  const [first, second] = await Promise.all([pending, host.acquire(b)])
  assert.equal(fixture.launches.length, 1)
  assert.equal(first.instanceId, second.instanceId)
  assert.equal(host.status().extensionConnected, false)
  await assert.rejects(host.control('restart'), /正在执行/)
  host.detach(a)
  assert.equal(host.leases.size, 1)
  host.detach(b)
  await host.control('stop')
  await host.shutdown()
})

test('system mode rejects CDP consumers without launching or changing mode', async () => {
  let launches = 0
  const host = new BrowserHost({ env: { WEWORKER_BROWSER_MODE: 'system' }, browserHome: tempDir(),
    createManager: () => { launches++; throw new Error('must not launch') } })
  await assert.rejects(host.acquire({ readyState: 1 }), error => error.code === 'BROWSER_MODE_REQUIRED')
  assert.equal(launches, 0)
  assert.equal(host.mode, 'system')
  await host.shutdown()
})

/**
 * Fake browser process: answers CDP requests written to fd 3 on fd 4.
 * `handlers[method]` returns a result object or throws to send a CDP error.
 * Window bounds are stateful so show/hide can be observed.
 */
function fakeBrowser({ handlers = {}, exitOnLaunch = null, bounds = { left: OFFSCREEN_POSITION, top: OFFSCREEN_POSITION, windowState: 'normal' } } = {}) {
  const requests = []
  const windowBounds = { ...bounds }
  const child = new EventEmitter()
  child.pid = 4321
  let buffered = ''
  const toBrowser = new Writable({
    write(chunk, _encoding, done) {
      buffered += chunk.toString('utf8')
      let end
      while ((end = buffered.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffered.slice(0, end))
        buffered = buffered.slice(end + 1)
        requests.push(message)
        respond(message)
      }
      done()
    },
  })
  const fromBrowser = new PassThrough()
  const stderr = new PassThrough()
  child.stdio = [null, null, stderr, toBrowser, fromBrowser]
  child.stderr = stderr
  child.exitCode = null
  child.exit = (code = 0) => {
    if (child.exitCode !== null) return
    child.exitCode = code
    fromBrowser.end()
    setImmediate(() => child.emit('exit', code, null))
  }
  const defaultHandlers = {
    'Browser.getVersion': () => ({ product: 'Chrome/155.0.0.0' }),
    'Extensions.loadUnpacked': () => ({ id: 'abcdefghijklmnopabcdefghijklmnop' }),
    'Target.createTarget': () => ({ targetId: 'page-1' }),
    'Browser.getWindowForTarget': () => ({ windowId: 9, bounds: { ...windowBounds } }),
    'Browser.setWindowBounds': (params) => { Object.assign(windowBounds, params.bounds); return {} },
    'Target.getTargets': () => ({ targetInfos: [
      { targetId: 'page-1', type: 'page', url: 'about:blank' },
      { targetId: 'sw-1', type: 'service_worker', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/background/service-worker.js' },
    ] }),
    'Target.attachToTarget': () => ({ sessionId: 'session-1' }),
    'Runtime.evaluate': () => ({ result: { type: 'string', value: 'ok' } }),
  }
  const respond = (message) => {
    setImmediate(() => {
      const handler = handlers[message.method] ?? defaultHandlers[message.method] ?? (() => ({}))
      try {
        const result = handler(message.params, message, windowBounds)
        fromBrowser.write(`${JSON.stringify({ id: message.id, result })}\0`)
      } catch (error) {
        fromBrowser.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } })}\0`)
      }
      if (message.method === 'Browser.close') child.exit(0)
    })
  }
  if (exitOnLaunch !== null) setImmediate(() => child.exit(exitOnLaunch))
  return {
    child,
    requests,
    windowBounds,
    methods: () => requests.map((request) => request.method),
    boundsSet: () => requests.filter((request) => request.method === 'Browser.setWindowBounds').map((request) => request.params.bounds),
  }
}

function manager(options = {}) {
  const browserHome = options.browserHome ?? tempDir()
  const launches = []
  const killed = []
  const statuses = []
  const queue = [...(options.browsers ?? [])]
  const instance = new DedicatedBrowserManager({
    browserHome,
    extensionDir: 'extensionDir' in options ? options.extensionDir : 'C:/weworker-fixtures/extension',
    instanceToken: 'fixture-instance-token-0123456789abcdef',
    discoverEndpoint: async () => 'ws://127.0.0.1:12345/devtools/browser/fixture',
    platform: 'win32',
    findExecutable: options.findExecutable ?? (() => ({ path: 'C:/weworker-fixtures/chrome.exe', name: 'Chrome' })),
    spawn: (command, args, spawnOptions) => {
      const browser = queue.shift() ?? fakeBrowser()
      launches.push({ command, args, spawnOptions, browser })
      return browser.child
    },
    killTree: (child) => { killed.push(child.pid); child.exit?.(1) },
    restartDelaysMs: [5, 5, 5, 5, 5],
    profileInUseRetryMs: 5,
    onStatusChange: (status) => statuses.push(status.status),
    ...options.overrides,
  })
  return { instance, launches, killed, browserHome, statuses }
}

test('browser mode defaults to WeWorker browser', () => {
  assert.equal(normalizeBrowserMode(undefined), 'dedicated')
  assert.equal(normalizeBrowserMode('system'), 'system')
  assert.equal(normalizeBrowserMode('other'), 'dedicated')
})

test('the mode lives in config.json under the browser home; the environment can fix it', () => {
  const home = tempDir()
  assert.equal(resolveBrowserHome({ env: {}, home: '/home/weworker-test' }), path.join('/home/weworker-test', '.weworker', 'browser'))
  assert.equal(resolveBrowserHome({ env: { WEWORKER_BROWSER_HOME: home } }), path.resolve(home))
  assert.deepEqual(readBrowserMode({ env: {}, browserHome: home }), { mode: 'dedicated', locked: false })
  assert.equal(writeBrowserMode('system', { browserHome: home }), 'system')
  assert.deepEqual(readBrowserMode({ env: {}, browserHome: home }), { mode: 'system', locked: false })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')), { mode: 'system' })
  assert.deepEqual(readBrowserMode({ env: { WEWORKER_BROWSER_MODE: 'dedicated' }, browserHome: home }), { mode: 'dedicated', locked: true })
  fs.writeFileSync(path.join(home, 'config.json'), 'not json')
  assert.equal(readBrowserMode({ env: {}, browserHome: home }).mode, 'dedicated')
})

test('finds Chrome before Edge and honours an explicit executable', () => {
  const env = { ProgramFiles: 'C:/Program Files', 'ProgramFiles(x86)': 'C:/Program Files (x86)', LOCALAPPDATA: 'C:/Users/weworker-test/AppData/Local' }
  const candidates = browserExecutableCandidates({ platform: 'win32', env })
  assert.equal(candidates[0].name, 'Chrome')
  assert.ok(candidates.findIndex((c) => c.name === 'Microsoft Edge') > candidates.findLastIndex((c) => c.name === 'Chrome'))
  const edgeOnly = findBrowserExecutable({ platform: 'win32', env, exists: (file) => file.endsWith('msedge.exe') })
  assert.equal(edgeOnly.name, 'Microsoft Edge')
  const explicit = findBrowserExecutable({ platform: 'win32', env: { ...env, WEWORKER_BROWSER_EXECUTABLE: 'C:/weworker-fixtures/chrome.exe' }, exists: () => true })
  assert.equal(explicit.path, 'C:/weworker-fixtures/chrome.exe')
  assert.equal(findBrowserExecutable({ platform: 'win32', env, exists: () => false }), null)
  const mac = browserExecutableCandidates({ platform: 'darwin', env: {}, home: '/Users/weworker-test' })
  assert.match(mac[0].path, /Google Chrome\.app/)
})

test('launch flags use a private profile, the CDP pipe and an off-screen window', () => {
  const args = buildBrowserArgs({ userDataDir: 'C:/weworker-fixtures/profile' })
  assert.ok(args.includes('--user-data-dir=C:/weworker-fixtures/profile'))
  for (const flag of ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--no-startup-window', '--no-first-run', '--disable-backgrounding-occluded-windows']) {
    assert.ok(args.includes(flag), flag)
  }
  assert.ok(args.includes(`--window-position=${OFFSCREEN_POSITION},${OFFSCREEN_POSITION}`))
  assert.ok(args.includes('--remote-debugging-port=0'))
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'))
  assert.equal(args.some((arg) => arg.startsWith('--load-extension')), false)
})

test('launch flags keep navigator.webdriver false despite the CDP pipe', () => {
  const args = buildBrowserArgs({ userDataDir: 'C:/weworker-fixtures/profile' })
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'))
  // These flags make Chrome announce automation to pages and users.
  assert.equal(args.some((arg) => arg === '--enable-automation' || arg.startsWith('--headless')), false)
})

test('the instance token is stable for a profile and replaced when invalid', () => {
  const dir = tempDir()
  const first = loadInstanceToken(dir)
  assert.match(first, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(loadInstanceToken(dir), first)
  fs.writeFileSync(path.join(dir, 'instance.json'), '{"token":"short"}')
  assert.notEqual(loadInstanceToken(dir), first)
})

test('the CDP pipe parses split frames, routes events and fails pending calls on close', async () => {
  const written = []
  const readable = new PassThrough()
  const cdp = createCdpPipe({ write: (data) => written.push(data) }, readable)
  const events = []
  cdp.onEvent((event) => events.push(event.method))
  const first = cdp.send('Browser.getVersion')
  const second = cdp.send('Target.getTargets', {}, 'session-1')
  assert.deepEqual(written.map((frame) => JSON.parse(frame.slice(0, -1))), [
    { id: 1, method: 'Browser.getVersion', params: {} },
    { id: 2, method: 'Target.getTargets', params: {}, sessionId: 'session-1' },
  ])
  const reply = `${JSON.stringify({ method: 'Target.targetCreated', params: {} })}\0${JSON.stringify({ id: 1, result: { product: 'Chrome' } })}\0${JSON.stringify({ id: 2, error: { code: -32601, message: 'not found' } })}\0`
  readable.write(reply.slice(0, 20))
  readable.write(reply.slice(20))
  assert.deepEqual(await first, { product: 'Chrome' })
  await assert.rejects(second, /not found/)
  assert.deepEqual(events, ['Target.targetCreated'])
  const pending = cdp.send('Browser.close')
  readable.end()
  await assert.rejects(pending, /closed/)
  await assert.rejects(cdp.send('Browser.getVersion'), /closed/)
})

test('marks the extension from inside its service worker, waiting for it to be ready', async () => {
  let targetsCalls = 0
  let evaluations = 0
  const sent = []
  const cdp = {
    async send(method, params, sessionId) {
      sent.push([method, sessionId ?? null])
      if (method === 'Target.getTargets') {
        targetsCalls += 1
        return { targetInfos: targetsCalls < 2 ? [] : [{ targetId: 'sw', type: 'service_worker', url: 'chrome-extension://extid/background/service-worker.js' }] }
      }
      if (method === 'Target.attachToTarget') return { sessionId: 's1' }
      if (method === 'Runtime.evaluate') {
        evaluations += 1
        assert.match(params.expression, new RegExp(BROWSER_INSTANCE_STORAGE_KEY))
        assert.match(params.expression, /fixture-token/)
        if (evaluations === 1) return { exceptionDetails: { exception: { description: 'ReferenceError: chrome is not defined' } } }
        if (evaluations === 2) return { result: { value: '__weworker_extension_storage_not_ready__' } }
        return { result: { value: 'ok' } }
      }
      return {}
    },
  }
  await markExtensionInstance(cdp, 'extid', { kind: 'dedicated', token: 'fixture-token' }, { pollMs: 1 })
  assert.equal(evaluations, 3)
  assert.deepEqual(sent.at(-1), ['Target.detachFromTarget', null])
  const failing = { send: async (method) => (method === 'Target.getTargets' ? { targetInfos: [] } : {}) }
  await assert.rejects(markExtensionInstance(failing, 'extid', {}, { timeoutMs: 5, pollMs: 1 }), /did not start/)
})

test('starts the browser off-screen with the extension and its instance marker, then stops it gracefully', async () => {
  const { instance, launches, killed, statuses } = manager()
  const status = await instance.start()
  assert.deepEqual(status, { status: 'running', browser: 'Chrome', extensionLoaded: true, cdpReady: true })
  const [{ browser, spawnOptions, args }] = launches
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'])
  assert.equal(spawnOptions.detached, false)
  assert.ok(args.some((arg) => arg.startsWith('--user-data-dir=') && arg.endsWith('profile')))
  assert.deepEqual(browser.methods().slice(0, 3), ['Browser.getVersion', 'Extensions.loadUnpacked', 'Target.createTarget'])
  assert.deepEqual(browser.requests.find((r) => r.method === 'Extensions.loadUnpacked').params, { path: 'C:/weworker-fixtures/extension' })
  assert.equal(browser.requests.find((r) => r.method === 'Target.createTarget').params.background, true)
  const marker = browser.requests.find((r) => r.method === 'Runtime.evaluate')
  assert.equal(marker.sessionId, 'session-1')
  assert.match(marker.params.expression, /fixture-instance-token-0123456789abcdef/)

  await instance.stop()
  assert.equal(instance.getStatus().status, 'stopped')
  assert.ok(browser.methods().includes('Browser.close'))
  assert.deepEqual(killed, [])
  assert.equal(launches.length, 1)
  assert.deepEqual(statuses, ['starting', 'running', 'stopped'])
})

/** Fake worker storage: answers the read, restore and marker evaluations. */
function storageHandlers(stored) {
  const evaluated = []
  return {
    evaluated,
    'Runtime.evaluate': (params) => {
      evaluated.push(params.expression)
      if (params.expression.includes('chrome.storage.local.get(null)')) return { result: { type: 'string', value: JSON.stringify(stored) } }
      return { result: { type: 'string', value: 'ok' } }
    },
  }
}

test('a changed extension build is reinstalled once, keeping its local storage', async () => {
  const browserHome = tempDir()
  const handlers = storageHandlers({ siteMemories: { 'example.com': { captureCount: 2 } } })
  const first = fakeBrowser({ handlers })
  const { instance } = manager({ browserHome, browsers: [first], overrides: { extensionDigest: () => 'build-1' } })
  await instance.start()
  // Chrome keeps the worker it registered first; only a reinstall picks up new files.
  assert.deepEqual(first.methods().slice(0, 4), ['Browser.getVersion', 'Extensions.loadUnpacked', 'Target.getTargets', 'Target.attachToTarget'])
  assert.ok(first.methods().indexOf('Extensions.uninstall') < first.methods().lastIndexOf('Extensions.loadUnpacked'))
  assert.equal(first.methods().filter((method) => method === 'Extensions.loadUnpacked').length, 2)
  assert.ok(handlers.evaluated.some((expression) => expression === 'chrome.storage.local.set({"siteMemories":{"example.com":{"captureCount":2}}}).then(() => \'ok\')'))
  assert.equal(readLoadedExtensionBuild(browserHome), 'build-1')
  await instance.stop()

  const second = fakeBrowser()
  const again = manager({ browserHome, browsers: [second], overrides: { extensionDigest: () => 'build-1' } })
  await again.instance.start()
  assert.equal(second.methods().includes('Extensions.uninstall'), false)
  assert.equal(second.methods().filter((method) => method === 'Extensions.loadUnpacked').length, 1)
  await again.instance.stop()
})

test('a browser that cannot reinstall the extension still starts and retries next time', async () => {
  const browserHome = tempDir()
  const logs = []
  const browser = fakeBrowser({ handlers: { 'Extensions.uninstall': () => { throw new Error("'Extensions.uninstall' wasn't found") } } })
  const { instance } = manager({ browserHome, browsers: [browser], overrides: { extensionDigest: () => 'build-2', log: (line) => logs.push(line) } })
  const status = await instance.start()
  assert.equal(status.status, 'running')
  assert.ok(logs.some((line) => line.includes('could not update the extension')))
  assert.equal(readLoadedExtensionBuild(browserHome), null)
  await instance.stop()
})

test('the extension build digest covers file paths and contents', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'background'))
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}')
  fs.writeFileSync(path.join(dir, 'background', 'service-worker.js'), 'v1')
  const first = extensionBuildDigest(dir)
  assert.equal(extensionBuildDigest(dir), first)
  fs.writeFileSync(path.join(dir, 'background', 'service-worker.js'), 'v2')
  assert.notEqual(extensionBuildDigest(dir), first)
})

test('shows the window on-screen for sign-in and hides it again', async () => {
  const browser = fakeBrowser()
  const { instance } = manager({ browsers: [browser] })
  await instance.start()
  assert.equal(await instance.hasVisibleWindow(), false)
  await instance.show()
  assert.deepEqual(browser.boundsSet()[0], { left: 120, top: 80, width: 1280, height: 860 })
  assert.ok(browser.methods().includes('Target.activateTarget'))
  assert.equal(await instance.hasVisibleWindow(), true)
  await instance.hide()
  assert.deepEqual(browser.boundsSet().at(-1), { left: OFFSCREEN_POSITION, top: OFFSCREEN_POSITION })
  assert.equal(await instance.hasVisibleWindow(), false)
  await instance.stop()
})

test('show() also moves a window whose parked position Chrome clamped', async () => {
  // Real Chrome reports -32000 back as about -18725 on Windows.
  const browser = fakeBrowser({ bounds: { left: -18725, top: -18725, windowState: 'normal' } })
  const { instance } = manager({ browsers: [browser] })
  await instance.start()
  await instance.show()
  assert.deepEqual(browser.boundsSet(), [{ left: 120, top: 80, width: 1280, height: 860 }])
  await instance.stop()
})

test('hide() leaves off-screen and minimized windows alone', async () => {
  const parked = fakeBrowser()
  const first = manager({ browsers: [parked] })
  await first.instance.start()
  await first.instance.hide()
  assert.deepEqual(parked.boundsSet(), [])
  await first.instance.stop()

  // Restoring a minimized window would bring it to the front.
  const minimized = fakeBrowser({ bounds: { left: 100, top: 100, windowState: 'minimized' } })
  const second = manager({ browsers: [minimized] })
  await second.instance.start()
  await second.instance.hide()
  assert.deepEqual(minimized.boundsSet(), [])
  assert.equal(await second.instance.hasVisibleWindow(), false)
  await second.instance.stop()

  const maximized = fakeBrowser({ bounds: { left: 0, top: 0, windowState: 'maximized' } })
  const third = manager({ browsers: [maximized] })
  await third.instance.start()
  await third.instance.hide()
  assert.deepEqual(maximized.boundsSet(), [{ windowState: 'normal' }, { left: OFFSCREEN_POSITION, top: OFFSCREEN_POSITION }])
  await third.instance.stop()
})

test('captureTarget screenshots one page over its own session and always detaches', async () => {
  // SOI + SOF0 (800×600) + EOI.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]).toString('base64')
  let failCapture = false
  const browser = fakeBrowser({ handlers: {
    'Target.attachToTarget': (params) => ({ sessionId: `session-${params.targetId}` }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } }),
    'Page.captureScreenshot': () => { if (failCapture) throw new Error('Target closed'); return { data: jpeg } },
  } })
  const { instance } = manager({ browsers: [browser] })
  await instance.start()
  const shot = await instance.captureTarget('page-7')
  assert.deepEqual([shot.width, shot.height, shot.data], [800, 600, jpeg])
  const forPage = (method) => browser.requests.filter((request) => request.method === method)
  assert.deepEqual(forPage('Target.attachToTarget').at(-1).params, { targetId: 'page-7', flatten: true })
  assert.equal(forPage('Page.captureScreenshot').at(-1).sessionId, 'session-page-7')
  assert.deepEqual(forPage('Target.detachFromTarget').at(-1).params, { sessionId: 'session-page-7' })

  failCapture = true
  await assert.rejects(instance.captureTarget('page-8'), /Target closed/)
  assert.deepEqual(forPage('Target.detachFromTarget').at(-1).params, { sessionId: 'session-page-8' })
  await assert.rejects(instance.captureTarget(''), /缺少截图目标/)
  await instance.stop()
  await assert.rejects(instance.captureTarget('page-7'), /未运行/)
})

test('reports a profile used by another process and retries without killing it', async () => {
  const handedOver = fakeBrowser({ exitOnLaunch: 0, handlers: { 'Browser.getVersion': () => { throw new Error('closed') } } })
  // Never answers: the profile owner keeps running elsewhere.
  handedOver.child.stdio[3] = new Writable({ write(_chunk, _encoding, done) { done() } })
  const { instance, launches, killed } = manager({ browsers: [handedOver] })
  const seen = new Set()
  const watch = setInterval(() => seen.add(instance.getStatus().status), 1)
  await instance.start()
  await tick()
  await sleep(30)
  clearInterval(watch)
  assert.ok(seen.has('profile_in_use'), [...seen].join(','))
  assert.ok(launches.length >= 2, 'retries later')
  // The launcher already exited after handing over; nothing is killed.
  assert.deepEqual(killed, [])
  await instance.stop()
})

test('restarts after the browser exits and gives up after repeated failed starts', async () => {
  const { instance, launches } = manager()
  await instance.start()
  launches[0].browser.child.exit(1)
  await sleep(40)
  assert.equal(instance.getStatus().status, 'running')
  assert.equal(launches.length, 2)
  await instance.stop()

  const failing = () => fakeBrowser({ handlers: { 'Extensions.loadUnpacked': () => { throw new Error('extension rejected') } } })
  const broken = manager({ browsers: Array.from({ length: 8 }, failing) })
  await broken.instance.start()
  await sleep(150)
  assert.deepEqual(broken.instance.getStatus(), { status: 'error', browser: 'Chrome', extensionLoaded: false, cdpReady: false, detail: 'extension rejected' })
  assert.equal(broken.launches.length, 5)
  await broken.instance.stop()
})

test('stays unavailable without a browser or extension and never spawns', async () => {
  const noBrowser = manager({ findExecutable: () => null })
  assert.equal((await noBrowser.instance.start()).status, 'unavailable')
  const noExtension = manager({ extensionDir: null })
  assert.equal((await noExtension.instance.start()).status, 'unavailable')
  assert.equal(noBrowser.launches.length + noExtension.launches.length, 0)
})

// ── BrowserHost ─────────────────────────────────────────────────────────────

/** Manager double: `start()` reaches `startStatus`; the extension connects `connectAfterMs` later. */
function fakeManager({ startStatus = 'running', visible = false } = {}) {
  const calls = []
  const fake = {
    status: 'stopped',
    visible,
    calls,
    get isRunning() { return fake.status === 'running' },
    getStatus: () => ({ status: fake.status, browser: 'Chrome', extensionLoaded: fake.status === 'running' }),
    async start() { calls.push('start'); fake.status = startStatus; fake.options?.onStatusChange(fake.getStatus()); return fake.getStatus() },
    async stop() { calls.push('stop'); fake.status = 'stopped'; return fake.getStatus() },
    async restart() { calls.push('restart'); fake.status = startStatus; return fake.getStatus() },
    // Like the real manager, show() starts a browser that is not running.
    async show() { calls.push('show'); fake.status = 'running'; return fake.getStatus() },
    async hide() { calls.push('hide'); return fake.getStatus() },
    async hasVisibleWindow() { return fake.visible },
  }
  return fake
}

function host({ env = { WEWORKER_BROWSER_MODE: 'dedicated' }, manager: fake = fakeManager(), connectAfterMs = 0, ...options } = {}) {
  const browserHome = tempDir()
  let connected = false
  const instance = new BrowserHost({
    env,
    browserHome,
    resolveExtensionDir: () => 'C:/weworker-fixtures/extension',
    isDedicatedConnected: () => connected,
    createManager: (managerOptions) => {
      fake.options = managerOptions
      // The extension says hello some time after the browser is ready.
      const start = fake.start
      fake.start = async () => {
        const status = await start()
        if (status.status === 'running') setTimeout(() => { connected = true }, connectAfterMs)
        return status
      }
      return fake
    },
    idleStopMs: 0,
    extensionConnectTimeoutMs: 100,
    pollMs: 2,
    ...options,
  })
  return { instance, fake, browserHome, setConnected: (value) => { connected = value } }
}

test('system mode never creates or starts a browser', async () => {
  const { instance, fake } = host({ env: { WEWORKER_BROWSER_MODE: 'system' } })
  assert.equal(await instance.ensureReady(), false)
  assert.deepEqual(fake.calls, [])
  assert.equal(instance.status().status, 'stopped')
  await assert.rejects(instance.control('show'), /我自己的 Chrome/)
  assert.equal((await instance.control('hide')).mode, 'system')
  assert.deepEqual(fake.calls, [])
})

test('dedicated mode starts the browser on demand and waits for its extension', async () => {
  const { instance, fake, browserHome } = host({ connectAfterMs: 10 })
  assert.equal(await instance.ensureReady(), true)
  assert.deepEqual(fake.calls, ['start'])
  assert.equal(fake.options.instanceToken, instance.token)
  assert.equal(fake.options.extensionDir, 'C:/weworker-fixtures/extension')
  assert.equal(fake.options.browserHome, browserHome)
  // Already connected: no second start.
  assert.equal(await instance.ensureReady(), true)
  assert.deepEqual(fake.calls, ['start'])
  assert.deepEqual(instance.status(), { mode: 'dedicated', modeLocked: true, status: 'running', browser: 'Chrome', extensionLoaded: true, extensionConnected: true, activeTasks: 0 })
})

test('ensureReady explains why the browser is not usable', async () => {
  const unavailable = host({ manager: fakeManager({ startStatus: 'unavailable' }) })
  await assert.rejects(unavailable.instance.ensureReady(), /WeWorker 浏览器未就绪：未找到 Chrome/)
  const silent = host({ connectAfterMs: 10_000 })
  await assert.rejects(silent.instance.ensureReady(), /扩展未连接/)
})

test('an unused browser stops after the idle time unless a window is on-screen or a client is attached', async () => {
  const idle = host({ idleStopMs: 20 })
  await idle.instance.ensureReady()
  await sleep(60)
  assert.deepEqual(idle.fake.calls, ['start', 'stop'])

  const visible = host({ idleStopMs: 20, manager: fakeManager({ visible: true }) })
  await visible.instance.ensureReady()
  await sleep(60)
  assert.deepEqual(visible.fake.calls, ['start'])
  visible.fake.visible = false
  await sleep(40)
  assert.deepEqual(visible.fake.calls, ['start', 'stop'])

  const attached = host({ idleStopMs: 20 })
  const desktop = {}
  await attached.instance.control('attach', {}, desktop)
  await sleep(60)
  assert.deepEqual(attached.fake.calls, ['start'], 'attach starts the browser and keeps it')
  attached.instance.detach(desktop)
  await sleep(60)
  assert.deepEqual(attached.fake.calls, ['start', 'stop'])
})

test('switching the mode persists it and stops or starts the browser', async () => {
  const { instance, fake, browserHome } = host({ env: {} })
  const desktop = {}
  await instance.control('attach', {}, desktop)
  assert.deepEqual(fake.calls, ['start'])
  assert.equal((await instance.control('set_mode', { mode: 'system' })).mode, 'system')
  assert.deepEqual(fake.calls, ['start', 'stop'])
  assert.deepEqual(readBrowserMode({ env: {}, browserHome }), { mode: 'system', locked: false })
  await instance.control('set_mode', { mode: 'dedicated' })
  await tick()
  assert.deepEqual(fake.calls, ['start', 'stop', 'start'])

  const locked = host()
  await assert.rejects(locked.instance.control('set_mode', { mode: 'system' }), /环境变量/)
})

test('control actions map to the browser, hide never starts it, and status changes are published', async () => {
  const { instance, fake } = host()
  const published = []
  instance.onStatus((status) => published.push(status.status))
  await instance.control('hide')
  assert.deepEqual(fake.calls, [])
  await instance.control('show')
  await instance.control('hide')
  await instance.control('restart')
  await instance.control('stop')
  assert.deepEqual(fake.calls, ['show', 'hide', 'restart', 'stop'])
  await instance.control('start')
  assert.ok(published.includes('running'))
  await assert.rejects(instance.control('open_url'), /Unknown browser action/)
  await instance.shutdown()
  assert.equal(fake.calls.at(-1), 'stop')
})
