import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createHostAdapterRuntime } from '../background/host-adapter-runtime.js';
import { runServiceWorkerInContext } from "./helpers/service-worker-test-loader.mjs";

const ROOT = process.cwd();

test('explicit structural analysis capture includes JSON telemetry without changing default filtering', () => {
  const worker = loadServiceWorker();
  const entries = [
    { url: 'https://example.com/api/list', responseContentType: 'application/json' },
    { url: 'https://example.com/telemetry/search', responseContentType: 'application/json' },
    { url: 'https://example.com/telemetry/script.js', responseContentType: 'application/javascript' },
  ];
  assert.equal(worker.context.formatNetworkEntries(entries, { businessOnly: true }).entries.length, 1);
  const analyzed = worker.context.formatNetworkEntries(entries, { businessOnly: true, includeTelemetry: true });
  assert.equal(analyzed.entries.length, 2);
  assert.equal(analyzed.entries.some(entry => entry.url.endsWith('.js')), false);
});

test('exploration and browser operations share the refresh queue; dialogs can unblock it', async () => {
  const worker = loadServiceWorker({ tabs: [{ id: 7, url: 'https://example.com/', status: 'complete' }] });
  const runtime = createHostAdapterRuntime({});
  worker.context.getHostAdapterRuntime = () => runtime;
  for (const [type, implementation] of [['exploration_intercept_read', 'executeInterceptRead'], ['exploration_page_query', 'executePageQuery'],
    ['exploration_observe_page', 'executePageSource'], ['exploration_capture_passive', 'runExploreWorkflow'], ['browser_execute', 'executeBrowserCommand']]) {
    let finish; const order = [];
    worker.context[implementation] = async () => { order.push('query'); await new Promise(resolve => finish = resolve); return { ok: true }; };
    const operation = worker.context.handleNativeMessage({ type, tabId: 7, command: 'click', id: 'example-query' });
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    const refresh = runtime.exclusive(7, async () => order.push('refresh'));
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['query']);
    if (type === 'browser_execute') {
      worker.context.executeBrowserCommand = async msg => { order.push(msg.command); return { ok: true }; };
      for (const command of ['dialog', 'downloads', 'events', 'wait']) await worker.context.handleNativeMessage({ type, tabId: 7, command, args: { kind: 'download' }, id: 'example-observer-' + command });
      assert.deepEqual(order, ['query', 'dialog', 'downloads', 'events', 'wait']);
    }
    finish(); await operation; await refresh; assert.equal(order.at(-1), 'refresh');
  }
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
  };
}

function loadServiceWorker({ tabs = [], tabResponse = null, staticAdapters = {}, managedCatalog = null, cookies = [] } = {}) {
  const runtimeOnMessage = makeEvent();
  const sentToTabs = [];
  const nativeMessages = [];
  const websocketInstances = [];
  const staticAdapterIds = Object.keys(staticAdapters).sort();

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    static CLOSING = 2;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = {};
      websocketInstances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }

    send(data) {
      nativeMessages.push(JSON.parse(data));
    }

    async emit(type, event = {}) {
      return await this.listeners[type]?.(event);
    }
  }

  const chrome = {
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setTitle() {},
    },
    alarms: {
      create() {},
      onAlarm: makeEvent(),
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
      onEvent: makeEvent(),
      onDetach: makeEvent(),
    },
    downloads: {
      download: async () => 1,
    },
    cookies: {
      getAll: async () => cookies,
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      getURL: (path) => `chrome-extension://test/${path}`,
      lastError: null,
      onMessage: runtimeOnMessage,
      reload() {},
    },
    scripting: {
      executeScript: async () => {},
    },
    sidePanel: {
      setPanelBehavior() {},
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      captureVisibleTab: async () => "data:image/png;base64,",
      create: async ({ url }) => { const tab = { id: 999, url, status: "complete" }; tabs.push(tab); return tab; },
      get: async (id) => tabs.find((tab) => tab.id === id) ?? null,
      onRemoved: makeEvent(),
      onUpdated: makeEvent(),
      query(queryInfo, callback) {
        if (typeof callback === "function") {
          callback(tabs);
          return undefined;
        }
        return Promise.resolve([...tabs]);
      },
      reload: async () => {},
      remove: async () => {},
      sendMessage: async (tabId, message) => {
        sentToTabs.push({ tabId, message });
        if (typeof tabResponse === "function") {
          return tabResponse(tabId, message);
        }
        if (tabResponse) return tabResponse;
        return { result: { ok: true, tabId, toolName: message.toolName } };
      },
      update: async (tabId) => ({ id: tabId }),
    },
    windows: {
      update: async () => ({}),
    },
  };

  const context = vm.createContext({
    Blob,
    Error,
    Map,
    Promise,
    Set,
    URL,
    WebSocket: FakeWebSocket,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    chrome,
    console: {
      log() {},
      warn() {},
      error() {},
    },
    fetch: async () => ({ ok: false, json: async () => [] }),
    setTimeout: (fn) => {
      if (typeof fn === "function") fn();
      return 0;
    },
    clearTimeout() {},
  });

  context.fetch = async (url) => {
    const path = String(url).replace("chrome-extension://test/", "");
    if (path === "adapters/index.json") {
      return { ok: true, json: async () => staticAdapterIds };
    }
    const indexMatch = path.match(/^adapters\/([^/]+)\/index\.js$/);
    if (indexMatch) {
      return { ok: Boolean(staticAdapters[indexMatch[1]]), text: async () => "" };
    }
    const generatedMatch = path.match(/^adapters\/([^/]+)\/wecli\.generated\.json$/);
    if (generatedMatch) {
      const adapter = staticAdapters[generatedMatch[1]];
      if (!adapter?.generated) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => adapter.generated };
    }
    const manifestMatch = path.match(/^adapters\/([^/]+)\/manifest\.json$/);
    if (manifestMatch) {
      const adapter = staticAdapters[manifestMatch[1]];
      if (!adapter) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => adapter.manifest || ({ id: manifestMatch[1] }) };
    }
    return { ok: false, json: async () => ({}), text: async () => "" };
  };

  runServiceWorkerInContext(context, { repoRoot: ROOT });
  context.requestBridge = async () => null;
  if (managedCatalog) {
    vm.runInContext("bridgeCapabilities = ['adapter_catalog_v1']", context);
    context.requestBridge = async () => ({ ok: true, result: managedCatalog });
    context.getHostAdapterRuntime = () => ({ execute: async (_tab, _manifest, _url, call) => call() });
  }

  const flushStaticRoutes = async () => {
    await context.loadStaticToolRoutes();
  };

  const registerTools = (tools, tab) => new Promise((resolve) => {
    const listener = runtimeOnMessage.listeners.at(-1);
    listener(
      { type: "register_tools", tools },
      { tab: { id: tab.id, url: tab.url } },
      resolve,
    );
  });

  const callNativeTool = async (toolName, args = {}) => {
    nativeMessages.length = 0;
    await websocketInstances[0].emit("message", {
      data: JSON.stringify({ type: "call_tool", id: "call-1", toolName, args }),
    });
    return nativeMessages.at(-1);
  };

  const listNativeTools = async () => {
    nativeMessages.length = 0;
    await websocketInstances[0].emit("message", {
      data: JSON.stringify({ type: "list_tools", id: "list-1" }),
    });
    return nativeMessages.at(-1);
  };

  const sendNative = async (message) => {
    nativeMessages.length = 0;
    await websocketInstances[0].emit("message", { data: JSON.stringify(message) });
    return nativeMessages.at(-1);
  };

  return { registerTools, callNativeTool, listNativeTools, sendNative, sentToTabs, flushStaticRoutes, context, tabs };
}

