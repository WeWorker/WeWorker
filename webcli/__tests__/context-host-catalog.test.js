import { expect, it, vi } from 'vitest';
import { validateV2Manifest } from '../adapter-package-validation.js';
import { loadContextCatalog, captureResult, canonicalTool } from '../context-profile.js';
import { compileResultBindings, extractBoundEntities, readBindingPath } from '../result-bindings.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';
import { runContextCall, runContextRoute } from '../context-command.js';
import { extractContextFlags } from '../context-cli-flags.js';
import { choose } from '../context-choice.js';

function manifest() {
  return { schema_version: 2, name: 'example.com', version: '1.0.0', description: 'Example records', match: ['example.com'], commands: [
    { id: 'list', description: 'List records', runtime: 'extension', module: 'extension/commands/list.js', safety: 'read', schema: { type: 'object', properties: { env: { type: 'string', default: 'test' } } },
      results: [{ itemsPath: '$.data.rows', idField: 'id', titleField: 'title', actions: [
        { id: 'detail', label: '查看详情', command: 'detail', args: { key: { from: 'item.id' }, env: { from: 'query.env' } } },
        { id: 'edit', label: '修改', command: 'edit', args: { key: { from: 'item.id' } }, inputs: ['body'] },
      ] }] },
    { id: 'detail', description: 'Read record', aliases: ['inspect'], runtime: 'extension', module: 'extension/commands/detail.js', safety: 'read', schema: { type: 'object', properties: { key: { type: 'string' }, env: { type: 'string' } }, required: ['key', 'env'] } },
    { id: 'edit', description: 'Edit record', runtime: 'extension', module: 'extension/commands/edit.js', safety: 'write', schema: { type: 'object', properties: { key: { type: 'string' }, body: { type: 'string' } }, required: ['key', 'body'] } },
  ] };
}
async function fixture() {
  const m = manifest(), validated = validateV2Manifest(m);
  const adapter = { name: m.name, version: m.version, source: 'builtin', manifest: m, commands: validated.commands, digest: 'a'.repeat(64) };
  const host = { profile: 'public', revision: 1, selections: {}, effective: [adapter], candidates: [adapter], diagnostics: [] };
  const catalog = await loadContextCatalog({ catalog: host });
  const state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: 'example.com.list', args: {}, raw: { data: { rows: [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }] } }, exitCode: 0, now: 1000, catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId, order: ['e2', 'e1'], completeness: 'unknown', delivered: true });
  return { state, snapshot, catalog, host };
}

