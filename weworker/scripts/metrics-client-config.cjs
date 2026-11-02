const fs = require('node:fs');
const path = require('node:path');

// Metrics enablement resolves per value as: explicit build env → model.json → off.
// The public repository keeps model.json free of any metrics configuration, so
// GitHub builds inject all three values from repository secrets and local runs
// export the same variables; a fork build without the secrets stays disabled.
function prepareMetricsClientConfig({ modelPath, outputPath, env = process.env }) {
  fs.rmSync(outputPath, { force: true });
  const environment = JSON.parse(fs.readFileSync(modelPath, 'utf8')).environment || {};
  if (Object.hasOwn(environment, 'WEBCLI_METRICS_TOKEN') || Object.hasOwn(environment, 'WEBCLI_METRICS_CLIENT_TOKEN')) {
    throw new Error('Metrics credentials must not be stored in model.json');
  }
  const upload = env.WEBCLI_METRICS_UPLOAD !== undefined
    ? env.WEBCLI_METRICS_UPLOAD
    : environment.WEBCLI_METRICS_UPLOAD;
  const endpointValue = env.WEBCLI_METRICS_ENDPOINT !== undefined
    ? env.WEBCLI_METRICS_ENDPOINT
    : environment.WEBCLI_METRICS_ENDPOINT;
  let config = { enabled: false };
  if (upload === 'on' && env.WEWORKER_METRICS_TEST_BUILD !== '1') {
    let endpoint;
    try { endpoint = new URL(endpointValue); }
    catch { throw new Error('Metrics endpoint must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/v1/metrics/batch') {
      throw new Error('Metrics endpoint must be an unambiguous batch URL');
    }
    const token = env.WEBCLI_METRICS_CLIENT_TOKEN;
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) {
      throw new Error('A metrics client token is required for this build');
    }
    config = { enabled: true, endpoint: endpoint.href, token };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return config;
}

module.exports = { prepareMetricsClientConfig };
