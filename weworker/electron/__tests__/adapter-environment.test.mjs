import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAdapterEnvironment } from '../adapter-environment.js';
import { resolveAdapterPaths } from '../../../webcli/paths.js';

function fixture(t, profile = 'internal') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-host-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, 'resources');
  const builtinDir = path.join(resourcesPath, 'adapters');
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.writeFileSync(path.join(builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile, adapters: [], legacy: [] }));
  return { packaged: true, resourcesPath, repoRoot: path.join(root, 'repo'), home: path.join(root, 'home'), env: {}, root, builtinDir };
}

test('packaged desktop, CLI and workers agree on the internal profile and all roots', (t) => {
  const options = fixture(t);
  const env = buildAdapterEnvironment(options);
  const paths = resolveAdapterPaths({ env, home: options.home });
  assert.equal(env.WEWORKER_BUILD_PROFILE, 'internal');
  assert.equal(paths.builtinDir, options.builtinDir);
  assert.equal(paths.userDir, path.join(options.home, '.weworker/adapters/.profiles/internal'));
  assert.equal(paths.stateDir, path.join(options.home, '.weworker/adapter-state/internal'));
  assert.equal(env.WEBCLI_ADAPTERS_DIR, paths.userDir);
  assert.equal(env.WEWORKER_ADAPTER_DATA_DIR, path.join(options.home, '.weworker'));
  const { legacyUserDir: ignoredLegacy, ...activePaths } = paths;
  const { legacyUserDir: childLegacy, ...childPaths } = resolveAdapterPaths({ env: { ...env }, home: 'unused' });
  assert.deepEqual(childPaths, activePaths);
});

test('desktop children stay pinned to the desktop Bridge port and never inherit npm isolation', (t) => {
  const options = fixture(t);
  const env = buildAdapterEnvironment({ ...options, env: { WEBCLI_BRIDGE_PORT: '3712', WEWORKER_WEBCLI_DISTRIBUTION: 'npm' } });
  assert.equal(env.WEBCLI_BRIDGE_PORT, '3711');
  assert.equal(env.WEWORKER_WEBCLI_DISTRIBUTION, undefined);
});

test('explicit user roots isolate metadata and conflicting overrides fail', (t) => {
  const options = fixture(t, 'public');
  const userDir = path.join(options.root, 'custom-user');
  const env = buildAdapterEnvironment({ ...options, env: { WEBCLI_ADAPTERS_DIR: userDir } });
  assert.equal(env.WEWORKER_ADAPTER_DATA_DIR, path.join(userDir, '.host-data'));
  assert.throws(() => buildAdapterEnvironment({ ...options, env: { WEBCLI_ADAPTERS_DIR: userDir, WEWORKER_USER_ADAPTERS_DIR: options.home } }), /Conflicting/);
});

test('current generated metadata without a legacy inventory works in desktop and CLI', (t) => {
  const options = fixture(t, 'public');
  fs.writeFileSync(path.join(options.builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [] }));
  for (const packaged of [true, false]) {
    const env = buildAdapterEnvironment({ ...options, packaged, env: { WEWORKER_BUILTIN_ADAPTERS_DIR: options.builtinDir } });
    assert.equal(resolveAdapterPaths({ env, home: options.home }).profile, 'public');
  }
  fs.writeFileSync(path.join(options.builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: {} }));
  assert.throws(() => buildAdapterEnvironment(options), /Invalid built-in Adapter profile metadata/);
});

test('packaged builds reject missing metadata or another profile and cannot use source fallbacks', (t) => {
  const options = fixture(t);
  assert.throws(() => buildAdapterEnvironment({ ...options, env: { WEWORKER_BUILD_PROFILE: 'public' } }), /does not match/);
  assert.throws(() => buildAdapterEnvironment({ ...options, resourcesPath: path.join(options.root, 'missing') }), /ENOENT/);
  const env = buildAdapterEnvironment({ ...options, env: { WEWORKER_BUILTIN_ADAPTERS_DIR: options.repoRoot } });
  assert.equal(env.WEWORKER_BUILTIN_ADAPTERS_DIR, options.builtinDir);
});

test('development uses prepared profile assets and requires prepare once source packages exist', (t) => {
  const options = fixture(t);
  const prepared = path.join(options.repoRoot, 'weworker/build/builtin-adapters');
  fs.mkdirSync(path.join(options.repoRoot, 'adapters'), { recursive: true });
  assert.throws(() => buildAdapterEnvironment({ ...options, packaged: false }), /prepare/);
  fs.cpSync(options.builtinDir, prepared, { recursive: true });
  const env = buildAdapterEnvironment({ ...options, packaged: false });
  assert.equal(env.WEWORKER_BUILD_PROFILE, 'internal');
  assert.equal(env.WEWORKER_BUILTIN_ADAPTERS_DIR, prepared);
});

test('packaged metadata and explicit root ownership are validated at the desktop boundary', (t) => {
  const options = fixture(t, 'public');
  fs.writeFileSync(path.join(options.builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'reserved' }));
  assert.throws(() => buildAdapterEnvironment(options), /Invalid built-in Adapter profile metadata/);
  fs.writeFileSync(path.join(options.builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [], legacy: [] }));
  const userDir = path.join(options.root, 'shared-user');
  fs.mkdirSync(userDir);
  fs.writeFileSync(path.join(userDir, '.adapter-profile.json'), JSON.stringify({ profile: 'internal' }));
  assert.throws(() => buildAdapterEnvironment({ ...options, env: { WEWORKER_USER_ADAPTERS_DIR: userDir } }), /different profile/);
});

test('packaged metadata without the retired legacy field is accepted', (t) => {
  const options = fixture(t, 'public');
  fs.writeFileSync(path.join(options.builtinDir, '.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [] }));
  const env = buildAdapterEnvironment(options);
  assert.equal(env.WEWORKER_BUILD_PROFILE, 'public');
  assert.equal(env.WEWORKER_BUILTIN_ADAPTERS_DIR, options.builtinDir);
});

test('Windows-style equivalent override casing is not a conflict', (t) => {
  if (process.platform !== 'win32') return;
  const options = fixture(t, 'public');
  const userDir = path.join(options.root, 'Shared-User');
  const env = buildAdapterEnvironment({ ...options, env: { WEWORKER_USER_ADAPTERS_DIR: userDir, WEBCLI_ADAPTERS_DIR: path.join(options.root, 'shared-user') } });
  assert.equal(env.WEWORKER_USER_ADAPTERS_DIR, path.resolve(userDir));
});
