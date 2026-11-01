import { Script } from 'node:vm';
import { resolve } from 'node:path';
import { buildAdapterCatalog, assertAdapterIdentity } from './adapter-catalog.js';
import { readPackageDirectory } from './adapter-package-files.js';
import { formatCallOutput, resolveOutputFormat } from './output-format.js';

const relevant = (entry, name) => !name || (!entry.name && !entry.names) || entry.name === name || entry.names?.includes(name);
const publicCandidate = entry => ({ name: entry.name, version: entry.version, source: entry.source, digest: entry.digest,
  commands: entry.commands.map(command => ({ id: command.id, runtime: command.runtime, safety: command.safety || 'read' })) });

/** Inventory includes disabled, shadowed and invalid packages, without loading their code. */
export function adapterStatus(name, options = {}) {
  if (name !== undefined) assertAdapterIdentity(name);
  const catalog = buildAdapterCatalog(options);
  const names = [...new Set([...catalog.candidates.map(entry => entry.name), ...Object.keys(catalog.selections || {}),
    ...catalog.diagnostics.flatMap(entry => entry.name ? [entry.name] : entry.names || [])])].filter(item => !name || item === name).sort();
  const diagnostics = catalog.diagnostics.filter(entry => relevant(entry, name));
  if (name && !names.length) diagnostics.push({ name, code: 'ADAPTER_NOT_FOUND' });
  const items = names.map(item => {
    const active = catalog.effective.find(entry => entry.name === item);
    return { name: item, selection: catalog.selections?.[item]?.source || 'builtin', active: active ? publicCandidate(active) : null,
      candidates: catalog.candidates.filter(entry => entry.name === item).map(publicCandidate),
      diagnostics: diagnostics.filter(entry => entry.name === item || entry.names?.includes(item)) };
  });
  return { ok: diagnostics.length === 0, scope: 'managed-v2', profile: catalog.profile, revision: catalog.revision,
    items, diagnostics, executed: false, limits: ['Frozen legacy adapters are not included.', 'Catalog validity does not prove runtime effects.'] };
}

export function inspectPackage(pkg) {
  const errors = [], warnings = [];
  let javascriptFiles = 0;
  for (const [file, bytes] of pkg.files) {
    if (/^(extension|http)\/.+\.js$/.test(file)) {
      javascriptFiles++;
      try { new Script('(function(module,exports,require){\n' + new TextDecoder('utf-8', { fatal: true }).decode(bytes) + '\n})', { filename: file }); }
      catch { errors.push({ code: 'JAVASCRIPT_SYNTAX', file }); }
    }
  }
  for (const command of pkg.commands) {
    if (!command.safety) warnings.push({ code: 'IMPLICIT_READ_SAFETY', command: command.id });
    if (command.runtime === 'wewright') warnings.push({ code: 'TOOLKIT_SYNTAX_NOT_CHECKED', command: command.id });
  }
  return { name: pkg.name, digest: pkg.digest, ok: errors.length === 0, files: pkg.files.size, javascriptFiles,
    commands: pkg.commands.length, errors, warnings };
}

/** Shared read-only collection: reject invalid or changed selected packages. */
export function collectDiagnosticPackages({ directory, name, ...options } = {}) {
  const packages = [], diagnostics = [];
  let profile = null;
  if (directory !== undefined) {
    try { packages.push({ pkg: readPackageDirectory(resolve(directory)) }); }
    catch (error) { diagnostics.push({ code: error.code || 'INVALID_ADAPTER_PACKAGE' }); }
  } else {
    if (name !== undefined) assertAdapterIdentity(name);
    const catalog = buildAdapterCatalog(options); profile = catalog.profile;
    diagnostics.push(...catalog.diagnostics.filter(entry => relevant(entry, name)));
    const selected = catalog.effective.filter(entry => !name || entry.name === name);
    if (name && !selected.length) diagnostics.push({ name, code: 'ADAPTER_NOT_ACTIVE' });
    for (const entry of selected) {
      try {
        const pkg = readPackageDirectory(entry.root);
        if (pkg.digest !== entry.digest) { diagnostics.push({ name: entry.name, code: 'ADAPTER_CONTENT_CHANGED' }); continue; }
        packages.push({ pkg, source: entry.source });
      } catch (error) { diagnostics.push({ name: entry.name, code: error.code || 'INVALID_ADAPTER_PACKAGE' }); }
    }
  }
  return { packages, diagnostics, profile, scope: directory === undefined ? 'active-managed-v2' : 'package-directory' };
}

/** Reuses package/grant/digest checks; JS compilation never executes an Adapter. */
export function validateAdapters(options = {}) {
  const { packages, diagnostics, profile, scope } = collectDiagnosticPackages(options);
  const results = packages.map(({ pkg, source }) => ({ ...inspectPackage(pkg), ...(source ? { source } : {}) }));
  return { ok: diagnostics.length === 0 && results.every(item => item.ok), scope,
    profile, executed: false, results, diagnostics,
    summary: { packages: results.length, commands: results.reduce((count, item) => count + item.commands, 0),
      errors: diagnostics.length + results.reduce((count, item) => count + item.errors.length, 0),
      warnings: results.reduce((count, item) => count + item.warnings.length, 0) },
    limits: ['Static validation does not invoke commands or verify remote effects.', 'Toolkit Python code is not executed or compiled.'] };
}

export function runAdapterDiagnostics(args, { outputFormat, ...options } = {}) {
  if (outputFormat !== undefined) resolveOutputFormat(outputFormat);
  const [command, ...rest] = args;
  if (!['status', 'validate'].includes(command)) throw new Error('Unknown Adapter diagnostic.');
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(formatCallOutput({ usage: ['webcli adapter status [name]', 'webcli adapter validate <directory>', 'webcli adapter validate --installed [name]'],
      scope: 'Managed v2 packages; read-only, no command execution or browser connection.' }, outputFormat ?? 'json')); return;
  }
  const positionals = rest.filter(value => !value.startsWith('--'));
  if (positionals.length > 1 || rest.some(value => value.startsWith('--') && !['--json', '--installed'].includes(value))
    || (command === 'status' && rest.includes('--installed')) || (command === 'validate' && !rest.includes('--installed') && positionals.length !== 1)) {
    throw new Error('Usage: webcli adapter status [name] | validate <directory> | validate --installed [name]');
  }
  const report = command === 'status' ? adapterStatus(positionals[0], options)
    : validateAdapters(rest.includes('--installed') ? { ...options, name: positionals[0] } : { ...options, directory: positionals[0] });
  console.log(formatCallOutput(report, outputFormat ?? 'json'));
  if (!report.ok) process.exitCode = 1;
  return report;
}
