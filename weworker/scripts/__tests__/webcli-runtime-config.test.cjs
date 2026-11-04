const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadWebcliRuntimeConfig } = require('../webcli-runtime-config.cjs');
test('only reviewed WebCLI fields enter runtime configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-config-'));
  const file = path.join(root, 'model.json');
  fs.writeFileSync(file, JSON.stringify({ providers: [{ secret: 'fixture-unrelated' }], environment: { WEBCLI_D3_URL: 'https://decision.example.test', DECISION_API_KEY: 'fixture-key', WEBCLI_D3_MODEL: '', WEBCLI_HOST_PROVIDER: 'example/provider.cjs', UNRELATED: 'fixture-unrelated' } }));
  assert.deepEqual(loadWebcliRuntimeConfig(file), { d3Url: 'https://decision.example.test', apiKey: 'fixture-key', model: '', hostProvider: 'example/provider.cjs' });
  fs.writeFileSync(file, JSON.stringify({ environment: { WEBCLI_HOST_PROVIDER: '../escape.cjs' } }));
  assert.throws(() => loadWebcliRuntimeConfig(file), /Invalid reviewed host provider/);
});
