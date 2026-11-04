import { test, expect, vi, afterEach } from 'vitest';
import { d3Predict } from '../auto-route-d3-client.js';
import { loadDecisionApiKey } from '../decision-api-key.js';
import { runtimeConfig } from '../runtime-config.js';
import { executeHostCli } from '../host-cli-provider.js';
const questions = { q: { type: 'choice', criteria: { a: 'A', b: 'B' } } };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); delete runtimeConfig.hostProvider; });
for (const model of ['', 'jev-latest']) test(`System One model configuration: ${model || 'omit'}`, async () => {
  vi.stubEnv('WEBCLI_D3_URL', 'https://decision.example.test');
  vi.stubEnv('DECISION_API_KEY', 'fixture-key');
  vi.stubEnv('WEBCLI_D3_MODEL', model);
  const fetch = vi.fn(async (url, request) => {
    expect(url).toBe('https://decision.example.test/v1/systemone');
    expect(request.headers.Authorization).toBe('Bearer fixture-key');
    expect(JSON.parse(request.body)).toEqual({ state: 'fixture request', questions, ...(model ? { model } : {}) });
    return { ok: true, json: async () => ({ model: 'fixture-server-model', answers: { q: { choice: 'a', probabilities: { a: 1, b: 0 } } } }) };
  });
  vi.stubGlobal('fetch', fetch);
  expect((await d3Predict('fixture request', questions)).routing.model).toBe('fixture-server-model');
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('credential configuration supports explicit environment overrides and rejects malformed keys', async () => {
  expect(await loadDecisionApiKey({ env: {}, defaultKey: 'fixture-configured' })).toBe('fixture-configured');
  expect(await loadDecisionApiKey({ env: { DECISION_API_KEY: 'fixture-override' }, defaultKey: 'fixture-configured' })).toBe('fixture-override');
  await expect(loadDecisionApiKey({ env: {}, defaultKey: 'fixture invalid' })).rejects.toThrow('DECISION_API_KEY');
});
test('reviewed host provider rejects traversal before loading code', async () => {
  runtimeConfig.hostProvider = '../untrusted.cjs';
  await expect(executeHostCli({})).rejects.toThrow('Invalid reviewed host provider');
});

test('optional authentication permits unconfigured public deployments', async () => {
  expect(await loadDecisionApiKey({ env: {}, file: 'fixture-does-not-exist.dpapi', optional: true })).toBeUndefined();
});
