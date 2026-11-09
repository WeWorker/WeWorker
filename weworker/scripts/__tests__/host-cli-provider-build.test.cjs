'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { hostCliProviderPlugins } = require('../host-cli-provider-build.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-provider-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'webcli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'weworker/host-cli-assets/example'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../../webcli/host-cli-provider.js'), path.join(root, 'webcli/host-cli-provider.js'));
  return root;
}
function configure(root, entry = 'host-cli-assets/example/provider.js') {
  fs.writeFileSync(path.join(root, 'weworker/host-cli-provider.json'), JSON.stringify({schemaVersion: 1, entry}));
}
async function bundle(root, name) {
  const out = path.join(root, name + '.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'webcli/host-cli-provider.js')], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: hostCliProviderPlugins(root) });
  return require(out);
}
test('unconfigured public distribution keeps host CLI disabled', async t => {
  const root = fixture(t);
  await assert.rejects((await bundle(root, 'public')).executeHostCli({}), {code: 'HOST_CLI_UNAVAILABLE'});
});
test('both bundles execute selected provider once and preserve unknown write outcome', async t => {
  const root = fixture(t); configure(root);
  const boundary = path.join(root, 'webcli/host-cli-provider.js');
  const original = fs.readFileSync(boundary, 'utf8');
  fs.writeFileSync(path.join(root, 'webcli/contract.js'), 'export const value = 42;');
  fs.writeFileSync(path.join(root, 'weworker/host-cli-assets/example/provider.js'), `
    import { value } from './contract.js';
    export async function executeHostCli(request) {
      if (request.write) { request.markWriteDispatched(); throw Object.assign(new Error('unknown'), {code: 'HOST_CLI_OUTCOME_UNKNOWN'}); }
      return {value, args: request.args};
    }
  `);
  for (const name of ['bridge', 'webcli']) {
    const provider = await bundle(root, name);
    assert.deepEqual(await provider.executeHostCli({args: {query: 'example'}}), {value:42, args:{query:'example'}});
    let dispatched = 0;
    await assert.rejects(provider.executeHostCli({write:true, markWriteDispatched() { dispatched++; }}), {code:'HOST_CLI_OUTCOME_UNKNOWN'});
    assert.equal(dispatched, 1);
  }
  assert.equal(fs.readFileSync(boundary, 'utf8'), original);
});
test('invalid or missing configured provider fails build instead of silently disabling it', t => {
  const root = fixture(t);
  for (const entry of ['../provider.js', '/tmp/provider.js', 'host-cli-assets/../provider.js', 'host-cli-assets/example/missing.js']) {
    configure(root, entry);
    assert.throws(() => hostCliProviderPlugins(root));
  }
});
test('both production bundle entrypoints use the build-time provider binding', () => {
  for (const name of ['bundle-bridge.cjs', 'bundle-webcli.cjs']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
    assert.match(source, /plugins: require\('\.\/host-cli-provider-build\.cjs'\)\.hostCliProviderPlugins\(projectRoot\)/);
    assert.match(source, /await esbuild\.build\(/);
  }
});
