import { randomUUID } from 'node:crypto';
import { buildAdapterCatalog } from './adapter-catalog.js';
import { describeAdapterCatalog } from './adapter-host.js';
import { buildRouteCatalog } from './auto-route-catalog.js';
import { compileResultBindings, extractBoundEntities, matchResultBinding } from './result-bindings.js';
import { fail } from './context-model.js';

// Use the same selected packages and content digests as the actual Runner.
export async function loadContextCatalog(options = {}) {
  const catalog = options.catalog || buildAdapterCatalog(options);
  if (!describeAdapterCatalog({ catalog }).available) fail('context_catalog_unavailable');
  const aliases = new Map();
  const entries = catalog.effective.flatMap(adapter => adapter.commands.filter(command => command.id !== adapter.manifest.auth?.qr?.command).map(command => {
    const name = `${adapter.name}.${command.id}`;
    for (const alias of command.aliases || []) aliases.set(`${adapter.name}.${alias}`, name);
    for (const alias of command.legacyNames || []) aliases.set(alias.toLowerCase(), name);
    return { ...command, name, adapterId: adapter.name, sourceFingerprint: adapter.digest,
      executionSnapshot: { name: adapter.name, digest: adapter.digest, profile: catalog.profile },
      // Ordinary v2 calls may default to read; a contextual action needs an explicit declaration.
      safety: adapter.manifest.commands.find(item => item.id === command.id)?.safety };
  }));
  return { entries, aliases, routeAdapters: buildRouteCatalog({ catalog }), tools: {}, profile: null, resultBindings: compileResultBindings(entries) };
}

export const canonicalTool = (name, catalog) => catalog?.aliases?.get(name) || catalog?.aliases?.get(name.toLowerCase()) || name;

export function callRole(tool, args, catalog) {
  tool = canonicalTool(tool, catalog);
  const entry = catalog.entries?.find(entry => entry.name === tool);
  if (entry?.safety === 'write') return 'approve';
  if (matchResultBinding(catalog.resultBindings?.get(tool), args)?.actions.length) return 'list';
  for (const binding of catalog.resultBindings?.values() || []) for (const rule of binding.results) {
    const action = rule.actions.find(action => action.tool === tool);
    if (action) return action.safety === 'read' ? 'detail' : 'approve';
  }
  return catalog.resultBindings?.has(tool) ? 'list' : 'unsupported';
}

export function snapshotDisplay(snapshot) {
  const cell = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]{}()!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  return { orderedEntityRefs: snapshot.entities.map(entity => entity.entityRef), completeness: snapshot.completeness,
    capturedCount: snapshot.entities.length, resultCount: snapshot.resultCount ?? snapshot.entities.length,
    markdown: ['| 序号 | 对象 | 标题 | 状态 |', '| --- | --- | --- | --- |',
      ...snapshot.entities.map((entity, i) => `| ${i + 1} | ${cell(entity.businessId)} | ${cell(entity.title)} | ${cell(entity.status)} |`)].join('\n') };
}

export function captureResult(state, { tool, args, raw, exitCode, now, catalog, roundId }) {
  if (exitCode !== 0 || raw?.error || raw?.success === false || raw?.ok === false || raw?.status === 'navigating') return null;
  tool = canonicalTool(tool, catalog);
  const binding = catalog.resultBindings?.get(tool);
  const extracted = binding && extractBoundEntities(binding, args, raw);
  if (extracted) {
    const round = state.activeRound?.roundId === roundId ? state.activeRound : state.rounds.find(round => round.roundId === roundId);
    if (!round) fail('context_stale_round', 4);
    const snapshotId = randomUUID();
    const snapshot = { snapshotId, sourceRoundId: roundId, capturedAt: now, tool, profile: binding.fingerprint,
      args: {}, ...extracted, display: null };
    state.snapshots[snapshotId] = snapshot;
    state.currentSnapshotId = snapshotId;
    round.snapshotIds.push(snapshotId);
    return snapshot;
  }
  const decision = state.preparedDecision;
  const source = decision?.source && state.snapshots[decision.source.snapshotId];
  const step = decision?.steps.find(step => step.tool === tool && JSON.stringify(step.args) === JSON.stringify(args));
  if (source && step && callRole(tool, args, catalog) === 'detail') {
    const entity = source.entities.find(entity => entity.businessId === step.businessId);
    if (entity) state.focus = { snapshotId: source.snapshotId, sourceRoundId: source.sourceRoundId, entityRef: entity.entityRef };
  }
  return null;
}