test("adapter refresh waits for the active background call before closing offscreen", async () => {
  const worker = loadServiceWorker();
  const events = [];
  worker.context.loadAdapterManifestAnywhere = async () => null;
  worker.context.chrome.offscreen = { closeDocument: async () => events.push('close') };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const call = worker.context.runDirectToolExclusive(async () => {
    events.push('started');
    await pending;
    events.push('result');
    return 'completed';
  });
  await new Promise(setImmediate);
  const refresh = worker.context.refreshAdapterTabs('fixture');
  await new Promise(setImmediate);
  assert.deepEqual(events, ['started']);
  release();
  assert.equal(await call, 'completed');
  await refresh;
  assert.deepEqual(events, ['started', 'result', 'close']);
});

test('batch refresh reserves later tab queues before waiting on the first tab', async () => {
  const worker = loadServiceWorker({ tabs: [7, 8].map(id => ({ id, url: 'https://example.com/', status: 'complete' })) });
  const runtime = createHostAdapterRuntime({}), order = [];
  worker.context.getHostAdapterRuntime = () => runtime;
  worker.context.loadAdapterManifestAnywhere = async () => ({ id: 'example.com', match: ['example.com'] });
  worker.context.sendTabMessage = async () => ({});
  worker.context.waitForTabLoad = async () => {};
  worker.context.injectAdapters = async () => {};
  worker.context.waitForDomainTools = async () => null;
  worker.context.chrome.tabs.get = async id => ({ id, url: 'https://example.com/', status: 'complete' });
  worker.context.chrome.tabs.reload = async id => { order.push('reload-' + id); };
  let release;
  const active = runtime.exclusive(7, () => new Promise(resolve => { release = resolve; }));
  await new Promise(setImmediate);
  const refresh = worker.context.refreshAdapterTabs('example.com');
  await new Promise(setImmediate);
  const later = runtime.exclusive(8, async () => order.push('later-exploration'));
  await new Promise(setImmediate); assert.deepEqual(order, []);
  release(); await active; await refresh; await later;
  assert.deepEqual(order, ['reload-7', 'reload-8', 'later-exploration']);
});

test('catalog refresh uses one tab snapshot and reload per document even when several adapters match', async () => {
  const worker = loadServiceWorker(), runtime = createHostAdapterRuntime({});
  const tabs = [{ id: 7, url: 'https://example.com/', status: 'complete' }], reloads = [], cleared = [];
  let queries = 0;
  worker.context.getHostAdapterRuntime = () => runtime;
  worker.context.chrome.tabs.query = async () => { queries++; return [...tabs]; };
  worker.context.chrome.tabs.get = async id => tabs.find(tab => tab.id === id);
  worker.context.loadAdapterManifestAnywhere = async id => ({ id, match: ['example.com'] });
  worker.context.sendTabMessage = async (id, msg) => { cleared.push([id, msg.siteKey]); return {}; };
  worker.context.waitForTabLoad = async () => {};
  worker.context.injectAdapters = async () => {};
  worker.context.waitForDomainTools = async () => null;
  worker.context.chrome.tabs.reload = async id => {
    reloads.push(id);
    tabs.push({ id: 8, url: 'https://example.com/new', status: 'complete' });
  };
  const result = await worker.context.refreshAdapterTabBatch(['example-first', 'example-second', 'example-first']);
  assert.equal(queries, 1); assert.deepEqual(reloads, [7]); assert.equal(result.refreshedTabs, 1);
  assert.deepEqual(cleared, [[7, 'example-first'], [7, 'example-second']]);
});

test('reconnect snapshots serialize and skip only the successfully refreshed identical catalog', async () => {
  const worker = loadServiceWorker(), calls = [];
  let catalog = { profile: 'public', revision: 1, managedNames: ['example'], adapters: [{ name: 'example', _hostSnapshot: { profile: 'public', digest: 'example-first' } }] };
  worker.context.doRefreshRegistry = async () => ({ adapters: ['example'] });
  worker.context.getHostAdapterClient = () => ({ catalog: async () => catalog });
  worker.context.refreshAdapterTabBatch = async ids => { calls.push([...ids]); return { refreshedTabs: 1 }; };
  const concurrent = await Promise.all([worker.context.refreshAdapterState({ sync: true }), worker.context.refreshAdapterState({ sync: true })]);
  assert.deepEqual(concurrent.map(result => result.refreshedTabs), [1, 0]); assert.equal(calls.length, 1);
  catalog = { ...catalog, adapters: [{ name: 'example', _hostSnapshot: { profile: 'public', digest: 'example-changed' } }] };
  assert.equal((await worker.context.refreshAdapterState({ sync: true })).refreshedTabs, 1);
  assert.equal((await worker.context.refreshAdapterState({ adapters: ['example'] })).refreshedTabs, 0);
  catalog = { ...catalog, revision: 2 };
  worker.context.refreshAdapterTabBatch = async () => { throw Error('example refresh failed'); };
  await assert.rejects(worker.context.refreshAdapterState({ sync: true }), /failed/);
  worker.context.refreshAdapterTabBatch = async () => ({ refreshedTabs: 1 });
  assert.equal((await worker.context.refreshAdapterState({ sync: true })).refreshedTabs, 1);
  catalog = null;
  assert.equal((await worker.context.refreshAdapterState({ sync: true })).refreshedTabs, 1);
});

test('managed refresh preserves documents, skips current snapshots and reinjects changed packages', async () => {
  const tabs = [7, 8].map(id => ({ id, url: 'https://example.com/', status: 'complete' }));
  const worker = loadServiceWorker({ tabs }), runtime = createHostAdapterRuntime({ bundle: async () => ({}), prepare: async () => {}, clear: async () => {}, inject: async () => {} });
  const manifest = { name: 'example', match: ['example.com'], _hostSnapshot: { profile: 'public', digest: 'example-new' } }, reloads = [];
  await runtime.execute(7, manifest, tabs[0].url);
  await runtime.execute(8, { ...manifest, _hostSnapshot: { ...manifest._hostSnapshot, digest: 'example-old' } }, tabs[1].url);
  worker.context.getHostAdapterRuntime = () => runtime;
  worker.context.chrome.tabs.get = async id => tabs.find(tab => tab.id === id);
  worker.context.chrome.tabs.reload = async id => { reloads.push(id); };
  worker.context.loadAdapterManifestAnywhere = async () => manifest;
  worker.context.sendTabMessage = async () => ({});
  worker.context.waitForTabLoad = async () => {};
  const injections = [];
  worker.context.injectAdapters = async id => { injections.push(id); };
  worker.context.waitForDomainTools = async () => null;
  assert.equal((await worker.context.refreshAdapterTabs('example')).refreshedTabs, 1);
  assert.deepEqual(reloads, []);
  assert.deepEqual(injections, [7, 8]);
});

