// Deployment launcher: model.json supplies deployment defaults to a selected CLI.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const VARIABLES = ['WEBCLI_D3_URL', 'DECISION_API_KEY', 'WEBCLI_D3_MODEL'];

function decisionEnvironment(config, inherited = process.env) {
  const settings = config.environment || {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('model.json environment must be an object.');
  const env = { ...inherited };
  for (const name of VARIABLES) {
    if (typeof env[name] === 'string' && (env[name].trim() || name === 'WEBCLI_D3_MODEL')) continue;
    const value = settings[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || (!value.trim() && name !== 'WEBCLI_D3_MODEL')) throw new Error(`model.json ${name} must be a non-empty string.`);
    env[name] = value.trim();
  }
  return env;
}

function runWebcli(args, options = {}) {
  if (args[0] !== '--cli' || !args[1] || args[1].startsWith('-')) {
    throw new Error('Usage: node scripts/run-webcli.cjs --cli <webcli/index.js> [arguments...]');
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(options.configPath || path.resolve(__dirname, '../weworker/model.json'), 'utf8')); }
  catch { throw new Error('Unable to read internal model configuration.'); }
  const entry = path.resolve(args[1]);
  try { if (!fs.statSync(entry).isFile()) throw new Error(); }
  catch { throw new Error('CLI entry must be a regular file.'); }
  const child = (options.spawn || spawnSync)(process.execPath, [entry, ...args.slice(2)], {
    env: decisionEnvironment(config, options.env || process.env), stdio: 'inherit', shell: false,
  });
  if (child.error) throw new Error('Unable to start WebCLI.');
  return child.status ?? 1;
}

if (require.main === module) {
  try { process.exitCode = runWebcli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { decisionEnvironment, runWebcli };
