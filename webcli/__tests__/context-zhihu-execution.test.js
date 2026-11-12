import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { compileResultBindings, extractBoundEntities } from '../result-bindings.js';
import { captureResult } from '../context-profile.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';
const root = resolve(import.meta.dirname, '../../adapters/zhihu.com');
const qid = '1937205528846655501', aid = '1937205528846655537', articleId = '1937205528846655599';
const answerUrl = `https://www.zhihu.com/question/${qid}/answer/${aid}`;
const author = { id: 'example-person-id', url_token: 'example-person', name: 'Example person' };
const question = { id: qid, title: 'Example question', type: 'question' };
const answer = { type: 'answer', id: aid, content: '<p>Example answer body</p>', question, author, voteup_count: 1 };
const article = { type: 'article', id: articleId, title: 'Example article', content: '<p>Article body</p>', author };
const pin = { type: 'pin', id: '123', excerpt_title: 'Example pin', content: [{ type: 'text', content: 'Example pin' }], author };
function setup({ noAuthor = false, noQuestion = false, duplicateCollection = false } = {}) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), requests = [], helpers = [];
  const list = data => ({ data, paging: { is_end: true, totals: data.length } });
  const context = { URL, URLSearchParams, console, Date, setTimeout, clearTimeout, AbortController,
    location: new URL('https://www.zhihu.com/'), document: { title: 'Example', cookie: '', body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: async (url, options = {}) => {
      const u = new URL(url); requests.push({ url: u, options }); let payload;
      if (options.method === 'POST') payload = { success: true, id: '987654321' };
      else if (u.pathname.endsWith('/search_v3')) payload = list([answer, question, article].map(object => ({ type: 'search_result', object })));
      else if (u.pathname.endsWith('/recommend')) payload = list([answer, question, article].map(target => ({ target })));
      else if (u.pathname.includes('/hot-lists/')) payload = list([{ target: question, detail_text: 'Example heat' }]);
      else if (u.pathname.includes('/comment_v5/')) payload = list([{ id: '123456789', content: '<p>Example comment</p>', author: { member: author }, child_comment_count: 0 }]);
      else if (u.pathname === '/api/v4/me' || u.pathname === '/api/v4/members/example-person') payload = author;
      else if (u.pathname.endsWith('/collections')) payload = list([{ id: '7654321', title: 'Example collection' }, ...(duplicateCollection ? [{ id: '7654322', title: 'Example collection' }] : [])]);
      else if (u.pathname.endsWith('/items')) payload = list([answer, article, pin].map(content => ({ content: { ...content, url: 'https://api.zhihu.com/answers/incorrect-api-url' } })));
      else if (u.pathname.endsWith('/answers')) payload = list([answer]);
      else if (u.pathname === `/api/v4/answers/${aid}`) payload = { ...answer, ...(noAuthor ? { author: { name: 'Anonymous' } } : {}), ...(noQuestion ? { question: undefined } : {}) };
      else if (u.pathname.endsWith('/articles')) payload = list([article]);
      else if (u.pathname.endsWith('/followers') || u.pathname.endsWith('/followees')) payload = list([author]);
      else if (u.pathname.endsWith('/pins')) payload = list([pin]);
      else throw new Error(`Unexpected request: ${u.pathname}`);
      return { ok: true, status: 200, url: u.href, headers: { get: () => 'application/json' }, json: async () => payload, text: async () => JSON.stringify(payload) };
    },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      helpers.push({ action, args });
      if (action === 'main_world_eval') return { value: await vm.runInContext(args.expression, context) };
      if (action === 'backend_file_write') return { success: true, path: args.path };
      throw new Error(`Unexpected helper: ${action}`);
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  const run = (name, args = {}) => handlers.get(`zhihu.com.${name}`)(args);
  return { context, requests, helpers, entries, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run,
    read: async (name, args = {}) => { let raw = await run(name, args); if (raw.__webcli_navigation?.resume) { context.location = new URL(raw.__webcli_navigation.url); raw = await run(name, args); } return raw; } };
}
function capture(s, command, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `zhihu.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state); registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return { state, snapshot };
}
function binding(s, command, args, raw, action, row = 0) {
  return extractBoundEntities(s.catalog.resultBindings.get(`zhihu.com.${command}`), args, raw).entities[row].bindings[action];
}
it.each(['search', 'recommend'])('%s routes reversed mixed rows using each selected type and does not invent article detail', async command => {
  const s = setup(), args = command === 'search' ? { query: 'Example' } : {}, raw = await s.read(command, args);
  const { state } = capture(s, command, args, raw);
  for (const [text, target, id] of [['查看第二条', 'question', qid], ['查看第三条', 'answer-detail', answerUrl]]) {
    const result = await routeContext(structuredClone(state), text, { catalog: s.catalog, now: 1001 });
    expect(result.kind).toBe('resolved'); expect(result.steps[0]).toMatchObject({ tool: `zhihu.com.${target}`, args: { id } });
    expect((await s.read(target, result.steps[0].args)).length).toBeGreaterThan(0);
  }
  expect((await routeContext(structuredClone(state), '查看第一条', { catalog: s.catalog, now: 1001 })).steps).toBeUndefined();
});
it.each([
  ['question', { id: qid }, 'detail', 'answer-detail', { id: answerUrl }],
  ['answer-detail', { id: aid }, 'comments', 'answer-comments', { id: answerUrl }],
  ['answer-comments', { id: aid }, 'author', 'user', { user: 'example-person' }],
  ['collections', {}, 'detail', 'collection', { id: '7654321' }],
  ['collection', { id: '7654321' }, 'detail', 'answer-detail', { id: answerUrl }],
  ['user', { user: 'example-person' }, 'user-answers', 'user-answers', { user: 'example-person' }],
  ['user-answers', { user: 'example-person' }, 'detail', 'answer-detail', { id: answerUrl }],
  ['followers', { user: 'example-person' }, 'detail', 'user', { user: 'example-person' }],
  ['following', { user: 'example-person' }, 'detail', 'user', { user: 'example-person' }],
  ['hot', {}, 'detail', 'question', { id: qid }],
  ['whoami', {}, 'detail', 'user', { user: 'example-person' }],
])('%s source and selected follow-up preserve exact identity', async (command, args, action, target, expected) => {
  const s = setup(), raw = await s.read(command, args), { state, snapshot } = capture(s, command, args, raw);
  expect(snapshot.entities.length).toBeGreaterThan(0);
  const b = binding(s, command, args, raw, action); expect(b).toMatchObject({ ready: true, tool: `zhihu.com.${target}`, args: expected });
  const result = await routeContext(state, `${snapshot.actions.find(a => a.id === action).label}${snapshot.entities.length === 1 ? '这条' : '第三条'}`, { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: b.tool, args: expected });
  expect((await s.read(target, result.steps[0].args)).length).toBeGreaterThan(0);
});
it('collection derives canonical URLs from actual identities and has no answer detail for articles or pins', async () => {
  const s = setup(), args = { id: '7654321' }, raw = await s.read('collection', args);
  expect(raw.map(r => r.url)).toEqual([answerUrl, `https://zhuanlan.zhihu.com/p/${articleId}`, 'https://www.zhihu.com/pin/123']);
  expect(binding(s, 'collection', args, raw, 'detail', 1)).toBeUndefined();
  expect(extractBoundEntities(s.catalog.resultBindings.get('zhihu.com.collection'), args, raw).entities[2].bindings).toEqual({});
});
it('user articles bind article writes and pins do not borrow answer actions', async () => {
  const s = setup(), args = { user: 'example-person' }, raw = await s.read('user-articles', args), b = binding(s, 'user-articles', args, raw, 'like');
  expect(b.args.target).toBe(`https://zhuanlan.zhihu.com/p/${articleId}`); await s.run('like', b.args);
  expect(s.requests.at(-1).url.pathname).toBe(`/api/v4/articles/${articleId}/voters`);
  expect((await s.read('pins', args))[0].url).toBe('https://www.zhihu.com/pin/123');
  expect(s.catalog.resultBindings.get('zhihu.com.pins').results[0].actions).toEqual([]);
});
it.each([
  ['like', 0, {}, `/api/v4/answers/${aid}/voters`],
  ['favorite', 0, { collection: 'Example collection' }, '/api/v4/favlists/7654321/items'],
  ['comment', 0, { text: 'Example comment' }, `/api/v4/answers/${aid}/comments`],
  ['follow', 1, {}, `/api/v4/questions/${qid}/followers`],
  ['answer', 1, { text: 'Example reply' }, `/api/v4/questions/${qid}/answers`],
])('%s executes its bound target through the actual mocked write handler', async (action, row, input, endpoint) => {
  const s = setup(), args = { query: 'Example' }, raw = await s.read('search', args), b = binding(s, 'search', args, raw, action, row);
  const result = await s.run(action, { ...b.args, ...input });
  expect(result[0].status).toBe('success'); expect(s.requests.at(-1).url.pathname).toBe(endpoint); expect(s.requests.at(-1).options.method).toBe('POST');
  const body = JSON.parse(s.requests.at(-1).options.body || '{}');
  if (input.text) expect(body.content).toBe(input.text);
  if (action === 'favorite') expect(body).toEqual({ item_id: aid, item_type: 'answer' });
});
it('comment input clarification survives serialization without changing its selected answer', async () => {
  const s = setup(), args = { query: 'Example' }, raw = await s.read('search', args), { state } = capture(s, 'search', args, raw);
  const pending = await routeContext(state, '发表评论第三条', { catalog: s.catalog, now: 1001 });
  expect(pending.missingFields).toEqual(['arguments.text']);
  const result = await routeContext(JSON.parse(JSON.stringify(state)), 'Example continuation', { catalog: s.catalog, now: 1002, replyTo: pending.clarificationId });
  expect(result.steps[0]).toMatchObject({ tool: 'zhihu.com.comment', args: { target: answerUrl, execute: true, text: 'Example continuation' } });
  await s.run('comment', result.steps[0].args); expect(JSON.parse(s.requests.at(-1).options.body).content).toBe('Example continuation');
});
it('missing author cannot be replaced by its display name', async () => {
  const s = setup({ noAuthor: true }), raw = await s.read('answer-detail', { id: aid });
  expect(binding(s, 'answer-detail', { id: aid }, raw, 'author').ready).toBe(false);
});
it('an answer without its question stays readable but cannot prepare unusable write targets', async () => {
  const s = setup({ noQuestion: true }), args = { id: aid }, raw = await s.read('answer-detail', args);
  expect(raw[0]).toMatchObject({ url: `https://www.zhihu.com/answer/${aid}`, context_write_target: null, content: 'Example answer body' });
  expect(binding(s, 'answer-detail', args, raw, 'comments').ready).toBe(true);
  for (const action of ['like', 'favorite', 'comment']) expect(binding(s, 'answer-detail', args, raw, action).ready).toBe(false);
  const { state } = capture(s, 'answer-detail', args, raw);
  const result = await routeContext(state, '点赞第一条', { catalog: s.catalog, now: 1001 });
  expect(result.kind).not.toBe('resolved');
  expect(s.requests.every(r => r.options.method !== 'POST')).toBe(true);
});
it('duplicate collection names stop before a write', async () => {
  const s = setup({ duplicateCollection: true });
  await expect(s.run('favorite', { target: answerUrl, execute: true, collection: 'Example collection' })).rejects.toThrow(/ambiguous/);
  expect(s.requests.every(r => r.options.method !== 'POST')).toBe(true);
});
it('download is a write and preparation never exports or automatically replays', async () => {
  const s = setup(); expect(s.entries.find(c => c.id === 'download').safety).toBe('write');
  expect(await s.run('download', { url: answerUrl, output: './example-export' })).toMatchObject({ __webcli_navigation: { resume: false, result: { status: 'prepared' } } });
  expect(s.requests).toHaveLength(0); expect(s.helpers).toHaveLength(0);
});
