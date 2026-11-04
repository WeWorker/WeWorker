import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHostSecretStore } from './host-secret-store.js';
import { runtimeConfig } from './runtime-config.js';
let provider;
export async function executeHostCli(request) {
  if (!runtimeConfig.hostProvider) throw Object.assign(new Error('Host CLI is unavailable in this build.'), { code: 'HOST_CLI_UNAVAILABLE' });
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.cjs$/.test(runtimeConfig.hostProvider)) throw new Error('Invalid reviewed host provider path.');
  if (!provider) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const roots = process.resourcesPath ? [path.join(process.resourcesPath, 'host-cli-assets')] : [path.join(here, 'host-cli-assets'), path.resolve(here, '../weworker/host-cli-assets'), path.resolve(here, '../../host-cli-assets')];
    const root = roots.find(candidate => fs.existsSync(path.join(candidate, runtimeConfig.hostProvider)));
    if (!root) throw new Error('Reviewed host provider resource is missing.');
    const entry = path.join(root, runtimeConfig.hostProvider);
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(entry));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Reviewed host provider escapes its resource directory.');
    const createProvider = createRequire(import.meta.url)(entry);
    provider = createProvider({ createHostSecretStore, assetRoot: path.dirname(entry) });
    if (typeof provider !== 'function') throw new Error('Invalid reviewed host provider.');
  }
  return provider(request);
}
