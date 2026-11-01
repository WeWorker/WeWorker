import { execFileSync } from 'node:child_process';
import { resolve, posix } from 'node:path';
import { adapterError, assertPackagePath, validatePackageFiles } from './adapter-package-files.js';
import { inspectPackage } from './adapter-diagnostics.js';
import { installAdapter } from './adapter-install-store.js';
import { adapterPermissions } from './adapter-catalog.js';
import { formatCallOutput, resolveOutputFormat } from './output-format.js';

// Read Git objects, never checkout, load filters, run hooks, npm or author code.
function git(repository, args, maxBuffer = 4 * 1024 * 1024, input) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(key)) delete env[key];
  try { return execFileSync('git', ['--no-pager', '-C', resolve(repository), ...args], { env, input, windowsHide: true, timeout: 15000, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw adapterError('GIT_SOURCE_UNAVAILABLE', 'Cannot read the selected local Git commit (Git missing, object unavailable, timeout or size limit).'); }
}
function snapshot(repository, ref) {
  if (typeof ref !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)) throw adapterError('GIT_COMMIT_REQUIRED', 'Use a full immutable commit ID.');
  if (git(repository, ['cat-file', '-t', ref]).toString().trim() !== 'commit') throw adapterError('GIT_COMMIT_REQUIRED', 'The object must be a commit.');
  const raw = git(repository, ['ls-tree', '-rlz', '--full-tree', ref]).toString('utf8');
  const entries = raw.split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(line);
    if (!match) throw adapterError('INVALID_GIT_TREE', 'Unsupported tree entry.');
    return { mode: match[1], type: match[2], oid: match[3], size: Number(match[4]), path: match[5] };
  });
  if (entries.length > 20000) throw adapterError('GIT_SOURCE_LIMIT', 'At most 20000 tracked entries are supported.');
  return entries;
}
function readBlobs(repository, entries, budget = 32 * 1024 * 1024) {
  let total = 0;
  for (const entry of entries) {
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') throw adapterError('UNSAFE_GIT_ENTRY', 'Symlinks and submodules are not package files.');
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > budget) throw adapterError('GIT_SOURCE_LIMIT', 'Git objects exceed the package budget.');
  }
  const missing = entries.filter(entry => entry.bytes === undefined);
  if (!missing.length) return;
  const bytes = git(repository, ['cat-file', '--batch'], budget + entries.length * 200, missing.map(entry => entry.oid).join('\n') + '\n');
  let offset = 0;
  for (const entry of missing) {
    const end = bytes.indexOf(10, offset), header = bytes.subarray(offset, end).toString('ascii');
    if (header !== `${entry.oid} blob ${entry.size}` || bytes.length < end + 2 + entry.size || bytes[end + 1 + entry.size] !== 10) throw adapterError('INVALID_GIT_OBJECT', 'Unexpected Git object response.');
    entry.bytes = bytes.subarray(end + 1, end + 1 + entry.size); offset = end + 2 + entry.size;
  }
}
function readPackage(repository, entries, subpath) {
  if (subpath !== '.') assertPackagePath(subpath);
  const prefix = subpath === '.' ? '' : subpath + '/';
  const selected = entries.filter(entry => entry.path.startsWith(prefix));
  if (!selected.length || selected.length > 512) throw adapterError('INVALID_PACKAGE', 'Select one package containing at most 512 files.');
  readBlobs(repository, selected);
  const files = new Map();
  for (const entry of selected) {
    const name = entry.path.slice(prefix.length); assertPackagePath(name);
    files.set(name, entry.bytes);
  }
  return validatePackageFiles(files);
}

export function inspectGitSource(repository, ref) {
  const entries = snapshot(repository, ref), results = [], diagnostics = [];
  const manifests = entries.filter(entry => posix.basename(entry.path) === 'manifest.json');
  if (manifests.length > 200) throw adapterError('GIT_SOURCE_LIMIT', 'At most 200 manifests are supported.');
  for (const entry of manifests) {
    const subpath = posix.dirname(entry.path);
    try {
      readBlobs(repository, [entry], 2 * 1024 * 1024);
      const manifest = JSON.parse(entry.bytes);
      if (manifest.schema_version !== 2) continue;
      const pkg = readPackage(repository, entries, subpath);
      results.push({ path: subpath, ...inspectPackage(pkg), permissions: adapterPermissions(pkg.manifest),
        commandDetails: pkg.commands.map(command => ({ id: command.id, runtime: command.runtime, safety: command.safety || 'read' })) });
    } catch (error) { diagnostics.push({ path: subpath, code: error.code || 'INVALID_MANIFEST' }); }
  }
  for (const item of results) if (results.filter(other => other.name === item.name).length > 1) diagnostics.push({ name: item.name, code: 'DUPLICATE_PACKAGE_NAME' });
  if (!results.length && !diagnostics.length) diagnostics.push({ code: 'NO_MANAGED_PACKAGES' });
  return { ok: diagnostics.length === 0 && results.every(item => item.ok), source: 'local-git-objects', commit: ref,
    executed: false, results, diagnostics,
    limits: ['Only committed v2 packages are inspected. Working-tree and untracked changes are excluded.',
      'No remote clone/update, dependency installation, OpenCLI plugin conversion, symlink or submodule traversal.'] };
}

export function installGitPackage({ repository, ref, subpath, digest, ...input }, options = {}) {
  if (typeof subpath !== 'string' || !/^[a-f0-9]{64}$/.test(digest || '')) throw adapterError('GIT_REVIEW_REQUIRED', 'Select the exact package path and digest from adapter source.');
  const pkg = readPackage(repository, snapshot(repository, ref), subpath);
  if (pkg.digest !== digest) throw adapterError('ADAPTER_CONTENT_CHANGED', 'Package differs from the reviewed digest.');
  if (!inspectPackage(pkg).ok) throw adapterError('JAVASCRIPT_SYNTAX', 'Package syntax validation failed.');
  const result = installAdapter({ ...input, files: pkg.files, origin: { kind: 'git', commit: ref, subpath } }, options);
  return { name: result.name, version: result.version, digest: result.digest, active: result.active, origin: result.origin };
}

export function runGitSource(args, { outputFormat } = {}) {
  if (outputFormat !== undefined) resolveOutputFormat(outputFormat);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(formatCallOutput({ usage: 'webcli adapter source <local-repository> --ref <full-commit-sha>',
      next: 'webcli adapter install --git <local-repository> --ref <sha> --package <path> --digest <reviewed-digest>' }, outputFormat ?? 'json')); return;
  }
  const values = args.filter(arg => arg !== '--json');
  if (values.length !== 3 || values[1] !== '--ref' || values[0].startsWith('-')) throw new Error('Use adapter source <local-repository> --ref <full-commit-sha>.');
  const report = inspectGitSource(values[0], values[2]);
  console.log(formatCallOutput(report, outputFormat ?? 'json'));
  if (!report.ok) process.exitCode = 1;
  return report;
}
