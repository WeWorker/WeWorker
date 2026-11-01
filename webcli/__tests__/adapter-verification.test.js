import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAdapters } from '../adapter-verification.js';
import { writePackageDirectory } from '../adapter-package-files.js';
import { resolveAdapterPaths } from '../paths.js';
import { ExplorationKnowledge } from '../exploration-knowledge.js';
import { toolkitArtifactHash } from '../adapter-registry.js';
import { installAdapter, selectAdapter } from '../adapter-install-store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'u01-verify-'));
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin') } });
  const directory = join(root, 'example');
  const files = new Map([['manifest.json', JSON.stringify({ schema_version: 2, name: 'example', version: '1.0.0', description: 'Example', match: ['example.com'],
    commands: [{ id: 'read', runtime: 'extension', module: 'extension/commands/read.js', description: 'Read', safety: 'read', schema: { type: 'object', properties: {} } },
      { id: 'write', runtime: 'extension', module: 'extension/commands/write.js', description: 'Write', safety: 'write', schema: { type: 'object', properties: {} } }] })],
  ['extension/commands/read.js', 'throw new Error("must not execute");'], ['extension/commands/write.js', 'throw new Error("must not write");']]);
  const pkg = writePackageDirectory(directory, files);
  return { root, paths, directory, files, pkg };
}
it('distinguishes static success, missing evidence and required evidence without executing read or write', async () => {
  const { directory, paths } = fixture();
  const result = await verifyAdapters({ directory, paths });
  expect(result).toMatchObject({ ok: true, staticOk: true, evidenceComplete: false, executed: false });
  expect(result.results[0].evidence.every(item => !item.executed && !item.replayAllowed && !item.currentEffectVerified)).toBe(true);
  expect(await verifyAdapters({ directory, paths, requireEvidence: true })).toMatchObject({ ok: false, staticOk: true });
  expect(existsSync(paths.stateDir)).toBe(false);
});
it('uses digest-bound historical read and independent write evidence without exposing args or granting current verification', async () => {
  const { root, directory, paths, pkg } = fixture(), knowledgeDir = join(root, 'knowledge');
  const store = new ExplorationKnowledge(knowledgeDir), verifiedAt = new Date().toISOString();
  const commands = { 'example.read': { packageDigest: pkg.digest, verifiedAt, cases: [{ id: 'one', args: { secret: 'PRIVATE_EXAMPLE_VALUE' } }] },
    'example.write': { packageDigest: pkg.digest, verifiedAt, writeVerification: { verifiedAt, replayAllowed: false, fixture: { secret: 'PRIVATE_EXAMPLE_VALUE' } } } };
  store.save('example', { expectedHash: store.read('example').hash, verifiedAt, packageDigest: pkg.digest, endpoints: [], commands });
  const report = await verifyAdapters({ directory, paths, knowledgeDir, requireEvidence: true });
  expect(report).toMatchObject({ ok: true, evidenceComplete: true, executed: false });
  expect(report.results[0].evidence.map(item => item.status)).toEqual(['HISTORICAL_READ_CASES', 'HISTORICAL_WRITE_EFFECT']);
  expect(JSON.stringify(report)).not.toContain('PRIVATE_EXAMPLE_VALUE');
  expect(JSON.stringify(report)).not.toContain(root);
  expect(await verifyAdapters({ directory, paths, knowledgeDir, requireEvidence: true, now: Date.now() + 31 * 86400000 })).toMatchObject({ ok: false, staticOk: true });
  writeFileSync(join(directory, 'extension/commands/read.js'), 'module.exports=()=>[];');
  expect((await verifyAdapters({ directory, paths, knowledgeDir })).results[0].evidence[0].status).toBe('EVIDENCE_DIGEST_MISMATCH');
});
it('does not turn offline write fixtures or missing knowledge into effect evidence', async () => {
  const { root, directory, paths, pkg } = fixture(), knowledgeDir = join(root, 'knowledge');
  const store = new ExplorationKnowledge(knowledgeDir), verifiedAt = new Date().toISOString();
  store.save('example', { expectedHash: store.read('example').hash, verifiedAt, packageDigest: pkg.digest, endpoints: [],
    commands: { 'example.write': { verifiedAt, packageDigest: pkg.digest, cases: [{}], writeVerification: { fixture: {} } } } });
  const result = await verifyAdapters({ directory, paths, knowledgeDir, requireEvidence: true });
  expect(result.ok).toBe(false);
  expect(result.results[0].evidence.map(item => item.status)).toEqual(['EVIDENCE_MISSING', 'WRITE_EFFECT_EVIDENCE_MISSING']);
  writeFileSync(store.file('example'), '{broken');
  expect((await verifyAdapters({ directory, paths, knowledgeDir })).results[0].evidence[0].status).toBe('EVIDENCE_INVALID');
});
it('retains disabled and tampered managed-package failures instead of verifying a fallback', async () => {
  const { paths, files } = fixture(); installAdapter({ files }, { paths }); selectAdapter('example', 'disabled', { paths });
  expect(await verifyAdapters({ paths, name: 'example' })).toMatchObject({ ok: false, diagnostics: [{ code: 'ADAPTER_NOT_ACTIVE' }] });
});
it('compiles legacy source without evaluating dynamic metadata and rejects unsafe support paths', async () => {
  const { root, paths } = fixture(), directory = join(root, 'legacy'); mkdirSync(directory);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ id: 'legacy' }));
  writeFileSync(join(directory, 'index.js'), 'throw new Error("do not run"); window.__webmcpRegister({tools:[{name:"legacy.read",handler(){}}]});');
  expect(await verifyAdapters({ directory, paths, runtime: 'legacy' })).toMatchObject({ ok: true, results: [{ commands: ['legacy.read'], warnings: [{ code: 'LEGACY_STATIC_NAMES_ONLY' }] }] });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ support_files: ['../outside.js'] }));
  expect(await verifyAdapters({ directory, paths, runtime: 'legacy' })).toMatchObject({ ok: false, results: [{ errors: [{ code: 'INVALID_PACKAGE_PATH' }] }] });
});
it('diagnoses Toolkit artifacts and unavailable runtime without executing Python, including corrupt neighbors', async () => {
  const { root, paths } = fixture(), directory = join(root, 'toolkit'); mkdirSync(join(directory, 'scripts'), { recursive: true });
  for (const file of ['toolkit.py', 'toolkit_runtime.py', 'requirements.txt']) writeFileSync(join(directory, 'scripts', file), 'raise RuntimeError("not executed")');
  writeFileSync(join(directory, 'SKILL.md'), '# Fixture');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, adapter_type: 'toolkit', id: 'toolkit', entry: 'scripts/toolkit.py', artifact_hash: toolkitArtifactHash(directory), tools: [{ id: 'read', name: 'toolkit.read' }] }));
  const options = { directory, paths, runtime: 'toolkit', env: { WEWORKER_TOOLKIT_RUNTIME: join(root, 'missing') } };
  expect(await verifyAdapters(options)).toMatchObject({ ok: true, results: [{ runtimeAvailable: false, executed: false, warnings: [{ code: 'TOOLKIT_RUNTIME_UNAVAILABLE' }, { code: 'TOOLKIT_PYTHON_NOT_EXECUTED' }] }] });
  writeFileSync(join(directory, 'scripts/toolkit.py'), 'changed');
  expect(await verifyAdapters(options)).toMatchObject({ ok: false, results: [{ errors: [{ code: 'TOOLKIT_DIGEST_MISMATCH' }] }] });
  const invalid = join(root, 'broken'); mkdirSync(invalid); writeFileSync(join(invalid, 'manifest.json'), '{');
  const report = await verifyAdapters({ ...options, directory: undefined, env: { ...options.env, WEWORKER_ADAPTERS_DIR: root } });
  expect(report.results.some(item => item.name === 'broken' && !item.ok)).toBe(true);
});
it('rejects linked Toolkit script directories before hashing outside files', async () => {
  const { root, paths } = fixture(), directory = join(root, 'linked'), outside = join(root, 'outside');
  mkdirSync(directory); mkdirSync(outside); symlinkSync(outside, join(directory, 'scripts'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(directory, 'SKILL.md'), '# Example');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, adapter_type: 'toolkit', id: 'linked', entry: 'scripts/toolkit.py' }));
  expect(await verifyAdapters({ directory, paths, runtime: 'toolkit' })).toMatchObject({ ok: false, results: [{ errors: [{ code: 'UNSAFE_TOOLKIT_FILE' }] }] });
});