test('missing or unresolved v2 catalog manifests never authorize document reload', async () => {
  for (const manifest of [null, { name: 'example.com', schema_version: 2, match: ['example.com'] }]) {
    const worker = loadServiceWorker({ tabs: [{ id: 7, url: 'https://example.com/', status: 'complete' }] });
    worker.context.loadAdapterManifestAnywhere = async () => manifest;
    worker.context.chrome.tabs.get = async () => ({ id: 7, url: 'https://example.com/', status: 'complete' });
    const effects = [];
    worker.context.chrome.tabs.reload = async () => effects.push('reload');
    worker.context.sendTabMessage = async () => effects.push('clear');
    worker.context.injectAdapters = async () => effects.push('inject');
    worker.context.waitForDomainTools = async () => null;
    assert.equal((await worker.context.refreshAdapterTabs('example.com')).refreshedTabs, 1);
    assert.deepEqual(effects, ['clear', 'inject']);
  }
});

test('same catalog fingerprint does not suppress a distinct package notification', async () => {
  const worker = loadServiceWorker(), calls = [];
  const catalog = { profile: 'public', revision: 1, managedNames: ['first', 'second'], adapters: [] };
  worker.context.doRefreshRegistry = async () => ({ adapters: ['first', 'second'] });
  worker.context.getHostAdapterClient = () => ({ catalog: async () => catalog });
  worker.context.refreshAdapterTabBatch = async ids => { calls.push([...ids]); return { refreshedTabs: 1 }; };
  assert.equal((await worker.context.refreshAdapterState({ adapters: ['first'] })).refreshedTabs, 1);
  assert.equal((await worker.context.refreshAdapterState({ adapters: ['second'] })).refreshedTabs, 1);
  assert.equal((await worker.context.refreshAdapterState({ sync: true })).refreshedTabs, 0);
  assert.deepEqual(calls, [['first'], ['second']]);
});

test('refresh never clears or reloads a tab that navigated after the catalog snapshot', async () => {
  const worker = loadServiceWorker({ tabs: [{ id: 7, url: 'https://example.com/', status: 'complete' }] });
  worker.context.loadAdapterManifestAnywhere = async () => null;
  worker.context.chrome.tabs.get = async () => ({ id: 7, url: 'https://example.org/', status: 'complete' });
  const effects = [];
  worker.context.chrome.tabs.reload = async () => effects.push('reload');
  worker.context.sendTabMessage = async () => effects.push('clear');
  worker.context.injectAdapters = async () => {};
  worker.context.waitForDomainTools = async () => null;
  assert.equal((await worker.context.refreshAdapterTabs('example.com')).refreshedTabs, 0);
  assert.deepEqual(effects, []);
});

test("managed foreground commands reuse an existing subdomain tab via suffix match", async () => {
  const manifest = { name: 'fixture', match: ['example.com', 'www.example.com'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'read-page', runtime: 'extension', safety: 'read' }] };
  const worker = loadServiceWorker({
    tabs: [{ id: 7, url: 'https://www.example.com/list', status: 'complete' }],
    managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] },
  });
  const executed = [];
  worker.context.getHostAdapterRuntime = () => ({
    execute: async (tabId, _manifest, tabUrl) => { executed.push({ tabId, tabUrl }); return 'fixture-result'; },
  });
  const result = await worker.callNativeTool('fixture.read-page', {});
  assert.equal(result.result, 'fixture-result');
  // route=example.com 精确匹配失败后按后缀复用 www.example.com 标签页，而不是新开（fake create 的 id 是 999）
  assert.equal(executed.length, 1);
  assert.equal(executed[0].tabId, 7);
  assert.equal(executed[0].tabUrl, 'https://www.example.com/list');
});

test("managed foreground tab selection prefers an exact hostname match over suffix matches", async () => {
  const manifest = { name: 'fixture', match: ['example.com', 'www.example.com'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'read-page', runtime: 'extension', safety: 'read', tabDomain: 'www.example.com' }] };
  const worker = loadServiceWorker({
    tabs: [
      { id: 5, url: 'https://shop.example.com/item', status: 'complete' },
      { id: 6, url: 'https://www.example.com/home', status: 'complete' },
    ],
    managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] },
  });
  const executed = [];
  worker.context.getHostAdapterRuntime = () => ({
    execute: async (tabId, _manifest, tabUrl) => { executed.push({ tabId, tabUrl }); return 'fixture-result'; },
  });
  const result = await worker.callNativeTool('fixture.read-page', {});
  assert.equal(result.result, 'fixture-result');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].tabId, 6);
  assert.equal(executed[0].tabUrl, 'https://www.example.com/home');
});

test('page source commands select exact origin/path, reject ambiguity, and never open a fallback page', async () => {
  const manifest = { name: 'fixture', match: ['example.com'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'read-page', runtime: 'extension', safety: 'read', pageRoute: { origin: 'https://example.com', pathname: '/items' } }] };
  const tabs = [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'http://example.com/items' },
    { id: 3, url: 'https://example.com/items?q=example' }];
  const worker = loadServiceWorker({ tabs, managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] } });
  const executed = [];
  worker.context.getHostAdapterRuntime = () => ({ execute: async tabId => { executed.push(tabId); return 'fixture-result'; } });
  assert.equal((await worker.callNativeTool('fixture.read-page')).result, 'fixture-result');
  assert.deepEqual(executed, [3]);
  tabs.push({ id: 4, url: 'https://example.com/items?q=another' });
  assert.equal((await worker.callNativeTool('fixture.read-page')).result.error.code, 'PAGE_SOURCE_AMBIGUOUS');
  tabs[3].active = true;
  assert.equal((await worker.callNativeTool('fixture.read-page')).result, 'fixture-result');
  assert.deepEqual(executed, [3, 4]);
  tabs[2].url = tabs[3].url = 'https://example.com/other';
  assert.equal((await worker.callNativeTool('fixture.read-page')).result.error.code, 'PAGE_SOURCE_ROUTE_MISSING');
  assert.equal(tabs.length, 4);
  assert.deepEqual(executed, [3, 4]);
  manifest.commands[0].pageRoute.additionalPaths = ['/results'];
  tabs[2].url = 'https://example.com/results?q=example';
  assert.equal((await worker.callNativeTool('fixture.read-page')).result, 'fixture-result');
  assert.deepEqual(executed, [3, 4, 3]);
  manifest.commands[0].pageRoute.navigation = { pathname: '/items/:id', pathParameters: [{ segmentIndex: 1, name: 'itemId', description: 'Public item ID' }] };
  tabs[2].url = 'https://example.com/items/007';
  assert.equal((await worker.callNativeTool('fixture.read-page')).result, 'fixture-result');
  tabs[3].url = 'https://example.com/items/008'; tabs[3].active = false;
  assert.equal((await worker.callNativeTool('fixture.read-page')).result.error.code, 'PAGE_SOURCE_AMBIGUOUS');
  tabs[3].url = 'https://example.com/items/%2f';
  assert.equal((await worker.callNativeTool('fixture.read-page')).result, 'fixture-result');
});

