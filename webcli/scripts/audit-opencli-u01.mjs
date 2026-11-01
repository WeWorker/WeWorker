// Execute unchanged 1.8.8 verification and manifest helpers; never install a plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const upstream = process.argv.find(arg => arg.startsWith('--upstream='))?.slice(11);
if (!upstream) throw new Error('Pass --upstream=<unpacked OpenCLI 1.8.8 with isolated dependencies>.');
const root = path.resolve(upstream), reportRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-u01-audit-'));
assert.equal(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version, '1.8.8');
const load = name => import(pathToFileURL(path.join(root, 'dist/src', name)).href);
const { verifyClis } = await load('verify.js'), { cli } = await load('registry.js');
const { readPluginManifest, isMonorepo, getEnabledPlugins } = await load('plugin-manifest.js');
let executed = 0;
for (const access of ['read', 'write']) cli({ site: 'example-u01', name: access, access, browser: false, description: 'Isolated example', func: () => { executed++; throw new Error('Must not execute.'); } });
const options = { target: 'example-u01', builtinClis: path.join(root, 'clis') };
const staticReport = await verifyClis({ ...options, smoke: false });
assert.equal(staticReport.ok, true); assert.equal(staticReport.validation.commands, 2); assert.equal(executed, 0);
const smoke = await verifyClis({ ...options, smoke: true });
assert.equal(smoke.ok, false); assert.equal(smoke.smoke.executed, false); assert.equal(executed, 0);
const missing = await verifyClis({ ...options, target: 'missing-example-u01', smoke: false });
assert.equal(missing.ok, true); assert.equal(missing.validation.commands, 0);
await fs.writeFile(path.join(reportRoot, 'opencli-plugin.json'), JSON.stringify({ plugins: { second: { path: 'packages/second', disabled: true }, first: { path: 'packages/first' } } }));
const manifest = readPluginManifest(reportRoot);
assert.equal(isMonorepo(manifest), true); assert.deepEqual(getEnabledPlugins(manifest).map(item => item.name), ['first']);
await fs.writeFile(path.join(reportRoot, 'report.json'), JSON.stringify({ passed: true, upstream: '1.8.8', executed, staticReport, smoke, missing,
  monorepo: { enabled: getEnabledPlugins(manifest) }, boundary: 'Direct exported functions only; no daemon/browser or plugin install lifecycle.' }, null, 2));
console.log('Artifacts: ' + reportRoot);
console.log('PASS static read/write zero execution; unavailable smoke fails; missing target returns zero; disabled monorepo child filtered');
