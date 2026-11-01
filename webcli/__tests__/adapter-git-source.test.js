import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectGitSource, installGitPackage } from '../adapter-git-source.js';
import { writePackageDirectory } from '../adapter-package-files.js';
import { resolveAdapterPaths } from '../paths.js';
import { buildAdapterCatalog } from '../adapter-catalog.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'u01-git-')), repository = join(root, 'repo'); mkdirSync(repository);
  const git = args => execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=' + join(root, 'no-hooks'), '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
  git(['init', '-q']);
  for (const name of ['one', 'two']) writePackageDirectory(join(repository, 'packages', name), new Map([
    ['manifest.json', JSON.stringify({ schema_version: 2, name, version: '1.0.0', description: 'Example', match: [`${name}.example.com`], commands: [{ id: 'read', runtime: 'extension', module: 'extension/commands/read.js', description: 'Read', schema: { type: 'object', properties: {} } }] })],
    ['extension/commands/read.js', 'throw new Error("must not execute");'],
  ]));
  writeFileSync(join(repository, 'package.json'), JSON.stringify({ scripts: { install: 'exit 99' } }));
  git(['add', '.']); git(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', '-c', 'core.hooksPath=' + join(root, 'no-hooks'), 'commit', '-qm', 'fixture']);
  const ref = git(['rev-parse', 'HEAD']).trim();
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin') } });
  return { root, repository, git, ref, paths };
}
it('discovers committed monorepo packages and installs exact reviewed bytes while preserving dirty worktree', () => {
  const { repository, ref, paths, git } = fixture();
  const report = inspectGitSource(repository, ref); expect(report.ok).toBe(true); expect(report.results).toHaveLength(2);
  writeFileSync(join(repository, 'packages/one/extension/commands/read.js'), 'BROKEN WORKTREE');
  const before = git(['status', '--porcelain']);
  const result = installGitPackage({ repository, ref, subpath: 'packages/one', digest: report.results[0].digest }, { paths });
  expect(result).toMatchObject({ name: 'one', origin: { kind: 'git', commit: ref, subpath: 'packages/one' } });
  const active = buildAdapterCatalog({ paths }).effective[0];
  expect(readFileSync(join(active.root, 'extension/commands/read.js'), 'utf8')).toContain('must not execute');
  expect(git(['status', '--porcelain'])).toBe(before);
  expect(buildAdapterCatalog({ paths }).effective).toHaveLength(1);
});
it('rejects mutable refs, noncommit objects, wrong digests and traversal before installation', () => {
  const { repository, ref, paths, git } = fixture();
  expect(() => inspectGitSource(repository, 'HEAD')).toThrow(/immutable/);
  expect(() => inspectGitSource(repository, git(['rev-parse', 'HEAD^{tree}']).trim())).toThrow(/commit/);
  expect(() => installGitPackage({ repository, ref, subpath: 'packages/one', digest: '0'.repeat(64) }, { paths })).toThrow(/digest/);
  expect(() => installGitPackage({ repository, ref, subpath: '../outside', digest: '0'.repeat(64) }, { paths })).toThrow(/path/);
  expect(existsSync(paths.stateDir)).toBe(false);
});
it('reports duplicate identities and malformed manifests instead of silently skipping them', () => {
  const { repository, ref, git } = fixture();
  const manifest = JSON.parse(readFileSync(join(repository, 'packages/two/manifest.json'))); manifest.name = 'one';
  writeFileSync(join(repository, 'packages/two/manifest.json'), JSON.stringify(manifest));
  mkdirSync(join(repository, 'bad')); writeFileSync(join(repository, 'bad/manifest.json'), '{');
  git(['add', '.']); git(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-qm', 'duplicates']);
  const report = inspectGitSource(repository, git(['rev-parse', 'HEAD']).trim());
  expect(report.ok).toBe(false); expect(report.diagnostics.map(item => item.code)).toContain('DUPLICATE_PACKAGE_NAME');
  expect(report.diagnostics.map(item => item.code)).toContain('INVALID_MANIFEST');
  expect(inspectGitSource(repository, ref).ok).toBe(true);
});
it('rejects Git symlink entries without checking them out or reading their target', () => {
  const { repository, git } = fixture();
  const oid = execFileSync('git', ['-C', repository, 'hash-object', '-w', '--stdin'], { input: '../../outside', encoding: 'utf8', windowsHide: true }).trim();
  git(['update-index', '--add', '--cacheinfo', `120000,${oid},packages/one/extension/commands/read.js`]);
  git(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-qm', 'linked object']);
  const report = inspectGitSource(repository, git(['rev-parse', 'HEAD']).trim());
  expect(report.ok).toBe(false);
  expect(report.diagnostics).toContainEqual({ path: 'packages/one', code: 'UNSAFE_GIT_ENTRY' });
});
