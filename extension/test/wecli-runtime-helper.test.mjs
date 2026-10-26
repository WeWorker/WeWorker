import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { runServiceWorkerInContext } from './helpers/adapter-test-loader.mjs'

const ROOT = process.cwd()

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeEvent() {
  const listeners = []
  return {
    addListener(listener) {
      listeners.push(listener)
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args)
    },
    listeners,
  }
}

function loadInjector(runtimeResponse = { ok: true, result: { value: 'ok' } }) {
  const runtimeMessages = []
  const fetchCalls = []
  const onMessage = makeEvent()
  const window = {
    __webmcpInjectorLoaded: false,
    addEventListener() {},
    location: { hostname: 'itsm.example.com', href: 'https://itsm.example.com/' },
  }
  const context = vm.createContext({
    AbortController,
    JSON,
    Map,
    PerformanceObserver: undefined,
    Promise,
    Set,
    URL,
    chrome: {
      runtime: {
        onMessage,
        async sendMessage(message) {
          runtimeMessages.push(message)
          return runtimeResponse
        },
      },
    },
    console: { log() {}, warn() {}, error() {} },
    document: {
      body: null,
      forms: [],
      scripts: [],
      title: 'test',
      querySelectorAll: () => [],
    },
    fetch: async (input, init = {}) => {
      fetchCalls.push({ input, init })
      return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      }
    },
    location: window.location,
    performance: { getEntriesByType: () => [] },
    setTimeout: () => 0,
    clearTimeout() {},
    window,
  })

  vm.runInContext(readFileSync(join(ROOT, 'extension/content/injector.js'), 'utf8'), context)
  return { runtime: window.__webmcpWecliRuntime, runtimeMessages, fetchCalls }
}

test('injector exposes browser-safe WeCLI runtime utilities', async () => {
  const { runtime, runtimeMessages, fetchCalls } = loadInjector()

  const validated = runtime.validateArgs({
    count: 2,
    enabled: true,
    'dry-run': true,
  }, {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      enabled: { type: 'boolean' },
    },
    required: ['count'],
    additionalProperties: false,
  })
  assert.equal(validated.count, 2)
  assert.equal(validated['dry-run'], true)

  assert.throws(
    () => runtime.requireConfirmation({}, 'itsm.approve'),
    (error) => error.code === 'CONFIRMATION_REQUIRED',
  )
  assert.deepEqual(plain(runtime.requireConfirmation({ 'dry-run': true }, 'itsm.approve')), { confirmed: false, dryRun: true })
  assert.equal(runtime.requireConfirmation({ __confirmed: true }, 'itsm.approve'), true)

  assert.deepEqual(await runtime.fetchJson('/api/tickets'), { ok: true })
  assert.equal(fetchCalls.at(-1).input, '/api/tickets')
  assert.equal(fetchCalls.at(-1).init.credentials, 'include')
  assert.equal(fetchCalls.at(-1).init.headers.Accept, 'application/json')
  assert.deepEqual(await runtime.requestPrivileged('storage_get', { key: 'token' }), { value: 'ok' })
  assert.deepEqual(plain(runtimeMessages.at(-1)), {
    type: 'wecli_runtime_request',
    action: 'storage_get',
    payload: { key: 'token' },
  })

  assert.deepEqual(await runtime.setFileInput('input[type=file]', ['C:\\tmp\\a.csv']), { value: 'ok' })
  assert.deepEqual(plain(runtimeMessages.at(-1)), {
    type: 'wecli_runtime_request',
    action: 'set_file_input',
    payload: { selector: 'input[type=file]', files: ['C:\\tmp\\a.csv'] },
  })

  const failing = loadInjector({ ok: false, error: { code: 'NO_TAB', message: 'Missing tab', details: { domain: 'x' } } }).runtime
  await assert.rejects(
    () => failing.requestPrivileged('storage_get', {}),
    (error) => error.code === 'NO_TAB' && error.details.domain === 'x',
  )
})

