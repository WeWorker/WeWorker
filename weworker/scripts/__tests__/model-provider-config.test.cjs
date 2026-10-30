const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { loadBuildProfile, loadBuildDefines } = require('../model-provider-config.cjs');
const { createEsbuildDefines } = require('../bundle-backend-ts.cjs');
const root = path.resolve(__dirname, '../..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'model.json'), 'utf8'));

function fixture(t, prepared) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-provider-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'build-profile.json'), JSON.stringify({ adapters: [], modelProviders: './model.json' }));
  const save = config => fs.writeFileSync(path.join(directory, 'model.json'), JSON.stringify(config));
  save(source);
  if (prepared) {
    fs.mkdirSync(path.join(directory, 'build'));
    fs.writeFileSync(path.join(directory, 'build/.build-defines.json'), JSON.stringify(prepared));
  }
  return { root: directory, save };
}

function compiled(entry, profile) {
  const result = buildSync({ entryPoints: [path.join(root, entry)], bundle: true,
    platform: 'node', format: 'cjs', write: false, define: createEsbuildDefines(profile) });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

test('build profile obtains provider metadata and the default from the referenced JSON', () => {
  const effective = loadBuildProfile();
  assert.deepEqual(effective.providers, source.providers);
  assert.equal(effective.defaultProvider, source.defaultProvider);
});

test('JSON changes replace stale public definitions in development and production', t => {
  const workspace = fixture(t, { profile: 'public', providers: [], defaultProvider: 'obsolete' });
  const config = structuredClone(source);
  config.defaultProvider = 'deepseek';
  config.providers.find(p => p.id === 'deepseek').weworker.baseUrl = 'https://example.org/anthropic';
  workspace.save(config);
  assert.deepEqual(loadBuildDefines(workspace).providers, config.providers);
  assert.equal(loadBuildDefines(workspace).defaultProvider, 'deepseek');
  assert.deepEqual(loadBuildDefines({ ...workspace, development: true }).providers, config.providers);
});

test('whole-file JSON replacement restores optional providers without source changes', t => {
  const workspace = fixture(t, { profile: 'public', providers: [], defaultProvider: 'obsolete' });
  const reduced = structuredClone(source);
  reduced.providers = reduced.providers.filter(p => !['builtin_dev', 'bank_coding'].includes(p.id));
  reduced.defaultProvider = 'anthropic';
  const { encryptedApiKey, ...managedTemplate } = reduced.providers.find(p => p.id === 'builtin');
  const managed = { ...managedTemplate, id: 'builtin_dev', name: 'Fixture managed provider',
    baseUrlEnv: 'WEWORKER_FIXTURE_MANAGED_BASE_URL', apiKeyEnv: 'WEWORKER_FIXTURE_MANAGED_API_KEY',
    models: ['fixture-locked'], defaultModel: 'fixture-locked',
    weworker: { ...managedTemplate.weworker, baseUrl: 'https://example.com/managed' },
    webwright: { ...managedTemplate.webwright, baseUrl: 'https://example.org/managed' } };
  const template = reduced.providers.find(p => p.id === 'anthropic');
  const coding = { ...template, id: 'bank_coding', name: 'Fixture coding provider',
    fixed: true, builtin: false, fixedModel: false, allowMultiple: false, authType: 'auth_token',
    baseUrlEnv: 'WEWORKER_FIXTURE_CODING_BASE_URL', models: [], defaultModel: '',
    weworker: { ...template.weworker, baseUrl: 'https://example.com/coding' },
    webwright: { ...template.webwright, baseUrl: 'https://example.org/coding' } };
  const full = { ...reduced, defaultProvider: 'bank_coding', providers: [...reduced.providers, managed, coding] };

  for (const config of [reduced, full, reduced]) {
    workspace.save(config);
    for (const development of [true, false]) {
      const profile = loadBuildDefines({ ...workspace, development });
      assert.deepEqual(profile.providers, config.providers);
      const registry = compiled('backend-ts/src/provider-registry.ts', profile);
      const metadata = compiled('renderer/src/utils/provider-config.js', profile);
      const selection = compiled('renderer/src/utils/model-selection.js', profile);
      assert.deepEqual([...registry.ALLOWED_PROVIDER_IDS], config.providers.map(p => p.id));
      assert.equal(metadata.BUILD_DEFAULT_PROVIDER, config.defaultProvider);
      for (const provider of [managed, coding]) {
        const included = config === full;
        assert.deepEqual(registry.getProvider(provider.id), included ? provider : undefined);
        assert.deepEqual(metadata.configuredProvider(provider.id), included ? provider : undefined);
        assert.equal(selection.buildSettingsProviderLists(metadata.BUILD_PROVIDERS, {}).visible.some(p => p.id === provider.id), included);
        assert.equal(selection.buildChatProviderOptions(metadata.BUILD_PROVIDERS, {}, config.defaultProvider).some(p => p.value === provider.id), included);
      }
      if (config !== full) continue;
      assert.equal(metadata.hasFixedModel(managed.id), true);
      assert.equal(metadata.hasFixedModel(coding.id), false);
      const { addable } = selection.buildSettingsProviderLists(metadata.BUILD_PROVIDERS, {});
      assert.equal(addable.some(p => [managed.id, coding.id].includes(p.id)), false);
      const backend = compiled('backend-ts/src/builtin-provider.ts', profile);
      const access = backend.builtinProviderAccess(backend.BUILTIN_DEV_PROVIDER, {
        WEWORKER_FIXTURE_MANAGED_API_KEY: 'fixture-managed-key',
      });
      assert.equal(access.apiKey, 'fixture-managed-key');
      assert.equal(access.model, 'fixture-locked');
      assert.equal(access.anthropicBaseUrl, managed.weworker.baseUrl);
      assert.equal(access.openaiBaseUrl, managed.webwright.baseUrl);
      const effective = backend.resolveBankCodingSettings({ active_provider: coding.id,
        api_key_bank_coding: 'fixture-user-key', model_bank_coding: 'fixture-selected-model' }, profile.providers, {});
      assert.equal(effective.api_key, 'fixture-user-key');
      assert.equal(effective.base_url, coding.weworker.baseUrl);
      assert.equal(effective.active_auth_type, 'auth_token');
      assert.equal(effective.model, 'fixture-selected-model');
    }
  }
});

test('overlay exclusions survive JSON refresh without provider reinsertion', t => {
  const provider = { ...source.providers.find(p => p.id === 'glm'), name: 'Fixture provider', fixed: false };
  const workspace = fixture(t, { profile: 'fixture', providerOverlay: {
    providers: { remove: ['builtin', 'builtin_dev'], upsert: [provider] }, defaultProvider: 'glm',
  } });
  const effective = loadBuildDefines(workspace);
  assert.equal(effective.defaultProvider, 'glm');
  assert.equal(effective.providers.some(p => p.builtin), false);
  assert.deepEqual(effective.providers.find(p => p.id === 'glm'), provider);
  assert.equal(compiled('backend-ts/src/provider-registry.ts', effective).getProvider('builtin'), undefined);
  assert.equal(compiled('renderer/src/utils/provider-config.js', effective).configuredProvider('builtin'), undefined);
});

test('JSON flags, authentication and gateway control compiled Backend and Renderer behavior', () => {
  const profile = loadBuildProfile();
  profile.providers = profile.providers.map(p => p.id === 'deepseek'
    ? { ...p, fixed: false, authType: 'auth_token', allowMultiple: false, weworker: { ...p.weworker, baseUrl: 'https://example.org/anthropic' } } : p);
  const backend = compiled('backend-ts/src/provider-visibility.ts', profile);
  const auth = compiled('backend-ts/src/anthropic-auth.ts', profile);
  const renderer = compiled('renderer/src/utils/model-selection.js', profile);
  assert.equal(backend.isFixedProvider('deepseek'), false);
  assert.equal(renderer.isFixedProvider('deepseek'), false);
  assert.deepEqual(auth.buildAnthropicAuthHeaders('fixture-key', 'deepseek'), { authorization: 'Bearer fixture-key' });
  assert.equal(renderer.buildSettingsProviderLists(profile.providers, {}).visible.some(p => p.id === 'deepseek'), false);
  assert.equal(renderer.buildSettingsProviderLists(profile.providers, {}).addable.some(p => p.id === 'deepseek'), false);
  const registry = compiled('backend-ts/src/provider-registry.ts', profile);
  assert.equal(registry.getProvider('deepseek').weworker.baseUrl, 'https://example.org/anthropic');
});

test('model locks are independent from fixed preset visibility', () => {
  const profile = loadBuildProfile();
  profile.providers = profile.providers.map(p => p.id === 'deepseek' ? { ...p, fixedModel: true, models: ['fixture-model'], defaultModel: 'fixture-model' } : p);
  const renderer = compiled('renderer/src/utils/provider-config.js', profile);
  assert.equal(renderer.hasFixedModel('deepseek'), true);
  assert.equal(renderer.isBuiltinProvider('deepseek'), false);
});

test('invalid flags, authentication, gateways and duplicate IDs fail validation', t => {
  const workspace = fixture(t);
  for (const patch of [{ fixed: 'false' }, { authType: 'invalid' }, { fixedModel: true, defaultModel: '' },
    { weworker: { protocol: 'anthropic_messages', baseUrl: 'https://fixture:fixture@example.com' } }, { baseUrlEnv: 'not valid' }]) {
    const config = structuredClone(source);
    Object.assign(config.providers.find(p => p.id === 'anthropic'), patch);
    workspace.save(config);
    assert.throws(() => loadBuildDefines(workspace));
  }
  const duplicate = structuredClone(source);
  duplicate.providers.push(duplicate.providers[0]);
  workspace.save(duplicate);
  assert.throws(() => loadBuildDefines(workspace), /Duplicate provider IDs/);
  const missing = structuredClone(source);
  delete missing.providers[0].fixed;
  workspace.save(missing);
  assert.throws(() => loadBuildDefines(workspace), /fixed must be a boolean/);
});

test('malformed JSON and ambiguous definitions fail instead of falling back', t => {
  const workspace = fixture(t);
  fs.writeFileSync(path.join(workspace.root, 'model.json'), '{');
  assert.throws(() => loadBuildDefines(workspace), /Failed to read model provider config/);
  fs.writeFileSync(path.join(workspace.root, 'build-profile.json'), JSON.stringify({ modelProviders: './model.json', providers: [] }));
  assert.throws(() => loadBuildDefines(workspace), /belong in that file/);
});

test('legacy nonpublic build definitions require the original overlay preparation', t => {
  const workspace = fixture(t, { profile: 'fixture', providers: source.providers });
  assert.throws(() => loadBuildDefines(workspace), /rerun prepare-build/);
  assert.deepEqual(loadBuildDefines({ ...workspace, development: true }).providers, source.providers);
});

test('runtime presets use JSON gateways and auth while custom settings retain user endpoints', () => {
  const profile = loadBuildProfile();
  const runtime = compiled('backend-ts/src/provider-config.ts', profile);
  const settings = { active_provider: 'deepseek', api_key: 'fixture-key', base_url: 'https://example.org/stale',
    base_url_is_full: true, model: 'fixture-selected', active_auth_type: 'auth_token' };
  assert.deepEqual(runtime.resolveConfiguredSettings(settings, profile.providers), {
    ...settings, base_url: profile.providers.find(p => p.id === 'deepseek').weworker.baseUrl,
    base_url_is_full: false, active_auth_type: 'api_key',
  });
  const custom = { ...settings, active_provider: 'custom' };
  assert.deepEqual(runtime.resolveConfiguredSettings(custom, profile.providers), custom);
  assert.deepEqual(runtime.resolveConfiguredSettings(settings, []), { ...settings, api_key: '', base_url: '', model: '' });
});

test('model locks apply to saved preset configurations and reject overrides', () => {
  const profile = loadBuildProfile();
  profile.providers = profile.providers.map(p => p.id === 'deepseek'
    ? { ...p, fixedModel: true, defaultModel: 'fixture-locked', models: ['fixture-locked'] } : p);
  const runtime = compiled('backend-ts/src/provider-config.ts', profile);
  const configurations = compiled('backend-ts/src/model-configurations.ts', profile);
  const settings = { active_provider: 'deepseek', model: 'fixture-old', added_providers: [], model_configurations: {
    'model-fixture': { provider_id: 'deepseek', model: 'fixture-old', openai_model: 'fixture-old-openai',
      base_url: 'https://example.org/stale', base_url_is_full: true, api_key: 'fixture-key' },
  } };
  assert.equal(runtime.resolveConfiguredSettings(settings, profile.providers).model, 'fixture-locked');
  const effective = configurations.getModelConfiguration(settings, 'model-fixture');
  assert.equal(effective.model, 'fixture-locked');
  assert.equal(effective.openai_model, 'fixture-locked');
  assert.equal(effective.base_url_is_full, false);
  assert.throws(() => configurations.updateModelConfiguration(settings, 'model-fixture', { model: 'fixture-override' }), /固定模型/);
  assert.equal(settings.model_configurations['model-fixture'].model, 'fixture-old');
});

test('JSON overlays cannot discard required behavior flags', t => {
  const workspace = fixture(t, { profile: 'fixture', providerOverlay: { providers: {
    upsert: [{ id: 'deepseek', name: 'Fixture', models: [], defaultModel: '',
      weworker: { protocol: 'anthropic_messages', baseUrl: 'https://example.com' },
      webwright: { protocol: 'openai_chat_completions', modelClass: 'openai_chat', baseUrl: 'https://example.org', structuredOutput: 'openai_json_object' } }],
  } } });
  assert.throws(() => loadBuildDefines(workspace), /fixed must be a boolean/);
});


test('encrypted JSON credentials stay Backend-only and follow overlay changes and exclusions', () => {
  const { createCipheriv, randomBytes } = require('node:crypto');
  const backendSource = fs.readFileSync(path.join(root, 'backend-ts/src/builtin-provider.ts'), 'utf8');
  const key = Buffer.from(backendSource.match(/EMBEDDED_SECRET_KEY = Buffer.from\('([^']+)'/)[1], 'hex');
  const encrypt = value => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
  };
  const profile = loadBuildProfile();
  const encrypted = encrypt('fixture-json-managed-key');
  profile.providers = profile.providers.map(p => p.id === 'builtin' ? { ...p, encryptedApiKey: encrypted,
    weworker: { ...p.weworker, baseUrl: 'https://example.com/managed' },
    webwright: { ...p.webwright, baseUrl: 'https://example.org/managed' } } : p);
  const backend = compiled('backend-ts/src/builtin-provider.ts', profile);
  assert.equal(backend.getBuiltinApiKey('builtin', {}), 'fixture-json-managed-key');
  assert.equal(backend.getBuiltinApiKey('builtin', { WEWORKER_BUILTIN_API_KEY: 'fixture-env-key' }), 'fixture-env-key');
  const access = backend.builtinProviderAccess(backend.BUILTIN_PROVIDER, {});
  assert.equal(access.anthropicBaseUrl, 'https://example.com/managed');
  assert.equal(access.openaiBaseUrl, 'https://example.org/managed');
  assert.equal('encryptedApiKey' in access.provider, false);
  const renderer = compiled('renderer/src/utils/provider-config.js', profile);
  assert.equal(renderer.BUILD_PROVIDERS.some(p => 'encryptedApiKey' in p), false);
  assert.equal(JSON.stringify(backend.publicBuiltinProviders([backend.BUILTIN_PROVIDER], {})).includes(encrypted), false);
  profile.providers = profile.providers.map(p => p.id === 'builtin' ? { ...p, encryptedApiKey: undefined } : p);
  assert.equal(compiled('backend-ts/src/builtin-provider.ts', profile).getBuiltinApiKey('builtin', {}), '');
  profile.providers = profile.providers.filter(p => p.id !== 'builtin');
  const excluded = buildSync({ entryPoints: [path.join(root, 'backend-ts/src/builtin-provider.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false, define: createEsbuildDefines(profile) }).outputFiles[0].text;
  assert.equal(excluded.includes(encrypted), false);
  assert.equal(excluded.includes(source.providers.find(p => p.id === 'builtin').encryptedApiKey), false);
  assert.equal(compiled('backend-ts/src/builtin-provider.ts', profile).getBuiltinApiKey('builtin', {}), '');
});

test('encrypted credentials reject plaintext and user-managed suppliers', t => {
  const workspace = fixture(t);
  const config = structuredClone(source);
  config.providers[0].encryptedApiKey = 'fixture-plaintext-key';
  workspace.save(config);
  assert.throws(() => loadBuildDefines(workspace), /encryptedApiKey/);
  config.providers[0].encryptedApiKey = source.providers[0].encryptedApiKey;
  config.providers.find(p => p.id === 'anthropic').encryptedApiKey = source.providers[0].encryptedApiKey;
  workspace.save(config);
  assert.throws(() => loadBuildDefines(workspace), /encryptedApiKey/);
});

test('Vite serves model metadata without encrypted credentials in development', async () => {
  const { createRequire } = require('node:module');
  const { pathToFileURL } = require('node:url');
  const rendererRequire = createRequire(path.join(root, 'renderer/package.json'));
  const { createServer } = await import(pathToFileURL(rendererRequire.resolve('vite')).href);
  const server = await createServer({ root: path.join(root, 'renderer'),
    configFile: path.join(root, 'renderer/vite.config.js'),
    server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const transformed = await server.transformRequest('/@fs/' + path.join(root, 'model.json').replaceAll('\\', '/'));
    assert.ok(transformed?.code);
    assert.equal(transformed.code.includes('encryptedApiKey'), false);
    assert.equal(source.providers.filter(p => p.encryptedApiKey).some(p => transformed.code.includes(p.encryptedApiKey)), false);
    const deployment = await server.transformRequest('/src/config/deployment.js');
    assert.ok(deployment?.code);
    assert.deepEqual(JSON.parse(server.config.define.__BUILD_DEPLOYMENT_CONFIG__),
      require('../../deployment-config.cjs').normalizeDeploymentConfig(require('../../deployment.json')));
    assert.match(deployment.code, /deploymentConfig = __BUILD_DEPLOYMENT_CONFIG__/);
    assert.equal(deployment.code.includes('deployment-config.cjs'), false);
  } finally { await server.close(); }
});

test('running Vite refreshes fixed-provider flags when the referenced JSON changes', async t => {
  const { createRequire } = require('node:module');
  const { pathToFileURL } = require('node:url');
  const vm = require('node:vm');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-vite-model-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const renderer = path.join(directory, 'renderer');
  fs.mkdirSync(renderer);
  fs.mkdirSync(path.join(directory, 'scripts'));
  for (const filename of ['model-provider-config.cjs', 'build-profile-overlay.cjs', 'build-profile-validator.cjs']) {
    fs.copyFileSync(path.join(root, 'scripts', filename), path.join(directory, 'scripts', filename));
  }
  fs.copyFileSync(path.join(root, 'deployment-config.cjs'), path.join(directory, 'deployment-config.cjs'));
  fs.writeFileSync(path.join(directory, 'deployment.json'), JSON.stringify({
    officialUrl: 'https://example.com',
    downloadUrl: 'https://example.com/downloads',
    updateSources: [{ id: 'primary', label: 'Primary', url: 'https://example.org/releases' }],
  }));
  fs.copyFileSync(path.join(root, 'renderer/vite.config.js'), path.join(renderer, 'vite.config.mjs'));
  fs.symlinkSync(fs.realpathSync(path.join(root, 'renderer/node_modules')), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(directory, 'build-profile.json'), JSON.stringify({ adapters: [], modelProviders: './model.json' }));
  const config = { defaultProvider: 'anthropic', providers: source.providers.filter(p => p.id === 'anthropic').map(p => ({
    ...p, weworker: { ...p.weworker, baseUrl: 'https://example.com' },
    webwright: { ...p.webwright, baseUrl: 'https://example.org' },
  })) };
  const configPath = path.join(directory, 'model.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const rendererRequire = createRequire(path.join(root, 'renderer/package.json'));
  const { createServer } = await import(pathToFileURL(rendererRequire.resolve('vite')).href);
  const server = await createServer({ root: renderer, configFile: path.join(renderer, 'vite.config.mjs'),
    logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const metadata = async () => {
      const port = server.httpServer.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/@vite/env`);
      const context = vm.createContext({});
      vm.runInContext(await response.text(), context);
      return context.__BUILD_PROVIDERS__;
    };
    assert.equal((await metadata())[0].fixed, true);
    config.providers[0].fixed = false;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const deadline = Date.now() + 8000;
    while (JSON.parse(server.config.define.__BUILD_PROVIDERS__)[0].fixed && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await server._restartPromise;
    while (!server.httpServer.listening && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await metadata())[0].fixed, false, 'development metadata must follow JSON edits without manually restarting Vite');
  } finally { await server.close(); }
});
