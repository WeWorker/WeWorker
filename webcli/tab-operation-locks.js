/** Shared by browser commands and exploration jobs in one Bridge process. */
export class TabOperationLocks {
  constructor({ externallyBusy = () => false } = {}) { this.leases = new Map(); this.externallyBusy = externallyBusy; }
  acquire(tabId) {
    if (tabId === undefined) return () => {};
    if (this.leases.has(tabId) || this.externallyBusy(tabId)) throw Object.assign(new Error('Another browser or exploration operation is using this tab. Wait for it to settle.'), { code: 'TAB_BUSY' });
    const token = Symbol(); this.leases.set(tabId, token);
    return () => { if (this.leases.get(tabId) === token) this.leases.delete(tabId); };
  }
}