test('cross-origin page selection keeps source and destination paths paired with their exact origins', async () => {
  const manifest = { name: 'fixture', match: ['example.com', 'example.org'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'read-page', runtime: 'extension', safety: 'read', pageRoute: { origin: 'https://example.com', pathname: '/entry',
      navigation: { resultOrigin: 'https://example.org:8443', pathname: '/items/:id', pathParameters: [{ segmentIndex: 1, name: 'itemId', description: 'Public item ID' }] } } }] };
  const tabs = [{ id: 1, url: 'https://example.com/items/007' }, { id: 2, url: 'https://example.org:8443/entry' },
    { id: 3, url: 'https://example.org/items/007' }, { id: 4, url: 'https://example.org:8443/items/007' }];
  const worker = loadServiceWorker({ tabs, managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] } });
  const executed = [];
  worker.context.getHostAdapterRuntime = () => ({ execute: async tabId => { executed.push(tabId); return 'fixture-result'; } });
  assert.equal((await worker.callNativeTool('fixture.read-page')).result, 'fixture-result');
  assert.deepEqual(executed, [4]);
  tabs[3].url = 'https://example.org:8443/items/:id';
  assert.equal((await worker.callNativeTool('fixture.read-page')).result.error.code, 'PAGE_SOURCE_ROUTE_MISSING');
  assert.deepEqual(executed, [4]); assert.equal(tabs.length, 4);
});

test('cross-origin preview never substitutes a matching tab for a missing or departed task tab', async () => {
  const route = { origin: 'https://example.com', pathname: '/entry', navigation: { resultOrigin: 'https://example.org', pathname: '/items/:id' } };
  const worker = loadServiceWorker({ tabs: [{ id: 1, url: 'https://example.org/other' }, { id: 2, url: 'https://example.org/items/007' }] });
  worker.context.findGenerationPreviewTab = () => { throw Error('Must not search for a replacement preview tab'); };
  for (const tabId of [1, 999, undefined]) {
    const result = await worker.context.validateGenerationPreview({ previewAdapterId: 'generation_preview_example', siteKey: 'example.com', tabId,
      previewBundle: { manifest: { commands: [{ pageRoute: route }] } } });
    assert.equal(result.passed, false);
  }
  assert.equal(worker.sentToTabs.length, 0);
});

test("managed background calls select the offscreen runner without opening a site tab", async () => {
  const manifest = { name: 'fixture', match: ['example.com'], runtime_allowed_hosts: ['api.example.org'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'read-item', aliases: ['read_item'], runtime: 'extension', safety: 'read', execution: {type:'api',runtime:'background'} }] };
  const worker = loadServiceWorker({ managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] } });
  const calls = [];
  worker.context.getManagedBackgroundRuntime = () => ({ execute: async (...args) => { calls.push(plain(args)); return 'fixture-result'; } });
  const result = await worker.callNativeTool('fixture.read_item', {count:'007'});
  assert.equal(result.result, 'fixture-result');
  assert.equal(worker.sentToTabs.length, 0);
  assert.equal(calls[0][1].id, 'read-item');
  assert.deepEqual(calls[0][2], {count:'007'});
  assert.deepEqual(calls[0][3].declaredHosts, ['example.com','api.example.org']);
});

test("managed write opt-out comes from the pinned package, not caller arguments", async () => {
  for (const requires_confirmation of [undefined, true, false]) {
    const manifest = { name: 'fixture', match: ['example.com'],
      _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
      commands: [{ id: 'reserve', aliases: ['reserve_room'], runtime: 'extension', safety: 'write',
        requires_confirmation, execution: { type: 'api', runtime: 'background' } }] };
    const worker = loadServiceWorker({ managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] } });
    const calls = [];
    worker.context.getManagedBackgroundRuntime = () => ({ execute: async (...args) => { calls.push(args); return 'reserved'; } });
    const result = await worker.callNativeTool('fixture.reserve_room', { requires_confirmation: false });
    if (requires_confirmation === false) assert.equal(result.result, 'reserved');
    else { assert.match(result.error, /confirmation/); assert.equal(calls.length, 0); }
  }
});

test("Ctrip suggestion and session-check commands run in the background with no site tab", async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'adapters/ctrip.com/manifest.json'), 'utf8'));
  manifest._hostSnapshot = { profile: 'public', digest: 'fixture-digest' };
  const worker = loadServiceWorker({ managedCatalog: { available: true, managedNames: [manifest.name], adapters: [manifest] } });
  const calls = [];
  worker.context.getManagedBackgroundRuntime = () => ({ execute: async (...args) => { calls.push(plain(args)); return 'fixture-result'; } });
  for (const command of ['search', 'hotel-suggest', 'whoami']) {
    const result = await worker.callNativeTool(`ctrip.com.${command}`, command === 'whoami' ? {} : { query: 'Example City' });
    assert.equal(result.result, 'fixture-result');
    assert.equal(calls.at(-1)[1].id, command);
  }
  assert.equal(worker.sentToTabs.length, 0);
});

test("background API fetch can return an authentication error without opening a tab", async () => {
  const worker = loadServiceWorker();
  worker.context.runRuntimeBridgeRequest = async () => ({ status: 403, ok: false, url: 'https://example.com/api', body: '' });
  worker.context.runDirectBrowserFetch = async () => { throw new Error('unexpected browser fallback'); };
  const result = await worker.context.runDirectBackendFetch({ url: 'https://example.com/api', browserFallback: false });
  assert.equal(result.status, 403);
});

test("background Ctrip session check reads allowed cookies without opening a tab", async () => {
  const worker = loadServiceWorker();
  const queried = [];
  worker.context.chrome.cookies = { getAll: async (options) => {
    queried.push(options);
    return [{ name: 'login_uid', value: 'fixture-only', domain: '.ctrip.com' }];
  } };
  vm.runInContext("directRuntimeContext = { routeDomain: 'www.ctrip.com', tabDomain: 'www.ctrip.com', declaredHosts: ['www.ctrip.com'], allowedHosts: ['www.ctrip.com'] }", worker.context);
  const result = await worker.context.handleDirectRuntimeRequest('cookies_get', {
    url: 'https://www.ctrip.com/', browserDebugger: false, names: ['login_uid', 'AHeadUserInfo'],
  });
  assert.equal(result.cookies.length, 1);
  assert.deepEqual(plain(queried), [{ url: 'https://www.ctrip.com/' }]);
  assert.equal(worker.sentToTabs.length, 0);
});

test("managed helper targets must remain in the current package's declared hosts", () => {
  const { context } = loadServiceWorker();
  const call = {declaredHosts:['app.example.com','*.api.example.org']};
  for (const payload of [{url:'https://app.example.com/path'}, {domain:'.api.example.org'}, {hostname:'one.api.example.org'}]) {
    assert.doesNotThrow(() => context.assertManagedRuntimeRequest('backend_fetch',payload,call));
  }
  for (const payload of [{url:'https://example.com/'}, {hostname:'other.example.org'}, {domains:['app.example.com','other.example.org']}, {url:'file:///fixture'}, {url:'https://user:placeholder@app.example.com/'}]) {
    assert.throws(() => context.assertManagedRuntimeRequest('backend_fetch',payload,call));
  }
});