function loadServiceWorker(options = {}) {
  const runtimeOnMessage = makeEvent()
  const cookieCalls = []
  const debuggerCalls = []
  const debuggerAttachCalls = []
  const debuggerDetachCalls = []
  const executeCalls = []
  const downloadCalls = []
  const createCalls = []
  const removeCalls = []
  const updateCalls = []
  const browserFetchResult = options.browserFetchResult
  const tabs = [{
    active: true,
    status: 'complete',
    ...(options.tab || { id: 7, url: 'https://itsm.example.com/workbench', windowId: 1 }),
  }]

  class FakeWebSocket {
    static OPEN = 1
    constructor() {
      this.readyState = FakeWebSocket.OPEN
    }
    addEventListener() {}
    send() {}
  }

  const chrome = {
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    alarms: { create() {}, onAlarm: makeEvent() },
    cookies: {
      async getAll(query) {
        cookieCalls.push(query)
        return [{ name: 'sid', value: 'secret', domain: '.example.com' }]
      },
    },
    debugger: {
      attach: async (target) => { debuggerAttachCalls.push(target) },
      detach: async (target) => { debuggerDetachCalls.push(target) },
      sendCommand: async (target, command, params = {}) => {
        debuggerCalls.push({ target, command, params })
        if (command === 'Network.getCookies') {
          return {
            cookies: [{
              name: 'SESSION',
              value: 'secret',
              domain: '.example.com',
              path: '/',
              secure: true,
              httpOnly: true,
            }],
          }
        }
        if (command === 'Network.getResponseBody') {
          return {
            body: options.networkResponseBase64
              ? Buffer.from(options.networkResponseBody || '', 'utf8').toString('base64')
              : options.networkResponseBody || '',
            base64Encoded: Boolean(options.networkResponseBase64),
          }
        }
        if (command === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (command === 'DOM.querySelector') return { nodeId: 2 }
        if (command === 'DOM.setFileInputFiles') return {}
        return {}
      },
      onEvent: makeEvent(),
      onDetach: makeEvent(),
    },
    downloads: {
      async download(options) {
        downloadCalls.push(options)
        return 88
      },
    },
    runtime: {
      getManifest: () => ({ version: 'test' }),
      getURL: (value) => `chrome-extension://test/${value}`,
      onMessage: runtimeOnMessage,
      reload() {},
    },
    scripting: {
      async executeScript(options) {
        executeCalls.push(options)
        if (options.world === 'MAIN' && options.args?.[0]?.url) {
          return [{
            result: {
              ok: true,
              status: 200,
              url: options.args[0].url,
              redirected: false,
              headers: { 'content-type': 'application/json' },
              body: '{"retCode":0,"data":{"data":[]}}',
              ...(browserFetchResult || {}),
            },
          }]
        }
        return [{ result: 'stored-value' }]
      },
    },
    sidePanel: { setPanelBehavior() {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      captureVisibleTab: async () => '',
      create: async (options) => {
        createCalls.push(options)
        const tab = { id: 8, windowId: 1, status: 'complete', ...options }
        tabs.push(tab)
        return tab
      },
      get: async (id) => tabs.find((tab) => tab.id === id),
      onRemoved: makeEvent(),
      onUpdated: makeEvent(),
      query: async () => tabs,
      reload: async () => {},
      remove: async (id) => {
        removeCalls.push(id)
        const index = tabs.findIndex((tab) => tab.id === id)
        if (index >= 0) tabs.splice(index, 1)
      },
      sendMessage: async () => ({}),
      update: async (id, update) => {
        updateCalls.push({ id, update })
        const tab = tabs.find((candidate) => candidate.id === id)
        if (tab) {
          Object.assign(tab, update, { status: 'complete' })
          chrome.tabs.onUpdated.emit(id, { status: 'complete' }, tab)
        }
        return { id, ...update }
      },
    },
    windows: { update: async () => ({}) },
  }

  const context = vm.createContext({
    Blob,
    Error,
    Map,
    Promise,
    Set,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
    WebSocket: FakeWebSocket,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    chrome,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url) => {
      const adapterHost = new URL(tabs[0].url).hostname
      if (String(url).endsWith(`/adapters/${adapterHost}/manifest.json`) && options.runtimeAllowedHosts) {
        return { ok: true, json: async () => ({ runtime_allowed_hosts: options.runtimeAllowedHosts }) }
      }
      return { ok: false, json: async () => [] }
    },
    setTimeout: () => 0,
    clearTimeout() {},
  })
  runServiceWorkerInContext(context, { repoRoot: ROOT })

  const request = (action, payload = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wecli_runtime_request "${action}" timed out`)), 100)
    const handled = runtimeOnMessage.listeners.at(-1)(
      { type: 'wecli_runtime_request', action, payload },
      { tab: tabs[0] },
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
    )
    if (handled !== true) {
      clearTimeout(timer)
      reject(new Error(`wecli_runtime_request "${action}" was not handled`))
    }
  })

  const directRequest = (action, payload = {}, route = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wecli_direct_runtime_request "${action}" timed out`)), 100)
    const handled = runtimeOnMessage.listeners.at(-1)(
      {
        type: 'wecli_direct_runtime_request',
        action,
        payload,
        route: {
          adapterId: 'itsm.example.com',
          routeDomain: 'itsm.example.com',
          tabDomain: 'itsm.example.com',
          ...route,
        },
      },
      {},
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
    )
    if (handled !== true) {
      clearTimeout(timer)
      reject(new Error(`wecli_direct_runtime_request "${action}" was not handled`))
    }
  })

  return {
    context,
    request,
    directRequest,
    cookieCalls,
    debuggerCalls,
    debuggerAttachCalls,
    debuggerDetachCalls,
    executeCalls,
    downloadCalls,
    createCalls,
    removeCalls,
    updateCalls,
    tabs,
  }
}

