import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateV2Manifest } from '../adapter-package-validation.js';
import { installAdapter, selectAdapter, removeInstalledAdapter } from '../adapter-install-store.js';
import { describeAdapterCatalog, resolveAdapterCall } from '../adapter-host.js';
import { resolveV2Tool } from '../adapter-package-v2.js';
import { managedAdapterView, managedAdapterSkill } from '../adapter-views.js';
import { describeDesktopAdapters } from '../adapter-desktop.js';
import { findExtensionTool } from '../adapter-cli.js';
import { createHostAdapterClient } from '../../extension/background/host-adapter-client.js';
import { WebSocketBridge } from '../bridge.js';
import { runToolkitTool } from '../toolkit-runner.js';

vi.mock('../toolkit-runner.js', () => ({ runToolkitTool: vi.fn(async (_match, args) => ({ result: args, exitCode: 0 })) }));

function command(id = 'list-items', aliases = ['list_items'], legacyNames = []) {
  return { id, aliases, ...(Array.isArray(legacyNames) && legacyNames.length ? { legacyNames } : {}), runtime: 'extension', module: `extension/commands/${id}.js`,
    description: 'Fixture command', safety: 'write', schema: { type: 'object', properties: { count: { type: 'integer' } } } };
}
function manifest(commands = [command()]) {
  return { schema_version: 2, name: 'demo', version: '1.0.0', description: 'Fixture Adapter', match: ['example.com'], commands };
}
function install(pkg = manifest()) {
  return installAdapter({ origin: { kind: 'local' }, files: new Map([
    ['manifest.json', JSON.stringify(pkg)], ...pkg.commands.map((entry) => [entry.module, '// fixture source']),
  ]) });
}
const cli = fileURLToPath(new URL('../index.js', import.meta.url));
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adapter-aliases-'));
  vi.stubEnv('WEWORKER_BUILD_PROFILE', 'public');
  vi.stubEnv('WEWORKER_BUILTIN_ADAPTERS_DIR', join(root, 'builtin'));
  vi.stubEnv('WEWORKER_USER_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEBCLI_ADAPTERS_DIR', join(root, 'user'));
  vi.stubEnv('WEWORKER_ADAPTER_DATA_DIR', join(root, 'data'));
  vi.stubEnv('WEWORKER_ADAPTERS_DIR', join(root, 'legacy'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('same-package command aliases', () => {
  it('rejects invalid aliases and collisions regardless of command order', () => {
    for (const aliases of [null, 'old', [null], ['other.tool'], ['old name'], ['../old'], ['a/b'], [''], ['x'.repeat(129)], ['list-items'], ['old', 'old'], Array(65).fill('old')]) {
      expect(() => validateV2Manifest(manifest([command('list-items', aliases)]))).toThrow(/alias/i);
    }
    for (const commands of [
      [command('first', ['second']), command('second', [])],
      [command('first', []), command('second', ['first'])],
      [command('first', ['old']), command('second', ['old'])],
    ]) expect(() => validateV2Manifest(manifest(commands))).toThrow(/alias/i);
    for (const legacyNames of [[null], ['old tool'], ['demo.list_items'], ['old.tool', 'old.tool'], Array(65).fill('old.tool')]) {
      expect(() => validateV2Manifest(manifest([command('list-items', ['list_items'], legacyNames)]))).toThrow(/legacy name/i);
    }
    expect(validateV2Manifest(manifest()).commands[0].aliases).toEqual(['list_items']);
  });

  it('resolves explicit cross-prefix legacy names through the same snapshot', async () => {
    install(manifest([command('list-items', ['list_items'], ['legacy.demo.list_items'])]));
    const canonical = resolveAdapterCall('demo.list-items');
    const legacy = resolveAdapterCall('legacy.demo.list_items');
    expect(legacy.adapter).toEqual(canonical.adapter);
    expect(legacy.command).toEqual(canonical.command);
    expect(legacy.snapshot).toEqual(canonical.snapshot);
    expect(resolveV2Tool('legacy.demo.list_items').command).toEqual(canonical.command);
    const client = createHostAdapterClient(async () => ({ ok: true, result: describeAdapterCatalog() }));
    const selected = await client.tool('legacy.demo.list_items');
    expect(selected.command.id).toBe('list-items');
    const tools = await client.tools([]);
    expect(tools[0].aliases).toEqual(expect.arrayContaining(['demo.list_items', 'legacy.demo.list_items']));
    expect((await findExtensionTool('legacy.demo.list_items')).tool.name).toBe('demo.list-items');
    const info = spawnSync(process.execPath, [cli, 'adapter', 'info', 'legacy.demo.list_items'], { cwd: root, env: process.env, encoding: 'utf8', timeout: 15000 });
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout).toContain('demo.list-items');
    const view = managedAdapterView('demo');
    expect(managedAdapterSkill(view)).toContain('`legacy.demo.list_items`');
  });

  it('resolves a single canonical command and snapshot across host, facade and Extension', async () => {
    const installed = install();
    const canonical = resolveAdapterCall('demo.list-items');
    expect(resolveAdapterCall('demo.list_items')).toEqual(canonical);
    expect(resolveV2Tool('demo.list_items').command).toEqual(canonical.command);
    const client = createHostAdapterClient(async () => ({ ok: true, result: describeAdapterCatalog() }));
    const selected = await client.tool('demo.list_items');
    expect(selected.command.id).toBe('list-items');
    expect(selected.manifest._hostSnapshot.digest).toBe(installed.digest);
    const tools = await client.tools([{ name: 'demo.list_items', adapterId: 'demo' }]);
    expect(tools.map((tool) => tool.name)).toEqual(['demo.list-items']);
    expect(tools[0].aliases).toEqual(['demo.list_items']);
    expect((await findExtensionTool('demo.list_items')).tool.name).toBe('demo.list-items');
    expect(describeDesktopAdapters().adapters[0].commands[0].aliases).toEqual(['list_items']);
  });

  it('executes canonical names and aliases without confirmation and pins forwarded calls', async () => {
    const installed = install();
    const request = vi.fn().mockResolvedValue('fixture result');
    const bridge = { _request: request, _extensionCapabilities: ['adapter_catalog_v1'] };
    const run = (name, args) => WebSocketBridge.prototype._callToolInner.call(bridge, name, args);
    for (const name of ['demo.list-items', 'demo.list_items']) {
      expect(await run(name, {})).toBe('fixture result');
    }
    expect(request).toHaveBeenCalledTimes(2);
    expect(await run('demo.list_items', { __confirmed: true })).toBe('fixture result');
    expect(request.mock.calls[0][0].adapterSnapshot.digest).toBe(installed.digest);
  });

  it('honors the package opt-out for canonical and alias calls without inventing confirmation', async () => {
    const pkg = manifest();
    pkg.commands[0].requires_confirmation = false;
    install(pkg);
    const request = vi.fn().mockResolvedValue('done');
    const bridge = { _request: request, _extensionCapabilities: ['adapter_catalog_v1'] };
    for (const name of ['demo.list-items', 'demo.list_items']) {
      expect(await WebSocketBridge.prototype._callToolInner.call(bridge, name, { count: '007' })).toBe('done');
    }
    expect(request.mock.calls[0][0].args).toEqual({ count: '007' });
    expect(managedAdapterView('demo').tools[0]).toMatchObject({ safety: 'write' });
    expect(managedAdapterSkill(managedAdapterView('demo'))).not.toContain('Confirmation:');
  });

  it('routes Toolkit aliases to the canonical module without converting parameters', async () => {
    const pkg = manifest(); delete pkg.match;
    pkg.commands[0].runtime = 'wewright'; pkg.commands[0].module = 'wewright/commands/list-items.py';
    const installed = install(pkg);
    const request = vi.fn(), args = { count: '007', __confirmed: true };
    expect(await WebSocketBridge.prototype._callToolInner.call({ _request: request }, 'demo.list_items', args)).toEqual({ count: '007' });
    const [match, forwarded] = runToolkitTool.mock.calls.at(-1);
    expect(match.adapter.root).toBe(installed.executionRoot);
    expect(match.adapter.entryPath).toBe(join(installed.executionRoot, 'wewright/commands/list-items.py'));
    expect(forwarded).toEqual({ count: '007' });
    expect(request).not.toHaveBeenCalled();
  });

  it('shows aliases in info and Skill and accepts them in help without duplicate commands', () => {
    install();
    const view = managedAdapterView('demo');
    expect(view.tools).toHaveLength(1);
    expect(managedAdapterSkill(view)).toContain('Compatible names: `demo.list_items`');
    for (const args of [['adapter', 'info', 'demo'], ['demo', 'list_items', 'help'], ['demo', 'demo.list_items', 'help']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: process.env, encoding: 'utf8', timeout: 15000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('demo.list-items');
      if (args[0] === 'adapter') expect(result.stdout).toContain('demo.list_items');
    }
  });

  it('never falls back after disable, corruption or removal', async () => {
    const installed = install();
    const client = createHostAdapterClient(async () => ({ ok: true, result: describeAdapterCatalog() }));
    async function blocked() {
      expect(() => resolveAdapterCall('demo.list_items')).toThrow(/unavailable/);
      await expect(client.tool('demo.list_items')).rejects.toThrow(/unavailable/);
      expect(await client.tools([{ name: 'demo.list_items' }])).toEqual([]);
    }
    selectAdapter('demo', 'disabled'); await blocked();
    selectAdapter('demo', 'user');
    writeFileSync(join(installed.executionRoot, 'extension/commands/list-items.js'), 'tampered'); await blocked();
    removeInstalledAdapter('demo'); await blocked();
  });
});
