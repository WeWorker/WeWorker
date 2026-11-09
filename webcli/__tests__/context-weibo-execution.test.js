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
const root = resolve(import.meta.dirname, '../../adapters/weibo.com');
const uid = '1234567890', id = '1937205528846655537', key = 'ExamplePost1';
const text = 'Example complete post ' + '内容'.repeat(200);
function setup({ unsafeId = false, noAuthorId = false, favoriteUrl = true, deleteFailure = false } = {}) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), requests = [], helpers = [], storage = new Map(); let deleted = false;
  const user = { id: Number(uid), screen_name: 'Example person', profile_url: '/u/' + uid };
  const post = { idstr: id, mblogid: key, text_raw: text, created_at: '2026-11-01', user };
  const app = { __vue_app__: { config: { globalProperties: { $store: { state: { config: { config: { uid, user } } } } } } } };
  const searchCard = { querySelector: s => s.includes('content') || s === '.txt' ? { textContent: 'Example search post' } : s.includes('name') ? { textContent: user.screen_name } : { getAttribute: () => `https://weibo.com/${uid}/${key}`, textContent: '2026-11-01' } };
  const favorite = { innerText: 'Example person\nExample favorite post text with enough visible content\n10:30', querySelector: () => null,
    querySelectorAll: () => favoriteUrl ? [{ href: `https://weibo.com/${uid}/${key}` }] : [] };
  const context = { URL, URLSearchParams, console, Date, location: new URL('https://weibo.com/'),
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {}, scrollBy() {},
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    document: { body: { innerText: '' }, title: 'Example', cookie: 'XSRF-TOKEN=example-csrf-placeholder',
      querySelector: s => s === '#app' ? app : null, querySelectorAll: s => s === '.card-wrap' ? [searchCard] : s.includes('scroller') ? [favorite] : [] },
    fetch: async (input, options = {}) => {
      const url = new URL(input, context.location.href); requests.push({ url, options }); let payload, status = 200;
      if (url.pathname === '/ajax/statuses/destroy') { if (!deleteFailure) deleted = true; payload = { ok: deleteFailure ? 0 : 1, msg: deleteFailure ? 'not permitted' : '' }; }
      else if (url.pathname === '/ajax/statuses/show') { if (deleted) { status = 404; payload = {}; } else payload = post; }
      else if (url.pathname.includes('timeline')) payload = { ok: 1, statuses: [{ ...post, ...(unsafeId ? { idstr: undefined, id: Number(id) } : {}), ...(noAuthorId ? { user: { screen_name: user.screen_name } } : {}) }, { ...post, idstr: '1937205528846655599', mblogid: 'ExamplePost2' }] };
      else if (url.pathname.includes('buildComments')) payload = { ok: 1, data: [{ idstr: '987654321', user, text: '<p>Example comment</p>', like_count: 1 }] };
      else if (url.pathname === '/ajax/statuses/hot_band') payload = { ok: 1, data: { band_list: [{ word: 'Example topic', num: 10 }] } };
      else if (url.pathname === '/ajax/profile/info') payload = { ok: 1, data: { user } };
      else if (url.pathname === '/ajax/profile/detail') payload = { ok: 1, data: {} };
      else if (url.pathname === '/ajax/statuses/searchProfile') payload = { ok: 1, data: { list: [post] } };
      else if (url.pathname === '/ajax/config/get_config') payload = { ok: 1, data: { uid } };
      else throw new Error(`Unexpected request: ${url.pathname}`);
      return { ok: status === 200, status, json: async () => payload, text: async () => JSON.stringify(payload) };
    }, __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      helpers.push({ action, args });
      if (action === 'main_world_eval') return { value: await vm.runInContext(args.expression, context) };
      if (action === 'cookies_get') return [{ name: 'SUB', value: 'example-placeholder' }, { name: 'SUBP', value: 'example-placeholder' }];
      throw new Error(`Unexpected helper: ${action}`);
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const f of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', f), 'utf8'), context);
  for (const c of pkg.commands) vm.runInContext(readFileSync(resolve(root, c.module), 'utf8'), context);
  const entries = pkg.commands.map(c => ({ ...c, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  const run = (name, args = {}) => handlers.get(`weibo.com.${name}`)(args);
  return { context, requests, helpers, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run,
    read: async (name, args = {}) => { for (let i = 0; i < 4; i++) { const raw = await run(name, args); if (!raw.__webcli_navigation?.resume) return raw; context.location = new URL(raw.__webcli_navigation.url); } throw new Error('Unexpected navigation loop'); } };
}
function binding(s, command, args, raw, action, row = 0) { return extractBoundEntities(s.catalog.resultBindings.get(`weibo.com.${command}`), args, raw).entities[row].bindings[action]; }
function capture(s, command, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `weibo.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state); registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true }); return { state, snapshot };
}
it.each([
  ['feed', {}, 'detail', 'post', { id: key }],
  ['search', { keyword: 'Example' }, 'detail', 'post', { id: key }],
  ['favorites', {}, 'detail', 'post', { id: key }],
  ['user-posts', { id: uid }, 'detail', 'post', { id }],
  ['post', { id: key }, 'comments', 'comments', { id }],
  ['comments', { id }, 'author', 'user', { id: uid }],
  ['hot', {}, 'search', 'search', { keyword: 'Example topic' }],
  ['user', { id: uid }, 'detail', 'user-posts', { id: uid }],
  ['me', {}, 'detail', 'user-posts', { id: uid }],
  ['whoami', {}, 'detail', 'user', { id: uid }],
])('%s executes its source and routes the displayed object to its real follow-up', async (command, args, action, target, expected) => {
  const s = setup(), raw = await s.read(command, args), b = binding(s, command, args, raw, action), { state, snapshot } = capture(s, command, args, raw);
  expect(b).toMatchObject({ ready: true, tool: `weibo.com.${target}`, args: expected });
  const result = await routeContext(state, snapshot.entities.length === 1 ? `${snapshot.actions.find(a => a.id === action).label}这条` : '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: b.tool, args: expected });
  const next = await s.read(target, result.steps[0].args); expect(Array.isArray(next) ? next.length > 0 : !!next).toBe(true);
});
it('post remains a full structured entity and bounds only its selection title', async () => {
  const s = setup(), [row] = await s.read('post', { id });
  expect(row).toMatchObject({ id, author_uid: uid, text }); expect(Buffer.byteLength(row.context_title)).toBeLessThanOrEqual(240);
  expect(binding(s, 'post', { id }, [row], 'comments').args.id).toBe(id);
});
it('comments link to their original post rather than treating comment rank as a post ID', async () => {
  const s = setup(), args = { id }, raw = await s.read('comments', args), b = binding(s, 'comments', args, raw, 'post');
  expect(b.args).toEqual({ id }); expect((await s.read('post', b.args))[0].id).toBe(id);
});
it('unsafe numeric post IDs and absent author IDs cannot become actionable identities', async () => {
  const s = setup({ unsafeId: true, noAuthorId: true }), raw = await s.read('feed');
  expect(binding(s, 'feed', {}, raw, 'detail').ready).toBe(true);
  for (const action of ['comments', 'delete', 'author']) expect(binding(s, 'feed', {}, raw, action).ready).toBe(false);
});
it('favorites without a real post URL never bind the favorites page as a post', async () => {
  const s = setup({ favoriteUrl: false }), raw = await s.read('favorites');
  expect(raw.length).toBe(1); expect(binding(s, 'favorites', {}, raw, 'detail').ready).toBe(false);
});
it('delete resolves the bound post and verifies disappearance through the mocked API', async () => {
  const s = setup(), raw = await s.read('feed'), b = binding(s, 'feed', {}, raw, 'delete');
  expect(await s.run('delete', b.args)).toMatchObject([{ status: 'deleted', id }]);
  const write = s.requests.find(r => r.options.method === 'POST'); expect(write.url.pathname).toBe('/ajax/statuses/destroy'); expect(new URLSearchParams(write.options.body).get('id')).toBe(id);
});
it('a denied delete is reported as failure rather than a successful action', async () => {
  const s = setup({ deleteFailure: true }); await expect(s.run('delete', { id })).rejects.toThrow(/not permitted/);
});