it('uses the selected host catalog, package digest, canonical command and alias', async () => {
  const { catalog } = await fixture();
  expect(catalog.entries.map(entry => entry.name)).toEqual(['example.com.list', 'example.com.detail', 'example.com.edit']);
  expect(canonicalTool('example.com.inspect', catalog)).toBe('example.com.detail');
  expect(catalog.entries[0].executionSnapshot).toEqual({ name: 'example.com', digest: 'a'.repeat(64), profile: 'public' });
  expect(catalog.routeAdapters[0].id).toBe('example.com');
});
it('fails closed for an unavailable host catalog', async () => {
  const { host } = await fixture(); host.diagnostics.push({ code: 'INVALID_ADAPTER_STATE' });
  await expect(loadContextCatalog({ catalog: host })).rejects.toThrow('context_catalog_unavailable');
});
it('requires explicit target safety rather than the ordinary read default', () => {
  const m = manifest(); delete m.commands[1].safety;
  expect(() => validateV2Manifest(m)).toThrow('binding_invalid_target');
});
it.each(['inspect', 'example.com.inspect'])('uses the existing command alias %s while emitting the canonical invocation name', alias => {
  const m = manifest(); m.commands[0].results[0].actions[0].command = alias;
  const validated = validateV2Manifest(m);
  const bindings = compileResultBindings(validated.commands.map(command => ({ ...command, adapterId: m.name })));
  expect(bindings.get('example.com.list').results[0].actions[0].tool).toBe('example.com.detail');
});
it('rejects a target from another Adapter', async () => {
  const { catalog } = await fixture(); catalog.entries[1].adapterId = 'example.org';
  expect(() => compileResultBindings(catalog.entries)).toThrow('binding_invalid_target');
});
it.each(['$.items[0]', '$.constructor.key', '$.items.filter()', '$.__proto__.x'])('rejects executable or inherited mapping path %s', path => {
  expect(() => readBindingPath({}, path)).toThrow('binding_invalid_path');
});
it('does not coerce a number into a string argument', async () => {
  const { catalog } = await fixture();
  const extracted = extractBoundEntities(catalog.resultBindings.get('example.com.list'), {}, { data: { rows: [{ id: 12, title: 'Number' }] } });
  expect(extracted.entities[0].bindings.detail.args.key).toBe(12);
  expect(extracted.entities[0].bindings.detail.ready).toBe(false);
});
it('binds an explicitly declared singleton without changing the Adapter return shape', () => {
  const m = manifest(), rule = m.commands[0].results[0];
  delete rule.itemsPath; rule.itemPath = '$.data.record';
  const validated = validateV2Manifest(m);
  const bindings = compileResultBindings(validated.commands.map(command => ({ ...command, adapterId: m.name })));
  const raw = { data: { record: { id: 'record-a', title: 'Record A' } } };
  const extracted = extractBoundEntities(bindings.get('example.com.list'), {}, raw);
  expect(extracted.entities[0].bindings.detail.args).toEqual({ key: 'record-a', env: 'test' });
  expect(raw.data.record).toEqual({ id: 'record-a', title: 'Record A' });
  expect(() => extractBoundEntities(bindings.get('example.com.list'), {}, { data: { record: [] } })).toThrow('binding_invalid_result');
});
it.each(['both', 'neither'])('rejects an ambiguous result cardinality: %s', kind => {
  const m = manifest(), rule = m.commands[0].results[0];
  if (kind === 'both') rule.itemPath = '$';
  else delete rule.itemsPath;
  expect(() => validateV2Manifest(m)).toThrow('binding_invalid_rule');
});
it.each(['__confirmed', '__grant'])('rejects internal control %s from mappings and clarification inputs', key => {
  const m = manifest(), action = m.commands[0].results[0].actions[1];
  action.args[key] = { value: true };
  expect(() => validateV2Manifest(m)).toThrow('binding_invalid_argument');
  delete action.args[key];
  m.commands[2].schema.properties[key] = { type: 'boolean' };
  action.inputs = [key];
  expect(() => validateV2Manifest(m)).toThrow('binding_invalid_input');
});
it('preserves business yes/confirm fields while ignoring the retired schema control', () => {
  const m = manifest(), action = m.commands[0].results[0].actions[1], schema = m.commands[2].schema;
  schema.properties.yes = { type: 'boolean' }; schema.properties.confirm = { type: 'boolean' };
  schema.properties.__confirmed = { type: 'boolean', default: true }; schema.required.push('__confirmed');
  action.args.yes = { value: false }; action.inputs = ['body', 'confirm'];
  const validated = validateV2Manifest(m);
  const bindings = compileResultBindings(validated.commands.map(command => ({ ...command, adapterId: m.name })));
  const compiled = bindings.get('example.com.list').results[0].actions[1];
  expect(compiled.schema.required).not.toContain('__confirmed');
  expect(compiled.schema.required).toContain('confirm');
  const extracted = extractBoundEntities(bindings.get('example.com.list'), {}, { data: { rows: [{ id: 'a', title: 'A' }] } });
  expect(extracted.entities[0].bindings.edit.args).toEqual({ key: 'a', yes: false });
});
it('rejects duplicate identities instead of guessing which result to open', async () => {
  const { catalog } = await fixture();
  expect(() => extractBoundEntities(catalog.resultBindings.get('example.com.list'), {}, { data: { rows: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] } })).toThrow('binding_invalid_entity');
});
it.each([NaN, Infinity, 9007199254740992])('rejects a non-finite or imprecise numeric identity %s', async id => {
  const { catalog } = await fixture();
  expect(() => extractBoundEntities(catalog.resultBindings.get('example.com.list'), {}, { data: { rows: [{ id, title: 'Invalid identity' }] } })).toThrow('binding_invalid_entity');
});
it('resolves 查看第二条 from actual display order without a model request', async () => {
  const { state, catalog } = await fixture(), provider = vi.fn();
  const result = await routeContext(state, '查看第二条', { catalog, now: 1001, provider });
  expect(result.kind).toBe('resolved'); expect(result.executionEligibility).toBe('read_only_allowed');
  expect(result.steps[0]).toMatchObject({ tool: 'example.com.detail', args: { key: 'a', env: 'test' } });
  expect(provider).not.toHaveBeenCalled();
});
it('keeps a bounded actionable window for large results and never treats it as the full list', async () => {
  const { state, catalog } = await fixture();
  beginRound(state, null, 1001);
  const raw = { data: { rows: Array.from({ length: 100 }, (_, index) => ({ id: `id-${index}`, title: `Record ${index}` })) } };
  const snapshot = captureResult(state, { tool: 'example.com.list', args: {}, raw, exitCode: 0, now: 1001, catalog, roundId: state.activeRound.roundId });
  expect(raw.data.rows).toHaveLength(100);
  expect(snapshot.entities).toHaveLength(20); expect(snapshot.resultCount).toBe(100); expect(snapshot.completeness).toBe('truncated');
  commitRound(state);
  const display = { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(entity => entity.entityRef), delivered: true };
  expect(() => registerDisplay(state, { ...display, completeness: 'complete' })).toThrow('context_invalid_display');
  registerDisplay(state, { ...display, completeness: 'truncated' });
  const result = await routeContext(state, '查看第二条', { catalog, now: 1002 });
  expect(result.steps[0].args.key).toBe('id-1');
  const outside = await routeContext(state, '查看第21条', { catalog, now: 1003 });
  expect(outside.steps).toBeUndefined();
});
it.each(['display', 'profile', 'expiry'])('refuses an unverified %s source', async kind => {
  const { state, snapshot, catalog } = await fixture();
  if (kind === 'display') snapshot.display = null;
  if (kind === 'profile') catalog.resultBindings.get(snapshot.tool).fingerprint = 'changed';
  const result = await routeContext(state, '查看第二条', { catalog, now: kind === 'expiry' ? 1801001 : 1001 });
  expect(result.steps).toBeUndefined();
});
it('declared writes retain source selection, ask for new content, and generate an executable plan', async () => {
  const { state, catalog } = await fixture();
  const question = await routeContext(state, '修改第二条', { catalog, now: 1001 });
  expect(question.missingFields).toEqual(['arguments.body']);
  const result = await routeContext(state, 'Replacement text', { catalog, now: 1002, replyTo: question.clarificationId });
  expect(result.steps[0].args).toEqual({ key: 'a', body: 'Replacement text' });
  expect(result.executionEligibility).toBe('write_allowed');
  expect(result.decision).not.toHaveProperty('confirmationRequired');
  const invoke = vi.fn(async () => ({ raw: { ok: true }, exitCode: 0 }));
  const store = { now: () => 1003, transaction: async (_id, fn) => fn(state, { persist: async () => {} }) };
  const executed = await runContextCall({ id: 'example', tool: 'example.com.edit', args: result.steps[0].args, invoke }, { catalog, store });
  expect(executed.receipt.toolOutcome).toBe('acknowledged');
  expect(invoke).toHaveBeenCalledOnce();
});
it('an unrelated first request falls back to the current single-turn route and retains its UUID', async () => {
  const { catalog } = await fixture(), state = newState(1000);
  const store = { now: () => 1000, transaction: async (_id, fn) => fn(state, { created: true }) };
  const singleTurn = vi.fn(async () => ({ kind: 'routed', callCommand: 'webcli call example.com.list' }));
  const result = await runContextRoute(['example.com', 'Search records'], { context: 'uuid-example' }, { catalog, store, singleTurn });
  expect(singleTurn).toHaveBeenCalledWith('Search records', { adapters: catalog.routeAdapters, knownSite: 'example.com' });
  expect(result.context).toMatchObject({ id: 'uuid-example', state: 'created' });
  expect(result.singleTurnRoute.callCommand).toBe('webcli call example.com.list');
});
it('generates distinct UUIDs and keeps context controls out of business flags', () => {
  const first = extractContextFlags(['call', 'example.com.list', '--new-context', '--env=test']);
  const second = extractContextFlags(['route', '--new-context', 'Search']);
  expect(first.context).toMatch(/^[a-f0-9-]{36}$/); expect(second.context).not.toBe(first.context);
  expect(first.args).toEqual(['call', 'example.com.list', '--env=test']);
});
it('an explicit unrelated classification starts a new route and clears the previous current focus', async () => {
  const { state, catalog } = await fixture();
  const result = await routeContext(state, 'Search a different topic', { catalog, now: 1001, provider: async () => 'NONE' });
  expect(result.kind).toBe('unrelated'); expect(state.currentSnapshotId).toBeNull(); expect(state.focus).toBeNull();
});
it.each([
  [false, 'example.com.unmapped-query', {}], [true, 'example.com.unmapped-query', {}],
  [false, 'example.com.detail', { key: 'new', env: 'test' }], [true, 'example.com.detail', { key: 'new', env: 'test' }],
])('an unassociated explicit query invalidates old scope before I/O, failure=%s tool=%s', async (failed, tool, args) => {
  const { state, snapshot, catalog } = await fixture();
  state.focus = { snapshotId: snapshot.snapshotId, sourceRoundId: snapshot.sourceRoundId, entityRef: 'e1' };
  let persisted = false;
  const store = { now: () => 1001, transaction: async (_id, fn) => fn(state, { created: false, persist: async () => { persisted = true; } }) };
  const invoke = vi.fn(async () => {
    expect(persisted).toBe(true); expect(state.currentSnapshotId).toBeNull(); expect(state.focus).toBeNull();
    return { raw: failed ? { error: 'Fixture failure' } : { rows: [{ id: 'new-result' }] }, exitCode: failed ? 1 : 0 };
  });
  const result = await runContextCall({ id: 'example', tool, args, invoke }, { store, catalog });
  expect(result.receipt.reasonCode).toBe(tool.endsWith('.unmapped-query') ? 'context_binding_unavailable' : undefined); expect(result.receipt.contextPersistence).toBe('committed');
  expect(invoke).toHaveBeenCalledOnce();
  const followup = await routeContext(state, '查看第二条', { catalog, now: 1002 });
  expect(followup.steps).toBeUndefined();
});
it.each([
  ['route', '--context', 'a', '--new-context', 'Search'],
  ['call', 'example.com.list', '--context', 'a', '--step', 's1'],
  ['route', '--context', '../unsafe', 'Search'],
])('rejects conflicting or incomplete context controls %j', (...args) => {
  expect(() => extractContextFlags(args)).toThrow();
});
it('uses the existing configured decision transport with a bounded deadline', async () => {
  const predict = vi.fn(async () => ({ answers: { selection: { type: 'choice', choice: 'A', probabilities: { A: .9, NONE: .04, NEEDS_INPUT: .03, HANDOFF: .03 } } } }));
  expect(await choose('Request', { A: 'Read displayed objects', NONE: 'Unrelated', NEEDS_INPUT: 'Ask', HANDOFF: 'Handoff' }, { predict, deadline: 12345 })).toBe('A');
  expect(predict.mock.calls[0][2]).toEqual({ deadline: 12345, maxResponseBytes: 65536 });
});
