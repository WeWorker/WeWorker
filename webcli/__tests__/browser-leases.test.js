import { describe, it, expect } from 'vitest';
import { BrowserLeases } from '../browser-leases.js';
import { TabOperationLocks } from '../tab-operation-locks.js';

const descriptor = { instanceId: 'fixture-instance', cdpUrl: 'ws://127.0.0.1:12345/devtools/browser/fixture' };
describe('shared browser ownership', () => {
  it('keeps Toolkit state exclusive and frees only the disconnected client', () => {
    const leases = new BrowserLeases(), a = {}, b = {};
    const first = leases.acquire(a, descriptor, { resource: 'toolkit:fixture', visible: true });
    expect(() => leases.acquire(b, descriptor, { resource: 'toolkit:fixture' })).toThrow(/Toolkit/);
    leases.acquire(b, descriptor);
    leases.release(b, first.leaseId);
    expect(leases.size).toBe(2);
    leases.detach(a);
    expect(leases.size).toBe(1);
    expect(leases.visible).toBe(false);
    expect(() => leases.acquire(b, descriptor, { resource: 'toolkit:fixture' })).not.toThrow();
  });
  it('rejects stale instance IDs, foreign leases and cross-client page collisions', () => {
    const leases = new BrowserLeases(), a = {}, b = {};
    const first = leases.acquire(a, descriptor), second = leases.acquire(b, descriptor);
    expect(() => leases.get(b, first.leaseId, descriptor.instanceId)).toThrow(/失效/);
    expect(() => leases.get(a, first.leaseId, 'new-instance')).toThrow(/失效/);
    const entry = leases.get(a, first.leaseId, descriptor.instanceId);
    leases.claim(entry, 'target-1', 10);
    expect(() => leases.claim(leases.get(b, second.leaseId, descriptor.instanceId), 'target-1', 10)).toThrow(/页面/);
    const profileLocks = new TabOperationLocks({ externallyBusy: id => leases.hasTab(id) });
    expect(() => profileLocks.acquire(10)).toThrow(/using this tab/);
    expect(() => profileLocks.acquire(11)).not.toThrow();
    leases.detach(a);
    expect(() => profileLocks.acquire(10)).not.toThrow();
  });
});
