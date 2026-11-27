'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, mergeBuildProfile } = require('./build-profile-overlay.cjs');
const { validateBuildProfile } = require('./build-profile-validator.cjs');
const ROOT = path.resolve(__dirname, '..');

function loadBuildProfile(profilePath = path.join(ROOT, 'build-profile.json')) {
  const profile = readJson(profilePath, 'build profile');
  if (!profile.modelProviders) {
    validateBuildProfile(profile);
    return profile; // Existing external profiles with inline provider definitions.
  }
  if (typeof profile.modelProviders !== 'string' || profile.providers !== undefined || profile.defaultProvider !== undefined) {
    throw new Error('modelProviders must reference a JSON file; providers/defaultProvider belong in that file');
  }
  const config = readJson(path.resolve(path.dirname(profilePath), profile.modelProviders), 'model provider config');
  const effective = { ...profile, providers: config.providers, defaultProvider: config.defaultProvider };
  return mergeConfiguredProfile(effective);
}

function mergeConfiguredProfile(base, overlay = {}) {
  const effective = mergeBuildProfile(base, overlay);
  validateBuildProfile(effective);
  if (effective.modelProviders) for (const provider of effective.providers) {
    for (const field of ['fixed', 'builtin', 'fixedModel', 'allowMultiple']) {
      if (typeof provider[field] !== 'boolean') throw new Error(`${provider.id}.${field} must be a boolean`);
    }
    if (!['api_key', 'auth_token'].includes(provider.authType)) throw new Error(`${provider.id}.authType is invalid`);
  }
  return effective;
}

// Always reread the source JSON, then apply the prepared provider overlay.
// Public builds also ignore legacy cached definitions that predate this loader.
function loadBuildDefines({ root = ROOT, development = false } = {}) {
  const base = loadBuildProfile(path.join(root, 'build-profile.json'));
  const definesPath = path.join(root, 'build/.build-defines.json');
  let prepared = {};
  if (!development && fs.existsSync(definesPath)) prepared = readJson(definesPath, 'build definitions');
  if (prepared.profile && prepared.profile !== 'public' && !prepared.providerOverlay) {
    throw new Error('Legacy custom build definitions: rerun prepare-build with the original overlay');
  }
  const effective = mergeConfiguredProfile(base, prepared.providerOverlay || {});
  return { ...prepared, providers: effective.providers, defaultProvider: effective.defaultProvider };
}

function publicProviders(providers) {
  return providers.map(({ encryptedApiKey, ...provider }) => provider);
}

function loadEndpointDefaults() {
  return readJson(path.join(ROOT, "model.json"), "model provider config").endpointDefaults;
}

module.exports = { loadEndpointDefaults, publicProviders, loadBuildProfile, loadBuildDefines, mergeConfiguredProfile };
