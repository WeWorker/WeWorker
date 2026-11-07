import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveAdapterPaths } from './paths.js';
import { readAdapterState } from './adapter-state.js';
import { adapterError, assertManagedDirectory, assertManagedFile, assertPackagePath, readPackageDirectory } from './adapter-package-files.js';
import { adapterPagePatterns } from './host-scope.js';
import { ADAPTER_ICON_FILES, validateAdapterIcon } from './adapter-package-validation.js';

export function assertAdapterIdentity(name) {
  assertPackagePath(name);
  if (name.includes('/') || name.startsWith('.') || /\s/.test(name) || name.length > 128) {
    throw adapterError('INVALID_ADAPTER_NAME', 'Invalid Adapter identity.');
  }
  return name;
}

export function packageSnapshotRoot(paths, name, digest) {
  assertAdapterIdentity(name);
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw adapterError('INVALID_ADAPTER_DIGEST', 'Invalid Adapter content digest.');
  return assertManagedFile(paths.packageDir, digest + '/' + name);
}

export function adapterPermissions(manifest) {
  return [...new Set([
    ...(manifest.match || []).map((host) => 'host:' + String(host).toLowerCase().replace(/\.$/, '')),
    // A site domain grants every subdomain, so adding one is a permission change.
    ...(manifest.domains || []).map((domain) => 'domain:' + String(domain).toLowerCase().replace(/\.$/, '')),
    ...(manifest.runtime_allowed_hosts || []).map((host) => 'host:' + String(host).toLowerCase().replace(/\.$/, '')),
    ...manifest.commands.map((command) => 'runtime:' + command.runtime),
    ...manifest.commands.flatMap(command => command.pageRoute?.navigation ? ['page-navigation:' + JSON.stringify(command.pageRoute)] : []),
    ...manifest.commands.flatMap(command => command.pageRoute?.workflow ? ['page-workflow:' + JSON.stringify(command.pageRoute)] : []),
    ...manifest.commands.flatMap(command => command.uiWrite ? ['ui-write:' + JSON.stringify({ route: command.pageRoute, submission: command.uiWrite })] : []),
    ...manifest.commands.flatMap(command => command.pageWrite ? ['page-write:' + JSON.stringify({ route: command.pageRoute, request: command.pageWrite })] : []),
    ...manifest.commands.flatMap(command => (command.http?.origins || []).map(origin => 'http-origin:' + origin)),
    ...manifest.commands.flatMap(command => command.http?.auth ? ['http-auth:' + JSON.stringify(command.http.auth)] : []),
    ...manifest.commands.flatMap(command => command.http?.cookies ? [
      ...command.http.cookies.names.map(name => 'http-cookie:' + command.http.cookies.origin + ':' + name),
      ...(command.http.cookies.csrf ? ['http-csrf:' + JSON.stringify(command.http.cookies.csrf)] : []),
      ...(command.http.version === 2 ? ['http-cookie-scope:' + JSON.stringify(command.http.cookies)] : []),
    ] : []),
    ...manifest.commands.filter((command) => command.execution?.runtime === 'background').map(() => 'execution:background'),
    ...manifest.commands.filter((command) => command.safety === 'write').map((command) => 'write:' + command.id),
  ])].sort();
}