test("managed command aliases dispatch the canonical handler with the same write gate", async () => {
  const manifest = { name: 'fixture', match: ['example.com'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'write-item', aliases: ['write_item'], runtime: 'extension', safety: 'write' }] };
  const worker = loadServiceWorker({ tabs: [{ id: 7, url: 'https://example.com/', status: 'complete' }],
    managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] } });
  const blocked = await worker.callNativeTool('fixture.write_item');
  assert.match(JSON.stringify(blocked), /confirmation/);
  assert.equal(worker.sentToTabs.length, 0);
  const result = await worker.callNativeTool('fixture.write_item', { __confirmed: true, count: '007' });
  assert.equal(result.result.toolName, 'fixture.write-item');
  assert.deepEqual(plain(worker.sentToTabs.at(-1).message.args), { __confirmed: true, count: '007' });
});

test("screenshot_target points at the tab of the last Adapter call and selects it", async () => {
  const manifest = { name: 'fixture', match: ['example.com'],
    _hostSnapshot: { name: 'fixture', profile: 'public', digest: 'fixture-digest' },
    commands: [{ id: 'pay', aliases: ['pay'], runtime: 'extension', safety: 'read' }] };
  // The window's active tab is the start-up about:blank; the command runs in a background tab.
  const worker = loadServiceWorker({
    tabs: [
      { id: 1, windowId: 5, url: 'about:blank', active: true, status: 'complete' },
      { id: 7, windowId: 5, url: 'https://example.com/checkout?session=placeholder', active: false, status: 'complete' },
    ],
    managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] },
  });
  const updates = [];
  worker.context.chrome.tabs.update = async (tabId, props) => { updates.push([tabId, plain(props)]); return { id: tabId }; };
  worker.context.chrome.debugger.getTargets = async () => [{ id: 'target-1', type: 'page', tabId: 1 }, { id: 'target-7', type: 'page', tabId: 7 }];
  await worker.callNativeTool('fixture.pay');
  assert.equal(worker.sentToTabs.at(-1).tabId, 7);

  const reply = await worker.sendNative({ type: 'screenshot_target', id: 'shot-1', traceID: 'fixturetrace1' });
  assert.equal(reply.type, 'call_tool_result');
  assert.deepEqual(plain(reply.result), { tabId: 7, url: 'https://example.com/checkout', reason: 'last_tool_call', targetId: 'target-7' });
  assert.deepEqual(updates, [[7, { active: true }]]);
  const trace = worker.context.getTraceLogs('fixturetrace1').join('\n');
  assert.match(trace, /截图目标: tab=7 \(last_tool_call\) https:\/\/example\.com\/checkout，在窗口内选中/);
});

function loadInjector() {
  const runtimeMessages = [];
  const onMessage = makeEvent();
  const window = {
    __webmcpInjectorLoaded: false,
    addEventListener() {},
    location: { hostname: "itsm.example.com", href: "https://itsm.example.com/" },
  };
  const context = vm.createContext({
    JSON,
    Map,
    PerformanceObserver: undefined,
    Promise,
    Set,
    URL,
    chrome: {
      runtime: {
        onMessage,
        sendMessage(message) {
          runtimeMessages.push(message);
        },
      },
    },
    console: {
      log() {},
      warn() {},
      error() {},
    },
    document: {
      body: null,
      forms: [],
      scripts: [],
      title: "test",
      querySelectorAll: () => [],
    },
    location: window.location,
    performance: {
      getEntriesByType: () => [],
    },
    setTimeout() {},
    window,
  });

  const source = readFileSync(join(ROOT, "extension/content/injector.js"), "utf8");
  vm.runInContext(source, context, { filename: "injector.js" });
  return { window, runtimeMessages };
}

test("content injector reports explicit ToolRoute metadata while keeping handler private", () => {
  const { window, runtimeMessages } = loadInjector();

  window.__webmcpRegister({
    name: "ITSM",
    tools: [{
      name: "itsm.example.com.list_tickets",
      publicName: "itsm.ls",
      adapterId: "itsm.example.com",
      routeDomain: "itsm.example.com",
      tabDomain: "workbench.itsm.example.com",
      excludeTabDomain: "pay.itsm.example.com",
      description: "List tickets",
      parameters: { type: "object" },
      generationSource: {
        version: "api-source-v1",
        fingerprint: "api-v1-test",
        sourceKind: "passive_list",
        risk: { level: "read", confidence: 0.97 },
      },
      handler: () => ({ ok: true }),
    }],
  });

  const tools = runtimeMessages.at(-1).tools;
  assert.deepEqual(plain(tools), [{
    name: "itsm.ls",
    publicName: "itsm.ls",
    handlerName: "itsm.example.com.list_tickets",
    adapterId: "itsm.example.com",
    routeDomain: "itsm.example.com",
    tabDomain: "workbench.itsm.example.com",
    excludeTabDomain: "pay.itsm.example.com",
    description: "List tickets",
    parameters: { type: "object" },
    generationSource: {
      version: "api-source-v1",
      fingerprint: "api-v1-test",
      sourceKind: "passive_list",
      risk: { level: "read", confidence: 0.97 },
    },
  }]);
});

test("content injector applies adapter route metadata to short and legacy ITSM tools", () => {
  const { window, runtimeMessages } = loadInjector();

  window.__webmcpRegister({
    name: "ITSM",
    adapterId: "itsm.example.com",
    routeDomain: "itsm.example.com",
    tabDomain: "itsm.example.com",
    tools: [
      {
        name: "itsm.example.com.ls",
        publicName: "itsm.ls",
        handlerName: "itsm.example.com.ls",
        description: "List tickets",
        parameters: {},
        handler: () => [],
      },
      {
        name: "itsm.example.com.check_login_status",
        description: "Check login",
        parameters: {},
        handler: () => ({ logged_in: true }),
      },
    ],
  });

  const tools = runtimeMessages.at(-1).tools;
  assert.equal(tools.length, 2);
  for (const tool of tools) {
    assert.equal(tool.adapterId, "itsm.example.com");
    assert.equal(tool.routeDomain, "itsm.example.com");
    assert.equal(tool.tabDomain, "itsm.example.com");
  }
});

test("service worker keeps legacy ITSM routing stable after short tools register", async () => {
  const tab = { id: 12, windowId: 1, url: "https://itsm.example.com/" };
  const { registerTools, callNativeTool, sentToTabs } = loadServiceWorker({ tabs: [tab] });

  const registration = await registerTools([
    {
      name: "itsm.ls",
      publicName: "itsm.ls",
      handlerName: "itsm.example.com.ls",
      adapterId: "itsm.example.com",
      routeDomain: "itsm.example.com",
      tabDomain: "itsm.example.com",
      description: "List tickets",
      parameters: {},
    },
    {
      name: "itsm.example.com.check_login_status",
      publicName: "itsm.example.com.check_login_status",
      handlerName: "itsm.example.com.check_login_status",
      adapterId: "itsm.example.com",
      routeDomain: "itsm.example.com",
      tabDomain: "itsm.example.com",
      description: "Check login",
      parameters: {},
    },
  ], tab);

  assert.equal(registration.ok, true);
  const response = await callNativeTool("itsm.example.com.check_login_status");

  assert.equal(response.type, "call_tool_result");
  assert.equal(sentToTabs.at(-1).tabId, 12);
  assert.equal(sentToTabs.at(-1).message.toolName, "itsm.example.com.check_login_status");
});

