const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { mergeBuildProfile } = require('../build-profile-overlay.cjs');
const { validateBuildProfile } = require('../build-profile-validator.cjs');
const { createEsbuildDefines } = require('../bundle-backend-ts.cjs');
const root = path.resolve(__dirname, '../..');
const { loadBuildProfile, publicProviders } = require('../model-provider-config.cjs');
const profile = loadBuildProfile();

function registryFor(profile) {
  const built = buildSync({ entryPoints: [path.join(root, 'backend-ts/src/provider-registry.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false,
    define: createEsbuildDefines(profile),
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

test('public profile and compiled backend expose identical credential-free built-in metadata', () => {
  validateBuildProfile(profile);
  const runtime = registryFor(profile);
  const builtin = profile.providers.find(p => p.id === 'builtin');
  assert.ok(builtin);
  assert.deepEqual(runtime.getProvider('builtin'), publicProviders([builtin])[0]);
  assert.deepEqual(runtime.PROVIDERS, publicProviders(profile.providers));
  assert.deepEqual([...runtime.ALLOWED_PROVIDER_IDS], profile.providers.map(p => p.id));
  const defines = createEsbuildDefines(profile);
  assert.deepEqual(JSON.parse(defines.__BUILD_PROVIDERS__), publicProviders(profile.providers));
  for (const entry of profile.providers) {
    for (const field of ['api_key', 'apiKey', 'token', 'secret']) assert.equal(entry[field], undefined);
  }
});

test('overlay can replace a managed provider endpoint without runtime reinsertion', () => {
  const builtin = profile.providers.find(p => p.id === 'builtin');
  const managed = { ...builtin, id: 'builtin_dev', name: 'Fixture managed provider',
    weworker: { ...builtin.weworker, baseUrl: 'https://example.com/anthropic' },
    webwright: { ...builtin.webwright, baseUrl: 'https://example.com/v1' },
  };
  const effective = mergeBuildProfile(profile, { providers: { remove: ['builtin'], upsert: [managed] }, defaultProvider: 'builtin_dev' });
  validateBuildProfile(effective);
  const runtime = registryFor(effective);
  assert.equal(runtime.getProvider('builtin'), undefined);
  assert.deepEqual(runtime.getProvider('builtin_dev'), publicProviders([managed])[0]);
  assert.ok(runtime.ALLOWED_LLM_BASE_URLS.has('https://example.com/v1'));
});

test('build profile accepts providers without a built-in model but keeps non-empty ones consistent', () => {
  // 模型名不再写死：models 与 defaultModel 允许同时为空，由模型列表接口或用户手填决定。
  const withoutModels = { ...profile, providers: profile.providers.map(p =>
    ['anthropic', 'glm', 'deepseek'].includes(p.id) ? { ...p, models: [], defaultModel: '' } : p) };
  validateBuildProfile(withoutModels);
  // 非空 defaultModel 仍必须出现在 models 里。
  const mismatched = { ...profile, providers: profile.providers.map(p =>
    p.id === 'deepseek' ? { ...p, models: ['fixture-model'], defaultModel: 'other-model' } : p) };
  assert.throws(() => validateBuildProfile(mismatched), /must exist in models or be empty/);
});


test('fixed coding provider survives profile compilation without deployment data', () => {
  const template = profile.providers.find(p => p.id === 'glm');
  const provider = { ...template, id: 'bank_coding', name: 'Fixture coding provider', allowMultiple: false,
    weworker: { ...template.weworker, baseUrl: 'https://example.com' },
    webwright: { ...template.webwright, baseUrl: 'https://example.org' } };
  const configured = mergeBuildProfile(profile, { providers: { upsert: [provider] } });
  assert.equal(provider.defaultModel, '');
  assert.deepEqual(provider.models, []);
  assert.ok(new URL(provider.weworker.baseUrl));
  assert.ok(new URL(provider.webwright.baseUrl));
  assert.deepEqual(registryFor(configured).PROVIDERS.find(p => p.id === 'bank_coding'), provider);
  const excluded = mergeBuildProfile(configured, { providers: { remove: ['bank_coding'] } });
  assert.equal(registryFor(excluded).getProvider('bank_coding'), undefined);
});
