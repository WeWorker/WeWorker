import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManagedBackgroundRuntime } from '../background/managed-background-runtime.js';

const PACKAGE = {
  name: 'demo.example.com',
  files: { 'extension/commands/list.js': 'window.__demoRegistered = true;' },
  manifest: {
    name: 'demo.example.com',
    commands: [{
      id: 'list',
      runtime: 'extension',
      module: 'extension/commands/list.js',
      safety: 'read',
      execution: { type: 'api', runtime: 'background' },
    }],
  },
};

function fakeApi(state) {
  return {
    runtime: {
      id: 'test-extension-id',
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      getContexts: async () => [],
    },
    offscreen: {
      createDocument: async ({ url }) => { state.url = url; },
      closeDocument: async () => {},
    },
    debugger: {
      getTargets: async () => (state.url ? [{ id: 'target-1', url: state.url }] : []),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target, _method, params) => {
        if (String(params?.expression || '').includes('__weworkerManagedInvoke')) {
          // Hold the command result until the test has registered the stuck helper.
          await state.invokeGate;
          return { result: { value: { ok: true, result: { done: true } } } };
        }
        return { result: { value: undefined } };
      },
    },
  };
}

test('a helper that never settles cannot hold the adapter queue forever', async () => {
  const state = {};
  state.invokeGate = new Promise((resolve) => { state.releaseInvoke = resolve; });

  const runtime = createManagedBackgroundRuntime({
    api: fakeApi(state),
    bundle: async () => PACKAGE,
    // A host fetch whose response never reaches the extension.
    request: () => new Promise(() => {}),
    exclusive: (fn) => fn(),
    pendingDrainMs: 200,
    timeoutMs: 10_000,
  });

  const execution = runtime.execute(PACKAGE.manifest, PACKAGE.manifest.commands[0], {});
  execution.catch(() => {});

  while (!state.url) await new Promise((resolve) => setTimeout(resolve, 5));
  const token = new URL(state.url).searchParams.get('call');
  assert.ok(token, 'runner document must carry a call token');

  let helper;
  for (let attempt = 0; attempt < 200 && !helper; attempt += 1) {
    try {
      helper = runtime.handleMessage(
        { type: 'managed_adapter_runtime_request', token, action: 'backend_fetch', payload: {} },
        { id: 'test-extension-id', url: state.url },
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(helper, 'the stuck helper must be accepted by the runtime');
  helper.catch(() => {});
  state.releaseInvoke();

  // Before the bounded drain this never settled: the pending helper kept the queue.
  const result = await Promise.race([
    execution,
    new Promise((_, reject) => setTimeout(() => reject(new Error('execution did not settle')), 3000)),
  ]);
  assert.deepEqual(result, { done: true });
});

test('a pending helper that finishes quickly is still awaited before the queue is released', async () => {
  const state = {};
  state.invokeGate = new Promise((resolve) => { state.releaseInvoke = resolve; });
  let settled = false;

  const runtime = createManagedBackgroundRuntime({
    api: fakeApi(state),
    bundle: async () => PACKAGE,
    request: () => new Promise((resolve) => { setTimeout(() => { settled = true; resolve({}); }, 50); }),
    exclusive: (fn) => fn(),
    pendingDrainMs: 2000,
    timeoutMs: 10_000,
  });

  const execution = runtime.execute(PACKAGE.manifest, PACKAGE.manifest.commands[0], {});
  execution.catch(() => {});

  while (!state.url) await new Promise((resolve) => setTimeout(resolve, 5));
  const token = new URL(state.url).searchParams.get('call');
  let helper;
  for (let attempt = 0; attempt < 200 && !helper; attempt += 1) {
    try {
      helper = runtime.handleMessage(
        { type: 'managed_adapter_runtime_request', token, action: 'backend_fetch', payload: {} },
        { id: 'test-extension-id', url: state.url },
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(helper);
  helper.catch(() => {});
  state.releaseInvoke();

  assert.deepEqual(await execution, { done: true });
  assert.equal(settled, true, 'a helper that completes in time must be awaited');
});
