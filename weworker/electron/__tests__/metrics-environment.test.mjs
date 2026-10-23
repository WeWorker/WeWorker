import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packagedMetricsEnvironment } from '../metrics-environment.js';

function fixture(t, config) {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-metrics-runtime-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  if (config) fs.writeFileSync(path.join(resourcesPath, 'metrics-client.json'), JSON.stringify(config));
  return resourcesPath;
}

test('public desktop and developer environment do not enable reporting by default', t => {
  const resourcesPath = fixture(t, { enabled: false });
  assert.deepEqual(packagedMetricsEnvironment({ packaged: true, resourcesPath, env: {} }), {});
  assert.deepEqual(packagedMetricsEnvironment({ packaged: false, resourcesPath, env: {} }), {});
  assert.deepEqual(packagedMetricsEnvironment({ packaged: true, resourcesPath: fixture(t), env: {} }), {});
});

test('private desktop supplies packaged client upload defaults without overriding local opt-out', t => {
  const resourcesPath = fixture(t, { enabled: true, endpoint: 'https://example.com/v1/metrics/batch', token: 'fixture-shared-client-credential-12345' });
  assert.deepEqual(packagedMetricsEnvironment({ packaged: true, resourcesPath, env: {} }), {
    WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch',
    WEBCLI_METRICS_TOKEN: 'fixture-shared-client-credential-12345', WEBCLI_METRICS_UPLOAD: 'on',
  });
  assert.deepEqual(packagedMetricsEnvironment({ packaged: true, resourcesPath, env: { WEBCLI_METRICS_UPLOAD: 'off', WEBCLI_METRICS_TOKEN: 'fixture-local-credential-123456' } }), {
    WEBCLI_METRICS_ENDPOINT: 'https://example.com/v1/metrics/batch',
  });
});

test('tampered package config fails closed without preventing desktop startup', t => {
  const resourcesPath = fixture(t, { enabled: true, endpoint: 'https://example.com/v1/stats', token: 'fixture-shared-client-credential-12345' });
  assert.deepEqual(packagedMetricsEnvironment({ packaged: true, resourcesPath, env: {} }), {});
  fs.writeFileSync(path.join(resourcesPath, 'metrics-client.json'), '{invalid');
  assert.deepEqual(packagedMetricsEnvironment({ packaged: true, resourcesPath, env: {} }), {});
});
