const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareMetricsClientConfig } = require('../metrics-client-config.cjs');
const { createElectronBuilderConfig } = require('../build-electron-current-arch.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-metrics-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { modelPath: path.join(dir, 'model.json'), outputPath: path.join(dir, 'build', 'metrics-client.json') };
}

test('a public build produces disabled config without a bundled credential', t => {
  const paths = fixture(t);
  fs.writeFileSync(paths.modelPath, JSON.stringify({ environment: {} }));
  const config = prepareMetricsClientConfig({ ...paths, env: {} });
  assert.deepEqual(config, { enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.outputPath, 'utf8')), { enabled: false });
});

test('private build takes the approved shared client token from a secure build variable', t => {
  const paths = fixture(t);
  fs.writeFileSync(paths.modelPath, JSON.stringify({ environment: { WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch', WEBCLI_METRICS_UPLOAD: 'on' }, providers: [{ encryptedApiKey: 'not-for-client' }] }));
  assert.throws(() => prepareMetricsClientConfig({ ...paths, env: {} }), /client token/i);
  const config = prepareMetricsClientConfig({ ...paths, env: { WEBCLI_METRICS_CLIENT_TOKEN: 'fixture-shared-client-credential-12345' } });
  assert.deepEqual(config, { enabled: true, endpoint: 'https://example.com/v1/metrics/batch', token: 'fixture-shared-client-credential-12345' });
  const bytes = fs.readFileSync(paths.outputPath, 'utf8');
  assert.ok(!bytes.includes('not-for-client'));
});

test('failed build removes an old generated client credential', t => {
  const paths = fixture(t);
  fs.mkdirSync(path.dirname(paths.outputPath), { recursive: true });
  fs.writeFileSync(paths.outputPath, JSON.stringify({ token: 'previous-private-build-credential' }));
  fs.writeFileSync(paths.modelPath, JSON.stringify({ environment: { WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch', WEBCLI_METRICS_UPLOAD: 'on' } }));
  assert.throws(() => prepareMetricsClientConfig({ ...paths, env: {} }), /client token/i);
  assert.equal(fs.existsSync(paths.outputPath), false);
});

test('untrusted PR builds may explicitly opt out without packaging a credential', t => {
  const paths = fixture(t);
  fs.writeFileSync(paths.modelPath, JSON.stringify({ environment: { WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch', WEBCLI_METRICS_UPLOAD: 'on' } }));
  assert.deepEqual(prepareMetricsClientConfig({ ...paths, env: { WEWORKER_METRICS_TEST_BUILD: '1' } }), { enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.outputPath, 'utf8')), { enabled: false });
});

test('desktop installer includes the generated metrics config as a resource', t => {
  const paths = fixture(t);
  const output = path.join(path.dirname(paths.modelPath), 'electron-builder.json');
  const config = JSON.parse(fs.readFileSync(createElectronBuilderConfig({ outputPath: output }), 'utf8'));
  assert.ok(config.extraResources.some(entry => entry.from === 'build/metrics-client.json' && entry.to === 'metrics-client.json'));
});

test('private build rejects unsafe URL and model-embedded credentials', t => {
  const paths = fixture(t);
  for (const endpoint of ['ftp://example.com/v1/metrics/batch', 'http://example.com/v1/stats', 'https://name:pass@example.com/v1/metrics/batch']) {
    fs.writeFileSync(paths.modelPath, JSON.stringify({ environment: { WEBCLI_METRICS_ENDPOINT: endpoint, WEBCLI_METRICS_UPLOAD: 'on' } }));
    assert.throws(() => prepareMetricsClientConfig({ ...paths, env: { WEBCLI_METRICS_CLIENT_TOKEN: 'fixture-shared-client-credential-12345' } }), /endpoint/i);
  }
  fs.writeFileSync(paths.modelPath, JSON.stringify({ environment: { WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch', WEBCLI_METRICS_UPLOAD: 'on', WEBCLI_METRICS_TOKEN: 'never-in-model' } }));
  assert.throws(() => prepareMetricsClientConfig({ ...paths, env: { WEBCLI_METRICS_CLIENT_TOKEN: 'fixture-shared-client-credential-12345' } }), /model/i);
});
