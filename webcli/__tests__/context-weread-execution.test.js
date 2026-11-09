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

const root = resolve(import.meta.dirname, '../../adapters/weread.qq.com');
function setup() {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), requests = [];
  const books = [101, 102].map(bookId => ({ bookId, title: `Book ${bookId}`, author: 'Example', bookInfo: { bookId, title: `Book ${bookId}`, author: 'Example' }, book: { title: `Book ${bookId}`, author: 'Example' } }));
  const payload = url => {
    const u = new URL(url, 'https://weread.qq.com'); requests.push(u);
    if (u.pathname === '/web/search/books') return '';
    if (u.pathname === '/book/info') return { title: 'Book 101', author: 'Example' };
    if (u.pathname === '/review/list') return { reviews: [{ review: { content: 'Full note', chapterName: 'Chapter' } }] };
    if (u.pathname === '/book/bookmarklist') return { updated: [{ markText: 'Highlight', chapterName: 'Chapter' }] };
    if (u.pathname === '/web/user') return { userVid: 123, name: 'Example' };
    return { books };
  };
  const context = { URL, URLSearchParams, console, setTimeout: callback => { callback(); return 1; }, clearTimeout,
    location: new URL('https://weread.qq.com/'), document: { cookie: 'wr_vid=123' },
    sessionStorage: { removeItem() {}, getItem() { return null; }, setItem() {} },
    fetch: async url => ({ ok: true, status: 200, json: async () => payload(url) }),
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      if (action === 'cookies_get') return [{ name: 'wr_vid', value: '123' }];
      if (action === 'main_world_eval') return { value: await vm.runInContext(args.expression, context) };
      if (action === 'backend_fetch') {
        const data = payload(args.url);
        return { ok: true, status: 200, url: args.url, body: typeof data === 'string' ? data : JSON.stringify(data) };
      }
      throw new Error(`Unexpected helper: ${action}`);
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { requests, catalog: { tools: {}, resultBindings: compileResultBindings(entries) }, run: (name, args = {}) => handlers.get(`weread.qq.com.${name}`)(args) };
}

async function displayed(s, command, args) {
  const raw = await s.run(command, args), state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `weread.qq.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(entity => entity.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return { state, single: snapshot.entities.length === 1, raw };
}

it.each([
  ['search', { query: 'Example' }, 'book', { 'book-id': 101 }],
  ['ranking', {}, 'book', { 'book-id': 101 }],
  ['shelf', {}, 'book', { 'book-id': 101 }],
  ['notebooks', {}, 'notes', { 'book-id': 101 }],
  ['book', { 'book-id': 101 }, 'notes', { 'book-id': '101' }],
  ['whoami', {}, 'shelf', {}],
])('%s executes the source and default follow-up while retaining the raw book ID', async (command, args, target, expected) => {
  const s = setup(), { state, single } = await displayed(s, command, args);
  const result = await routeContext(state, single ? '查看这条' : '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.kind).toBe('resolved'); expect(result.steps[0]).toMatchObject({ tool: `weread.qq.com.${target}`, args: expected });
  const raw = await s.run(target, result.steps[0].args);
  expect(raw.length).toBeGreaterThan(0);
  if (expected['book-id']) expect(s.requests.at(-1).searchParams.get('bookId')).toBe('101');
});

it('book-search asks only for the search text and retains the selected numeric ID', async () => {
  const s = setup(), { state } = await displayed(s, 'shelf', {});
  const question = await routeContext(state, '书内搜索第二条', { catalog: s.catalog, now: 1001 });
  expect(question.missingFields).toEqual(['arguments.query']);
  const result = await routeContext(state, 'Example query', { catalog: s.catalog, now: 1002, replyTo: question.clarificationId });
  expect(result.steps[0]).toMatchObject({ tool: 'weread.qq.com.book-search', args: { book: 101, query: 'Example query' } });
});

it.each(['highlights', 'outline', 'notes'])('shelf exposes the %s alternative using the same selected book', async actionId => {
  const s = setup(), raw = await s.run('shelf');
  const extracted = extractBoundEntities(s.catalog.resultBindings.get('weread.qq.com.shelf'), {}, raw);
  expect(extracted.entities[0].bindings[actionId]).toMatchObject({ ready: true, args: { 'book-id': 101 } });
});
