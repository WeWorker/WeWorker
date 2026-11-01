import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { collectDiagnosticPackages, inspectPackage } from './adapter-diagnostics.js';
import { assertManagedDirectory, assertManagedFile, adapterError } from './adapter-package-files.js';
import { assertAdapterIdentity, buildAdapterCatalog } from './adapter-catalog.js';
import { resolveAdapterPaths, resolveAdaptersDir } from './paths.js';
import { inspectToolkitDirectory, resolveToolkitAdaptersDir } from './adapter-registry.js';
import { resolveToolkitRuntime } from './toolkit-runner.js';
import { ExplorationKnowledge } from './exploration-knowledge.js';
import { formatCallOutput, resolveOutputFormat } from './output-format.js';

const limits = [
  'No tool, Python, browser, Bridge or network request is executed. Runtime availability is only a filesystem check.',
  'Historical evidence is local, unauthenticated data; matching digest and age do not prove current behavior or authorize writes.',
  'Use exploration.validate for current author cases, explicit write review/verification for effects, and trace for individual calls.',
];
const recent = (value, now) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60000 && now - Date.parse(value) < 30 * 86400000;
function boundedRead(root, file) {
  const target = assertManagedFile(root, file), stat = lstatSync(target);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw adapterError('INVALID_DIAGNOSTIC_FILE', 'Expected a regular file of at most 2 MiB.');
  return readFileSync(target);
}

function evidenceFor(pkg, directory, now) {
  let stored, error;
  if (directory) {
    try {
      const store = new ExplorationKnowledge(resolve(directory), { readOnly: true });
      const file = basename(store.file(pkg.name));
      if (existsSync(join(directory, file))) boundedRead(resolve(directory), file);
      stored = store.read(pkg.name, { activeDigest: pkg.digest, now });
    } catch { error = 'EVIDENCE_INVALID'; }
  }
  return pkg.commands.map(command => {
    const entry = stored?.knowledge?.commands?.[`${pkg.name}.${command.id}`];
    let status = error || (!directory ? 'EVIDENCE_SOURCE_NOT_SELECTED' : !entry ? 'EVIDENCE_MISSING'
      : stored.knowledge.packageDigest !== pkg.digest || entry.packageDigest !== pkg.digest ? 'EVIDENCE_DIGEST_MISMATCH'
      : !recent(entry.verifiedAt, now) || stored.stale ? 'EVIDENCE_STALE' : 'HISTORICAL_READ_CASES');
    let cases = Array.isArray(entry?.cases) ? entry.cases.length : 0;
    if (status === 'HISTORICAL_READ_CASES') {
      if (command.safety === 'write') {
        const proof = entry.writeVerification;
        cases = Array.isArray(proof?.fixture?.cases) ? proof.fixture.cases.length : proof?.fixture ? 1 : 0;
        status = proof && recent(proof.verifiedAt, now) && proof.replayAllowed === false && cases ? 'HISTORICAL_WRITE_EFFECT' : 'WRITE_EFFECT_EVIDENCE_MISSING';
      } else if (!cases) status = 'READ_CASES_MISSING';
    }
    return { command: command.id, runtime: command.runtime, safety: command.safety || 'read', status,
      source: directory ? 'exploration-knowledge' : null, cases,
      verifiedAt: entry && recent(entry.verifiedAt, now) ? new Date(entry.verifiedAt).toISOString() : null,
      executed: false, currentEffectVerified: false, replayAllowed: false };
  });
}