test('direct authentication response detection covers HTTP, SSO HTML, and application timeout codes', () => {
  const { context } = loadServiceWorker()

  assert.equal(context.isDirectAuthenticationResponse({ status: 401 }), true)
  assert.equal(context.isDirectAuthenticationResponse({
    status: 200,
    url: 'https://passport.example.com/login',
    body: '<html>login</html>',
  }), true)
  assert.equal(context.isDirectAuthenticationResponse({
    status: 200,
    url: 'https://itsm.example.com/api',
    body: '{"retCode":3001,"retDetail":"登录超时，请重新登录!"}',
  }), true)
  assert.equal(context.isDirectAuthenticationResponse({
    status: 200,
    url: 'https://itsm.example.com/api',
    body: '{"retCode":0,"data":[]}',
  }), false)
})

test('service worker provides host-scoped privileged runtime helpers', async () => {
  const { request, cookieCalls, debuggerCalls, executeCalls, downloadCalls } = loadServiceWorker()

  assert.equal((await request('cookies_get', { url: 'https://itsm.example.com/api' })).ok, true)
  assert.equal(cookieCalls.length, 1)

  assert.deepEqual(plain(await request('storage_get', { key: 'token', area: 'local' })), {
    ok: true,
    result: { value: 'stored-value' },
  })
  assert.equal(executeCalls.at(-1).target.tabId, 7)

  assert.deepEqual(plain(await request('download', {
    url: 'https://itsm.example.com/export.csv',
    filename: 'exports/tickets.csv',
  })), {
    ok: true,
    result: { downloadId: 88, filename: 'exports/tickets.csv' },
  })
  assert.equal(downloadCalls.length, 1)
  assert.equal(downloadCalls.at(-1).filename, 'exports/tickets.csv')

  assert.deepEqual(plain(await request('set_file_input', {
    selector: 'input[type=file]',
    files: ['C:\\tmp\\a.csv'],
  })), {
    ok: true,
    result: { success: true, message: '已通过 CDP 设置 1 个文件', files: ['C:\\tmp\\a.csv'] },
  })
  const fileCall = debuggerCalls.find((call) => call.command === 'DOM.setFileInputFiles')
  assert.equal(fileCall.target.tabId, 7)
  assert.deepEqual(fileCall.params.files, ['C:\\tmp\\a.csv'])

  const rejected = await request('download', { url: 'https://evil.example/file' })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /host/i)
})

