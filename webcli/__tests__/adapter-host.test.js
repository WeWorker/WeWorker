import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAdapter, selectAdapter } from '../adapter-install-store.js';
import { describeAdapterCatalog, readAdapterBundle, resolveAdapterCall } from '../adapter-host.js';
import { WebSocketBridge } from '../bridge.js';
import { createHostAdapterClient } from '../../extension/background/host-adapter-client.js';
import { runToolkitTool } from '../toolkit-runner.js';

vi.mock('../toolkit-runner.js', () => ({ runToolkitTool: vi.fn(async (_match, parameters) => ({ result: parameters, exitCode: 0 })) }));

let root;
const files = (version = '1.0.0', source = 'first') => new Map([
  ['manifest.json', JSON.stringify({ schema_version: 2, name: 'demo', version,
    description: 'Fixture Adapter', match: ['example.com'], commands: [{ id: 'list', runtime: 'extension',
      module: 'extension/commands/list.js', description: 'Read fixture', schema: { type: 'object', properties: {} } }] })],
  ['extension/commands/list.js', source],
]);
function install(version, source) { return installAdapter({ files: files(version, source), origin: { kind: 'local' } }); }
function rpc(message) {
  let response;
  WebSocketBridge.prototype._handleAdapterSnapshot.call({}, message, { send: (text) => { response = JSON.parse(text); } });
  return response;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adapter-host-'));
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', join(root, 'builtin'));
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', join(root, 'data'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('host catalog and execution snapshots', () => {
  it('passes one authoritative snapshot through Bridge and Extension without local paths', async () => {
    const installed = install();
    const client = createHostAdapterClient(async (message) => rpc(message));
    const selected = await client.manifest('demo');
    expect(selected.managed).toBe(true);
    expect(selected.manifest._hostSnapshot.digest).toBe(installed.digest);
    expect(resolveAdapterCall('demo.list').snapshot.digest).toBe(installed.digest);
    expect((await client.tools([{ name: 'demo.obsolete', adapterId: 'demo' }])).map((tool) => tool.name)).toEqual(['demo.list']);
    expect((await client.tool('demo.list')).command.id).toBe('list');
    const bundle = await client.bundle(selected.manifest);
    expect(bundle.files['extension/commands/list.js']).toBe('first');
    expect(JSON.stringify(bundle)).not.toContain(root);
    expect(JSON.stringify(describeAdapterCatalog())).not.toContain(root);
  });

  it('refuses a changed selection instead of mixing old metadata with new scripts', async () => {
    install();
    const client = createHostAdapterClient(async (message) => rpc(message));
    const before = (await client.manifest('demo')).manifest;
    const pinned = await client.bundle(before);
    install('1.1.0', 'second');
    await expect(client.bundle(before)).rejects.toThrow(/unavailable/);
    expect(pinned.files['extension/commands/list.js']).toBe('first');
    const after = (await client.manifest('demo')).manifest;
    expect((await client.bundle(after)).files['extension/commands/list.js']).toBe('second');
    expect(() => readAdapterBundle({ name: 'demo', digest: after._hostSnapshot.digest, profile: 'custom' })).toThrow(/selection changed/);
  });

  it('binds Backend calls to a snapshot and rejects a stale CLI snapshot before forwarding', async () => {
    const installed = install();
    const request = vi.fn().mockResolvedValue('fixture result');
    // Without known capabilities the Bridge starts WeWorker 浏览器 first; here it is already running.
    const bridge = { _request: request, _extensionCapabilities: ['adapter_catalog_v1'], _ensureBrowser: async () => {} };
    const run = (snapshot) => WebSocketBridge.prototype._callToolInner.call(bridge, 'demo.list', {}, 'fixture-trace', snapshot);
    expect(await run()).toBe('fixture result');
    const before = request.mock.calls[0][0].adapterSnapshot;
    expect(before.digest).toBe(installed.digest);
    install('1.1.0', 'second');
    await expect(run(before)).rejects.toThrow(/changed since/);
    expect(request).toHaveBeenCalledTimes(1);
    bridge._extensionCapabilities = [];
    await expect(run()).rejects.toThrow(/Reload/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never restores legacy package copies after disable, damage or a host disconnection', async () => {
    const installed = install();
    let offline = false;
    const client = createHostAdapterClient(async (message) => offline ? null : rpc(message));
    const legacy = [{ id: 'demo', version: '0.1.0' }, { id: 'other' }];
    expect((await client.merge(legacy)).find((item) => item.id === 'demo').version).toBe('1.0.0');
    selectAdapter('demo', 'disabled');
    expect(() => resolveAdapterCall('demo.list')).toThrow(/unavailable/);
    await expect(client.tool('demo.list')).rejects.toThrow(/unavailable/);
    expect((await client.merge(legacy)).map((item) => item.id)).toEqual(['other']);
    selectAdapter('demo', 'user');
    writeFileSync(join(installed.executionRoot, 'extension/commands/list.js'), 'tampered');
    expect((await client.merge(legacy)).map((item) => item.id)).toEqual(['other']);
    offline = true;
    expect((await client.merge(legacy)).map((item) => item.id)).toEqual(['other']);
  });

  it('rejects traversal and messages without a selected digest', () => {
    install();
    for (const payload of [{ name: '../escape' }, { name: 'demo' }]) {
      const result = rpc({ type: 'adapter_bundle', id: 'fixture', payload });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(root);
    }
  });

  it('routes Toolkit packages to their pinned host runner without converting arguments', async () => {
    const result = installAdapter({ origin: { kind: 'local' }, files: new Map([
      ['manifest.json', JSON.stringify({ schema_version: 2, name: 'toolkit-fixture', version: '1.0.0', description: 'Fixture', commands: [
        { id: 'run', runtime: 'wewright', module: 'wewright/commands/run.py', description: 'Fixture', schema: { type: 'object', properties: { count: { type: 'integer' } } } },
      ] })], ['wewright/commands/run.py', '# runner boundary fixture'],
    ]) });
    const request = vi.fn();
    const parameters = { count: '007' };
    const output = await WebSocketBridge.prototype._callToolInner.call({ _request: request }, 'toolkit-fixture.run', parameters);
    expect(output).toEqual(parameters);
    expect(request).not.toHaveBeenCalled();
    const [match, args] = runToolkitTool.mock.calls.at(-1);
    expect(match.adapter.root).toBe(result.executionRoot);
    expect(match.adapter.entryPath).toBe(join(result.executionRoot, 'wewright/commands/run.py'));
    expect(args).toEqual(parameters);
  });

  it('fails closed on unreadable installation state instead of restoring old assets', async () => {
    install();
    writeFileSync(join(root, 'data/adapter-state/public/registry.json'), '{invalid');
    const client = createHostAdapterClient(async (message) => rpc(message));
    expect(await client.merge([{ id: 'demo' }])).toEqual([]);
    expect(await client.tools([{ name: 'demo.list' }])).toEqual([]);
    await expect(client.tool('demo.list')).rejects.toThrow(/inspection/);
    expect(() => resolveAdapterCall('demo.list')).toThrow(/inspection/);
  });
});