/** Legacy is deliberately syntax/static-name only; never evaluate author metadata. */
async function inspectCompatibility(directory, runtime, options) {
  const errors = [], warnings = [], root = resolve(directory), name = basename(root);
  let commands = [], digest = null, runtimeAvailable = null;
  try {
    assertAdapterIdentity(name); assertManagedDirectory(root);
    const manifestBytes = boundedRead(root, 'manifest.json'), manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (runtime === 'toolkit') {
      const adapter = inspectToolkitDirectory(root, name);
      commands = adapter.tools.map(tool => tool.id); digest = adapter.manifest.artifact_hash;
      try {
        const candidate = resolveToolkitRuntime(options);
        runtimeAvailable = lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink();
      } catch { runtimeAvailable = false; }
      if (!runtimeAvailable) warnings.push({ code: 'TOOLKIT_RUNTIME_UNAVAILABLE' });
      warnings.push({ code: 'TOOLKIT_PYTHON_NOT_EXECUTED' });
    } else {
      if (manifest.schema_version === 2 || manifest.adapter_type === 'toolkit') throw adapterError('RUNTIME_MISMATCH', 'Expected a legacy extension package.');
      if (manifest.id && manifest.id !== name) throw adapterError('LEGACY_IDENTITY_MISMATCH', 'Legacy identity differs from directory.');
      if (manifest.support_files !== undefined && (!Array.isArray(manifest.support_files) || manifest.support_files.length > 512)) throw adapterError('INVALID_LEGACY_MANIFEST', 'Invalid support files.');
      const digestBuilder = createHash('sha256').update(manifestBytes), names = new Set();
      const files = [...new Set(['index.js', ...(manifest.support_files || [])])];
      let totalBytes = manifestBytes.length;
      const { parseToolsFromSource } = await import('./adapter-cli.js');
      for (const file of files) {
        const bytes = boundedRead(root, file); totalBytes += bytes.length;
        if (totalBytes > 32 * 1024 * 1024) throw adapterError('DIAGNOSTIC_LIMIT', 'Legacy diagnostic input exceeds 32 MiB.');
        digestBuilder.update(file).update('\0').update(bytes);
        if (!file.endsWith('.js')) continue;
        try { new Script(bytes.toString('utf8'), { filename: file }); }
        catch { errors.push({ code: 'JAVASCRIPT_SYNTAX', file }); continue; }
        if (file !== 'index.js') continue;
        for (const tool of parseToolsFromSource(bytes.toString('utf8'), manifest, { namesOnly: true })) {
          if (names.has(tool.name)) errors.push({ code: 'DUPLICATE_COMMAND', command: tool.name });
          names.add(tool.name);
        }
      }
      commands = [...names]; digest = digestBuilder.digest('hex');
      warnings.push({ code: 'LEGACY_STATIC_NAMES_ONLY' });
      if (!commands.length) warnings.push({ code: 'LEGACY_COMMANDS_UNRESOLVED' });
    }
  } catch (error) { errors.push({ code: error.code || (runtime === 'toolkit' ? 'INVALID_TOOLKIT_PACKAGE' : 'INVALID_LEGACY_PACKAGE') }); }
  return { name, runtime, digest, commands, ok: errors.length === 0, errors, warnings, runtimeAvailable, executed: false };
}

