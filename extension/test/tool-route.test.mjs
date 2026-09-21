import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { runServiceWorkerInContext } from "./helpers/adapter-test-loader.mjs";

const ROOT = process.cwd();

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

function loadServiceWorker({ tabs = [], tabResponse = null, staticAdapters = {} } = {}) {
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
      create: async ({ url }) => ({ id: 999, url }),
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

  return { registerTools, callNativeTool, listNativeTools, sentToTabs, flushStaticRoutes };
}

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
