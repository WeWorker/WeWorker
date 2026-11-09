import { expect, it, vi } from 'vitest';
vi.mock('../adapter-host.js', async importOriginal => ({ ...await importOriginal(), resolveAdapterCall: vi.fn() }));
import { resolveAdapterCall } from '../adapter-host.js';
import { WebSocketBridge } from '../bridge.js';

it.each(['read', 'write'])('forwards only the extension envelope preparation receipt for %s', async safety => {
  resolveAdapterCall.mockReturnValue({ command: { id: 'edit', safety, runtime: 'extension' }, snapshot: { name: 'example.com', digest: 'fixture', profile: 'public' } });
  const bridge = Object.create(WebSocketBridge.prototype), prepared = vi.fn();
  bridge._extensionCapabilities = ['adapter_catalog_v1'];
  bridge._request = vi.fn(async () => ({ result: { status: 'prepared' }, execution: { phase: 'prepared' } }));
  expect(await bridge._callToolInner('example.com.edit', {}, null, null, null, prepared)).toEqual({ status: 'prepared' });
  expect(bridge._request.mock.calls[0][3]).toBe(true);
  expect(prepared).toHaveBeenCalledTimes(safety === 'write' ? 1 : 0);
  prepared.mockClear();
  bridge._request.mockResolvedValue({ result: { status: 'prepared', execution: { phase: 'prepared' }, dispatched: false } });
  await bridge._callToolInner('example.com.edit', {}, null, null, null, prepared);
  expect(prepared).not.toHaveBeenCalled();
});
it('keeps ordinary Bridge callers on the original raw business result contract', async () => {
  resolveAdapterCall.mockReturnValue({ command: { id: 'edit', safety: 'write', runtime: 'extension' }, snapshot: {} });
  const bridge = Object.create(WebSocketBridge.prototype), result = { status: 'prepared' };
  bridge._extensionCapabilities = ['adapter_catalog_v1']; bridge._request = vi.fn(async () => result);
  expect(await bridge._callToolInner('example.com.edit', {})).toBe(result);
  expect(bridge._request.mock.calls[0]).toHaveLength(3);
});
it('includes preparation beside the CLI result only when the host callback reported it', async () => {
  const bridge = Object.create(WebSocketBridge.prototype);
  bridge._beginCallTiming = vi.fn(); bridge._finishCallTiming = vi.fn(); bridge._reply = vi.fn();
  const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const result = { status: 'prepared' };
    bridge.callTool = vi.fn(async (_tool, _args, _trace, _snapshot, options) => { options.onPrepared(); return result; });
    await bridge._handleClientRequest({ type: 'call_tool', toolName: 'example.com.edit', args: {}, id: 'fixture' }, {});
    expect(bridge._reply.mock.calls[0][1]).toMatchObject({ result, execution: { phase: 'prepared' } });
    bridge._reply.mockClear(); bridge.callTool.mockResolvedValue(result);
    await bridge._handleClientRequest({ type: 'call_tool', toolName: 'example.com.edit', args: {}, id: 'fixture' }, {});
    expect(bridge._reply.mock.calls[0][1]).not.toHaveProperty('execution');
  } finally { output.mockRestore(); }
});