export async function verifyAdapters({ directory, name, runtime = 'managed', knowledgeDir, requireEvidence = false, now = Date.now(), ...options } = {}) {
  if (!['managed', 'legacy', 'toolkit'].includes(runtime)) throw adapterError('INVALID_ARGUMENT', 'Use managed, legacy or toolkit.');
  if (name !== undefined) assertAdapterIdentity(name);
  if (runtime !== 'managed' && knowledgeDir) throw adapterError('INVALID_ARGUMENT', 'Exploration knowledge applies only to managed v2 packages.');
  let results = [], diagnostics = [], profile = null;
  if (runtime === 'managed') {
    const collected = collectDiagnosticPackages({ ...options, directory, name });
    diagnostics = collected.diagnostics; profile = collected.profile;
    results = collected.packages.map(({ pkg, source }) => ({ ...inspectPackage(pkg), source: source || 'directory',
      evidence: evidenceFor(pkg, knowledgeDir, now) }));
  } else {
    const paths = options.paths || resolveAdapterPaths(options), roots = directory ? [] : runtime === 'toolkit'
      ? [resolveToolkitAdaptersDir(options)] : [options.legacyBuiltinDir || resolveAdaptersDir(), paths.userDir];
    const catalog = directory ? null : buildAdapterCatalog({ ...options, paths });
    if (catalog) diagnostics.push(...catalog.diagnostics.filter(item => !name || item.name === name || item.names?.includes(name) || (!item.name && !item.names)));
    const excluded = new Set(catalog ? [...catalog.candidates.map(entry => entry.name), ...Object.keys(catalog.selections || {}),
      ...catalog.diagnostics.flatMap(item => item.name ? [item.name] : item.names || [])] : []);
    const candidates = directory ? [{ directory, source: 'directory' }] : [];
    for (const root of roots) {
      try {
        assertManagedDirectory(root);
        if (!existsSync(root)) continue;
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || (name && entry.name !== name) || excluded.has(entry.name)) continue;
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const child = join(root, entry.name);
          if (!existsSync(join(child, 'manifest.json'))) continue;
          // Keep malformed candidates visible, but do not label valid other runtimes as failures.
          let manifest;
          try { manifest = JSON.parse(boundedRead(child, 'manifest.json')); } catch { /* reported below */ }
          if (manifest && (runtime === 'toolkit' ? manifest.adapter_type !== 'toolkit' : manifest.schema_version === 2 || manifest.adapter_type === 'toolkit')) continue;
          candidates.push({ directory: child, source: runtime === 'toolkit' ? 'toolkit-skills' : root === paths.userDir ? 'user' : 'builtin' });
        }
      } catch { diagnostics.push({ code: 'INVALID_DIAGNOSTIC_ROOT' }); }
    }
    for (const candidate of candidates) results.push({ ...await inspectCompatibility(candidate.directory, runtime, options), source: candidate.source });
    for (const item of results) if (results.filter(other => other.name === item.name).length > 1) diagnostics.push({ name: item.name, code: 'AMBIGUOUS_ADAPTER' });
    if (name && !results.length) diagnostics.push({ name, code: 'ADAPTER_NOT_ACTIVE' });
  }
  const staticOk = diagnostics.length === 0 && results.every(item => item.ok);
  const evidenceComplete = results.length > 0 && results.every(item => item.evidence?.length && item.evidence.every(proof => ['HISTORICAL_READ_CASES', 'HISTORICAL_WRITE_EFFECT'].includes(proof.status)));
  return { schemaVersion: 1, ok: staticOk && (!requireEvidence || evidenceComplete), staticOk, evidenceComplete,
    scope: directory ? 'package-directory' : 'installed', runtime, profile, executed: false, results, diagnostics, limits };
}

export async function runAdapterVerify(args, { outputFormat, ...options } = {}) {
  if (outputFormat !== undefined) resolveOutputFormat(outputFormat);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(formatCallOutput({ usage: 'webcli adapter verify <dir> | --installed [name] [--runtime managed|legacy|toolkit] [--knowledge-dir <existing-store>] [--require-evidence]', limits }, outputFormat ?? 'json')); return;
  }
  const parsed = {}, positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--runtime', '--knowledge-dir'].includes(arg)) {
      const key = arg === '--runtime' ? 'runtime' : 'knowledgeDir';
      if (parsed[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new Error('Invalid verify option.');
      parsed[key] = args[++i];
    } else if (arg === '--require-evidence') parsed.requireEvidence = true;
    else if (arg === '--installed') parsed.installed = true;
    else if (arg === '--json') continue;
    else if (arg.startsWith('-')) throw new Error('Unknown verify option.');
    else positionals.push(arg);
  }
  if (positionals.length > 1 || (!parsed.installed && positionals.length !== 1)) throw new Error('Use verify <directory> or verify --installed [name].');
  const report = await verifyAdapters({ ...options, ...parsed, ...(parsed.installed ? { name: positionals[0] } : { directory: positionals[0] }) });
  console.log(formatCallOutput(report, outputFormat ?? 'json'));
  if (!report.ok) process.exitCode = 1;
  return report;
}
