import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED_PROFILE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function isValidProfile(profile) {
  return typeof profile === 'string' && PROFILE_PATTERN.test(profile) && !RESERVED_PROFILE.test(profile);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || (process.platform === 'win32' && a.toLowerCase() === b.toLowerCase());
}

function readBuiltProfile(builtinDir) {
  const metadataPath = path.join(builtinDir, '.profile.json');
  const stat = fs.lstatSync(metadataPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Built-in Adapter profile metadata must be a regular file.');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata?.schema_version !== 1 || !isValidProfile(metadata.profile)
      || !Array.isArray(metadata.adapters)
      || (metadata.legacy !== undefined && !Array.isArray(metadata.legacy))) {
    throw new Error('Invalid built-in Adapter profile metadata.');
  }
  return metadata.profile;
}

function assertExplicitRootProfile(userDir, profile) {
  const markerPath = path.join(userDir, '.adapter-profile.json');
  if (!fs.existsSync(markerPath)) return;
  const stat = fs.lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Adapter root profile marker must be a regular file.');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch { throw new Error('Invalid Adapter root profile marker.'); }
  if (!isValidProfile(marker?.profile) || marker.profile !== profile) {
    throw new Error('This user Adapter root belongs to a different profile.');
  }
}

/** Resolve once at the desktop boundary; all child processes inherit the same
 * profile and roots. This module also runs inside the packaged Electron app. */
export function buildAdapterEnvironment({ env = process.env, packaged, resourcesPath, repoRoot, home = os.homedir() }) {
  let builtinDir;
  if (packaged) {
    builtinDir = path.join(resourcesPath, 'adapters');
  } else {
    builtinDir = env.WEWORKER_BUILTIN_ADAPTERS_DIR || path.join(repoRoot, 'weworker/build/builtin-adapters');
    if (!fs.existsSync(path.join(builtinDir, '.profile.json'))) {
      if (env.WEWORKER_BUILTIN_ADAPTERS_DIR) throw new Error('Prepare the selected built-in Adapter directory before starting the desktop.');
      if (fs.existsSync(path.join(repoRoot, 'adapters'))) throw new Error('Run the profile prepare command before starting the desktop.');
      // Transitional checkout with only legacy Extension assets.
      builtinDir = path.join(repoRoot, 'adapters');
    }
  }
  const metadataPath = path.join(builtinDir, '.profile.json');
  let builtProfile;
  if (packaged || fs.existsSync(metadataPath)) builtProfile = readBuiltProfile(builtinDir);
  const profile = builtProfile || env.WEWORKER_BUILD_PROFILE || 'public';
  if (!isValidProfile(profile)) throw new Error('Invalid Adapter profile.');
  if (builtProfile && env.WEWORKER_BUILD_PROFILE && env.WEWORKER_BUILD_PROFILE !== builtProfile) throw new Error('Adapter build profile does not match the host profile.');
  if (env.WEWORKER_USER_ADAPTERS_DIR && env.WEBCLI_ADAPTERS_DIR && !samePath(env.WEWORKER_USER_ADAPTERS_DIR, env.WEBCLI_ADAPTERS_DIR)) {
    throw new Error('Conflicting host and CLI Adapter directory overrides.');
  }
  const userOverride = env.WEWORKER_USER_ADAPTERS_DIR || env.WEBCLI_ADAPTERS_DIR;
  const userDir = path.resolve(userOverride || path.join(home, '.weworker/adapters', ...(profile === 'public' ? [] : ['.profiles', profile])));
  assertExplicitRootProfile(userDir, profile);
  const dataDir = path.resolve(env.WEWORKER_ADAPTER_DATA_DIR || (userOverride ? path.join(userDir, '.host-data') : path.join(home, '.weworker')));
  const childEnv = {
    ...env,
    WEWORKER_BUILD_PROFILE: profile,
    WEWORKER_BUILTIN_ADAPTERS_DIR: path.resolve(builtinDir),
    WEWORKER_USER_ADAPTERS_DIR: userDir,
    WEBCLI_ADAPTERS_DIR: userDir,
    WEWORKER_ADAPTER_DATA_DIR: dataDir,
    // Desktop children always talk to the desktop Bridge, even if the parent shell
    // was configured for the standalone npm WebCLI.
    WEBCLI_BRIDGE_PORT: '3711',
    ...(packaged ? { WEWORKER_RESOURCES_PATH: resourcesPath } : {}),
  };
  delete childEnv.WEWORKER_WEBCLI_DISTRIBUTION;
  return childEnv;
}
