// CLI acceptance: owned Git repository, install roots and loopback HTTP only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile), source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcli-u01-acceptance-'));
const bundled = process.argv.includes('--bundled');
const explicit = process.argv.find(arg => arg.startsWith('--entry='))?.slice(8);
const entry = explicit || (bundled ? path.resolve(source, '../weworker/build/webcli-dist/webcli.cjs') : path.join(source, 'index.js'));
const requests = [], checks = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
const server = http.createServer((req, res) => { requests.push({ method: req.method, url: req.url }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag: 'committed' })); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const env = { ...process.env, WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'),
  WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'),
  WEWORKER_ADAPTERS_DIR: path.join(root, 'skills'), WEWORKER_TOOLKIT_RUNTIME: path.join(root, 'missing-runtime'),
  WEBCLI_METRICS: 'off', WEBCLI_METRICS_UPLOAD: 'off' };
delete env.WEWORKER_RESOURCES_PATH;
const raw = args => exec(process.execPath, [entry, ...args], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const run = async args => JSON.parse((await raw([...args, '--output-format=json'])).stdout);
console.log('Artifacts: ' + root);
try {
  const repository = path.join(root, 'repo'); await fs.mkdir(repository);
  const git = async args => (await exec('git', ['-C', repository, '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), '-c', 'commit.gpgsign=false', ...args], { windowsHide: true })).stdout.trim();
  await git(['init', '-q']);
  const directory = path.join(repository, 'packages/example-git'); await fs.mkdir(path.join(directory, 'http/commands'), { recursive: true });
  const manifest = { schema_version: 2, name: 'example-git', version: '1.0.0', description: 'Public Git fixture',
    commands: [{ id: 'read', runtime: 'http', module: 'http/commands/read.js', description: 'Read public item', safety: 'read', schema: { type: 'object', properties: {} }, http: { version: 1, strategy: 'PUBLIC_API', origins: [origin] } },
      { id: 'write', runtime: 'http', module: 'http/commands/write.js', description: 'Must not execute', safety: 'write', schema: { type: 'object', properties: {} }, http: { version: 1, strategy: 'PUBLIC_API', origins: [origin] } }] };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'http/commands/read.js'), 'module.exports=(args,api)=>api.request({url:' + JSON.stringify(origin + '/items') + '});');
  await fs.writeFile(path.join(directory, 'http/commands/write.js'), 'throw new Error("verification must not execute a write");');
  await fs.writeFile(path.join(repository, 'package.json'), JSON.stringify({ scripts: { install: 'exit 99' } }));
  await git(['add', '.']); await git(['-c', 'user.name=Example', '-c', 'user.email=example@example.com', '-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), 'commit', '-qm', 'Public fixture']);
  const ref = await git(['rev-parse', 'HEAD']);
  const discovered = await run(['adapter', 'source', repository, '--ref', ref]); assert.equal(discovered.ok, true);
  const digest = discovered.results[0].digest;
  await fs.writeFile(path.join(directory, 'http/commands/read.js'), 'DIRTY WORKTREE');
  const dirty = await git(['status', '--porcelain']);
  const install = ['adapter', 'install', '--git', repository, '--ref', ref, '--package', 'packages/example-git', '--digest', digest];
  await assert.rejects(run([...install.slice(0, -1), '0'.repeat(64)]));
  assert.equal((await run(install)).digest, digest);
  assert.equal(await git(['status', '--porcelain']), dirty); assert.equal(requests.length, 0);
  pass('immutable Git discovery, exact digest installation and dirty checkout preservation; repository scripts never run');
  const verified = await run(['adapter', 'verify', '--installed', 'example-git']);
  assert.equal(verified.staticOk, true); assert.equal(verified.evidenceComplete, false); assert.equal(verified.executed, false);
  assert.equal(verified.results[0].evidence.length, 2);
  let failure; try { await run(['adapter', 'verify', '--installed', 'example-git', '--require-evidence']); } catch (error) { failure = error; }
  assert.equal(failure?.code, 1); assert.equal(JSON.parse(failure.stdout).staticOk, true); assert.equal(requests.length, 0);
  pass('ordinary verification never invokes read/write tools; evidence-required exits nonzero instead of claiming runtime success');
  assert.equal((await run(['call', 'example-git.read'])).tag, 'committed');
  assert.deepEqual(requests, [{ method: 'GET', url: '/items' }]);
  pass('explicit ordinary HTTP call uses installed commit bytes, not dirty source');
  for (const format of ['json', 'yaml', 'csv', 'table', 'plain', 'markdown']) {
    const output = await raw(['adapter', 'verify', '--installed', 'example-git', '--output-format=' + format]);
    assert.ok(output.stdout.includes('example-git'));
  }
  for (const args of [['adapter', 'verify', '--installed', 'example-git', '--smoke'], ['adapter', 'verify', '--installed', 'example-git', '--output-format=invalid'],
    ['adapter', 'source', repository, '--ref', 'HEAD']]) await assert.rejects(raw(args));
  assert.equal(requests.length, 1);
  pass('six output formats and invalid flags/ref/format preserve zero-execution diagnostics');
  const legacy = path.join(root, 'legacy'); await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'manifest.json'), JSON.stringify({ id: 'legacy' }));
  await fs.writeFile(path.join(legacy, 'index.js'), 'throw new Error("never execute"); window.__webmcpRegister({tools:[{name:"legacy.read",handler(){}}]});');
  assert.equal((await run(['adapter', 'verify', legacy, '--runtime', 'legacy'])).results[0].commands[0], 'legacy.read');
  await fs.writeFile(path.join(legacy, 'index.js'), 'const = invalid;');
  await assert.rejects(run(['adapter', 'verify', legacy, '--runtime', 'legacy']));
  const toolkit = path.join(root, 'skills/toolkit'); await fs.mkdir(path.join(toolkit, 'scripts'), { recursive: true });
  for (const file of ['toolkit.py', 'toolkit_runtime.py', 'requirements.txt']) await fs.writeFile(path.join(toolkit, 'scripts', file), 'raise RuntimeError("never execute")');
  await fs.writeFile(path.join(toolkit, 'SKILL.md'), '# Public example');
  const { toolkitArtifactHash } = await import('../adapter-registry.js');
  await fs.writeFile(path.join(toolkit, 'manifest.json'), JSON.stringify({ schema_version: 1, id: 'toolkit', adapter_type: 'toolkit', entry: 'scripts/toolkit.py',
    artifact_hash: toolkitArtifactHash(toolkit), tools: [{ id: 'read', name: 'toolkit.read' }] }));
  const inspected = await run(['adapter', 'verify', '--installed', 'toolkit', '--runtime', 'toolkit']);
  assert.equal(inspected.ok, true); assert.equal(inspected.results[0].runtimeAvailable, false);
  await fs.writeFile(path.join(toolkit, 'scripts/toolkit.py'), 'tampered');
  await assert.rejects(run(['adapter', 'verify', '--installed', 'toolkit', '--runtime', 'toolkit']));
  pass('legacy syntax and Toolkit integrity/unavailable-runtime diagnostics work in actual CLI without Python execution');
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ passed: true, bundled, explicitEntry: !!explicit, checks, requests }, null, 2));
} catch (error) { await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({ message: error.message, stdout: error.stdout, stack: error.stack })); throw error; }
finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
