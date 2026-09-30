import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-v2.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { managedAdapterSkill } from '../adapter-views.js';
import { validateCreatorCaptures } from '../scripts/opencli-xiaohongshu/creator-capture.js';
const root = resolve(import.meta.dirname, '../..');
const base = resolve(root, 'adapters/xiaohongshu.com');
const WEB = 'https://www.xiaohongshu.com';
const CREATOR = 'https://creator.xiaohongshu.com';
const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NOTE = `${WEB}/explore/${ID}?xsec_token=fixture-token`;
const PUBLISH = `${CREATOR}/publish/publish?from=menu_left&target=image`;
function setup(url = WEB + '/explore', values = [], privileged) {
  const pkg = validateV2AdapterDir(base), handlers = new Map(), calls = [], storage = new Map();
  const queue = [...values];
  const ctx = { URL, Map, Set, console, location: new URL(url), setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      calls.push({ action, ...args });
      if (privileged) { const result = await privileged(action, args); if (result !== undefined) return result; }
      if (action === 'main_world_eval') return { value: { ok: true, value: queue.shift() } };
      if (action === 'network_capture_read') return { entries: [] };
      if (action === 'cookies_get') return { cookies: [] };
      return { success: true };
    } },
  };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(buildV2Bootstrap(pkg.manifest), ctx);
  for (const file of readdirSync(resolve(base, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(base, 'extension/internal', file), 'utf8'), ctx);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(base, command.module), 'utf8'), ctx);
  return { pkg, ctx, calls, queue, storage, run: async (name, args = {}) => handlers.get('xiaohongshu.com.' + name)(args) };
}
describe('Xiaohongshu v2 migration contracts', () => {
  it('registers all 25 upstream commands, seven local/compatibility entries and derived guidance', () => {
    const s = setup();
    expect(s.pkg.commands).toHaveLength(32);
    expect(s.ctx.__xhsOpenCLI.commands.size).toBe(25);
    expect(managedAdapterSkill({ ...s.pkg.manifest, id: s.pkg.manifest.name, tools: [], guidance: readFileSync(resolve(base, 'guidance.md'), 'utf8') })).toContain('xsec_token');
    for (const cmd of s.pkg.commands.filter(c => c.safety === 'write' && !['like-note', 'favorite-note'].includes(c.id))) expect(cmd.requires_confirmation).toBe(true);
    expect(s.pkg.manifest.verified_on).toBeUndefined();
  });
  it('continues a read after host navigation without evaluating the wrong page', async () => {
    const s = setup();
    const result = await s.run('search', { query: 'fixture', limit: '2' });
    expect(result.__webcli_navigation).toMatchObject({ version: 1, resume: true });
    expect(new URL(result.__webcli_navigation.url).searchParams.get('keyword')).toBe('fixture');
    expect(s.calls).toHaveLength(0);
  });
  it('ends write navigation without publishing, deleting or replaying', async () => {
    for (const [name, args] of [['follow', { 'user-id': ID }], ['delete-note', { 'note-id': ID, execute: 'true' }], ['publish', { title: 'Fixture', content: 'Fixture body', 'card-text': 'Fixture card' }], ['draft-delete', { id: 'fixture' }]]) {
      const s = setup();
      const result = await s.run(name, { ...args, __confirmed: true });
      expect(result.__webcli_navigation).toMatchObject({ resume: false, result: { executed: false } });
      expect(s.calls.filter(x => x.action === 'main_world_eval')).toHaveLength(0);
    }
  });
  it.each(['publish', 'delete-note', 'draft-clear', 'follow', 'ask'])('guards %s before helper calls', async name => {
    const s = setup();
    await expect(s.run(name, { title: 'Fixture', content: 'Body', query: 'Fixture', 'note-id': ID, 'user-id': ID })).rejects.toThrow();
    expect(s.calls).toHaveLength(0);
  });
  it.each([0, -1, 1.2, true, '', '1e2', '101', null])('rejects invalid limits %s before navigation', async limit => {
    const s = setup(); await expect(s.run('search', { query: 'fixture', limit })).rejects.toMatchObject({ code: 'ARGUMENT' }); expect(s.calls).toHaveLength(0);
  });
  it.each(['false-ish', 0, 1, null])('rejects ambiguous boolean %s', async execute => {
    const s = setup(); await expect(s.run('delete-note', { 'note-id': ID, execute, __confirmed: true })).rejects.toMatchObject({ code: 'ARGUMENT' }); expect(s.calls).toHaveLength(0);
  });
  it('converts false string to dry-run false rather than truthy execute', () => {
    const s = setup(); const cmd = s.ctx.__xhsOpenCLI.commands.get('delete-note');
    expect(s.ctx.__xhsOpenCLI.normalizeArgs(cmd, { 'note-id': ID, execute: 'false' }).execute).toBe(false);
  });
  it.each([ID, `https://example.org/explore/${ID}?xsec_token=fixture`, `${WEB}/explore/${ID}`, `https://user:pass@www.xiaohongshu.com/explore/${ID}?xsec_token=fixture`, `http://www.xiaohongshu.com/explore/${ID}?xsec_token=fixture`])('rejects unsafe/unsigned note URL %s', async url => {
    const s = setup(); await expect(s.run('note', { 'note-id': url })).rejects.toMatchObject({ code: 'ARGUMENT' }); expect(s.calls).toHaveLength(0);
  });
  it('keeps signed URLs and returns note interaction fields', async () => {
    const s = setup(NOTE, [{ title: 'Fixture', author: 'Fixture author', desc: 'Body', likes: '12', collects: '收藏', comments: '3', tags: ['fixture'] }]);
    const rows = await s.run('note', { 'note-id': NOTE });
    expect(rows).toContainEqual({ field: 'collects', value: '0' });
    expect(rows).toContainEqual({ field: 'tags', value: 'fixture' });
  });
  it('retains signed feed URLs and refuses malformed empty-store payloads', async () => {
    const s = setup(WEB + '/explore', [{ items: [{ id: ID, title: 'Fixture', author: 'Fixture', xsecToken: 'fixture-token', likes: '0' }] }]);
    expect((await s.run('feed', { limit: '1' }))[0].url).toContain('xsec_token=fixture-token');
    await expect(setup(WEB + '/explore', [{ items: {} }]).run('feed')).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
  it('uses server identity, never cookie presence as proof of login', async () => {
    const s = setup(CREATOR + '/new/home', [{ data: { name: 'Fixture creator', fans_count: 0 } }]);
    expect(await s.run('check-login-status')).toMatchObject({ logged_in: true, followers: 0 });
    await expect(setup(CREATOR + '/new/home', [{ auth: true }]).run('whoami')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('keeps Chinese legacy filter mappings and new limit', async () => {
    const s = setup(); let captured;
    s.ctx.__xhsOpenCLI = { invoke: async (name, args) => { captured = { name, args }; return []; } };
    await s.run('search-notes', { keyword: 'Fixture', sortBy: '最多收藏', noteType: '图文', publishTime: '一周内', searchScope: '已关注', location: '同城', limit: '5' });
    expect(captured).toMatchObject({ name: 'search', args: { query: 'Fixture', sort: 'most-collected', 'note-type': 'image', 'publish-time': 'week', scope: 'following', location: 'same-city', limit: '5' } });
  });
  it('does not silently swallow evaluation exceptions', async () => {
    const s = setup(NOTE, [], action => action === 'main_world_eval' ? { value: { ok: false, message: 'fixture failure' } } : undefined);
    await expect(s.run('note', { 'note-id': NOTE })).rejects.toThrow('fixture failure');
  });
  it('unwraps actual main-world functions and async IIFEs', async () => {
    const s = setup(); s.ctx.__webmcpWecliRuntime.requestPrivileged = async (_, args) => ({ value: await vm.runInContext(args.expression, s.ctx) });
    const p = new s.ctx.__xhsOpenCLI.Page({ name: 'fixture', access: 'read' }, {});
    expect(await p.evaluate('async () => ({ count: 2 })')).toEqual({ count: 2 });
    expect(await p.evaluate('(async () => 3)()')).toBe(3);
    await expect(p.evaluate('() => { throw new Error("failed") }')).rejects.toThrow('failed');
  });
  it('decodes real runtime capture responsePreview and rejects truncation', async () => {
    let entry = { responseStatus: 200, responsePreview: '{"data":{"notes":[]}}' };
    const s = setup(WEB + '/explore', [], action => action === 'network_capture_read' ? { entries: [entry] } : undefined);
    const p = new s.ctx.__xhsOpenCLI.Page({ name: 'liked', access: 'read' }, {});
    expect(await p.getInterceptedRequests()).toEqual([{ data: { notes: [] } }]);
    entry.responseBodyTruncated = true; await expect(p.getInterceptedRequests()).rejects.toThrow('truncated');
  });
  it('does not reuse captures across notification types or expired invocations', async () => {
    const s = setup(); const p = new s.ctx.__xhsOpenCLI.Page({ name: 'notifications', access: 'read' }, { type: 'likes' });
    s.storage.set('__ww_xhs_capture_pattern', JSON.stringify({ pattern: '/you/', call: 'old', at: Date.now(), target: s.ctx.location.href }));
    await p.installInterceptor('/you/'); expect(s.calls.some(c => c.action === 'network_capture_start')).toBe(true);
  });
  it('downloads only allowed MIME/hosts with base64 bytes and no account cookies', async () => {
    const media = { noteId: ID, media: [{ type: 'image', url: 'https://sns-img.xhscdn.com/fixture.jpg' }] };
    const s = setup(NOTE, [media], action => action === 'backend_fetch' ? { ok: true, status: 200, bodyEncoding: 'base64', body: '/9j/', size: 3, headers: { 'content-type': 'image/jpeg' } } : action === 'backend_file_write' ? { path: 'fixture-output/image.jpg' } : undefined);
    const rows = await s.run('download', { 'note-id': NOTE, output: 'fixture-output' });
    expect(rows[0]).toMatchObject({ status: 'saved', size: 3 });
    expect(s.calls.find(c => c.action === 'backend_fetch').options).toMatchObject({ redirect: 'manual', responseEncoding: 'base64' });
    expect(s.calls.find(c => c.action === 'backend_file_write')).toMatchObject({ content: '/9j/', encoding: 'base64' });
  });
  it.each(['https://example.org/image.jpg', 'https://xhscdn.com.example.org/image.jpg', 'http://sns-img.xhscdn.com/image.jpg'])('rejects media host %s', async url => {
    const s = setup(NOTE, [{ noteId: ID, media: [{ type: 'image', url }] }]);
    await expect(s.run('download', { 'note-id': NOTE })).rejects.toMatchObject({ code: 'ARGUMENT' }); expect(s.calls.some(c => c.action === 'backend_fetch')).toBe(false);
  });
  it('resolves short links with bounded trusted redirects before note navigation', async () => {
    const s = setup(WEB + '/explore', [], action => action === 'backend_fetch' ? { status: 302, headers: { location: NOTE } } : undefined);
    expect((await s.run('download', { 'note-id': 'https://xhslink.com/fixture' })).__webcli_navigation.url).toBe(NOTE);
  });
  it('rejects a short-link redirect to an unrelated host', async () => {
    const s = setup(WEB + '/explore', [], action => action === 'backend_fetch' ? { status: 302, headers: { location: 'https://example.org/' } } : undefined);
    await expect(s.run('download', { 'note-id': 'https://xhslink.com/fixture' })).rejects.toMatchObject({ code: 'ARGUMENT' });
  });
  it('rejects missing upload files before any page mutation', async () => {
    const s = setup(PUBLISH, [], action => { if (action === 'backend_file_read') throw new Error('File not found'); });
    await expect(s.run('publish', { title: 'Fixture', content: 'Body', images: 'C:/weworker-fixtures/missing.jpg', __confirmed: true })).rejects.toThrow('File not found');
    expect(s.calls.map(c => c.action)).toEqual(['backend_file_read']);
  });
  it('stops at login redirects instead of entering host navigation loops', async () => {
    const s = setup(CREATOR + '/login');
    await expect(s.run('creator-stats')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(s.calls).toHaveLength(0);
  });
  it('reports unexpected target redirects without repeatedly navigating', async () => {
    const s = setup(CREATOR + '/unexpected');
    s.storage.set('__ww_xhs_navigation', JSON.stringify({ command: 'creator-stats', url: CREATOR + '/new/home', at: Date.now() }));
    await expect(s.run('creator-stats')).rejects.toMatchObject({ code: 'PAGE_REDIRECT' });
  });
  it('checks identity on any creator route without requiring /new/home', async () => {
    const s = setup(CREATOR + '/home', [{ data: { name: 'Fixture' } }]);
    expect(await s.run('whoami')).toMatchObject({ logged_in: true, followers: null });
  });
  it('enforces dry-run and validates deletion postconditions in the actual bundle', async () => {
    const entries = { ok: true, entries: [{ key: 12, row: { title: 'Fixture draft' } }] };
    const dry = setup(PUBLISH, [entries]);
    expect((await dry.run('draft-delete', { id: 'n:12', execute: 'false', __confirmed: true }))[0].status).toBe('dry-run');
    expect(dry.calls.filter(x => x.action === 'main_world_eval')).toHaveLength(1);
    const live = setup(PUBLISH, [entries, { ok: true, deleted: true }]);
    expect((await live.run('draft-delete', { id: 'n:12', execute: 'true', __confirmed: true }))[0].status).toBe('deleted');
    const failed = setup(PUBLISH, [entries, { ok: true, deleted: false }]);
    await expect(failed.run('draft-delete', { id: 'n:12', execute: true, __confirmed: true })).rejects.toThrow('still exists');
  });
  it.each([false, true])('publishes or saves draft with verified native editor input (draft=%s)', async draft => {
    let final = false;
    const s = setup(PUBLISH, [], (action, args) => {
      if (action === 'backend_file_read') return { path: 'C:/weworker-fixtures/image.jpg', content: '/9j/', encoding: 'base64', size: 3 };
      if (action !== 'main_world_eval') return;
      const code = args.expression; let value;
      if (code.includes('location.href')) value = final ? CREATOR + '/publish/success' : PUBLISH;
      else if (code.includes("const targets = ['上传图文', '图文', '图片']")) value = { ok: true, text: '上传图文' };
      else if (code.includes('hasTitleInput') && code.includes('hasVideoSurface')) value = { state: 'editor_ready', hasTitleInput: true, hasImageInput: true, hasVideoSurface: false };
      else if (code.includes('const sels =') && code.includes('return el ? sels : null')) value = 'input[type="file"][accept*="image"]';
      else if (code.includes('[class*="upload"][class*="progress"]')) value = false;
      else if (code.includes('const sels =') && code.includes('for (const sel of sels)')) value = true;
      else if (code.includes('__opencli_xhs_fill_phase') && code.includes('"locate"')) value = { ok: true, sel: '[contenteditable="true"]', kind: 'contenteditable' };
      else if (code.includes('__opencli_xhs_fill_phase') && code.includes('"prepare"')) value = { ok: true };
      else if (code.includes('__opencli_xhs_fill_phase') && code.includes('"verify"')) value = { ok: true, actual: code.includes('"Fixture title"') ? 'Fixture title' : 'Fixture body' };
      else if (code.includes('xhs-publish-btn')) { final = true; value = { ok: true, via: 'method' }; }
      else if (code.includes('(markers =>')) value = draft ? '保存成功' : '发布成功';
      else throw new Error('Unexpected publish evaluation: ' + code.slice(0, 150));
      return { value: { ok: true, value } };
    });
    const rows = await s.run('publish', { title: 'Fixture title', content: 'Fixture body', images: 'C:/weworker-fixtures/image.jpg', draft: String(draft), __confirmed: true });
    expect(rows[0].status).toContain(draft ? '暂存成功' : '发布成功');
    expect(s.calls.filter(c => c.action === 'native_input').map(c => c.text)).toEqual(['Fixture title', 'Fixture body']);
    expect(s.calls.find(c => c.action === 'set_file_input').files).toEqual(['C:/weworker-fixtures/image.jpg']);
  });
  it('does not confuse creator login with a requested public web command', async () => {
    const s = setup(CREATOR + '/login');
    const result = await s.run('search', { query: 'fixture' });
    expect(new URL(result.__webcli_navigation.url).hostname).toBe('www.xiaohongshu.com');
  });
  it('includes replies without consuming the top-level comment limit', async () => {
    const row = { author: 'Fixture', authorHrefRaw: '/user/profile/' + ID, text: 'Parent', likes: 0, time: '', is_reply: false, reply_to: '', images: [] };
    const s = setup(NOTE, [{ results: [row, { ...row, text: 'Reply', is_reply: true, reply_to: 'Fixture', images: ['https://sns-img.xhscdn.com/fixture.jpg'] }, { ...row, text: 'Next parent' }] }]);
    const rows = await s.run('comments', { 'note-id': NOTE, limit: '1', 'with-replies': 'true' });
    expect(rows.map(r => r.text)).toEqual(['Parent', 'Reply']);
    expect(rows[1]).toMatchObject({ userId: ID, is_reply: true, images: ['https://sns-img.xhscdn.com/fixture.jpg'] });
    await expect(setup(NOTE, [{}]).run('comments', { 'note-id': NOTE })).rejects.toThrow('Missing comment results');
  });
  it('permits at most one read-only cooldown reload across host continuations', async () => {
    const s = setup(NOTE, [{ securityBlock: true }, { securityBlock: true }]);
    expect((await s.run('note', { 'note-id': NOTE })).__webcli_navigation).toMatchObject({ url: NOTE, resume: true });
    await expect(s.run('note', { 'note-id': NOTE })).rejects.toMatchObject({ code: 'SECURITY_BLOCK' });
    expect(s.storage.has('__ww_xhs_detail_retry')).toBe(false);
  });
  it('keeps local like/favorite navigation bounded without enabling write replay', async () => {
    const s = setup();
    expect((await s.run('like-note', { url: NOTE })).__webcli_navigation).toMatchObject({ resume: false, result: { executed: false } });
    await expect(s.run('favorite-note', { url: 'https://example.org/explore/' + ID })).rejects.toThrow();
  });
  it('retains idempotent local actions and compatibility confirmation grant', async () => {
    const s = setup(NOTE); let params;
    s.ctx.__xiaohongshu_com_internal.invoke = async (_, input) => { params = input; return { liked: true, alreadyLiked: true }; };
    expect(await s.run('like-note', { url: NOTE })).toMatchObject({ alreadyLiked: true });
    expect(params.__confirmed).toBe(true);
  });
  it('ignores aria-hidden and near-transparent duplicate filter controls', async () => {
    const s = setup(WEB + '/search_result?keyword=fixture&source=web_search_result_notes'); let filterResult;
    s.ctx.__webmcpWecliRuntime.requestPrivileged = async (_, args) => {
      const source = args.expression;
      if (!source.includes('const requestedFilters =')) {
        if (filterResult) throw new Error('stop after filter verification');
        return { value: { ok: true, value: 'content' } };
      }
      const requests = JSON.parse(source.match(/const requestedFilters = (.*);/)[1]);
      const element = (textContent, hidden = false, opacity = '1') => ({ textContent, opacity, parentElement: null, closest: () => hidden ? {} : null, getBoundingClientRect: () => ({ width: 96, height: 40 }), classList: { contains: () => true } });
      const groups = requests.map(r => {
        const group = element(''); group.children = [{ tagName: 'SPAN', textContent: r.group }];
        group.querySelectorAll = () => [element(r.option, true), element(r.option, false, '0.00001'), element(r.option)];
        return group;
      });
      const panel = element(''); panel.querySelectorAll = () => groups;
      s.ctx.document = { body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [panel] };
      s.ctx.getComputedStyle = el => ({ display: 'block', visibility: 'visible', opacity: el.opacity });
      filterResult = await vm.runInContext(source, s.ctx);
      return { value: filterResult };
    };
    await expect(s.run('search', { query: 'fixture', limit: 1 })).rejects.toThrow('stop after filter verification');
    expect(filterResult).toMatchObject({ ok: true, value: { status: 'ok' } });
  });
  it('accepts canonical note redirects without matching tracking parameters', async () => {
    const s = setup(WEB + '/explore/' + ID, [{ title: 'Fixture', author: 'Fixture', desc: 'Body' }]);
    const result = await s.run('note', { 'note-id': WEB + '/search_result/' + ID + '?xsec_token=fixture-token&xsec_source=pc_search' });
    expect(result).toContainEqual({ field: 'title', value: 'Fixture' });
  });
  it('does not treat a success acknowledgement without creator notes as an empty list', () => {
    const key = '/api/galaxy/creator/datacenter/note/analyze/list';
    expect(() => validateCreatorCaptures({ [key]: { ok: true, status: 200, body: JSON.stringify({ data: { result: { code: 0, success: true, message: 'success' } } }) } })).toThrow('missing note_infos');
    expect(() => validateCreatorCaptures({ [key]: { ok: true, status: 200, body: JSON.stringify({ data: { note_infos: [], total_count: 0 } }) } })).not.toThrow();
    expect(() => validateCreatorCaptures({ [key]: { ok: false, status: 406 } })).toThrow('HTTP 406');
  });
});