test('service worker allows ProjectDemo runtime helpers to read SDL sibling-domain cookies', async () => {
  const { request, cookieCalls } = loadServiceWorker({
    tab: { id: 7, url: 'https://project.example.com/workbench', windowId: 1 },
    runtimeAllowedHosts: ['sdl.example.com'],
  })

  assert.equal((await request('cookies_get', { url: 'http://sdl.example.com/' })).ok, true)
  assert.deepEqual(plain(cookieCalls), [{ url: 'http://sdl.example.com/' }])

  const rejected = await request('cookies_get', { url: 'https://evil.example/' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'HOST_NOT_ALLOWED')
})

test('service worker captures only matching same-host Adapter responses and releases its debugger', async () => {
  const payload = JSON.stringify({ status: 0, data: { context: { finished: true }, items: [] } })
  const worker = loadServiceWorker({
    tab: { id: 7, url: 'https://api.example.com/online/list', windowId: 1 },
    networkResponseBody: payload,
    networkResponseBase64: true,
  })
  const started = await worker.request('network_capture_start', {
    pattern: '/api/query',
  })
  assert.equal(started.ok, true)
  const emitDebuggerEvent = worker.context.chrome.debugger.onEvent.listeners[0]
  await emitDebuggerEvent({ tabId: 7 }, 'Network.requestWillBeSent', {
    requestId: 'ignored',
    request: { url: 'https://evil.example/api/query', method: 'POST' },
  })
  await emitDebuggerEvent({ tabId: 7 }, 'Network.requestWillBeSent', {
    requestId: 'response',
    request: { url: 'https://api.example.com/api/query', method: 'POST' },
  })
  await emitDebuggerEvent({ tabId: 7 }, 'Network.responseReceived', {
    requestId: 'response',
    response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } },
  })
  await emitDebuggerEvent({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'response', encodedDataLength: payload.length })
  const captured = await worker.request('network_capture_read', { waitMs: 0, finish: true })
  assert.equal(captured.ok, true)
  assert.deepEqual(plain(captured.result.entries), [{
    kind: 'cdp',
    url: 'https://api.example.com/api/query',
    method: 'POST',
    timestamp: captured.result.entries[0].timestamp,
    responseStatus: 200,
    responseContentType: 'application/json',
    responsePreview: payload,
    responseBodyFullSize: payload.length,
    responseBodyTruncated: false,
  }])
  assert.deepEqual(plain(worker.debuggerAttachCalls), [{ tabId: 7 }])
  assert.deepEqual(plain(worker.debuggerDetachCalls), [{ tabId: 7 }])
  assert.equal(worker.context.ensureCdpState(7).entries.length, 0)
})

test('Adapter response capture enforces its body limit and keeps a borrowed debugger attached', async () => {
  const payload = 'x'.repeat(8 * 1024 * 1024 + 1)
  const worker = loadServiceWorker({
    tab: { id: 7, url: 'https://api.example.com/online/list', windowId: 1 },
    networkResponseBody: payload,
  })
  await worker.context.ensureCdpAttached(7)
  const started = await worker.request('network_capture_start', { pattern: 'query' })
  assert.equal(started.ok, true)
  const emitDebuggerEvent = worker.context.chrome.debugger.onEvent.listeners[0]
  await emitDebuggerEvent({ tabId: 7 }, 'Network.requestWillBeSent', {
    requestId: 'large-response',
    request: { url: 'https://api.example.com/api/query', method: 'POST' },
  })
  await emitDebuggerEvent({ tabId: 7 }, 'Network.responseReceived', {
    requestId: 'large-response',
    response: { status: 200, mimeType: 'application/json', headers: {} },
  })
  await emitDebuggerEvent({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'large-response' })
  const captured = await worker.request('network_capture_read', { finish: true })
  assert.equal(captured.ok, true)
  assert.equal(captured.result.entries[0].responseBodyFullSize, payload.length)
  assert.equal(captured.result.entries[0].responsePreview.length, 8 * 1024 * 1024)
  assert.equal(captured.result.entries[0].responseBodyTruncated, true)
  assert.deepEqual(plain(worker.debuggerAttachCalls), [{ tabId: 7 }])
  assert.deepEqual(plain(worker.debuggerDetachCalls), [])
})

test('direct browser_fetch reuses the existing ITSM tab and browser credentials', async () => {
  const {
    directRequest,
    cookieCalls,
    createCalls,
    debuggerAttachCalls,
    debuggerDetachCalls,
    debuggerCalls,
  } = loadServiceWorker()

  const response = await directRequest('cookies_get', {
    url: 'https://itsm.example.com/itsm/request/getRequestList.spr',
  })

  assert.equal(response.ok, true)
  assert.equal(response.result.source, 'browser-debugger')
  assert.equal(response.result.cookies[0].name, 'SESSION')
  assert.equal(cookieCalls.length, 0)
  assert.equal(createCalls.length, 0)
  assert.deepEqual(plain(debuggerAttachCalls), [{ tabId: 7 }])
  assert.deepEqual(plain(debuggerDetachCalls), [{ tabId: 7 }])
  assert.ok(debuggerCalls.some((call) => call.command === 'Network.getCookies'))
})

