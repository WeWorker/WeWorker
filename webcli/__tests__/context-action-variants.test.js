import { expect, it } from 'vitest';
import { compileResultBindings } from '../result-bindings.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { captureResult } from '../context-profile.js';
import { routeContext } from '../context-router.js';

function fixture({ write = false, unknown = false } = {}) {
  const variants = ['answer', 'question'].map(type => ({ when: { type }, command: type,
    args: { id: { from: `item.${type}_id` } }, ...(write ? { inputs: [type === 'answer' ? 'body' : 'title'] } : {}) }));
  const entries = [{ name: 'fixture.list', adapterId: 'fixture', safety: 'read', results: [{ itemsPath: '$', idField: 'id', titleField: 'title',
    actions: [{ id: write ? 'edit' : 'detail', label: write ? '修改' : '查看详情', variants }] }] },
    ...['answer', 'question'].map(type => ({ name: `fixture.${type}`, adapterId: 'fixture', safety: write ? 'write' : 'read',
      schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, body: { type: 'string' }, title: { type: 'string' } }, required: ['id'], additionalProperties: false } }))];
  const catalog = { entries, tools: {}, resultBindings: compileResultBindings(entries) }, state = newState(1000);
  beginRound(state, null, 1000);
  const raw = [{ id: 'answer:1', title: 'Example answer', type: 'answer', answer_id: '1' }, { id: 'question:2', title: 'Example question', type: 'question', question_id: '2' },
    ...(unknown ? [{ id: 'article:3', title: 'Unknown article', type: 'article', answer_id: 'forged-answer', question_id: 'forged-question' }] : [])];
  const snapshot = captureResult(state, { tool: 'fixture.list', args: {}, raw, exitCode: 0, now: 1000, catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return { state, catalog, entries };
}
it.each([['查看第一条', 'question', '2'], ['查看第二条', 'answer', '1']])('mixed rows %s chooses the selected declared command and its own argument mapping', async (text, target, id) => {
  const { state, catalog } = fixture(), result = await routeContext(state, text, { catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: `fixture.${target}`, args: { id } });
  expect(result.steps[0].invocation.tool).toBe(`fixture.${target}`);
});
it('a mixed displayed scope creates each step from its own bound command', async () => {
  const { state, catalog } = fixture(), result = await routeContext(state, '查看这些', { catalog, now: 1001 });
  expect(result.steps.map(s => [s.tool, s.args.id])).toEqual([['fixture.question', '2'], ['fixture.answer', '1']]);
});
it('an unmatched row cannot borrow another type even if it contains plausible IDs', async () => {
  const { state, catalog } = fixture({ unknown: true });
  expect((await routeContext(state, '查看第一条', { catalog, now: 1001 })).steps).toBeUndefined();
});
it('variant-specific input resumes after serialization without changing the selected target or ID', async () => {
  const { state, catalog } = fixture({ write: true }), question = await routeContext(state, '修改第一条', { catalog, now: 1001 });
  expect(question.missingFields).toEqual(['arguments.title']);
  const result = await routeContext(JSON.parse(JSON.stringify(state)), 'Example replacement', { catalog, now: 1002, replyTo: question.clarificationId });
  expect(result.executionEligibility).toBe('write_allowed');
  expect(result.steps[0]).toMatchObject({ tool: 'fixture.question', args: { id: '2', title: 'Example replacement' } });
});
it('heterogeneous missing inputs do not prompt for one schema and then apply it to another command', async () => {
  const { state, catalog } = fixture({ write: true }), question = await routeContext(state, '修改这些', { catalog, now: 1001 });
  expect(question.steps).toBeUndefined(); expect(question.missingFields).toEqual(['arguments']);
});
it.each([
  variants => { variants[1].when = { type: 'answer' }; },
  variants => { variants[1].when = { other: 'value' }; },
  variants => { variants[1].when = {}; },
  variants => { variants[1].when = JSON.parse('{"__proto__":"value"}'); },
  variants => { variants[1].when = { type: { unexpected: true } }; },
  variants => { variants[1].command = 'another.target'; },
])('invalid, overlapping or undeclared variants fail package compilation', mutate => {
  const { entries } = fixture(), changed = structuredClone(entries); mutate(changed[0].results[0].actions[0].variants);
  expect(() => compileResultBindings(changed)).toThrow();
});
it('one action cannot silently change between read and write according to a result row', () => {
  const { entries } = fixture(); entries[2].safety = 'write';
  expect(() => compileResultBindings(entries)).toThrow(/binding_invalid_variant/);
});
