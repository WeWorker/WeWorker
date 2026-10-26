import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveAdapterPaths } from './paths.js';
import { adapterError, assertManagedDirectory, assertManagedFile, readPackageDirectory, validatePackageFiles, writePackageDirectory } from './adapter-package-files.js';
import { adapterPermissions, assertAdapterIdentity, buildAdapterCatalog, packageSnapshotRoot } from './adapter-catalog.js';
import { readAdapterState, renameManagedFile, withAdapterStoreLock, writeAdapterState, writeManagedJson } from './adapter-state.js';

export function normalizeAdapterOrigin(origin = { kind: 'local' }) {
  if (!origin || !['local', 'hub', 'generated', 'development'].includes(origin.kind)) {
    throw adapterError('INVALID_ADAPTER_ORIGIN', 'Invalid Adapter installation origin.');
  }
  if (origin.kind !== 'hub') return { kind: origin.kind };
  let url;
  try { url = new URL(origin.service); } catch { throw adapterError('INVALID_ADAPTER_ORIGIN', 'Invalid Adapter Hub origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw adapterError('INVALID_ADAPTER_ORIGIN', 'Adapter Hub identity must not contain credentials, query parameters or fragments.');
  }
  return { kind: 'hub', service: url.toString().replace(/\/+$/, '') };
}

function sameOrigin(a, b) { return JSON.stringify(normalizeAdapterOrigin(a)) === JSON.stringify(normalizeAdapterOrigin(b)); }

export function assertInstalledAdapterOrigin(name, origin, options = {}) {
  assertAdapterIdentity(name);
  const paths = options.paths || resolveAdapterPaths(options);
  const current = readAdapterState(paths).installations[name];
  if (current && !sameOrigin(current.origin, origin)) {
    throw adapterError('ADAPTER_ORIGIN_CHANGED', 'Installed Adapter belongs to another source; explicitly reinstall to change its source.');
  }
}

/** SemVer precedence; build metadata does not change version precedence. */
export function compareAdapterVersions(a, b) {
  const parse = (text) => {
    const match = String(text).match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/);
    if (!match) throw adapterError('INVALID_PACKAGE_VERSION', 'Invalid Adapter package version.');
    return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre && !right.pre) return 0;
  if (!left.pre || !right.pre) return left.pre ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function checkRootProfile(paths) {
  const file = assertManagedFile(paths.userDir, '.adapter-profile.json');
  if (existsSync(file)) {
    let marker;
    try { marker = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    if (marker?.profile !== paths.profile) throw adapterError('ADAPTER_PROFILE_CONFLICT', 'This user Adapter root belongs to a different profile.');
  } else writeManagedJson(paths.userDir, '.adapter-profile.json', { profile: paths.profile });
}

export function pinAdapterPackage(pkg, paths) {
  const snapshot = packageSnapshotRoot(paths, pkg.name, pkg.digest);
  if (existsSync(snapshot)) {
    if (readPackageDirectory(snapshot).digest !== pkg.digest) throw adapterError('ADAPTER_CONTENT_CHANGED', 'Pinned Adapter package was modified.');
    return snapshot;
  }
  assertManagedDirectory(paths.packageDir);
  mkdirSync(paths.packageDir, { recursive: true });
  const temporary = assertManagedFile(paths.packageDir, '.staging/' + randomUUID() + '/' + pkg.name);
  const copied = writePackageDirectory(temporary, pkg.files);
  if (copied.digest !== pkg.digest) throw adapterError('ADAPTER_CONTENT_CHANGED', 'Adapter changed while being pinned.');
  mkdirSync(dirname(snapshot), { recursive: true });
  try { renameManagedFile(temporary, snapshot); }
  catch (error) {
    if (!existsSync(snapshot) || readPackageDirectory(snapshot).digest !== pkg.digest) throw error;
  }
  return snapshot;
}

function transactionPaths(paths, journal) {
  if (!/^[a-f0-9-]{36}$/.test(journal?.id || '') || !['install', 'remove'].includes(journal.operation)
    || !Number.isSafeInteger(journal.revision) || journal.revision < 0 || typeof journal.hadTarget !== 'boolean'
    || (journal.operation === 'install' && !/^[a-f0-9]{64}$/.test(journal.nextDigest || ''))) {
    throw adapterError('INVALID_ADAPTER_TRANSACTION', 'Adapter transaction requires inspection.');
  }
  const name = assertAdapterIdentity(journal.name);
  const root = assertManagedFile(paths.userDir, '.transactions/' + journal.id);
  return {
    root, target: assertManagedFile(paths.userDir, name),
    stage: assertManagedFile(root, 'stage/' + name),
    backup: assertManagedFile(root, 'backup/' + name),
    failed: assertManagedFile(root, 'failed/' + name),
  };
}

function move(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  renameManagedFile(source, target);
}

/** The state commit is authoritative. Interrupted mirrors roll back on next operation. */
export function recoverAdapterTransaction(paths) {
  const pending = assertManagedFile(paths.stateDir, 'pending.json');
  if (!existsSync(pending)) return false;
  let journal;
  try { journal = JSON.parse(readFileSync(pending, 'utf8')); }
  catch { throw adapterError('INVALID_ADAPTER_TRANSACTION', 'Adapter transaction requires inspection.'); }
  const tx = transactionPaths(paths, journal);
  const state = readAdapterState(paths);
  const record = state.installations[journal.name];
  const committed = state.revision === journal.revision + 1
    && (journal.operation === 'install' ? record?.digest === journal.nextDigest : !record);
  if (!committed) {
    if (state.revision !== journal.revision) throw adapterError('INVALID_ADAPTER_TRANSACTION', 'Adapter state changed outside the pending transaction.');
    if (existsSync(tx.backup)) {
      if (existsSync(tx.target)) {
        if (journal.operation !== 'install' || readPackageDirectory(tx.target).digest !== journal.nextDigest) {
          throw adapterError('ADAPTER_RECOVERY_CONFLICT', 'Adapter files changed after an interrupted operation.');
        }
        move(tx.target, tx.failed);
      }
      move(tx.backup, tx.target);
    } else if (!journal.hadTarget && existsSync(tx.target)) {
      if (journal.operation !== 'install' || readPackageDirectory(tx.target).digest !== journal.nextDigest) {
        throw adapterError('ADAPTER_RECOVERY_CONFLICT', 'Adapter files changed after an interrupted operation.');
      }
      move(tx.target, tx.failed);
    }
  }
  mkdirSync(tx.root, { recursive: true });
  move(pending, join(tx.root, committed ? 'committed.json' : 'recovered.json'));
  return true;
}

function ensureSelectable(paths, state, name, source) {
  const catalog = buildAdapterCatalog({ paths, state });
  if (!catalog.effective.some((entry) => entry.name === name && entry.source === source)) {
    const diagnostic = catalog.diagnostics.find((entry) => entry.name === name || entry.names?.includes(name));
    throw adapterError(diagnostic?.code || 'ADAPTER_NOT_SELECTABLE', 'Adapter cannot be enabled; resolve package or domain conflicts first.');
  }
}

function runLocked(options, operation) {
  const paths = options.paths || resolveAdapterPaths(options);
  return withAdapterStoreLock(paths, () => {
    checkRootProfile(paths);
    recoverAdapterTransaction(paths);
    return operation(paths, readAdapterState(paths));
  });
}

export function installAdapter(input, options = {}) {
  // Snapshot and validate source bytes before changing any installed state.
  const pkg = input.files ? validatePackageFiles(input.files) : readPackageDirectory(input.directory);
  const origin = normalizeAdapterOrigin(input.origin);
  return runLocked(options, (paths, state) => {
    if (input.expectedStateRevision !== undefined && state.revision !== input.expectedStateRevision) {
      throw adapterError('ADAPTER_REVIEW_CHANGED', 'Adapter state changed after installation review.');
    }
    const before = buildAdapterCatalog({ paths, state });
    const active = before.effective.find((entry) => entry.name === pkg.name);
    if (input.expectedSourceDigest !== undefined && (active?.digest || null) !== input.expectedSourceDigest) {
      throw adapterError('ADAPTER_BASE_CHANGED', 'Adapter changed since this draft was created.');
    }
    const previous = state.installations[pkg.name];
    // A quarantined snapshot must not erase the previously approved capability/version boundary.
    const base = previous ? { version: previous.version, permissions: previous.grants || [] } : active;
    if (!previous && existsSync(assertManagedFile(paths.userDir, pkg.name))) {
      throw adapterError('ADAPTER_UNMANAGED_CONFLICT', 'An unmanaged Adapter directory already exists; review its migration before installing.');
    }
    if (previous && !sameOrigin(previous.origin, origin) && !input.allowSourceChange) {
      throw adapterError('ADAPTER_ORIGIN_CHANGED', 'Explicit source-change approval is required.');
    }
    if (base && compareAdapterVersions(pkg.manifest.version, base.version) < 0 && !input.allowDowngrade) {
      throw adapterError('ADAPTER_DOWNGRADE', 'Explicit downgrade approval is required.');
    }
    const grants = adapterPermissions(pkg.manifest);
    if (base && grants.some((permission) => !base.permissions.includes(permission)) && !input.allowPermissionChange) {
      throw adapterError('ADAPTER_PERMISSION_CHANGE', 'Adapter update requests additional permissions.');
    }
    const pinnedRoot = pinAdapterPackage(pkg, paths);
    const next = structuredClone(state);
    // JSON object dictionaries may contain valid names such as "constructor".
    next.installations = Object.assign(Object.create(null), next.installations);
    next.selections = Object.assign(Object.create(null), next.selections);
    next.installations[pkg.name] = {
      name: pkg.name, version: pkg.manifest.version, digest: pkg.digest,
      profile: paths.profile, origin, grants,
    };
    if (input.activate !== false) next.selections[pkg.name] = { source: 'user', digest: pkg.digest };
    else if (next.selections[pkg.name]?.source === 'user') next.selections[pkg.name] = { source: 'disabled' };
    next.revision++;
    if (input.activate !== false) ensureSelectable(paths, next, pkg.name, 'user');
    const journal = {
      id: randomUUID(), operation: 'install', name: pkg.name, revision: state.revision,
      nextDigest: pkg.digest, hadTarget: existsSync(assertManagedFile(paths.userDir, pkg.name)),
    };
    const tx = transactionPaths(paths, journal);
    writePackageDirectory(tx.stage, pkg.files);
    writeManagedJson(paths.stateDir, 'pending.json', journal);
    try {
      if (journal.hadTarget) move(tx.target, tx.backup);
      move(tx.stage, tx.target);
      options.onPhase?.('mirror-ready');
      writeAdapterState(paths, next);
      options.onPhase?.('state-committed');
      recoverAdapterTransaction(paths);
    } catch (error) {
      recoverAdapterTransaction(paths);
      throw error;
    }
    return { name: pkg.name, version: pkg.manifest.version, digest: pkg.digest, dir: tx.target,
      executionRoot: pinnedRoot, revision: next.revision, active: input.activate !== false, origin };
  });
}

export function removeInstalledAdapter(name, options = {}) {
  assertAdapterIdentity(name);
  return runLocked(options, (paths, state) => {
    if (options.expectedStateRevision !== undefined && state.revision !== options.expectedStateRevision) {
      throw adapterError('ADAPTER_REVIEW_CHANGED', 'Adapter state changed after deletion review.');
    }
    if (options.expectedSourceDigest !== undefined) {
      const active = buildAdapterCatalog({ paths, state }).effective.find((entry) => entry.name === name);
      if ((active?.digest || null) !== options.expectedSourceDigest) {
        throw adapterError('ADAPTER_BASE_CHANGED', 'Adapter changed after deletion review.');
      }
    }
    const target = assertManagedFile(paths.userDir, name);
    if (!state.installations[name]) {
      const current = buildAdapterCatalog({ paths, state });
      if (current.candidates.some((entry) => entry.name === name && entry.source === 'builtin')) {
        throw adapterError('ADAPTER_BUILTIN_NOT_REMOVABLE', 'Built-in Adapter cannot be removed; disable it or remove a user version.');
      }
      throw adapterError('ADAPTER_NOT_INSTALLED', 'Managed user Adapter is not installed.');
    }
    const next = structuredClone(state);
    next.selections = Object.assign(Object.create(null), next.selections);
    delete next.installations[name];
    // Retain a tombstone to suppress stale legacy copies, but do not select a
    // nonexistent builtin: that would block fresh exploration after removal.
    const hasBuiltin = buildAdapterCatalog({ paths, state }).candidates.some(entry => entry.name === name && entry.source === 'builtin');
    next.selections[name] = { source: hasBuiltin ? 'builtin' : 'disabled' };
    next.revision++;
    const after = buildAdapterCatalog({ paths, state: next });
    if (after.diagnostics.some((item) => item.code === 'ADAPTER_DOMAIN_CONFLICT' && item.names?.includes(name))) {
      throw adapterError('ADAPTER_DOMAIN_CONFLICT', 'Restoring the built-in Adapter would create a domain conflict.');
    }
    const journal = { id: randomUUID(), operation: 'remove', name, revision: state.revision, hadTarget: existsSync(target) };
    const tx = transactionPaths(paths, journal);
    writeManagedJson(paths.stateDir, 'pending.json', journal);
    try {
      if (journal.hadTarget) move(tx.target, tx.backup);
      options.onPhase?.('mirror-ready');
      writeAdapterState(paths, next);
      recoverAdapterTransaction(paths);
    } catch (error) { recoverAdapterTransaction(paths); throw error; }
    return { name, action: 'removed', revision: next.revision };
  });
}

export function selectAdapter(name, source, options = {}) {
  assertAdapterIdentity(name);
  if (!['builtin', 'user', 'development', 'disabled'].includes(source)) throw adapterError('INVALID_ADAPTER_SOURCE', 'Invalid Adapter selection.');
  return runLocked(options, (paths, state) => {
    const next = structuredClone(state);
    next.selections = Object.assign(Object.create(null), next.selections);
    const previous = state.selections[name];
    next.selections[name] = source === 'disabled'
      ? { source, resumeSource: previous?.source === 'disabled' ? previous.resumeSource : previous?.source || 'builtin' }
      : { source };
    if (source !== 'disabled') ensureSelectable(paths, next, name, source);
    next.revision++;
    writeAdapterState(paths, next);
    return buildAdapterCatalog({ paths, state: next });
  });
}

export function registerDevelopmentAdapter(directory, options = {}) {
  const pkg = readPackageDirectory(resolve(directory));
  return runLocked(options, (paths, state) => {
    const next = structuredClone(state);
    next.development = Object.assign(Object.create(null), next.development);
    next.selections = Object.assign(Object.create(null), next.selections);
    next.development[pkg.name] = { root: pkg.root, grants: adapterPermissions(pkg.manifest), origin: { kind: 'development' } };
    next.selections[pkg.name] = { source: 'development' };
    next.revision++;
    ensureSelectable(paths, next, pkg.name, 'development');
    writeAdapterState(paths, next);
    return buildAdapterCatalog({ paths, state: next });
  });
}