test("service worker routes public itsm.ls to the mapped handler on its constrained tab domain", async () => {
  const tab = { id: 11, windowId: 1, url: "https://workbench.itsm.example.com/" };
  const { registerTools, callNativeTool, sentToTabs } = loadServiceWorker({ tabs: [tab] });

  const registration = await registerTools([{
    name: "itsm.ls",
    publicName: "itsm.ls",
    handlerName: "itsm.example.com.list_tickets",
    adapterId: "itsm.example.com",
    routeDomain: "itsm.example.com",
    tabDomain: "workbench.itsm.example.com",
    description: "List tickets",
    parameters: {},
  }], tab);

  assert.equal(registration.ok, true);
  const response = await callNativeTool("itsm.ls", { status: "open" });

  assert.equal(response.type, "call_tool_result");
  assert.equal(sentToTabs.at(-1).tabId, 11);
  assert.deepEqual(plain(sentToTabs.at(-1).message), {
    type: "call_tool",
    toolName: "itsm.example.com.list_tickets",
    args: { status: "open" },
  });
});

test("service worker allows multiple public sites to route through pace.example.com", async () => {
  const tab = { id: 21, windowId: 1, url: "https://pace.example.com/" };
  const { registerTools, callNativeTool, sentToTabs } = loadServiceWorker({ tabs: [tab] });

  const registration = await registerTools([
    {
      name: "pace-pipeline.run",
      publicName: "pace-pipeline.run",
      handlerName: "pace.example.com.pipeline_run",
      adapterId: "pace.example.com",
      routeDomain: "pace.example.com",
      description: "Run pipeline",
      parameters: {},
    },
    {
      name: "pace-publishorder.run",
      publicName: "pace-publishorder.run",
      handlerName: "pace.example.com.publishorder_run",
      adapterId: "pace.example.com",
      routeDomain: "pace.example.com",
      description: "Run publish order",
      parameters: {},
    },
  ], tab);

  assert.equal(registration.ok, true);

  await callNativeTool("pace-pipeline.run");
  assert.equal(sentToTabs.at(-1).message.toolName, "pace.example.com.pipeline_run");

  await callNativeTool("pace-publishorder.run");
  assert.equal(sentToTabs.at(-1).message.toolName, "pace.example.com.publishorder_run");
});

test("service worker rejects duplicate public names with deterministic route details", async () => {
  const tabs = [
    { id: 31, windowId: 1, url: "https://itsm.example.com/" },
    { id: 32, windowId: 1, url: "https://project.example.com/" },
  ];
  const { registerTools } = loadServiceWorker({ tabs });

  assert.equal((await registerTools([{
    name: "itsm.ls",
    publicName: "itsm.ls",
    handlerName: "itsm.example.com.list_tickets",
    adapterId: "itsm.example.com",
    routeDomain: "itsm.example.com",
    description: "List tickets",
    parameters: {},
  }], tabs[0])).ok, true);

  const response = await registerTools([{
    name: "itsm.ls",
    publicName: "itsm.ls",
    handlerName: "project.example.com.list_demands",
    adapterId: "project.example.com",
    routeDomain: "project.example.com",
    description: "List demands",
    parameters: {},
  }], tabs[1]);

  assert.equal(response.ok, false);
  assert.match(response.error, /Duplicate public tool name "itsm\.ls"/);
  assert.match(response.error, /existing=.*adapterId=itsm\.example\.com.*handlerName=itsm\.example\.com\.list_tickets.*routeDomain=itsm\.example\.com/);
  assert.match(response.error, /incoming=.*adapterId=project\.example\.com.*handlerName=project\.example\.com\.list_demands.*routeDomain=project\.example\.com/);
});

test("service worker preserves legacy domain.action routing", async () => {
  const tab = { id: 41, windowId: 1, url: "https://www.jd.com/" };
  const { registerTools, callNativeTool, sentToTabs } = loadServiceWorker({ tabs: [tab] });

  assert.equal((await registerTools([{
    name: "jd.com.search_products",
    description: "Search products",
    parameters: {},
  }], tab)).ok, true);

  const response = await callNativeTool("jd.com.search_products", { keyword: "phone" });

  assert.equal(response.type, "call_tool_result");
  assert.equal(sentToTabs.at(-1).tabId, 41);
  assert.equal(sentToTabs.at(-1).message.toolName, "jd.com.search_products");
});

test("service worker keeps live route for static commands that are not direct capable", async () => {
  const tab = { id: 61, windowId: 1, url: "https://api.example.com/" };
  const worker = loadServiceWorker({
    tabs: [tab],
    staticAdapters: {
      "api.example.com": {
        generated: {
          registeredCommands: [{
            publicName: "api.list",
            handlerName: "api.example.com.direct_list",
            adapterId: "api.example.com",
            routeDomain: "api.example.com",
            tabDomain: "api.example.com",
            navigateBefore: true,
            parameters: { type: "object", properties: {} },
          }],
        },
      },
    },
  });
  await worker.flushStaticRoutes();

  assert.equal((await worker.registerTools([{
    name: "api.list",
    publicName: "api.list",
    handlerName: "api.example.com.live_list",
    adapterId: "api.example.com",
    routeDomain: "api.example.com",
    tabDomain: "api.example.com",
    description: "Live API list",
    parameters: { type: "object", properties: {} },
  }], tab)).ok, true);

  const response = await worker.callNativeTool("api.list", {});

  assert.equal(response.type, "call_tool_result");
  assert.equal(worker.sentToTabs.at(-1).tabId, 61);
  assert.equal(worker.sentToTabs.at(-1).message.toolName, "api.example.com.live_list");
});

test("service worker validates static direct route arguments before offscreen execution", async () => {
  const worker = loadServiceWorker({
    staticAdapters: {
      "api.example.com": {
        generated: {
          registeredCommands: [{
            publicName: "api.direct",
            handlerName: "api.example.com.direct",
            adapterId: "api.example.com",
            routeDomain: "api.example.com",
            tabDomain: "api.example.com",
            browser: true,
            navigateBefore: false,
            parameters: {
              type: "object",
              properties: {
                id: { type: "integer" },
              },
              required: ["id"],
              additionalProperties: false,
            },
          }],
        },
      },
    },
  });
  await worker.flushStaticRoutes();

  const response = await worker.callNativeTool("api.direct", {});

  assert.equal(response.type, "call_tool_error");
  assert.match(response.error, /Missing required argument: id/);
});

test("service worker includes static direct tools in list_tools when no live tab registered", async () => {
  const worker = loadServiceWorker({
    staticAdapters: {
      "api.example.com": {
        generated: {
          registeredCommands: [{
            publicName: "api.direct",
            handlerName: "api.example.com.direct",
            adapterId: "api.example.com",
            routeDomain: "api.example.com",
            tabDomain: "api.example.com",
            description: "Static direct API",
            browser: true,
            navigateBefore: false,
            parameters: {
              type: "object",
              properties: {
                id: { type: "integer" },
              },
              required: ["id"],
              additionalProperties: false,
            },
          }],
        },
      },
    },
  });
  await worker.flushStaticRoutes();

  const response = await worker.listNativeTools();
  const tool = response.tools.find((item) => item.name === "api.direct");

  assert.equal(response.type, "list_tools_result");
  assert.deepEqual(plain(tool), {
    name: "api.direct",
    publicName: "api.direct",
    handlerName: "api.example.com.direct",
    adapterId: "api.example.com",
    routeDomain: "api.example.com",
    tabDomain: "api.example.com",
    directCapable: true,
    executionMode: "direct",
    description: "Static direct API",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    domain: "api.example.com",
    tabCount: 0,
    direct: true,
  });
});

