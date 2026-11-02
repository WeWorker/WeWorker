import { describe, it, expect, vi } from 'vitest';
import { WebSocketBridge } from '../bridge.js';
import { resolveAdapterCall } from '../adapter-host.js';
import { executeHostCli } from '../host-cli-provider.js';
import { EventEmitter } from 'node:events';

vi.mock('../adapter-host.js', async (importOriginal) => ({
  ...await importOriginal(), resolveAdapterCall: vi.fn(),
}));
vi.mock('../host-cli-provider.js', () => ({
  executeHostCli: vi.fn(async () => { throw Object.assign(new Error('unavailable'), { code: 'HOST_CLI_UNAVAILABLE' }); }),
}));

describe('host CLI bridge', () => {
  it('uses the pending invocation and refuses unrelated connections and replays', async () => {
    const bridge = Object.create(WebSocketBridge.prototype);
    const sent = [], responses = [];
    const ws = { readyState: 1, send: data => responses.push(JSON.parse(data)) };
    bridge._profiles = null;
    bridge._extensionWs = ws;
    bridge._pendingRequests = new Map();
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' };
    vi.mocked(resolveAdapterCall).mockReturnValue({ snapshot, adapter: { source: 'builtin', manifest: {} },
      command: { id: 'list', safety: 'read', runtime: 'extension', execution: { type: 'api', runtime: 'background' } } });
    const pending = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.list', adapterSnapshot: snapshot }, 2000);
    const parentId = sent[0].id;
    const foreign = { readyState: 1, send: data => responses.push(JSON.parse(data)) };
    await bridge._handleHostCliRequest({ parentId, id: 'foreign', payload: { args: {} } }, foreign);
    expect(responses.at(-1).code).toBe('HOST_CLI_CONTEXT_INVALID');
    await bridge._handleHostCliRequest({ parentId, id: 'first', payload: { args: {} } }, ws);
    expect(responses.at(-1).code).toBe('HOST_CLI_UNAVAILABLE');
    await bridge._handleHostCliRequest({ parentId, id: 'second', payload: { args: {} } }, ws);
    expect(responses.at(-1).code).toBe('HOST_CLI_ALREADY_CALLED');
    bridge._handleExtensionMessage({ type: 'call_tool_result', id: parentId, result: { ok: true } }, ws);
    await expect(pending).resolves.toEqual({ ok: true });
    await bridge._handleHostCliRequest({ parentId, id: 'late', payload: { args: {} } }, ws);
    expect(responses.at(-1).code).toBe('HOST_CLI_CONTEXT_INVALID');
  });

  it('sends a host-only cookie RPC on the same invocation and rejects another host', async () => {
    const bridge = Object.create(WebSocketBridge.prototype), sent = [], responses = [];
    const ws = { readyState: 1, send: data => responses.push(JSON.parse(data)) };
    bridge._profiles = null; bridge._extensionWs = ws; bridge._pendingRequests = new Map();
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'b'.repeat(64), profile: 'public' };
    vi.mocked(resolveAdapterCall).mockReturnValue({ snapshot, adapter: { source: 'builtin', manifest: { match: ['example.com'] } },
      command: { id: 'list', safety: 'read', runtime: 'extension', execution: { type: 'api', runtime: 'background' } } });
    vi.mocked(executeHostCli).mockImplementationOnce(async ({ credentials }) => {
      await expect(credentials.cookies({ url: 'https://other.example.com/' })).rejects.toThrow();
      const cookies = await credentials.cookies({ url: 'https://example.com/api/action' });
      expect(cookies).toEqual([{ name: 'session', value: 'synthetic-cookie' }]);
      return { success: true };
    });
    const pending = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.list', adapterSnapshot: snapshot }, 2000);
    const parentId = sent[0].id;
    bridge._request = vi.fn(async msg => {
      expect(msg).toEqual({ type: 'host_cli_cookies', parentId, payload: { url: 'https://example.com/api/action' } });
      return { cookies: [{ name: 'session', value: 'synthetic-cookie' }] };
    });
    await bridge._handleHostCliRequest({ parentId, id: 'helper', payload: { args: {} } }, ws);
    expect(responses.at(-1)).toEqual({ type: 'wecli_host_cli_result', id: 'helper', ok: true, result: { success: true } });
    expect(JSON.stringify(responses)).not.toContain('synthetic-cookie');
    bridge._handleExtensionMessage({ type: 'call_tool_result', id: parentId, result: { ok: true } }, ws);
    await pending;
  });

  it('permits exact declared shared authentication hosts but rejects wildcard-only and unrelated hosts', async () => {
    const bridge = Object.create(WebSocketBridge.prototype), sent = [], responses = [];
    const ws = { readyState: 1, send: data => responses.push(JSON.parse(data)) };
    bridge._profiles = null; bridge._extensionWs = ws; bridge._pendingRequests = new Map();
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'b'.repeat(64), profile: 'public' };
    vi.mocked(resolveAdapterCall).mockReturnValue({ snapshot, adapter: { source: 'builtin', manifest: { match: ['example.com'], runtime_allowed_hosts: ['auth.example.org', '*.wild.example.org'] } },
      command: { id: 'list', safety: 'read', runtime: 'extension', execution: { type: 'api', runtime: 'background' } } });
    vi.mocked(executeHostCli).mockImplementationOnce(async ({ credentials }) => {
      await expect(credentials.cookies({ url: 'https://other.example.com/' })).rejects.toThrow();
      await expect(credentials.cookies({ url: 'https://auth.wild.example.org/' })).rejects.toThrow();
      const cookies = await credentials.cookies({ url: 'https://auth.example.org/api/action' });
      expect(cookies).toEqual([{ name: 'session', value: 'synthetic-cookie' }]);
      return { success: true };
    });
    const pending = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.list', adapterSnapshot: snapshot }, 2000);
    const parentId = sent[0].id;
    bridge._request = vi.fn(async msg => {
      expect(msg).toEqual({ type: 'host_cli_cookies', parentId, payload: { url: 'https://auth.example.org/api/action' } });
      return { cookies: [{ name: 'session', value: 'synthetic-cookie' }] };
    });
    await bridge._handleHostCliRequest({ parentId, id: 'helper', payload: { args: {} } }, ws);
    expect(responses.at(-1)).toEqual({ type: 'wecli_host_cli_result', id: 'helper', ok: true, result: { success: true } });
    expect(JSON.stringify(responses)).not.toContain('synthetic-cookie');
    bridge._handleExtensionMessage({ type: 'call_tool_result', id: parentId, result: { ok: true } }, ws);
    await pending;
  });

  it('preserves only approved generic error codes and never forwards provider exception text', async () => {
    const bridge = Object.create(WebSocketBridge.prototype), sent = [], responses = [];
    const ws = { readyState: 1, send: data => responses.push(JSON.parse(data)) };
    bridge._profiles = null; bridge._extensionWs = ws; bridge._pendingRequests = new Map();
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'c'.repeat(64), profile: 'public' };
    vi.mocked(resolveAdapterCall).mockReturnValue({ snapshot, adapter: { source: 'builtin', manifest: { match: ['example.com'] } },
      command: { id: 'list', safety: 'read', runtime: 'extension', execution: { type: 'api', runtime: 'background' } } });
    for (const [inputCode, outputCode] of [['HOST_CLI_AUTH_UNCERTAIN', 'HOST_CLI_AUTH_UNCERTAIN'], ['HOST_CLI_UNSUPPORTED_PLATFORM', 'HOST_CLI_UNSUPPORTED_PLATFORM'], ['HOST_CLI_IDENTITY_UNVERIFIED', 'HOST_CLI_IDENTITY_UNVERIFIED'], ['HOST_CLI_SECRET_STORE_UNAVAILABLE', 'HOST_CLI_SECRET_STORE_UNAVAILABLE'], ['HOST_CLI_AUTH_BUSY', 'HOST_CLI_AUTH_BUSY'], ['PRIVATE_CODE', 'HOST_CLI_FAILED']]) {
      vi.mocked(executeHostCli).mockImplementationOnce(async () => { throw Object.assign(new Error('synthetic-secret'), { code: inputCode }); });
      const pending = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.list', adapterSnapshot: snapshot }, 2000);
      const parentId = sent.at(-1).id;
      await bridge._handleHostCliRequest({ parentId, id: 'helper', payload: { args: {} } }, ws);
      expect(responses.at(-1).code).toBe(outputCode);
      expect(JSON.stringify(responses.at(-1))).not.toContain('synthetic-secret');
      if (inputCode === 'HOST_CLI_AUTH_UNCERTAIN') expect(responses.at(-1).error).toContain('could not be confirmed');
      bridge._handleExtensionMessage({ type: 'call_tool_result', id: parentId, result: true }, ws);
      await pending;
    }
  });

  it('only forwards bounded missing field names before write dispatch', async () => {
    const bridge = Object.create(WebSocketBridge.prototype), sent = [], responses = [];
    const ws = { readyState: 1, send: data => responses.push(JSON.parse(data)) };
    bridge._profiles = null; bridge._extensionWs = ws; bridge._pendingRequests = new Map();
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'f'.repeat(64), profile: 'public' };
    vi.mocked(resolveAdapterCall).mockReturnValue({ snapshot, adapter: { source: 'builtin', manifest: {} },
      command: { id: 'read', safety: 'read', runtime: 'extension', execution: { type: 'api', runtime: 'background' } } });
    for (const [details, expected] of [[{ missingFields: ['devOwner', 'customFields.example'], extra: 'secret' }, { missingFields: ['devOwner', 'customFields.example'] }],
      [{ missingFields: ['bad\nvalue'] }, undefined], [{ missingFields: Array(51).fill('x') }, undefined], [{ missingFields: ['x'.repeat(271)] }, undefined]]) {
      vi.mocked(executeHostCli).mockImplementationOnce(async () => { throw Object.assign(new Error('secret'), { code: 'HOST_CLI_REQUIRED_FIELDS', details }); });
      const pending = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.read', adapterSnapshot: snapshot }, 2000);
      const parentId = sent.at(-1).id;
      await bridge._handleHostCliRequest({ parentId, id: 'helper', payload: { args: {} } }, ws);
      expect(responses.at(-1).details).toEqual(expected);
      expect(JSON.stringify(responses.at(-1))).not.toContain('secret');
      bridge._handleExtensionMessage({ type: 'call_tool_error', id: parentId, code: 'HOST_CLI_REQUIRED_FIELDS', error: 'fixed', details }, ws);
      await expect(pending).rejects.toMatchObject(expected ? { code: 'HOST_CLI_REQUIRED_FIELDS', details: expected } : { code: 'HOST_CLI_REQUIRED_FIELDS' });
    }
  });

  it('reports an unknown outcome when a dispatched write times out or the extension errors', async () => {
    const bridge = Object.create(WebSocketBridge.prototype), sent = [];
    const ws = { readyState: 1, send() {} };
    bridge._profiles = null; bridge._extensionWs = ws; bridge._pendingRequests = new Map();
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'd'.repeat(64), profile: 'public' };
    const first = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.write', args: { value: 1 }, adapterSnapshot: snapshot }, 15);
    bridge._pendingRequests.get(sent.at(-1).id).hostWriteDispatched = true;
    await expect(first).rejects.toMatchObject({ code: 'HOST_CLI_OUTCOME_UNKNOWN' });
    const second = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.write', args: { value: 1 }, adapterSnapshot: snapshot }, 2000);
    const id = sent.at(-1).id;
    bridge._pendingRequests.get(id).hostWriteDispatched = true;
    bridge._handleExtensionMessage({ type: 'call_tool_error', id, error: 'disconnected', code: 'AUTH_REQUIRED' }, ws);
    await expect(second).rejects.toMatchObject({ code: 'HOST_CLI_OUTCOME_UNKNOWN' });
  });

  it('does not reinterpret classified host errors as login problems or replay them', async () => {
    const bridge = Object.create(WebSocketBridge.prototype);
    bridge._siteLogin = vi.fn();
    for (const code of ['HOST_CLI_OUTCOME_UNKNOWN', 'HOST_CLI_AUTH_UNCERTAIN', 'HOST_CLI_CONFIRMATION_REQUIRED']) {
      bridge._callToolInner = vi.fn().mockRejectedValue(Object.assign(new Error('stopped'), { code, fromExtension: true }));
      await expect(bridge._callToolWithLogin('example.com.write', {}, null)).rejects.toMatchObject({ code });
      expect(bridge._callToolInner).toHaveBeenCalledTimes(1);
      expect(bridge._siteLogin).not.toHaveBeenCalled();
    }
  });

  it('aborts host work when the original client disconnects', async () => {
    const bridge = Object.create(WebSocketBridge.prototype), sent = [];
    const ws = { readyState: 1 }, client = new EventEmitter();
    client.readyState = 1;
    bridge._profiles = null; bridge._extensionWs = ws; bridge._pendingRequests = new Map();
    bridge._route = { getStore: () => ({ client }) };
    bridge._send = msg => { sent.push(msg); return true; };
    const snapshot = { name: 'example.com', digest: 'e'.repeat(64), profile: 'public' };
    const call = bridge._requestNow({ type: 'call_tool', toolName: 'example.com.write', args: {}, adapterSnapshot: snapshot }, 2000);
    const pending = bridge._pendingRequests.get(sent[0].id);
    pending.hostWriteDispatched = true;
    client.emit('close');
    await expect(call).rejects.toMatchObject({ code: 'HOST_CLI_OUTCOME_UNKNOWN' });
    expect(pending.controller.signal.aborted).toBe(true);
    expect(bridge._pendingRequests.size).toBe(0);
    expect(client.listenerCount('close')).toBe(0);
  });
});
