import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAdapterPaths } from '../paths.js';
import { buildAdapterCatalog, publicAdapterCatalog, resolveCatalogTool } from '../adapter-catalog.js';
import { readPackageDirectory, validatePackageFiles, writePackageDirectory } from '../adapter-package-files.js';
import { readAdapterState, withAdapterStoreLock } from '../adapter-state.js';
import { assertInstalledAdapterOrigin, compareAdapterVersions, installAdapter, registerDevelopmentAdapter, removeInstalledAdapter, selectAdapter } from '../adapter-install-store.js';
import { loadV2Adapters, resolveV2Tool } from '../adapter-package-v2.js';
import { prepareGenerationRun } from '../generation-harness/existing-site.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(profile = 'public') {
  const root = mkdtempSync(join(tmpdir(), 'adapter-store-'));
  roots.push(root);
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_BUILD_PROFILE: profile, WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin') } });
  return { root, paths };
}
function files({ name = 'demo', version = '1.0.0', domain = 'example.com', safety = 'read', command = 'list', runtime = 'extension', source = 'first' } = {}) {
  const module = runtime + '/commands/' + command + (runtime === 'extension' ? '.js' : '.py');
  return new Map([
    ['manifest.json', Buffer.from(JSON.stringify({
      schema_version: 2, name, version, description: 'Fixture Adapter',
      ...(runtime === 'extension' ? { match: [domain] } : {}),
      commands: [{ id: command, runtime, module, description: 'Fixture command', safety, schema: { type: 'object', properties: {} } }],
    }))],
    [module, Buffer.from(source)],
  ]);
}
const local = { kind: 'local' };
const hub = { kind: 'hub', service: 'https://example.org/adapterhub' };
const snapshot = (paths) => buildAdapterCatalog({ paths });

