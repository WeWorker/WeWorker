import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { BrowserLeases } from '../../webcli/browser-leases.js';
import { TabOperationLocks } from '../../webcli/tab-operation-locks.js';

const source = readFileSync(new URL('../background/service-worker.js', import.meta.url), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness({ failure = false, releaseFailure = false } = {}) {
  const leases = new BrowserLeases();
  const client = { readyState: 1 };
  const descriptor = { instanceId: 'fixture-instance' };
  const locks = new TabOperationLocks({ externallyBusy: tabId => leases.hasTab(tabId) });
  const replies = [];
  let releaseStarted, finishRelease;
  const releasing = new Promise(resolve => releaseStarted = resolve);
  const releaseGate = new Promise(resolve => finishRelease = resolve);
  const context = vm.createContext({
    chrome: {}, ensureCdpAttached() {}, cdpEvaluate() {}, getCdpNetworkSnapshot() {}, getTraceLogs() {}, clearBrowserDebuggerState() {},
    executeBrowserCommand: async () => { if (failure) throw Object.assign(new Error('Fixture operation failed'), { code: 'FIXTURE_FAILED' }); return { ok: true, data: { identity: 'fixture' } }; },
    getHostAdapterRuntime: () => ({ exclusive: async (_tab, operation) => operation() }),
    claimSharedPage: async tabId => {
      const lease = leases.acquire(client, descriptor);
      leases.claim(leases.get(client, lease.leaseId, descriptor.instanceId), 'fixture-target', tabId);
      return async () => { releaseStarted(); await releaseGate; if (releaseFailure) throw new Error('Fixture release failed'); leases.release(client, lease.leaseId); };
    },
    sendToNative: reply => {
      let nextOperation;
      try { locks.acquire(7)(); nextOperation = 'available'; } catch (error) { nextOperation = error.code; }
      replies.push({ reply, nextOperation });
    },
  });
  vm.runInContext(productionFunction('handleNativeMessageInternal'), context);
  return { context, leases, locks, replies, releasing, finishRelease };
}

for (const failure of [false, true]) test('browser response waits for shared lease release: ' + (failure ? 'operation failure' : 'bind success'), async () => {
  const h = harness({ failure });
  const operation = h.context.handleNativeMessageInternal({ type: 'browser_execute', command: 'bind', tabId: 7, id: 'fixture' });
  await h.releasing;
  assert.equal(h.leases.hasTab(7), true);
  assert.throws(() => h.locks.acquire(7), { code: 'TAB_BUSY' });
  const earlyReplies = h.replies.length;
  h.finishRelease();
  await operation;
  assert.equal(earlyReplies, 0, 'Bridge must not receive completion while this operation still owns the page');
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].nextOperation, 'available', 'immediate exploration start must not collide with bind');
  assert.equal(h.replies[0].reply.result.ok, !failure);
  if (failure) assert.equal(h.replies[0].reply.result.error.code, 'FIXTURE_FAILED');
});

test('release failure is explicit rather than reporting a ready page', async () => {
  const h = harness({ releaseFailure: true });
  const operation = h.context.handleNativeMessageInternal({ type: 'browser_execute', command: 'bind', tabId: 7, id: 'fixture' });
  await h.releasing; h.finishRelease(); await operation;
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].reply.result.ok, false);
  assert.equal(h.replies[0].reply.result.error.code, 'BROWSER_RELEASE_FAILED');
});

for (const command of ['dialog', 'downloads', 'events', 'wait']) test('observer remains available during page ownership: ' + command, async () => {
  const h = harness();
  h.context.claimSharedPage = () => { throw new Error('Observer must not acquire a page'); };
  await h.context.handleNativeMessageInternal({ type: 'browser_execute', command, args: { kind: 'download' }, tabId: 7, id: 'fixture' });
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].reply.result.ok, true);
});