function domainsOverlap(left, right) {
  const clean = (value) => String(value).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  const a = clean(left), b = clean(right);
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

function readBuiltinCatalogMetadata(root) {
  const metadataPath = join(root, '.profile.json');
  if (!existsSync(metadataPath)) return { adapters: null, profile: null };
  try {
    const stat = lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('profile metadata is not a regular file');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (metadata?.schema_version !== 1 || typeof metadata.profile !== 'string'
      || !/^[a-z0-9][a-z0-9_-]*$/.test(metadata.profile) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(metadata.profile)
      || !Array.isArray(metadata.adapters)) throw new Error('invalid profile metadata');
    const adapters = new Map();
    const seen = new Set();
    for (const entry of metadata.adapters) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'digest,name,version'
        || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.version !== 'string') throw new Error('invalid profile entry');
      assertAdapterIdentity(entry.name);
      const folded = entry.name.toLowerCase();
      if (seen.has(folded)) throw new Error('duplicate profile identity');
      seen.add(folded);
      adapters.set(entry.name, entry);
    }
    return { adapters, profile: metadata.profile };
  } catch {
    return { adapters: new Map(), profile: null, error: 'INVALID_BUILTIN_PROFILE' };
  }
}
/** No implicit user override. Only an explicit, profile-bound selection is active. */
export function buildAdapterCatalog(options = {}) {
  const paths = options.paths || resolveAdapterPaths(options);
  const diagnostics = [];
  let state;
  try { state = options.state || readAdapterState(paths); }
  catch (error) {
    return { profile: paths.profile, revision: 0, candidates: [], effective: [], diagnostics: [{ code: error.code || 'INVALID_ADAPTER_STATE' }] };
  }
  const candidates = [];
  const add = (root, source, name, record = null, expected = null) => {
    try {
      assertAdapterIdentity(name);
      const pkg = readPackageDirectory(root);
      if (pkg.name !== name) throw adapterError('INVALID_ADAPTER_NAME', 'Adapter identity changed.');
      if (record?.digest && source === 'user' && pkg.digest !== record.digest) {
        throw adapterError('ADAPTER_CONTENT_CHANGED', 'Installed Adapter content changed.');
      }
      if (expected && source === 'builtin' && (pkg.digest !== expected.digest || pkg.manifest.version !== expected.version)) {
        throw adapterError('BUILTIN_ADAPTER_CONTENT_CHANGED', 'Built-in Adapter content does not match its profile.');
      }
      const permissions = adapterPermissions(pkg.manifest);
      const iconFile = ADAPTER_ICON_FILES.find(file => pkg.files.has(file));
      const iconBytes = iconFile && pkg.files.get(iconFile);
      if (source === 'development' && permissions.some((permission) => !record.grants?.includes(permission))) {
        throw adapterError('ADAPTER_PERMISSION_CHANGE', 'Development Adapter requires additional permissions.');
      }
      candidates.push({
        name, version: pkg.manifest.version, root: resolve(root), source,
        digest: pkg.digest, manifest: pkg.manifest, commands: pkg.commands,
        guidance: pkg.files.get('guidance.md')?.toString('utf8') || '',
        iconUrl: iconBytes ? `data:${validateAdapterIcon(iconFile, iconBytes)};base64,${iconBytes.toString('base64')}` : undefined,
        permissions, origin: record?.origin || null,
      });
    } catch (error) {
      diagnostics.push({ name, source, code: error.code || 'INVALID_ADAPTER_PACKAGE' });
    }
  };
  const scan = (root, source, skip = new Set()) => {
    try {
      assertManagedDirectory(root);
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || skip.has(entry.name) || !entry.isDirectory()) continue;
        const dir = assertManagedFile(root, entry.name);
        if (!existsSync(join(dir, 'manifest.json'))) continue;
        add(dir, source, entry.name);
      }
    } catch (error) { diagnostics.push({ source, code: error.code || 'INVALID_ADAPTER_ROOT' }); }
  };
  const builtinMetadata = readBuiltinCatalogMetadata(paths.builtinDir);
  if (builtinMetadata.error) {
    diagnostics.push({ source: 'builtin', code: builtinMetadata.error });
  } else if (builtinMetadata.profile && builtinMetadata.profile !== paths.profile) {
    diagnostics.push({ source: 'builtin', code: 'INVALID_BUILTIN_PROFILE' });
  } else if (builtinMetadata.adapters) {
    try {
      assertManagedDirectory(paths.builtinDir);
      const expected = new Set(builtinMetadata.adapters.keys());
      for (const entry of readdirSync(paths.builtinDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
        if (!expected.has(entry.name)) diagnostics.push({ name: entry.name, source: 'builtin', code: 'UNEXPECTED_BUILTIN_ADAPTER' });
      }
      for (const [name, entry] of builtinMetadata.adapters) {
        add(join(paths.builtinDir, name), 'builtin', name, null, entry);
      }
    } catch (error) {
      diagnostics.push({ source: 'builtin', code: error.code || 'INVALID_BUILTIN_ROOT' });
    }
  } else {
    scan(paths.builtinDir, 'builtin');
  }
  for (const [name, record] of Object.entries(state.installations)) {
    try {
      if (record?.name !== name || record.profile !== paths.profile) throw adapterError('INVALID_ADAPTER_STATE', 'Installation identity does not match.');
      add(packageSnapshotRoot(paths, name, record.digest), 'user', name, record);
    } catch (error) { diagnostics.push({ name, source: 'user', code: error.code || 'INVALID_ADAPTER_STATE' }); }
  }
  // Unmanaged directories are inventory, never automatically enabled.
  scan(paths.userDir, 'unmanaged', new Set(Object.keys(state.installations)));
  for (const [name, record] of Object.entries(state.development)) {
    if (!record || typeof record.root !== 'string' || !record.root) {
      diagnostics.push({ name, source: 'development', code: 'INVALID_ADAPTER_STATE' });
      continue;
    }
    add(record.root, 'development', name, record);
  }

  const byName = new Map();
  const casing = new Map();
  const blockedNames = new Set();
  for (const candidate of candidates) {
    const folded = candidate.name.toLowerCase();
    if (casing.has(folded) && casing.get(folded) !== candidate.name) {
      blockedNames.add(casing.get(folded)); blockedNames.add(candidate.name);
      diagnostics.push({ name: candidate.name, code: 'ADAPTER_NAME_COLLISION' });
    }
    casing.set(folded, candidate.name);
    if (!byName.has(candidate.name)) byName.set(candidate.name, []);
    byName.get(candidate.name).push(candidate);
  }
  const selected = [];
  for (const [name, selection] of Object.entries(state.selections)) {
    if (!byName.has(name) && selection?.source !== 'disabled') diagnostics.push({ name, source: selection?.source, code: 'ADAPTER_NOT_SELECTED' });
  }
  for (const [name, choices] of byName) {
    if (blockedNames.has(name)) continue;
    const selection = Object.hasOwn(state.selections, name) ? state.selections[name] : { source: 'builtin' };
    if (selection?.source === 'disabled') continue;
    const candidate = choices.find((item) => item.source === selection?.source);
    if (!candidate || (selection.digest && selection.digest !== candidate.digest)) {
      diagnostics.push({ name, code: candidate ? 'ADAPTER_CONTENT_CHANGED' : 'ADAPTER_NOT_SELECTED' });
      continue;
    }
    selected.push(candidate);
  }
  const legacyTools = new Map();
  for (const candidate of selected) {
    for (const command of candidate.commands) {
      for (const legacyName of command.legacyNames || []) {
        const key = String(legacyName).toLowerCase();
        const previous = legacyTools.get(key);
        if (previous && (previous.adapter !== candidate || previous.command !== command)) {
          diagnostics.push({ code: 'ADAPTER_LEGACY_NAME_CONFLICT', names: [previous.toolName, legacyName] });
          legacyTools.delete(key);
          continue;
        }
        if (!previous) legacyTools.set(key, { adapter: candidate, command, toolName: legacyName });
      }
    }
  }

  const conflicts = new Set();
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const left = adapterPagePatterns(selected[i].manifest), right = adapterPagePatterns(selected[j].manifest);
      if (left.some((host) => right.some((other) => domainsOverlap(host, other)))) {
        conflicts.add(selected[i].name); conflicts.add(selected[j].name);
        diagnostics.push({ code: 'ADAPTER_DOMAIN_CONFLICT', names: [selected[i].name, selected[j].name] });
      }
    }
  }
  return {
    profile: paths.profile, revision: state.revision, candidates, selections: state.selections,
    effective: selected.filter((item) => !conflicts.has(item.name)).sort((a, b) => a.name.localeCompare(b.name)),
    legacyTools, diagnostics,
  };
}

export function publicAdapterCatalog(catalog) {
  return {
    profile: catalog.profile, revision: catalog.revision, diagnostics: catalog.diagnostics,
    adapters: catalog.effective.map(({ name, version, digest, source, manifest, commands }) => ({
      name, version, digest, source, description: manifest.description, match: manifest.match || [],
      domains: manifest.domains || [],
      requires_auth: manifest.requires_auth || false,
      runtime_allowed_hosts: manifest.runtime_allowed_hosts || [],
      scenarios: manifest.scenarios || [], commands,
    })),
  };
}

export function resolveCatalogTool(toolName, options = {}) {
  const catalog = options.catalog || buildAdapterCatalog(options);
  const legacy = catalog.legacyTools?.get(String(toolName).toLowerCase());
  if (legacy) return { adapter: legacy.adapter, command: legacy.command, toolName };
  for (const adapter of [...catalog.effective].sort((a, b) => b.name.length - a.name.length)) {
    if (!toolName.startsWith(adapter.name + '.')) continue;
    const callId = toolName.slice(adapter.name.length + 1);
    const command = adapter.commands.find((item) => item.id === callId || item.aliases?.includes(callId));
    return command ? { adapter, command, toolName } : null;
  }
  return null;
}
