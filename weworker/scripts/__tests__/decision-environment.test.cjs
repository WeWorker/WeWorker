const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decisionEnvironment, runWebcli } = require('../../../scripts/run-webcli.cjs');

test('injects only allowlisted decision variables without changing input objects', () => {
  const config = { environment: { WEBCLI_D3_URL: ' https://decision.example.test ', UNSAFE_SETTING: 'unused' } };
  const env = { PATH: 'existing' };
  const result = decisionEnvironment(config, env);
  assert.equal(result.WEBCLI_D3_URL, 'https://decision.example.test');
  assert.equal(result.UNSAFE_SETTING, undefined);
  assert.deepEqual(env, { PATH: 'existing' });
  assert.equal(config.environment.WEBCLI_D3_URL, ' https://decision.example.test ');
});
test('explicit process settings override internal defaults', () => {
  const config = { environment: { WEBCLI_D3_URL: 'https://default.example.test', WECLI_LAYA_URL: 'https://laya.example.test', WECLI_SEMIF_URL: 'https://semif.example.test' } };
  const env = decisionEnvironment(config, { WEBCLI_D3_URL: 'https://override.example.test' });
  assert.equal(env.WEBCLI_D3_URL, 'https://override.example.test');
  assert.equal(env.WECLI_LAYA_URL, undefined);
  assert.equal(env.WECLI_SEMIF_URL, undefined);
});
test('rejects invalid model environment settings without printing values', () => {
  for (const environment of [[], 'bad', { WEBCLI_D3_URL: 42 }, { WEBCLI_D3_URL: ' ' }]) {
    assert.throws(() => decisionEnvironment({ environment }, {}), /must be/);
  }
});
test('launcher forwards arguments and environment to the selected CLI, with shell disabled', () => {
  let captured;
  const exit = runWebcli(['--cli', __filename, 'route', 'example request'], { env: { WEBCLI_D3_URL: 'https://decision.example.test' }, spawn: (...args) => { captured = args; return { status: 2 }; } });
  assert.equal(exit, 2);
  assert.deepEqual(captured[1], [__filename, 'route', 'example request']);
  assert.equal(captured[2].shell, false);
  assert.equal(typeof captured[2].env.WEBCLI_D3_URL, 'string');
});
