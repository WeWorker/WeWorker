import { isDeepStrictEqual } from 'node:util';
import { buildAdapterCatalog } from '../adapter-catalog.js';
import { adapterError, readPackageDirectory } from '../adapter-package-files.js';

const hostKey = value => String(value).toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
const overlaps = (left, right) => {
  const a = hostKey(left), b = hostKey(right);
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
};

/** Resolve ownership before planning, without changing any catalog selection. */
export function prepareGenerationRun(run) {
  const memory = run.snapshot.input?.memory;
  if (!memory?.siteKey || memory.generationBaseline) return memory;
  const catalog = buildAdapterCatalog();
  const host = memory.siteHost || memory.siteKey;
  if (catalog.diagnostics.some(item => !item.name || item.name === memory.siteKey)) {
    throw adapterError('ADAPTER_CATALOG_REVIEW_REQUIRED', '请先解决工具包目录中的冲突，再生成增量工具。');
  }
  const owners = catalog.effective.filter(entry => entry.name === memory.siteKey || entry.manifest.match?.some(match => overlaps(match, host)));
  if (owners.length > 1) throw adapterError('ADAPTER_DOMAIN_CONFLICT', '多个工具包覆盖目标站点，请先检查域名归属。');
  const base = owners[0];
  if (!base) return memory;
  if (base.commands.some(command => command.runtime !== 'extension')) throw adapterError('GENERATION_EXISTING_RUNTIME_UNSUPPORTED', '现有工具包包含其他运行时，请单独检查后再扩展。');
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
export function verifyRetainedPackage(pkg, evidence, { paths } = {}) {
  if (!evidence?.retainedPackage) return new Set();
  const baseline = evidence.retainedPackage;
  const active = buildAdapterCatalog(paths ? { paths } : {}).effective.find(entry => entry.name === pkg.name);
  if (baseline.name !== pkg.name || !active || active.digest !== baseline.digest) throw adapterError('ADAPTER_BASE_CHANGED', '保留工具的安装基线已变化，请重新生成。');
  const before = readPackageDirectory(active.root);
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
