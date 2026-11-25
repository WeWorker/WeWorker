import { isDeepStrictEqual } from 'node:util';
import { buildAdapterCatalog } from '../adapter-catalog.js';
import { adapterError, readPackageDirectory } from '../adapter-package-files.js';

const hostKey = value => String(value).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
const overlaps = (left, right) => {
  const a = hostKey(left), b = hostKey(right);
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
};

/** Resolve ownership before planning, without changing any catalog selection. */
export function prepareGenerationRun(run, { paths } = {}) {
  const memory = run.snapshot.input?.memory;
  if (!memory?.siteKey || memory.generationBaseline) return memory;
  const catalog = buildAdapterCatalog(paths ? { paths } : {});
  const host = memory.siteHost || memory.siteKey;
  if (catalog.diagnostics.some(item => !item.name || item.name === memory.siteKey)) {
    throw adapterError('ADAPTER_CATALOG_REVIEW_REQUIRED', '请先解决工具包目录中的冲突，再生成增量工具。');
  }
  const owners = catalog.effective.filter(entry => entry.name === memory.siteKey || entry.manifest.match?.some(match => overlaps(match, host)));
  if (owners.length > 1) throw adapterError('ADAPTER_DOMAIN_CONFLICT', '多个工具包覆盖目标站点，请先检查域名归属。');
  const base = owners[0];
  if (!base) return memory;
  if (base.commands.some(command => !['extension', 'http', 'wewright'].includes(command.runtime))) throw adapterError('GENERATION_EXISTING_RUNTIME_UNSUPPORTED', '现有工具包包含其他运行时，请单独检查后再扩展。');
  const original = memory.siteKey;
  const rebindName = value => typeof value === 'string' && value.startsWith(original + '.') ? base.name + value.slice(original.length) : value;
  const prepared = { ...memory, siteKey: base.name,
    actionApiCandidates: (memory.actionApiCandidates || []).map(candidate => ({ ...candidate, toolName: rebindName(candidate.toolName) })),
    generationBaseline: { name: base.name, digest: base.digest, reservedNames: base.commands.flatMap(command => [command.id, ...(command.aliases || [])]) },
  };
  run.snapshot.siteKey = base.name;
  run.snapshot.input = { ...run.snapshot.input, memory: prepared };
  run.setArtifact('generationTarget', { exploredHost: host, name: base.name, digest: base.digest, retainedCommandCount: base.commands.length });
  return prepared;
}

export function allocateGenerationPlan(memory, plan) {
  if (!memory.generationBaseline) return plan;
  const reserved = new Set(memory.generationBaseline.reservedNames.map(name => name.replace(/_/g, '-')));
  const tools = (plan.tools || []).map(tool => {
    let name = String(tool.name || '').split('.').pop();
    while (reserved.has(name.replace(/_/g, '-'))) name = 'explored_' + name;
    reserved.add(name.replace(/_/g, '-'));
    return { ...tool, name };
  });
  return { ...plan, tools };
}

/** Task-side retention claims never exempt bytes that differ from the active baseline. */
export function verifyRetainedPackage(pkg, evidence, { paths, repairScope } = {}) {
  if (!evidence?.retainedPackage) {
    if (repairScope) throw adapterError('RETAINED_ADAPTER_CHANGED', 'Repair baseline evidence is missing.');
    return new Set();
  }
  const baseline = evidence.retainedPackage;
  const active = buildAdapterCatalog(paths ? { paths } : {}).effective.find(entry => entry.name === pkg.name);
  if (baseline.name !== pkg.name || !active || active.digest !== baseline.digest) throw adapterError('ADAPTER_BASE_CHANGED', '保留工具的安装基线已变化，请重新生成。');
  const before = readPackageDirectory(active.root);
  // Only the owning service's scope can authorize replacements. Draft evidence
  // and plans are author-editable and must never expand that scope themselves.
  if (repairScope) return verifyRepairRetention(before, pkg, repairScope);
  for (const [name, contents] of before.files) {
    if (name !== 'manifest.json' && !pkg.files.get(name)?.equals(contents)) throw adapterError('RETAINED_ADAPTER_CHANGED', '生成草稿修改了已有工具文件。');
  }
  for (const command of before.manifest.commands) {
    if (!isDeepStrictEqual(pkg.manifest.commands.find(item => item.id === command.id), command)) throw adapterError('RETAINED_ADAPTER_CHANGED', '生成草稿修改或删除了已有命令。');
  }
  // All existing metadata/grants are retained; only additive lists, version and commands may change.
  for (const [key, value] of Object.entries(before.manifest)) {
    if (['version', 'commands', 'match', 'runtime_allowed_hosts'].includes(key)) continue;
    if (!isDeepStrictEqual(pkg.manifest[key], value)) throw adapterError('RETAINED_ADAPTER_CHANGED', '生成草稿修改了已有工具包元数据。');
  }
  for (const key of ['match', 'runtime_allowed_hosts']) {
    if ((before.manifest[key] || []).some(value => !pkg.manifest[key]?.includes(value))) throw adapterError('RETAINED_ADAPTER_CHANGED', '生成草稿删除了已有权限。');
  }
  return new Set(before.manifest.commands.map(command => command.id));
}

