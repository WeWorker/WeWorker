import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createHostAdapterRuntime, waitForAdapterPageRecovery } from '../background/host-adapter-runtime.js';

const source = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const start = source.indexOf('async function callToolInTab(');
const fn = source.slice(start, source.indexOf('\n}', start) + 2);
const message = 'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.';
function harness(sendMessage) {
  const scope = vm.createContext({
    chrome: { tabs: { sendMessage } },
    traceLog() {}, console: { log() {}, error() {} }, setTimeout, clearTimeout,
  });
  vm.runInContext(fn, scope);
  return scope.callToolInTab;
}
test('classifies Chrome BFCache transport rejection for managed calls without retrying in the transport', async () => {
  let calls = 0;
  const call = harness(async () => { calls++; throw new Error(message); });
  await assert.rejects(call(1, 'example.com.read', {}, null, false, 1000), { code: 'ADAPTER_BFCACHE_DISCONNECTED' });
  assert.equal(calls, 1);
});
test('does not classify business responses or generic channel errors as BFCache transport loss', async () => {
  for (const send of [async () => ({ error: message }), async () => { throw new Error('message channel closed'); }]) {
    await assert.rejects(harness(send)(1, 'example.com.read', {}, null, false, 1000), error => {
      assert.notEqual(error.code, 'ADAPTER_BFCACHE_DISCONNECTED'); return true;
    });
  }
});
test('managed runtime recovers the real transport error and returns the retried read result', async () => {
  let calls = 0, injected = 0;
  const command = { id: 'read', safety: 'read' };
  const manifest = { name: 'example.com', match: ['example.com'], commands: [command] };
  const url = 'https://example.com/';
  const call = harness(async () => { if (++calls === 1) throw new Error(message); return { result: ['recovered'] }; });
  const runtime = createHostAdapterRuntime({
    bundle: async () => [], prepare: async () => {}, clear: async () => {}, inject: async () => { injected++; },
    ready: async () => url,
    recover: (...args) => waitForAdapterPageRecovery({ tabs: { get: async () => ({ url, status: 'complete' }) } }, ...args),
  });
  assert.deepEqual(await runtime.execute(1, manifest, url, budget => call(1, 'example.com.read', {}, null, false, budget), command), ['recovered']);
  assert.equal(calls, 2); assert.equal(injected, 2);
});
