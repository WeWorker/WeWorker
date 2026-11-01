import { buildAdapterCatalog, assertAdapterIdentity } from './adapter-catalog.js';
import { readPackageDirectory, adapterError } from './adapter-package-files.js';

export function resolveAdapterCall(toolName, options = {}) {
  const catalog = buildAdapterCatalog(options);
  if (catalog.diagnostics.some((entry) => !entry.name && !entry.names)) {
    throw adapterError('ADAPTER_CATALOG_UNAVAILABLE', 'Adapter catalog requires inspection before execution.');
  }
  const names = [...new Set([
    ...Object.entries(catalog.selections || {}).filter(([, selection]) => selection?.source === 'disabled').map(([name]) => name),
    ...catalog.candidates.filter((entry) => entry.source !== 'unmanaged').map((entry) => entry.name),
    ...catalog.diagnostics.filter((entry) => entry.source !== 'unmanaged').flatMap((entry) => entry.name ? [entry.name] : entry.names || []),
  ])].sort((a, b) => b.length - a.length);
  const legacy = catalog.legacyTools?.get(String(toolName).toLowerCase());
  if (legacy) return { adapter: legacy.adapter, command: legacy.command, toolName,
    snapshot: { name: legacy.adapter.name, digest: legacy.adapter.digest, profile: catalog.profile } };
  const name = names.find((entry) => toolName.startsWith(entry + '.'));
  if (!name) return null;
  const adapter = catalog.effective.find((entry) => entry.name === name);
  const callId = toolName.slice(name.length + 1);
  const command = adapter?.commands.find((entry) => entry.id === callId || entry.aliases?.includes(callId));
  if (!command) throw adapterError('ADAPTER_COMMAND_UNAVAILABLE', 'Selected Adapter command is unavailable; refresh the catalog.');
  return { adapter, command, snapshot: { name, digest: adapter.digest, profile: catalog.profile } };
}

/** Host messages expose package metadata, never local filesystem locations. */
export function describeAdapterCatalog(options = {}) {
  // Hosts may pass a catalog they already built for the same read (resolveCatalogTool does the same).
  const catalog = options.catalog || buildAdapterCatalog(options);
  const managedNames = new Set(catalog.candidates.filter((entry) => entry.source !== 'unmanaged').map((entry) => entry.name));
  for (const [name, selection] of Object.entries(catalog.selections || {})) {
    if (selection?.source === 'disabled') managedNames.add(name);
  }
  for (const diagnostic of catalog.diagnostics) {
    if (diagnostic.name && diagnostic.source !== 'unmanaged') managedNames.add(diagnostic.name);
    for (const name of diagnostic.names || []) managedNames.add(name);
  }
  return {
    profile: catalog.profile, revision: catalog.revision, managedNames: [...managedNames].sort(),
    available: !catalog.diagnostics.some((entry) => !entry.name && !entry.names),
    diagnostics: catalog.diagnostics,
    adapters: catalog.effective.map((entry) => ({
      ...entry.manifest, id: entry.name,
      _hostSnapshot: { profile: catalog.profile, digest: entry.digest, source: entry.source },
      ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
      ...(options.includeGuidance ? { _hostGuidance: entry.guidance } : {}),
    })),
  };
}

/** Read every source from one verified package. A changed selection requires rediscovery. */
export function readAdapterBundle(payload, options = {}) {
  const name = assertAdapterIdentity(payload?.name);
  if (!/^[a-f0-9]{64}$/.test(payload?.digest || '') || typeof payload.profile !== 'string') {
    throw adapterError('INVALID_ADAPTER_SNAPSHOT', 'An explicit Adapter snapshot is required.');
  }
  const catalog = buildAdapterCatalog(options);
  const adapter = catalog.effective.find((entry) => entry.name === name);
  if (catalog.profile !== payload.profile || !adapter || adapter.digest !== payload.digest) {
    throw adapterError('STALE_ADAPTER_SNAPSHOT', 'Adapter selection changed; refresh its catalog before execution.');
  }
  const pkg = readPackageDirectory(adapter.root);
  if (pkg.digest !== adapter.digest) throw adapterError('ADAPTER_CONTENT_CHANGED', 'Adapter changed while reading its execution snapshot.');
  return {
    name, digest: pkg.digest, profile: catalog.profile, manifest: pkg.manifest,
    files: Object.fromEntries([...pkg.files].filter(([path]) => path.startsWith('extension/')).map(([path, bytes]) => [path, bytes.toString('utf8')])),
  };
}