describe('unified catalog and installer', () => {
  it('installs a validated package, enables it and pins execution contents', () => {
    const { paths } = setup();
    const result = installAdapter({ files: files(), origin: local }, { paths });
    expect(readPackageDirectory(result.dir).digest).toBe(result.digest);
    expect(readPackageDirectory(result.executionRoot).digest).toBe(result.digest);
    expect(result.executionRoot.startsWith(paths.packageDir)).toBe(true);
    expect(result.executionRoot.startsWith(paths.cacheDir)).toBe(false);
    expect(snapshot(paths).effective[0]).toMatchObject({ name: 'demo', source: 'user', digest: result.digest });
    expect(resolveCatalogTool('demo.list', { paths }).command.runtime).toBe('extension');
    expect(resolveV2Tool('demo.list', { paths }).adapter.root).toBe(result.executionRoot);
    expect(loadV2Adapters({ paths })[0].digest).toBe(result.digest);
    expect(JSON.stringify(publicAdapterCatalog(snapshot(paths)))).not.toContain(result.executionRoot);
  });

  it('requires explicit activation for directories that were copied by hand', () => {
    const { paths } = setup();
    writePackageDirectory(join(paths.userDir, 'demo'), files());
    expect(snapshot(paths).effective).toHaveLength(0);
    expect(snapshot(paths).candidates[0].source).toBe('unmanaged');
    expect(snapshot(paths).diagnostics[0].code).toBe('ADAPTER_NOT_SELECTED');
    expect(() => installAdapter({ files: files(), origin: local }, { paths })).toThrow(/unmanaged/);
    expect(() => removeInstalledAdapter('demo', { paths })).toThrow(/not installed/);
    expect(readPackageDirectory(join(paths.userDir, 'demo')).manifest.version).toBe('1.0.0');
  });

  it('keeps running package roots stable when the installed version changes', () => {
    const { paths } = setup();
    const first = installAdapter({ files: files(), origin: local }, { paths });
    const second = installAdapter({ files: files({ version: '1.1.0', source: 'second' }), origin: local }, { paths });
    expect(first.executionRoot).not.toBe(second.executionRoot);
    expect(readFileSync(join(first.executionRoot, 'extension/commands/list.js'), 'utf8')).toBe('first');
    expect(readFileSync(join(second.executionRoot, 'extension/commands/list.js'), 'utf8')).toBe('second');
    expect(snapshot(paths).effective[0].root).toBe(second.executionRoot);
  });

  it('rolls back an interrupted mirror before the state commit', () => {
    const { paths } = setup();
    const original = installAdapter({ files: files(), origin: local }, { paths });
    expect(() => installAdapter({ files: files({ version: '1.1.0' }), origin: local }, {
      paths, onPhase: () => { throw new Error('fixture failure'); },
    })).toThrow('fixture failure');
    expect(readPackageDirectory(original.dir).digest).toBe(original.digest);
    expect(snapshot(paths).effective[0].digest).toBe(original.digest);
    expect(readAdapterState(paths).revision).toBe(1);
  });

  it('recovers a real crashed installer without stealing live process locks', () => {
    const { paths } = setup();
    const original = installAdapter({ files: files(), origin: local }, { paths });
    const program = 'import { installAdapter } from ' + JSON.stringify(new URL('../adapter-install-store.js', import.meta.url).href) + ';'
      + 'const paths=JSON.parse(process.argv[1]);const entries=JSON.parse(process.argv[2]);'
      + 'installAdapter({files:new Map(entries),origin:{kind:"local"}},{paths,onPhase(){process.exit(23)}});';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(paths),
      JSON.stringify([...files({ version: '1.1.0' })].map(([name, bytes]) => [name, bytes.toString()]))], { timeout: 15000 });
    expect(child.status, child.stderr?.toString()).toBe(23);
    // Readers continue to use the committed version while the mirror is interrupted.
    expect(snapshot(paths).effective[0].digest).toBe(original.digest);
    installAdapter({ files: files({ version: '1.2.0' }), origin: local }, { paths });
    expect(snapshot(paths).effective[0].version).toBe('1.2.0');
    withAdapterStoreLock(paths, () => {
      expect(() => installAdapter({ files: files(), origin: local }, { paths })).toThrow(/operation is running/);
    });
  });

  it('keeps a committed update after interruption and restores a failed removal', () => {
    const { paths } = setup();
    installAdapter({ files: files(), origin: local }, { paths });
    expect(() => installAdapter({ files: files({ version: '1.1.0' }), origin: local }, {
      paths, onPhase: (phase) => { if (phase === 'state-committed') throw new Error('after commit'); },
    })).toThrow('after commit');
    expect(snapshot(paths).effective[0].version).toBe('1.1.0');
    expect(() => removeInstalledAdapter('demo', {
      paths, onPhase: () => { throw new Error('interrupted removal'); },
    })).toThrow('interrupted removal');
    expect(readPackageDirectory(join(paths.userDir, 'demo')).manifest.version).toBe('1.1.0');
    expect(snapshot(paths).effective[0].version).toBe('1.1.0');
  });

  it('refuses an update whose generation baseline is stale', () => {
    const { paths } = setup();
    const original = installAdapter({ files: files(), origin: local }, { paths });
    installAdapter({ files: files({ version: '1.1.0' }), origin: local }, { paths });
    expect(() => installAdapter({ files: files({ version: '1.2.0' }), origin: local, expectedSourceDigest: original.digest }, { paths })).toThrow(/changed since/);
    expect(snapshot(paths).effective[0].version).toBe('1.1.0');
  });

  it('does not follow a different Hub merely because its package name matches', () => {
    const { paths } = setup();
    installAdapter({ files: files(), origin: hub }, { paths });
    const otherHub = { kind: 'hub', service: 'https://other.example.org/adapterhub' };
    expect(() => assertInstalledAdapterOrigin('demo', otherHub, { paths })).toThrow(/another source/);
    expect(() => installAdapter({ files: files({ version: '1.1.0' }), origin: otherHub }, { paths })).toThrow(/source-change/);
    expect(() => installAdapter({ files: files(), origin: { kind: 'hub', service: 'https://user:placeholder@example.org/?token=placeholder' } }, { paths })).toThrow(/credentials/);
    expect(readAdapterState(paths).installations.demo.origin).toEqual(hub);
  });

  it('requires explicit permission expansion and downgrade choices', () => {
    const { paths } = setup();
    installAdapter({ files: files(), origin: local }, { paths });
    expect(() => installAdapter({ files: files({ version: '1.1.0', safety: 'write' }), origin: local }, { paths })).toThrow(/additional permissions/);
    installAdapter({ files: files({ version: '1.1.0', safety: 'write' }), origin: local, allowPermissionChange: true }, { paths });
    expect(() => installAdapter({ files: files(), origin: local }, { paths })).toThrow(/downgrade/);
    installAdapter({ files: files(), origin: local, allowDowngrade: true }, { paths });
    expect(snapshot(paths).effective[0].version).toBe('1.0.0');
  });

  it('treats removing write confirmation as a reviewed package permission change', () => {
    const { paths } = setup();
    installAdapter({ files: files({ safety: 'write' }), origin: local }, { paths });
    const next = files({ safety: 'write', version: '1.1.0' });
    const manifest = JSON.parse(next.get('manifest.json'));
    manifest.commands[0].requires_confirmation = false;
    next.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    expect(() => installAdapter({ files: next, origin: local }, { paths })).toThrow(/additional permissions/);
    installAdapter({ files: next, origin: local, allowPermissionChange: true }, { paths });
    expect(snapshot(paths).effective[0].commands[0].requires_confirmation).toBe(false);
  });

  it('replaces an explicitly selected built-in and restores it on removal', () => {
    const { paths } = setup();
    writePackageDirectory(join(paths.builtinDir, 'demo'), files());
    const original = readPackageDirectory(join(paths.builtinDir, 'demo')).digest;
    expect(snapshot(paths).effective[0].source).toBe('builtin');
    installAdapter({ files: files({ version: '2.0.0' }), origin: hub }, { paths });
    expect(snapshot(paths).effective[0].source).toBe('user');
    removeInstalledAdapter('demo', { paths });
    expect(snapshot(paths).effective[0].source).toBe('builtin');
    expect(readPackageDirectory(join(paths.builtinDir, 'demo')).digest).toBe(original);
  });

  it('allows fresh exploration after removing a user-only package', () => {
    const { paths } = setup();
    installAdapter({ files: files(), origin: local }, { paths });
    removeInstalledAdapter('demo', { paths });
    expect(readAdapterState(paths).selections.demo).toEqual({ source: 'disabled' });
    expect(snapshot(paths).effective).toEqual([]);
    expect(snapshot(paths).diagnostics).toEqual([]);
    const memory = { siteKey: 'demo', siteHost: 'example.com' };
    expect(prepareGenerationRun({ snapshot: { input: { memory } } }, { paths })).toBe(memory);
    installAdapter({ files: files(), origin: local }, { paths });
    expect(resolveCatalogTool('demo.list', { paths }).command.runtime).toBe('extension');
  });

  it('rejects a stale deletion review before removing the installed package', () => {
    const { paths } = setup();
    const installed = installAdapter({ files: files(), origin: local }, { paths });
    expect(() => removeInstalledAdapter('demo', { paths, expectedStateRevision: installed.revision - 1,
      expectedSourceDigest: installed.digest })).toThrow(/changed after deletion review/);
    expect(() => removeInstalledAdapter('demo', { paths, expectedStateRevision: installed.revision,
      expectedSourceDigest: '0'.repeat(64) })).toThrow(/changed after deletion review/);
    expect(snapshot(paths).effective[0].digest).toBe(installed.digest);
  });

  it('keeps distinct profiles and explicit root ownership isolated', () => {
    const { root, paths } = setup();
    const custom = resolveAdapterPaths({ home: root, env: { WEWORKER_BUILD_PROFILE: 'custom', WEWORKER_BUILTIN_ADAPTERS_DIR: paths.builtinDir } });
    installAdapter({ files: files(), origin: local }, { paths });
    expect(snapshot(custom).effective).toHaveLength(0);
    installAdapter({ files: files({ version: '2.0.0' }), origin: local }, { paths: custom });
    expect(snapshot(paths).effective[0].version).toBe('1.0.0');
    expect(snapshot(custom).effective[0].version).toBe('2.0.0');
    expect(() => installAdapter({ files: files(), origin: local }, { paths: { ...custom, userDir: paths.userDir } })).toThrow(/different profile/);
  });

  it('blocks domain overlap without damaging the currently active package', () => {
    const { paths } = setup();
    installAdapter({ files: files(), origin: local }, { paths });
    expect(() => installAdapter({ files: files({ name: 'other', domain: 'sub.example.com' }), origin: local }, { paths })).toThrow(/conflicts/);
    expect(snapshot(paths).effective.map((entry) => entry.name)).toEqual(['demo']);
    expect(readAdapterState(paths).installations.other).toBeUndefined();
  });

  it('isolates a damaged package and never falls back to modified mirror code', () => {
    const { paths } = setup();
    const result = installAdapter({ files: files(), origin: local }, { paths });
    writePackageDirectory(join(paths.builtinDir, 'healthy'), files({ name: 'healthy', domain: 'example.org' }));
    writeFileSync(join(result.executionRoot, 'extension/commands/list.js'), 'modified');
    expect(snapshot(paths).effective.map((entry) => entry.name)).toEqual(['healthy']);
    expect(snapshot(paths).diagnostics.some((entry) => entry.code === 'ADAPTER_CONTENT_CHANGED')).toBe(true);
    expect(() => installAdapter({ files: files({ version: '1.1.0', safety: 'write' }), origin: local }, { paths })).toThrow(/additional permissions/);
  });

  it('supports explicit development roots, code refresh and permission review', () => {
    const { root, paths } = setup();
    const development = join(root, 'project/demo');
    writePackageDirectory(development, files());
    registerDevelopmentAdapter(development, { paths });
    const before = snapshot(paths).effective[0].digest;
    writeFileSync(join(development, 'extension/commands/list.js'), 'changed code');
    expect(snapshot(paths).effective[0].digest).not.toBe(before);
    writeFileSync(join(development, 'manifest.json'), files({ safety: 'write' }).get('manifest.json'));
    expect(snapshot(paths).effective).toHaveLength(0);
    expect(snapshot(paths).diagnostics.some((entry) => entry.code === 'ADAPTER_PERMISSION_CHANGE')).toBe(true);
    registerDevelopmentAdapter(development, { paths });
    selectAdapter('demo', 'disabled', { paths });
    expect(snapshot(paths).effective).toHaveLength(0);
  });

  it.each(['constructor', '__proto__'])('handles prototype-like name %s as an ordinary identity', (name) => {
    const { paths } = setup();
    installAdapter({ files: files({ name }), origin: local }, { paths });
    expect(snapshot(paths).effective[0].name).toBe(name);
    expect(readAdapterState(paths).installations[name].name).toBe(name);
    selectAdapter(name, 'disabled', { paths });
    selectAdapter(name, 'user', { paths });
    removeInstalledAdapter(name, { paths });
    expect(snapshot(paths).effective).toHaveLength(0);
    expect(readAdapterState(paths).selections[name]).toEqual({ source: 'disabled' });
    expect(snapshot(paths).diagnostics).toEqual([]);
  });
});

describe('file and version boundaries', () => {
  it('rejects extra executable files and Windows path aliases before installation', () => {
    const extra = files();
    extra.set('extension/commands/unused.js', Buffer.from('unused'));
    expect(() => validatePackageFiles(extra)).toThrow(/Unexpected/);
    for (const path of ['extension/internal/aux.txt', 'extension/internal/a.js:stream', '../escape', 'extension/internal/../escape']) {
      const invalid = files(); invalid.set(path, Buffer.from('bad'));
      expect(() => validatePackageFiles(invalid)).toThrow(/path/);
    }
  });
  it('uses SemVer precedence including prereleases and build metadata', () => {
    expect(compareAdapterVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareAdapterVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareAdapterVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
  });
});
