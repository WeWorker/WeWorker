import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createHostAdapterClient } from '../background/host-adapter-client.js';
import { siteAuthBindings } from './helpers/service-worker-test-loader.mjs';

const source = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(end > start);
  return source.slice(start, end);
}
const manifest = {
  schema_version: 2, name: 'fixture.example.com', version: '1.0.0',
  _hostSnapshot: { profile: 'public', digest: 'a'.repeat(64), source: 'builtin' },
  commands: [{ id: 'read', runtime: 'extension', safety: 'read', execution: { type: 'api', runtime: 'background' } }],
};
function harness({ failed = false } = {}) {
  const messages = [], requests = [];
  const context = vm.createContext({
    pendingWriteRequests: new Map(), setTimeout, clearTimeout,
    ws: { readyState: 1 }, WebSocket: { OPEN: 1 },
    console: { log() {} }, traceLog() {},
    browserInstanceHelloFields: () => ({}),
    ...siteAuthBindings(),
    callManagedBackgroundTool: async () => ({ fixture: true }),
    sendToNative(message) {
      if (!['adapter_catalog', 'adapter_bundle'].includes(message.type)) { messages.push(message); return; }
      requests.push(message.type);
      const result = message.type === 'adapter_catalog'
        ? { available: true, managedNames: [manifest.name], adapters: [manifest] }
        : { name: manifest.name, ...manifest._hostSnapshot, scripts: [] };
      queueMicrotask(() => context.handleNativeMessage({
        id: message.id, type: message.type + '_result', ok: !failed,
        ...(failed ? { error: 'fixture host failure' } : { result }),
      }));
    },
  });
  vm.runInContext(['requestBridge', 'sharedBrowserRequest', 'claimSharedPage', 'handleNativeMessageInternal', 'handleNativeMessage'].map(productionFunction).join('\n'), context);
  const client = createHostAdapterClient(message => context.requestBridge(message, 100));
  context.getHostAdapterClient = () => client;
  return { context, client, messages, requests };
}
test('real Service Worker dispatcher resolves host catalog and bundle responses', async () => {
  const { context, client, requests } = harness();
  const selected = await client.tool(manifest.name + '.read');
  assert.equal(selected.managed, true);
  assert.equal((await client.bundle(selected.manifest)).digest, manifest._hostSnapshot.digest);
  assert.deepEqual(requests, ['adapter_catalog', 'adapter_bundle']);
  assert.equal(context.pendingWriteRequests.size, 0);
});
test('host errors resolve the pending request without masquerading as a timeout', async () => {
  const { context } = harness({ failed: true });
  for (const type of ['adapter_catalog', 'adapter_bundle']) {
    const response = await context.requestBridge({ type }, 100);
    assert.equal(response.error, 'fixture host failure');
    assert.equal(context.pendingWriteRequests.size, 0);
  }
});
test('managed call accepts the matching snapshot and still rejects a stale digest', async () => {
  const { context, messages } = harness();
  const message = { type: 'call_tool', id: 'fixture-call', toolName: manifest.name + '.read', args: {},
    adapterSnapshot: { name: manifest.name, profile: 'public', digest: manifest._hostSnapshot.digest } };
  await context.handleNativeMessage(message);
  assert.equal(messages[0].type, 'call_tool_result');
  assert.equal(messages[0].result.fixture, true);
  await context.handleNativeMessage({ ...message, adapterSnapshot: { ...message.adapterSnapshot, digest: 'b'.repeat(64) } });
  assert.equal(messages[1].type, 'call_tool_error');
  assert.match(messages[1].error, /Adapter changed/);
});