export function verifyRepairRetention(before, pkg, scope) {
  const reject = () => { throw adapterError('REPAIR_SCOPE_CHANGED', 'Repair must preserve unselected content and grants; declarative write contracts must exactly match the service-bound repair plan.'); };
  if (scope.name !== before.name || scope.digest !== before.digest || !Array.isArray(scope.commandIds) || !scope.commandIds.length
    || scope.commandIds.length > 50 || new Set(scope.commandIds).size !== scope.commandIds.length) reject();
  const selected = new Set(scope.commandIds), modules = new Set();
  const shared = scope.sharedFiles || [];
  if (!Array.isArray(shared) || shared.length > 50 || new Set(shared).size !== shared.length
    || shared.some(file => typeof file !== 'string' || !/^(?:extension|http)\/internal\/[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..') || !before.files.has(file))
    || (shared.length && (scope.impact !== 'all-package-commands' || selected.size !== before.manifest.commands.length
      || before.manifest.commands.some(command => !selected.has(command.id))))) reject();
  const writeIds = scope.writeCommandIds || [];
  if (!Array.isArray(writeIds) || new Set(writeIds).size !== writeIds.length || writeIds.some(id => !selected.has(id))) reject();
  const contracts = scope.pageWriteContracts || {};
  if (!contracts || typeof contracts !== 'object' || Array.isArray(contracts) || Object.keys(contracts).some(id => !writeIds.includes(id))) reject();
  for (const id of selected) {
    const command = before.manifest.commands.find(item => item.id === id);
    if (!command || !['extension', 'http'].includes(command.runtime)
      || (writeIds.includes(id) ? command.safety !== 'write' || (command.runtime !== 'http' && !(command.pageWrite || command.uiWrite)) : command.safety !== 'read')
      || !command.module.startsWith(command.runtime + '/commands/')
      || before.manifest.commands.some(other => other.id !== id && other.module === command.module)) reject();
    modules.add(command.module);
    if (writeIds.includes(id) && command.runtime === 'extension') {
      const key = command.uiWrite ? 'uiWrite' : 'pageWrite', contract = contracts[id];
      if (!contract || Object.keys(contract).sort().join(',') !== [key, 'pageRoute'].sort().join(',')
        || contract.pageRoute?.origin !== command.pageRoute.origin || contract[key]?.method !== command[key].method
        || new URL(contract[key]?.url).origin !== command.pageRoute.origin
        || !isDeepStrictEqual(contract[key]?.idempotency, command[key].idempotency)) reject();
    } else if (contracts[id]) reject();
  }
  for (const file of shared) {
    for (const bytes of [before.files.get(file), pkg.files.get(file)]) {
      try { if (!bytes || bytes.length > 250000 || new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) reject(); }
      catch { reject(); }
    }
    modules.add(file);
  }
  if (before.files.size !== pkg.files.size) reject();
  for (const [name, contents] of before.files) {
    if (!pkg.files.has(name) || (name !== 'manifest.json' && !modules.has(name) && !pkg.files.get(name).equals(contents))) reject();
  }
  const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  if (!isDeepStrictEqual(omit(before.manifest, ['version', 'commands']), omit(pkg.manifest, ['version', 'commands']))) reject();
  if (!isDeepStrictEqual(before.manifest.commands.map(item => item.id), pkg.manifest.commands.map(item => item.id))) reject();
  for (const command of before.manifest.commands) {
    const next = pkg.manifest.commands.find(item => item.id === command.id);
    const allowed = selected.has(command.id) ? ['description', 'schema'] : [];
    if (contracts[command.id]) {
      const contract = contracts[command.id];
      for (const key of Object.keys(contract)) if (!isDeepStrictEqual(next[key], contract[key])) reject();
      allowed.push(...Object.keys(contract));
    }
    if (!isDeepStrictEqual(omit(command, allowed), omit(next, allowed))) reject();
  }
  return new Set(before.manifest.commands.filter(item => !selected.has(item.id)).map(item => item.id));
}
