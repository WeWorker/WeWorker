import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WebSocketBridge } from '../bridge.js';
import { WriteConfirmationCoordinator } from '../write-confirmation.js';
import { resolveAdapterCall } from '../adapter-host.js';
import { executeHostCli } from '../host-cli-provider.js';

vi.mock('../adapter-host.js', async original => ({ ...await original(), resolveAdapterCall: vi.fn() }));
vi.mock('../host-cli-provider.js', () => ({ executeHostCli: vi.fn() }));

function fixture(confirm = async () => true) {
  const bridge = Object.create(WebSocketBridge.prototype), messages = [], sent = [];
  const client = new EventEmitter(); client.readyState = 1; client.send = data => messages.push(JSON.parse(data));
  const extension = { readyState: 1, send: data => {
    const msg = JSON.parse(data);
    if (msg.type === 'wecli_host_cli_result') queueMicrotask(() => bridge._handleExtensionMessage({
      type: msg.ok ? 'call_tool_result' : 'call_tool_error', id: sent.at(-1).id, result: msg.result, code: msg.code, error: msg.error,
    }, extension));
  } };
  const selected = { snapshot: { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' },
    adapter: { name: 'example.com', source: 'builtin', manifest: { match: ['example.com'] } },
    command: { id: 'submit', safety: 'write', runtime: 'extension', execution: { type: 'api', runtime: 'background' },
      schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } } };
  vi.mocked(resolveAdapterCall).mockReturnValue(selected);
  vi.mocked(executeHostCli).mockReset().mockImplementation(async ({ markWriteDispatched }) => { markWriteDispatched(); return { ok: true }; });
  bridge._profiles = null; bridge._extensionWs = extension;
  bridge._extensionCapabilities = ['adapter_catalog_v1', 'adapter_background_v1'];
  bridge._writeConfirmations = new WriteConfirmationCoordinator({ confirm });
  bridge._writeInvocation = new AsyncLocalStorage(); bridge._route = new AsyncLocalStorage();
  bridge._pendingRequests = new Map(); bridge._callTimings = new Map();
  bridge._writeAccountContext = async () => 'example-account';
  bridge._request = (...args) => bridge._requestNow(...args);
  bridge._send = message => {
    sent.push(message);
    queueMicrotask(() => bridge._handleHostCliRequest({ id: 'helper', parentId: message.id, payload: { args: message.args } }, extension));
    return true;
  };
  const call = (args = { count: '123' }, id = 'example-call') => bridge._handleClientRequest({ type: 'call_tool', id, toolName: 'example.com.submit', args }, client);
  return { bridge, client, extension, selected, messages, sent, call };
}

describe('Bridge → managed API → host CLI confirmation', () => {
  it('waits for a host event, then continues the captured request once without a second CLI command', async () => {
    let approve;
    const f = fixture(() => new Promise(resolve => { approve = resolve; }));
    const pending = f.call({ count: '123', __confirmed: true });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'write_execution_event', execution: expect.objectContaining({ state: 'waiting_confirmation' }) })));
    expect(f.sent).toHaveLength(0); expect(executeHostCli).not.toHaveBeenCalled();
    // A model's socket message is not the private parent decision channel.
    await f.bridge._handleClientRequest({ type: 'write_confirmation_decision', requestId: f.messages[0]?.execution?.requestId, approved: true }, f.client);
    expect(f.sent).toHaveLength(0);
    approve(true); await pending;
    expect(f.sent).toHaveLength(1); expect(executeHostCli).toHaveBeenCalledOnce();
    expect(vi.mocked(executeHostCli).mock.calls[0][0].args).toEqual({ count: 123 });
    expect(f.messages.at(-1)).toMatchObject({ type: 'call_tool_result', execution: { state: 'succeeded' } });
    await f.call({ count: 123 }, 'duplicate');
    expect(executeHostCli).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'disconnect', 'unavailable'])('does not dispatch on %s', async reason => {
    const f = fixture(async () => { if (reason === 'disconnect') f.client.emit('close'); return false; });
    if (reason === 'unavailable') f.bridge._writeConfirmations = new WriteConfirmationCoordinator();
    await f.call();
    expect(f.sent).toHaveLength(0); expect(executeHostCli).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({ type: 'call_tool_error', execution: { dispatched: false } });
  });
  it('reports a lost provider response as unknown and never enters login replay', async () => {
    const f = fixture();
    vi.mocked(executeHostCli).mockImplementation(async ({ markWriteDispatched }) => { markWriteDispatched(); throw Error('lost'); });
    f.bridge._callToolWithLogin = vi.fn(() => { throw Error('must not replay'); });
    await f.call(); await f.call();
    expect(executeHostCli).toHaveBeenCalledOnce(); expect(f.bridge._callToolWithLogin).not.toHaveBeenCalled();
    expect(f.messages.at(-1)).toMatchObject({ type: 'call_tool_error', code: 'WRITE_OUTCOME_UNKNOWN', execution: { state: 'unknown', retryable: false } });
  });
  it('retains a host-proven required-field preflight error as not submitted', async () => {
    const f = fixture();
    vi.mocked(executeHostCli).mockImplementation(async () => { throw Object.assign(new Error('untrusted provider output'), { code: 'HOST_CLI_REQUIRED_FIELDS', details: { missingFields: ['title'] } }); });
    await f.call();
    expect(f.messages.at(-1)).toMatchObject({ code: 'HOST_CLI_REQUIRED_FIELDS', execution: { state: 'not_submitted', dispatched: false, retryable: true } });
    expect(JSON.stringify(f.messages)).not.toContain('untrusted provider output');
  });
});
