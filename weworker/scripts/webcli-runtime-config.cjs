'use strict';
const fs = require('node:fs');
const path = require('node:path');
function loadWebcliRuntimeConfig(modelPath = path.resolve(__dirname, '../model.json')) {
  const environment = JSON.parse(fs.readFileSync(modelPath, 'utf8')).environment || {};
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../webcli/runtime-config.json'), 'utf8'));
  for (const [field, name] of Object.entries({ d3Url: 'WEBCLI_D3_URL', apiKey: 'DECISION_API_KEY', model: 'WEBCLI_D3_MODEL', hostProvider: 'WEBCLI_HOST_PROVIDER' })) {
    if (environment[name] === undefined) continue;
    if (typeof environment[name] !== 'string') throw new Error(`${name} must be a string.`);
    config[field] = environment[name];
  }
  if (config.hostProvider && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.cjs$/.test(config.hostProvider)) throw new Error('Invalid reviewed host provider path.');
  return config;
}
module.exports = { loadWebcliRuntimeConfig };
