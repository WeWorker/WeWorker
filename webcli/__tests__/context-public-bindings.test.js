import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { compileResultBindings, extractBoundEntities } from '../result-bindings.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { captureResult } from '../context-profile.js';
import { routeContext } from '../context-router.js';

const cases = [
  ['36kr.com', 'search', {}, [{ title: 'First', url: 'https://www.36kr.com/p/1' }, { title: 'Second', url: 'https://www.36kr.com/p/2' }], 'article', { id: 'https://www.36kr.com/p/1' }],
  ['36kr.com', 'news', {}, [{ title: 'First', url: 'https://www.36kr.com/p/1' }, { title: 'Second', url: 'https://www.36kr.com/p/2' }], 'article', { id: 'https://www.36kr.com/p/1' }],
  ['36kr.com', 'hot', {}, [{ title: 'First', url: 'https://www.36kr.com/p/1' }, { title: 'Second', url: 'https://www.36kr.com/p/2' }], 'article', { id: 'https://www.36kr.com/p/1' }],
  ...['search', 'author', 'recent'].map(command => ['arxiv.org', command, {}, [{ id: '2401.00001', title: 'First' }, { id: '2401.00002', title: 'Second' }], 'paper', { id: '2401.00001' }]),
  ['github.com', 'repos', {}, [{ repo: 'example/first', url: 'https://github.com/example/first' }, { repo: 'example/second', url: 'https://github.com/example/second' }], 'get-repository-detail', { repository_url: 'https://github.com/example/first' }],
  ['github.com', 'search-repositories', {}, { repositories: [{ full_name: 'example/first', url: 'https://github.com/example/first' }, { full_name: 'example/second', url: 'https://github.com/example/second' }] }, 'get-repository-detail', { repository_url: 'https://github.com/example/first' }],
  ['bilibili.com', 'search-videos', {}, { videos: [{ title: 'First', url: 'https://www.bilibili.com/video/BVfixture1' }, { title: 'Second', url: 'https://www.bilibili.com/video/BVfixture2' }] }, 'open-video-detail', { video_url: 'https://www.bilibili.com/video/BVfixture1' }],
  ...['search', 'trending', 'summary', 'random'].map(command => ['wikipedia.org', command, { lang: 'zh' }, ['summary', 'random'].includes(command) ? [{ title: 'First' }] : [{ title: 'First' }, { title: 'Second' }], ['summary', 'random'].includes(command) ? 'page' : 'summary', { title: 'First', lang: 'zh' }]),
  ...['top', 'best', 'new', 'ask', 'show', 'jobs'].map(command => ['news.ycombinator.com', command, {}, [{ id: 101, title: 'First' }, { id: 102, title: 'Second' }], 'read', { id: 101 }]),
  ['news.ycombinator.com', 'search', {}, [{ id: '101', title: 'First' }, { id: '102', title: 'Second' }], 'read', { id: '101' }],
  ...['posts', 'search'].map(command => ['tieba.baidu.com', command, {}, [{ id: '101', title: 'First' }, { id: '102', title: 'Second' }], 'read', { id: '101' }]),
  ['tieba.baidu.com', 'hot', {}, [{ url: 'https://tieba.baidu.com/hottopic/1', title: 'First' }, { url: 'https://tieba.baidu.com/hottopic/2', title: 'Second' }], 'search', { keyword: 'First' }],
];
function fixture(id) {
  const pkg = validateV2AdapterDir(resolve(import.meta.dirname, '../../adapters', id));
  const entries = pkg.commands.map(command => ({ ...command, adapterId: id, sourceFingerprint: 'fixture-digest' }));
  return { ...pkg, catalog: { tools: {}, resultBindings: compileResultBindings(entries) } };
}
it.each(cases)('%s.%s uses its real manifest and display order to preserve invocation parameters', async (id, command, args, raw, target, expected) => {
  const { catalog } = fixture(id), state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `${id}.${command}`, args, raw, exitCode: 0, now: 1000, catalog, roundId: state.activeRound.roundId });
  const single = id === 'wikipedia.org' && ['summary', 'random'].includes(command);
  expect(snapshot.entities).toHaveLength(single ? 1 : 2); commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: single ? ['e1'] : ['e2', 'e1'], completeness: 'unknown', delivered: true });
  const result = await routeContext(state, single ? '查看这条' : '查看第二条', { catalog, now: 1001 });
  expect(result.kind).toBe('resolved'); expect(result.executionEligibility).toBe('read_only_allowed');
  expect(result.steps[0]).toMatchObject({ tool: `${id}.${target}`, args: expected });
});
it.each([['github.com', 'repos', 'star'], ['bilibili.com', 'search-videos', 'like'], ['bilibili.com', 'search-videos', 'favorite']])('%s.%s declares the exact business arguments for explicit %s', (id, command, actionId) => {
  const { catalog } = fixture(id), binding = catalog.resultBindings.get(`${id}.${command}`);
  const row = cases.find(test => test[0] === id && test[1] === command)[3];
  const extracted = extractBoundEntities(binding, {}, row);
  expect(extracted.entities[0].bindings[actionId].safety).toBe('write');
  expect(extracted.entities[0].bindings[actionId].args.confirm).toBe(true);
  expect(extracted.entities[0].bindings[actionId].args).not.toHaveProperty('__confirmed');
});
it('retains the current build profile scope for all changed packages', () => {
  const profile = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../weworker/build-profile.json'), 'utf8'));
  for (const id of new Set(cases.map(test => test[0]))) expect(profile.adapters).toContain(id);
});
it.each(['search', 'trending', 'summary', 'random'])('Wikipedia %s preserves the declared language default without asking the model', command => {
  const { catalog } = fixture('wikipedia.org');
  const extracted = extractBoundEntities(catalog.resultBindings.get('wikipedia.org.' + command), {}, [{ title: 'Example' }]);
  expect(extracted.entities[0].bindings.detail.args).toEqual({ title: 'Example', lang: 'en' });
  expect(extracted.entities[0].bindings.detail.ready).toBe(true);
});
it.each(['example-author', null])('HN author follow-up uses only the returned identity %s', author => {
  const { catalog } = fixture('news.ycombinator.com');
  const extracted = extractBoundEntities(catalog.resultBindings.get('news.ycombinator.com.top'), {}, [{ id: 101, title: 'Example', author }]);
  expect(extracted.entities[0].bindings.author.args).toEqual({ username: author });
  expect(extracted.entities[0].bindings.author.ready).toBe(author !== null);
});
it('Tieba read explicitly declares the absence of per-reply operations in the current package', () => {
  const { catalog } = fixture('tieba.baidu.com');
  const rule = catalog.resultBindings.get('tieba.baidu.com.read').results[0];
  expect(rule.actions).toEqual([]);
  expect(rule.reason).toContain('page');
});
it('HN user explicitly declares a profile leaf rather than manufacturing a user-posts operation', () => {
  const { catalog } = fixture('news.ycombinator.com');
  const rule = catalog.resultBindings.get('news.ycombinator.com.user').results[0];
  expect(rule.actions).toEqual([]);
  expect(rule.reason).toContain('username/karma/created/about');
});
