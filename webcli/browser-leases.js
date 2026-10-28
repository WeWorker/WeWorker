import { randomUUID } from 'node:crypto';

const failure = (code, message) => Object.assign(new Error(message), { code });

/** Connection-owned resources. Closing a client releases all its claims. */
export class BrowserLeases {
  constructor() { this.entries = new Map(); }
  get size() { return this.entries.size; }
  acquire(client, descriptor, { resource = '', visible = false } = {}) {
    if (!client || client.readyState === 3) throw failure('BROWSER_DISCONNECTED', '浏览器控制连接已关闭');
    if (resource && [...this.entries.values()].some(entry => entry.resource === resource)) {
      throw failure('BROWSER_BUSY', '同一 Toolkit 正在执行，请等待当前调用结束');
    }
    const leaseId = randomUUID();
    this.entries.set(leaseId, { client, ...descriptor, resource, visible, pages: new Map() });
    return { ...descriptor, leaseId };
  }
  get(client, leaseId, instanceId) {
    const entry = this.entries.get(leaseId);
    if (!entry || entry.client !== client || entry.instanceId !== instanceId) {
      throw failure('BROWSER_INSTANCE_CHANGED', '浏览器实例或占用已失效，请检查当前状态后重新发起任务');
    }
    return entry;
  }
  claim(entry, targetId, tabId) {
    for (const other of this.entries.values()) {
      if (other !== entry && other.instanceId === entry.instanceId && other.pages.has(targetId)) {
        throw failure('TAB_BUSY', '页面正在被其他任务使用');
      }
    }
    entry.pages.set(targetId, tabId);
  }
  hasTab(tabId) { return [...this.entries.values()].some(entry => [...entry.pages.values()].includes(tabId)); }
  release(client, leaseId) {
    if (this.entries.get(leaseId)?.client === client) this.entries.delete(leaseId);
  }
  detach(client) {
    for (const [id, entry] of this.entries) if (entry.client === client) this.entries.delete(id);
  }
  get visible() { return [...this.entries.values()].some(entry => entry.visible); }
}
