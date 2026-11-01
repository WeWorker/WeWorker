import { afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdapterPaths } from '../paths.js';
import { writePackageDirectory, readPackageDirectory } from '../adapter-package-files.js';
import { installAdapter, registerDevelopmentAdapter, selectAdapter } from '../adapter-install-store.js';
import { ejectAdapter } from '../adapter-export.js';
import { runManagedAdapterCommand } from '../managed-adapter-cli.js';
import { buildAdapterCatalog } from '../adapter-catalog.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'adapter-export-')); roots.push(root);
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin') } });
  const files = new Map([['manifest.json', JSON.stringify({ schema_version: 2, name: 'example', version: '1.0.0', description: 'Public example', match: ['example.com'],
    commands: [{ id: 'read', runtime: 'extension', module: 'extension/commands/read.js', description: 'Read', safety: 'read', schema: {} }] })],
  ['extension/commands/read.js', 'throw new Error("must not execute");'], ['extension/internal/shared.js', 'module.exports = { public: true };']]);
  const pkg = writePackageDirectory(join(paths.builtinDir, 'example'), files);
  mkdirSync(join(root, 'work'));
  return { root, paths, pkg, destination: join(root, 'work/example') };
}
it('exports the complete built-in snapshot without executing or activating and supports explicit development/reset selection', () => {
  const f = setup();
  const exported = runManagedAdapterCommand(['eject', 'example', '--directory', f.destination], { paths: f.paths });
  expect(exported).toMatchObject({ source: 'builtin', activated: false, digest: f.pkg.digest, files: 3 });
  expect(readPackageDirectory(f.destination).digest).toBe(f.pkg.digest);
  expect(existsSync(f.paths.stateDir)).toBe(false);
  writeFileSync(join(f.destination, 'extension/commands/read.js'), 'module.exports = () => "edited";');
  registerDevelopmentAdapter(f.destination, { paths: f.paths });
  expect(buildAdapterCatalog({ paths: f.paths }).effective[0].source).toBe('development');
  selectAdapter('example', 'builtin', { paths: f.paths });
  expect(buildAdapterCatalog({ paths: f.paths }).effective[0].digest).toBe(f.pkg.digest);
  expect(readFileSync(join(f.destination, 'extension/commands/read.js'), 'utf8')).toContain('edited');
  expect(readPackageDirectory(join(f.paths.builtinDir, 'example')).digest).toBe(f.pkg.digest);
});
it('exports the built-in baseline even when a managed user package is selected', () => {
  const f = setup(), files = new Map(f.pkg.files);
  files.set('extension/commands/read.js', Buffer.from('module.exports = () => "user";'));
  installAdapter({ files, origin: { kind: 'local' } }, { paths: f.paths });
  const state = readFileSync(join(f.paths.stateDir, 'registry.json'));
  expect(ejectAdapter('example', f.destination, { paths: f.paths }).digest).toBe(f.pkg.digest);
  expect(readFileSync(join(f.paths.stateDir, 'registry.json'))).toEqual(state);
});
it('rejects existing, linked, misnamed, managed or missing-parent destinations without modifying them', () => {
  const f = setup(); mkdirSync(f.paths.userDir, { recursive: true });
  for (const directory of [join(f.root, 'work/wrong'), join(f.paths.userDir, 'example'), join(f.root, 'missing/example'), join(f.paths.builtinDir, 'example')]) {
    expect(() => ejectAdapter('example', directory, { paths: f.paths })).toThrow();
  }
  symlinkSync(f.paths.builtinDir, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => ejectAdapter('example', join(f.root, 'linked/example'), { paths: f.paths })).toThrow();
  mkdirSync(f.destination); writeFileSync(join(f.destination, 'keep.txt'), 'Public existing file');
  expect(() => ejectAdapter('example', f.destination, { paths: f.paths })).toThrow(/already exists/);
  expect(readFileSync(join(f.destination, 'keep.txt'), 'utf8')).toBe('Public existing file');
  expect(() => ejectAdapter('missing', join(f.root, 'work/missing'), { paths: f.paths })).toThrow(/built-in/);
  expect(existsSync(join(f.paths.userDir, 'example'))).toBe(false);
});