test("service worker smoke covers list_tools, missing tab, and login failure", async () => {
  const tab = { id: 51, windowId: 1, url: "https://itsm.example.com/" };
  const worker = loadServiceWorker({
    tabs: [tab],
    tabResponse: { error: "LOGIN_REQUIRED: ITSM session is missing" },
  });

  assert.equal((await worker.registerTools([{
    name: "itsm.ls",
    publicName: "itsm.ls",
    handlerName: "itsm.example.com.list_tickets",
    adapterId: "itsm.example.com",
    routeDomain: "itsm.example.com",
    description: "List tickets",
    parameters: {},
  }], tab)).ok, true);

  const listed = await worker.listNativeTools();
  assert.equal(listed.type, "list_tools_result");
  assert.equal(listed.tools.some((tool) => tool.name === "itsm.ls"), true);

  const loginFailure = await worker.callNativeTool("itsm.ls");
  assert.equal(loginFailure.type, "call_tool_error");
  assert.match(loginFailure.error, /LOGIN_REQUIRED/)

  const missingTabWorker = loadServiceWorker({ tabs: [] });
  const missingTab = await missingTabWorker.callNativeTool("itsm.ls");
  assert.equal(missingTab.type, "call_tool_error");
  // 自动打开站点后仍未就绪：提示可能需登录
  assert.match(missingTab.error, /已自动打开站点|未找到域名/)
});

test("managed page calls open the declared route without user setup and do not replay transport errors", async () => {
  const manifest = { name: 'fixture', match: ['example.com'], _hostSnapshot: { profile: 'public', digest: 'fixture' },
    commands: [{ id: 'list', runtime: 'extension', routeDomain: 'example.com', safety: 'read' }] };
  const worker = loadServiceWorker({ managedCatalog: { available: true, managedNames: ['fixture'], adapters: [manifest] } });
  const result = await worker.callNativeTool('fixture.list');
  assert.equal(result.result.tabId, 999);
  assert.equal((await worker.context.chrome.tabs.get(999)).url, 'http://example.com/');
  let calls = 0;
  worker.context.chrome.tabs.sendMessage = async () => { calls++; throw new Error('The message port closed before a response was received.'); };
  const failed = await worker.callNativeTool('fixture.list');
  assert.match(failed.error, /message port closed/);
  assert.equal(calls, 1);
});

test("managed page calls do not select helper subdomain tabs as the execution page", async () => {
  const manifest = {
    name: 'gitee.com',
    match: ['gitee.com', 'www.gitee.com'],
    runtime_allowed_hosts: ['so.gitee.com'],
    _hostSnapshot: { profile: 'public', digest: 'fixture' },
    commands: [{ id: 'search', runtime: 'extension', routeDomain: 'gitee.com', safety: 'read' }],
  };
  const worker = loadServiceWorker({
    tabs: [{ id: 10, url: 'https://so.gitee.com/?q=weworker', status: 'complete' }],
    managedCatalog: { available: true, managedNames: ['gitee.com'], adapters: [manifest] },
  });
  const result = await worker.callNativeTool('gitee.com.search');
  assert.equal(result.result.tabId, 999);
  assert.equal((await worker.context.chrome.tabs.get(999)).url, 'http://gitee.com/');
});

test("managed page calls hand an existing SSO tab to login instead of opening a second business tab", async () => {
  const worker = loadServiceWorker({
    tabs: [{ id: 40, url: 'https://passport.example.com/login?return=%2Forders', status: 'complete' }],
    managedCatalog: loginCatalog,
  });
  const result = await worker.callNativeTool('fixture.example.com.list');
  assert.equal(result.type, 'call_tool_error');
  assert.equal(result.code, 'AUTH_REQUIRED', JSON.stringify(result));
  assert.deepEqual(plain(result.auth), {
    site: loginManifest.name,
    phase: 'navigation',
    pageUrl: 'https://passport.example.com/login',
  });
  assert.equal(worker.tabs.length, 1);
});

// ─── Website login: structured AUTH_REQUIRED and the Bridge's login messages ───

const loginManifest = {
  name: 'fixture.example.com', match: ['www.example.com'], _hostSnapshot: { profile: 'public', digest: 'fixture' },
  auth: {
    login_url: 'https://passport.example.com/login', login_hosts: ['passport.example.com'],
    check: { cookies: { url: 'https://www.example.com/', all: ['session_id'] } },
  },
  commands: [
    { id: 'list', runtime: 'extension', routeDomain: 'www.example.com', safety: 'read' },
    { id: 'read', runtime: 'extension', safety: 'read', execution: { type: 'api', runtime: 'background' } },
  ],
};
const loginCatalog = { available: true, managedNames: [loginManifest.name], adapters: [loginManifest] };

test("a page step that lands on the declared SSO host reports AUTH_REQUIRED before Adapter code runs", async () => {
  const worker = loadServiceWorker({ tabs: [{ id: 5, url: 'https://passport.example.com/login?return=%2Forders', status: 'complete' }], managedCatalog: loginCatalog });
  await assert.rejects(worker.context.waitForManagedPageReady(5, loginManifest, true, 2000), (error) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    // The return URL (which may carry tokens) never leaves the extension.
    assert.deepEqual(plain(error.details), { site: loginManifest.name, phase: 'navigation', pageUrl: 'https://passport.example.com/login' });
    return true;
  });
  // A terminal navigation (an old `login` command) may still open the login page.
  worker.tabs[0].url = 'https://www.example.com/orders';
  assert.equal(await worker.context.waitForManagedPageReady(5, loginManifest, true, 2000), 'https://www.example.com/orders');
});

test("Adapter AUTH_REQUIRED and HTTP 401 reach the Bridge as structured errors", async () => {
  const page = loadServiceWorker({
    tabs: [{ id: 6, url: 'https://www.example.com/', status: 'complete' }], managedCatalog: loginCatalog,
    tabResponse: { error: 'Session expired', code: 'AUTH_REQUIRED', details: { phase: 'handler' } },
  });
  const fromPage = await page.callNativeTool('fixture.example.com.list');
  assert.equal(fromPage.type, 'call_tool_error');
  assert.equal(fromPage.code, 'AUTH_REQUIRED');
  assert.deepEqual(plain(fromPage.auth), { site: loginManifest.name, phase: 'handler' });

  const background = loadServiceWorker({ managedCatalog: loginCatalog });
  background.context.getManagedBackgroundRuntime = () => ({ execute: async () => {
    throw Object.assign(new Error('HTTP 401'), { code: 'HTTP_ERROR', details: { status: 401 } });
  } });
  const fromApi = await background.callNativeTool('fixture.example.com.read');
  assert.equal(fromApi.code, 'AUTH_REQUIRED');
  assert.equal(fromApi.auth.site, loginManifest.name);

  const other = loadServiceWorker({ tabs: [{ id: 7, url: 'https://www.example.com/', status: 'complete' }], managedCatalog: loginCatalog,
    tabResponse: { error: 'Bad input', code: 'INVALID_ARGS' } });
  const invalid = await other.callNativeTool('fixture.example.com.list');
  assert.equal(invalid.code, 'INVALID_ARGS');
  assert.equal(invalid.auth, undefined);
});

