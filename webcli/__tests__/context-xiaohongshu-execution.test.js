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
import { decorateResults } from '../scripts/opencli-xiaohongshu/context-results.js';

const root = resolve(import.meta.dirname, '../../adapters/xiaohongshu.com');
const web = 'https://www.xiaohongshu.com', creator = 'https://creator.xiaohongshu.com';
const ids = ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'], uid = 'cccccccccccccccccccccccc';
const noteUrl = id => `${web}/explore/${id}?xsec_token=fixture-${id}&xsec_source=pc_search`;
function setup(url = web + '/explore', values = [], privileged) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), calls = [], queue = [...values], storage = new Map();
  const context = { URL, Map, Set, console, location: new URL(url), setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      calls.push({ action, args });
      const supplied = await privileged?.(action, args); if (supplied !== undefined) return supplied;
      if (action === 'main_world_eval') return { value: { ok: true, value: queue.shift() } };
      if (action === 'network_capture_read') return { entries: [] };
      if (action === 'cookies_get') return { cookies: [] };
      return { success: true };
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const c of pkg.commands) vm.runInContext(readFileSync(resolve(root, c.module), 'utf8'), context);
  const entries = pkg.commands.map(c => ({ ...c, adapterId: pkg.name, sourceFingerprint: 'fixture-package' }));
  const catalog = { entries, tools: {}, resultBindings: compileResultBindings(entries) };
  return { pkg, context, calls, queue, catalog, run: (name, args = {}) => handlers.get('xiaohongshu.com.' + name)(args) };
}
function bound(s, name, args, raw) { return extractBoundEntities(s.catalog.resultBindings.get('xiaohongshu.com.' + name), args, raw); }
async function route(s, name, args, raw, text) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: 'xiaohongshu.com.' + name, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state); registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return routeContext(state, text, { catalog: s.catalog, now: 1001 });
}
it('executes feed -> displayed second note -> actual detail and comments bindings without losing signed parameters or full content', async () => {
  const s = setup(web + '/explore', [{ items: ids.map((id, i) => ({ id, title: 'Title ' + i, author: 'Example', xsecToken: 'fixture-' + id, likes: '0' })) }]);
  const rows = await s.run('feed', { limit: 2 });
  const plan = await route(s, 'feed', { limit: 2 }, rows, '查看第二条');
  expect(plan.steps[0]).toMatchObject({ tool: 'xiaohongshu.com.note', args: { 'note-id': rows[0].url } });
  expect(new URL(plan.steps[0].args['note-id']).searchParams.get('xsec_token')).toBe('fixture-' + ids[0]);
  s.context.location = new URL(rows[0].url); s.queue.push({ title: 'Full note', author: 'Example', desc: '正文'.repeat(1000), likes: '3' });
  const detail = await s.run('note', plan.steps[0].args);
  expect(detail.find(r => r.field === 'content').value).toBe('正文'.repeat(1000));
  const title = bound(s, 'note', plan.steps[0].args, detail).entities[0];
  expect(title.bindings.comments).toMatchObject({ ready: true, args: { 'note-id': rows[0].url } });
  expect(bound(s, 'note', plan.steps[0].args, detail).entities[1].bindings).toEqual({});
  s.queue.push({ results: [{ author: 'Example', authorHrefRaw: '/user/profile/' + uid, text: 'Comment', likes: '0', time: '', is_reply: false, reply_to: '' }] });
  const comments = await s.run('comments', title.bindings.comments.args);
  expect(bound(s, 'comments', title.bindings.comments.args, comments).entities[0].bindings.detail).toMatchObject({ ready: true, args: { id: uid } });
});
it.each(['note', 'open-note'])('%s retains the signed target on the title row, with no repeated actions on numeric fields', async name => {
  const s = setup(noteUrl(ids[0]), [{ title: 'Example', author: 'Author', desc: 'Body', comments: '2' }]);
  const args = name === 'note' ? { 'note-id': noteUrl(ids[0]) } : { url: noteUrl(ids[0]) };
  const raw = await s.run(name, args), entities = bound(s, name, args, raw).entities;
  expect(entities[0].bindings.like).toMatchObject({ ready: true, args: { id: ids[0], url: noteUrl(ids[0]), confirm: true } });
  expect(entities.slice(1).every(e => !Object.keys(e.bindings).length)).toBe(true);
});
it.each(['comments', 'read-comments'])('%s routes an actual comment author and refuses unknown author identity', async name => {
  const rows = [{ author: 'Known', authorHrefRaw: '/user/profile/' + uid, text: 'First', likes: '0', time: '', is_reply: false, reply_to: '' },
    { author: 'Unknown display name', text: 'Second', likes: '0', time: '', is_reply: false, reply_to: '' }];
  const s = setup(noteUrl(ids[0]), [{ results: rows }]);
  const args = name === 'comments' ? { 'note-id': noteUrl(ids[0]) } : { url: noteUrl(ids[0]) };
  const raw = await s.run(name, args), entities = bound(s, name, args, raw).entities;
  expect(entities[0].bindings.follow).toMatchObject({ ready: true, args: { 'user-id': uid } });
  expect(entities[1].bindings.detail.ready).toBe(false);
  const result = await route(s, name, args, raw, '查看第二条');
  expect(result.steps[0]).toMatchObject({ tool: 'xiaohongshu.com.user', args: { id: uid } });
});
it('routes real local drafts with encoded identity and type, then executes the selected mock deletion', async () => {
  const url = creator + '/publish/publish?from=menu_left&target=image';
  const entries = { ok: true, entries: [{ key: 12, row: { title: 'First' } }, { key: 'draft-2', row: { title: 'Second' } }] };
  const s = setup(url, [entries]);
  const rows = await s.run('drafts', { type: 'image' }), plan = await route(s, 'drafts', { type: 'image' }, rows, '查看第二条');
  expect(plan.steps[0]).toMatchObject({ tool: 'xiaohongshu.com.draft-open', args: { id: 'n:12', type: 'image' } });
  s.queue.push(entries); const detail = await s.run('draft-open', plan.steps[0].args);
  const deletion = bound(s, 'draft-open', plan.steps[0].args, detail).entities[0].bindings.delete;
  expect(deletion).toMatchObject({ ready: true, args: { id: 'n:12', type: 'image', execute: true } });
  s.queue.push(entries, { ok: true, deleted: true });
  expect((await s.run('draft-delete', deletion.args))[0].status).toBe('deleted');
});
it.each(['whoami', 'check-login-status'])('%s obtains server identity and declares independent account queries', async name => {
  const s = setup(creator + '/new/home', [{ data: { name: 'Example account', fans_count: 0 } }]);
  const raw = await s.run(name), entity = bound(s, name, {}, raw).entities[0];
  expect(raw.followers).toBe(0); expect(entity.bindings.detail).toMatchObject({ ready: true, tool: 'xiaohongshu.com.creator-notes', args: {} });
  expect(entity.bindings.stats.ready).toBe(true); expect(entity.bindings.drafts.ready).toBe(true);
});
it.each(['feed', 'search', 'search-notes', 'liked', 'saved', 'user'])('%s package mappings reject unsigned, mismatched and spoofed note provenance', name => {
  const s = setup();
  for (const url of [web + '/explore/' + ids[0], noteUrl(ids[1]), 'https://www.xiaohongshu.com.example.org/explore/' + ids[0] + '?xsec_token=fixture']) {
    const raw = decorateResults(name === 'search-notes' ? 'search' : name, {}, [{ id: ids[0], title: 'Example', url }]);
    expect(Object.values(bound(s, name, {}, raw).entities[0].bindings).every(b => !b.ready)).toBe(true);
  }
});
it('public note queries never expose deletion, while creator works bind their own exact note ID', () => {
  const s = setup();
  for (const name of ['creator-notes', 'creator-notes-summary']) {
    const raw = decorateResults(name, {}, [{ id: ids[0], title: 'Owned note', url: web + '/explore/' + ids[0] }]);
    const b = bound(s, name, {}, raw).entities[0].bindings;
    expect(b.detail).toMatchObject({ ready: true, args: { 'note-id': ids[0] } });
    expect(b.delete).toMatchObject({ ready: true, args: { 'note-id': ids[0], execute: true } });
  }
  expect(bound(s, 'feed', {}, decorateResults('feed', {}, [{ id: ids[0], title: 'Public', url: noteUrl(ids[0]) }])).entities[0].bindings).not.toHaveProperty('delete');
});
it('a notification retains actual author identity instead of using the display name', async () => {
  const s = setup(web + '/notification', [true], action => action === 'network_capture_read' ? { entries: [{ responseStatus: 200,
    responsePreview: JSON.stringify({ data: { message_list: [{ title: 'Liked', user_info: { nickname: 'Example', user_id: uid } }, { title: 'System notice' }] } }) }] } : undefined);
  const raw = await s.run('notifications', { type: 'likes' }), entities = bound(s, 'notifications', { type: 'likes' }, raw).entities;
  expect(entities[0].bindings.detail).toMatchObject({ ready: true, args: { id: uid } });
  expect(entities[1].bindings.detail.ready).toBe(false);
});
it('rejects a legacy action with a different id and signed URL before navigating or clicking', async () => {
  const s = setup(noteUrl(ids[0]));
  await expect(s.run('like-note', { id: ids[1], url: noteUrl(ids[0]), confirm: true })).rejects.toThrow('does not match');
  expect(s.calls).toHaveLength(0);
});
it('every read command is explicitly classified and terminal results explain their capability boundary', () => {
  const s = setup();
  for (const c of s.pkg.commands.filter(c => c.safety === 'read')) {
    expect(c.results, c.id).toBeDefined();
    for (const r of c.results) if (!r.actions.length) expect(r.reason.length).toBeGreaterThan(20);
  }
});
it.each(['creator-notes', 'creator-notes-summary', 'creator-note-detail'])('%s executes its signed-capture parser before binding owned actions', async name => {
  const capture = { '/api/galaxy/creator/datacenter/note/analyze/list': { ok: true, status: 200,
    body: JSON.stringify({ data: { total_count: 2, note_infos: ids.map((id, i) => ({ id, title: 'Owned ' + i, read_count: 3 })) } }) } };
  const dom = { title: 'Owned detail', infoText: '2026-11-01 12:00', sections: [{ title: '基础数据', metrics: [{ label: '观看数', value: '3', extra: '' }] }] };
  const s = setup(creator + '/statistics', [], (action, args) => {
    if (action !== 'main_world_eval') return;
    const code = args.expression;
    let result;
    if (code.includes('JSON.stringify(window.__xhsCapture')) result = JSON.stringify(capture);
    if (code.includes("document.querySelector('.note-title')")) result = dom;
    return { value: { ok: true, value: result } };
  });
  const args = name === 'creator-note-detail' ? { 'note-id': ids[0] } : { limit: 2 };
  const raw = await s.run(name, args), entities = bound(s, name, args, raw).entities;
  expect(raw.length).toBeGreaterThan(0);
  expect(entities[0].bindings.delete).toMatchObject({ ready: true, args: { 'note-id': ids[0], execute: true } });
  if (name === 'creator-note-detail') {
    expect(raw.find(r => r.metric === '观看数').value).toBe('3');
    expect(entities[1].bindings).toEqual({});
  } else {
    const plan = await route(s, name, args, raw, '查看第二条');
    expect(plan.steps[0]).toMatchObject({ tool: 'xiaohongshu.com.creator-note-detail', args: { 'note-id': ids[0] } });
  }
});
it.each(['creator-profile', 'creator-stats'])('%s executes the account API parser and keeps aggregate fields terminal', async name => {
  const data = name === 'creator-profile' ? { data: { name: 'Example', fans_count: 0 } }
    : { data: { seven: { view_count: 0, view_list: [{ count: 0 }] } } };
  const s = setup(creator + '/new/home', [data]), raw = await s.run(name);
  expect(raw.length).toBeGreaterThan(0); expect(bound(s, name, {}, raw)).toBeNull();
  if (name === 'creator-stats') expect(raw.find(r => r.metric.includes('views')).total).toBe(0);
});
it('home navigation is a receipt, and the actual feed query is a separate call', async () => {
  const s = setup(), raw = await s.run('navigate-to-homepage');
  expect(raw).toMatchObject({ __webcli_navigation: { resume: false, result: { status: 'opened' } } });
  expect(bound(s, 'navigate-to-homepage', {}, raw)).toBeNull();
});
it('user reads real hydrated rows and preserves the signed profile-note path', async () => {
  const args = { id: uid, limit: 2 };
  const s = setup(web + '/user/profile/' + uid, [{ storePresent: true, notesPresent: true,
    noteGroups: [ids.map((id, i) => ({ id, noteCard: { noteId: id, title: 'Note ' + i, user: { userId: uid } }, xsecToken: 'fixture-' + id }))] }]);
  const raw = await s.run('user', args), b = bound(s, 'user', args, raw).entities[0].bindings;
  expect(b.detail.ready).toBe(true); expect(b.like.ready).toBe(true);
  expect(new URL(b.detail.args['note-id']).pathname).toBe('/user/profile/' + uid + '/' + ids[0]);
});
it.each(['liked', 'saved'])('%s consumes scoped network captures and retains signed note links', async name => {
  const s = setup(web + '/user/profile/' + uid, [false, { hostname: 'www.xiaohongshu.com', pathname: '/user/profile/' + uid }],
    action => action === 'network_capture_read' ? { entries: [{ responseStatus: 200, responsePreview: JSON.stringify({ data: {
      notes: ids.map((id, i) => ({ id, xsec_token: 'fixture-' + id, note_card: { title: 'Example ' + i, user: { user_id: uid } } })),
    } }) }] } : undefined);
  const args = { id: uid, limit: 2 };
  // The collection tab is selected through the ordinary host navigation continuation.
  const navigation = await s.run(name, args);
  expect(navigation.__webcli_navigation.resume).toBe(true);
  s.context.location = new URL(navigation.__webcli_navigation.url);
  const raw = await s.run(name, args), plan = await route(s, name, args, raw, '查看第二条');
  expect(plan.steps[0].args['note-id']).toContain('xsec_token=fixture-' + ids[0]);
});
it.each(['search', 'search-notes'])('%s executes the actual search parser and routes the displayed note with its complete signed URL', async name => {
  const rawRows = ids.map((id, i) => ({ title: 'Search ' + i, author: 'Example', likes: '0', url: noteUrl(id), author_url: web + '/user/profile/' + uid }));
  const harvest = { rows: rawRows, diag: { securityBlock: false, stopReason: 'target', scrollHeight: 1000, clientHeight: 800, cardCount: 2, feedClientHeight: 800, distinctCardTops: 2 } };
  const s = setup(web + '/search_result?keyword=Example&source=web_search_result_notes', ['content', { status: 'ok' }, harvest]);
  const args = name === 'search' ? { query: 'Example', limit: 2 } : { keyword: 'Example', limit: 2 };
  const raw = await s.run(name, args), plan = await route(s, name, args, raw, '查看第二条');
  expect(plan.steps[0]).toMatchObject({ tool: 'xiaohongshu.com.note', args: { 'note-id': noteUrl(ids[0]) } });
});
it('an owned note deletion executes the bound note ID and verifies disappearance', async () => {
  const url = creator + '/new/note-manager';
  const s = setup(url, [url, true, { ok: true }, { ok: true }, false]);
  const raw = decorateResults('creator-notes', {}, [{ id: ids[0], title: 'Owned note' }]);
  const deletion = bound(s, 'creator-notes', {}, raw).entities[0].bindings.delete;
  expect((await s.run('delete-note', deletion.args))[0]).toMatchObject({ status: 'deleted', note_id: ids[0] });
  expect(s.calls.some(c => c.action === 'main_world_eval' && c.args.expression.includes(ids[0]))).toBe(true);
});