test('direct browser fetch closes its inactive background tab when the target site is not open', async () => {
  const {
    directRequest,
    createCalls,
    updateCalls,
    removeCalls,
    executeCalls,
    tabs,
  } = loadServiceWorker({
    tab: { id: 7, url: 'https://example.com/workbench', windowId: 1 },
  })
  const payload = {
    url: 'https://itsm.example.com/itsm/request/getRequestList.spr',
    options: {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: '{"currentPage":1}',
    },
  }

  const first = await directRequest('browser_fetch', payload)
  assert.equal(first.ok, true)
  assert.equal(first.result.replay.transport, 'browser-page')
  assert.equal(first.result.replay.tabId, 8)
  assert.deepEqual(plain(createCalls), [{ url: 'about:blank', active: false }])
  assert.deepEqual(plain(updateCalls.slice(0, 2)), [
    { id: 8, update: { url: 'https://itsm.example.com/', active: false } },
  ])
  assert.equal(executeCalls.at(-1).target.tabId, 8)
  assert.equal(tabs.find((tab) => tab.id === 7).active, true)
  assert.equal(tabs.find((tab) => tab.id === 8), undefined)
  assert.deepEqual(removeCalls, [8])

  const second = await directRequest('browser_fetch', payload)
  assert.equal(second.ok, true)
  assert.equal(second.result.replay.tabId, 8)
  assert.equal(createCalls.length, 2)
  assert.deepEqual(plain(updateCalls.slice(1)), [
    { id: 8, update: { url: 'https://itsm.example.com/', active: false } },
  ])
  assert.deepEqual(removeCalls, [8, 8])
})

test('direct browser_fetch rejects a redirected response from an unapproved host', async () => {
  const { directRequest } = loadServiceWorker({
    browserFetchResult: { redirected: true, url: 'https://evil.example/leak' },
  })

  const response = await directRequest('browser_fetch', { url: 'https://itsm.example.com/api' })

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'HOST_NOT_ALLOWED')
  assert.deepEqual(plain(response.error.details), {
    tabHost: 'itsm.example.com',
    targetHost: 'evil.example',
  })
})

test('direct storage_get refreshes localStorage through a temporary inactive tab', async () => {
  const {
    directRequest,
    createCalls,
    updateCalls,
    removeCalls,
    executeCalls,
    tabs,
  } = loadServiceWorker({
    tab: { id: 7, url: 'https://example.com/workbench', windowId: 1 },
  })

  const response = await directRequest('storage_get', {
    key: 'token',
    area: 'local',
    url: 'http://platform-uat.example.com/workflow/publish/history',
  }, {
    adapterId: 'platform-uat.example.com',
    routeDomain: 'platform-uat.example.com',
    tabDomain: 'platform-uat.example.com',
  })

  assert.deepEqual(plain(response), {
    ok: true,
    result: { value: 'stored-value' },
  })
  assert.deepEqual(plain(createCalls), [{ url: 'about:blank', active: false }])
  assert.deepEqual(plain(updateCalls), [{
    id: 8,
    update: { url: 'http://platform-uat.example.com/', active: false },
  }])
  assert.equal(executeCalls.at(-1).target.tabId, 8)
  assert.equal(tabs.find((tab) => tab.id === 7).active, true)
  assert.equal(tabs.find((tab) => tab.id === 8), undefined)
  assert.deepEqual(removeCalls, [8])
})

test('cache-only storage reads never consult or create a business page', async () => {
  const f = loadServiceWorker();
  const stored = {};
  f.context.chrome.storage.local.get = async () => stored;
  f.context.chrome.storage.local.set = async value => Object.assign(stored, value);
  const payload = { key: 'example_token', area: 'local', url: 'https://itsm.example.com/', cacheOnly: true };
  const missing = await f.directRequest('storage_get', payload);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'PAGE_CONTEXT_REQUIRED');
  assert.equal(f.createCalls.length, 0);
  assert.equal(f.executeCalls.length, 0);
  const populated = await f.directRequest('storage_get', { ...payload, cacheOnly: false });
  assert.equal(populated.ok, true);
  const executions = f.executeCalls.length;
  const cached = await f.directRequest('storage_get', payload);
  assert.deepEqual(plain(cached), plain(populated));
  assert.equal(f.executeCalls.length, executions);
  assert.equal(f.createCalls.length, 0);
});