test("auth_open_login reuses a redirected login tab, opens only declared login pages, and auth_check reports the cookie check", async () => {
  const worker = loadServiceWorker({ tabs: [], managedCatalog: loginCatalog, cookies: [] });
  // An undeclared URL is ignored in favour of the declared login page.
  const opened = await worker.sendNative({ type: 'auth_open_login', id: 'o1', site: loginManifest.name, url: 'https://attacker.example.net/login' });
  assert.equal(opened.type, 'call_tool_result');
  assert.equal(opened.result.url, 'https://passport.example.com/login');
  let checked = await worker.sendNative({ type: 'auth_check', id: 'c1', site: loginManifest.name });
  const { fingerprint: before, ...first } = plain(checked.result);
  assert.deepEqual(first, { loginTab: { open: true, url: 'https://passport.example.com/login', onLoginPage: true }, cookies: false });

  worker.tabs[0].url = 'https://www.example.com/home';
  worker.context.chrome.cookies.getAll = async () => [{ name: 'session_id', value: 'fixture-session' }, { name: 'other', value: 'x' }];
  checked = await worker.sendNative({ type: 'auth_check', id: 'c2', site: loginManifest.name });
  const { fingerprint: after, ...second } = plain(checked.result);
  assert.deepEqual(second, { loginTab: { open: true, url: 'https://www.example.com/home', onLoginPage: false }, cookies: true });
  // Only a hash of the checked cookies leaves the extension; a new session changes it.
  assert.match(after, /^[0-9a-f]{8}$/);
  assert.notEqual(after, before);
  assert.equal(JSON.stringify(checked).includes('fixture-session'), false);

  const redirected = loadServiceWorker({ tabs: [{ id: 30, url: 'https://passport.example.com/login?x=1', status: 'complete', active: false }], managedCatalog: loginCatalog });
  const reused = await redirected.sendNative({ type: 'auth_open_login', id: 'o2', site: loginManifest.name });
  assert.equal(reused.result.tabId, 30);

  const redirecting = loadServiceWorker({ tabs: [{ id: 31, url: 'https://www.example.com/', pendingUrl: 'https://passport.example.com/login?next=%2F', status: 'loading', active: false }], managedCatalog: loginCatalog });
  const observed = await redirecting.sendNative({ type: 'auth_observe_open', id: 'observe-1', site: loginManifest.name, tabId: 31 });
  assert.deepEqual(plain(observed.result), { tabId: 31, state: 'login', url: 'https://passport.example.com/login' });
  const reusedPending = await redirecting.sendNative({ type: 'auth_open_login', id: 'o3', site: loginManifest.name, tabId: 31 });
  assert.equal(reusedPending.result.tabId, 31);
  assert.equal(reusedPending.result.url, 'https://passport.example.com/login?next=%2F');
  assert.equal(redirecting.tabs.length, 1);

  const wrongTarget = await redirected.sendNative({ type: 'auth_open_login', id: 'o4', site: loginManifest.name, tabId: 999 });
  assert.equal(wrongTarget.type, 'call_tool_error');
  assert.match(wrongTarget.error, /opened tab/i);

  const unknown = await redirected.sendNative({ type: 'auth_check', id: 'c3', site: '../etc' });
  assert.equal(unknown.type, 'call_tool_error');
});

// ─── Managed page routing across a package's hosts ───

test("a route-less command reuses the package tab that moved to another declared host", async () => {
  const manifest = { name: 'shop.example.com', match: ['www.example.com', 'order.example.com', 'pay.example.com'], _hostSnapshot: { profile: 'public', digest: 'fixture' },
    commands: [
      { id: 'list', runtime: 'extension', safety: 'read', excludeTabDomain: 'pay.example.com' },
      { id: 'home', runtime: 'extension', safety: 'read', routeDomain: 'www.example.com' },
    ] };
  const tabs = [
    { id: 1, url: 'https://pay.example.com/checkout', status: 'complete', lastAccessed: 30 },
    { id: 2, url: 'https://order.example.com/list', status: 'complete', lastAccessed: 20 },
    { id: 3, url: 'https://other.example.net/', status: 'complete', lastAccessed: 40 },
  ];
  const worker = loadServiceWorker({ tabs, managedCatalog: { available: true, managedNames: [manifest.name], adapters: [manifest] } });
  const reused = await worker.callNativeTool('shop.example.com.list');
  assert.equal(reused.result.tabId, 2);
  // An explicit route still opens its own host.
  const routed = await worker.callNativeTool('shop.example.com.home');
  assert.equal(routed.result.tabId, 999);
  assert.equal((await worker.context.chrome.tabs.get(999)).url, 'http://www.example.com/');
});

test("a redirect to an undeclared host names the host and is marked as a package problem", async () => {
  const worker = loadServiceWorker({ tabs: [{ id: 8, url: 'https://www.example.org/home', status: 'complete' }] });
  const manifest = { name: 'apex.example.org', match: ['example.org'] };
  await assert.rejects(worker.context.waitForManagedPageReady(8, manifest, true, 2000), (error) => {
    assert.equal(error.code, 'ADAPTER_HOST_NOT_ALLOWED');
    assert.match(error.message, /Host: www\.example\.org/);
    assert.match(error.message, /重试无效/);
    assert.doesNotMatch(error.message, /\/home/);
    return true;
  });
});

// ─── Site domains: every subdomain of a declared domain, including regional domains ───

test("a route redirected to another declared site domain runs there and reuses that tab", async () => {
  const manifest = { name: 'shop.example.com', match: ['www.example.com'], domains: ['example.com', 'example.hk'],
    _hostSnapshot: { profile: 'public', digest: 'fixture' },
    commands: [{ id: 'orders', runtime: 'extension', safety: 'read', routeDomain: 'order.example.com' }] };
  const worker = loadServiceWorker({ managedCatalog: { available: true, managedNames: [manifest.name], adapters: [manifest] } });
  const created = [];
  const tabs = worker.context.chrome.tabs;
  const original = tabs.create;
  // The site sends order.example.com to its regional host.
  tabs.create = async (props) => {
    created.push(props.url);
    const tab = await original(props);
    tab.url = 'https://order.example.hk/list';
    return tab;
  };
  const first = await worker.callNativeTool('shop.example.com.orders');
  assert.equal(first.result.tabId, 999);
  const second = await worker.callNativeTool('shop.example.com.orders');
  assert.equal(second.result.tabId, 999);
  assert.deepEqual(created, ['http://order.example.com/']);
});

test("a redirect outside every declared site domain is still refused", async () => {
  const manifest = { name: 'shop.example.com', match: ['www.example.com'], domains: ['example.com'],
    _hostSnapshot: { profile: 'public', digest: 'fixture' },
    commands: [{ id: 'orders', runtime: 'extension', safety: 'read', routeDomain: 'order.example.com' }] };
  const worker = loadServiceWorker({ managedCatalog: { available: true, managedNames: [manifest.name], adapters: [manifest] } });
  const original = worker.context.chrome.tabs.create;
  worker.context.chrome.tabs.create = async (props) => Object.assign(await original(props), { url: 'https://order.example.net/list' });
  const failed = await worker.callNativeTool('shop.example.com.orders');
  assert.match(failed.error, /Host: order\.example\.net/);
  assert.match(failed.error, /domains/);
});
