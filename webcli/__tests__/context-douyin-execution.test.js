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
const root = resolve(import.meta.dirname, '../../adapters/douyin.com');
const ids = ['1937205528846655537', '1937205528846655599'];
function setup() {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), requests = []; let deleted = false;
  const works = ids.map((aweme_id, i) => ({ aweme_id, desc: `Example video ${i}`, create_time: 1700000000, status: 1 }));
  const del = { innerText: '删除作品', click() {} }, confirm = { innerText: '确定', click() { deleted = true; } };
  const card = { innerText: '删除作品 继续编辑', contains: () => false, querySelectorAll: s => s === 'a[href]' ? [{ href: `https://www.douyin.com/video/${ids[0]}` }] : [del] };
  const li = { querySelector: () => ({ getAttribute: () => `/video/${ids[0]}` }), querySelectorAll: () => [{ children: [], textContent: 'Example public video description' }] };
  const context = { URL, URLSearchParams, AbortController, console, Date, location: new URL('https://creator.douyin.com/creator-micro/content/manage'),
    setTimeout: (fn, ms) => { if (ms < 10000) fn(); return 1; }, clearTimeout() {},
    document: { body: { innerText: '' }, querySelector: () => null, querySelectorAll: s => s === '[data-e2e="scroll-list"] li' ? [li] : s.includes('video-card') ? [card] : [confirm] },
    fetch: async (input, options = {}) => {
      const url = new URL(input, context.location.href); requests.push({ url, options }); let payload;
      if (options.method === 'POST') payload = { status_code: 0 };
      else if (url.pathname.includes('user/info')) payload = { user_info: { uid: ids[0], nickname: 'Example creator' } };
      else if (url.pathname.includes('/creator/item/list')) payload = { items: ids.map(id => ({ id, metrics: { play: 12, like: 2 } })), has_more: false };
      else if (url.pathname.includes('/draft/')) payload = { aweme_list: works };
      else if (url.pathname.includes('/mix/list/')) payload = { mix_list: [{ mix_id: '123', mix_name: 'Example mix', item_count: 2 }] };
      else if (url.pathname.includes('/activity/')) payload = { activity_list: [{ activity_id: '123', title: 'Example activity', end_time: 1700000000 }] };
      else if (url.pathname.includes('/search/poi/')) payload = { poi_list: [{ poi_id: '123', poi_name: 'Example POI', city_name: 'Example city' }] };
      else if (url.pathname.includes('challengesug')) payload = { sug_list: [{ cid: '123', cha_name: 'Example' }] };
      else if (url.pathname.includes('/hashtag/rec')) payload = { hashtag_list: [{ id: '123', name: 'Example' }] };
      else if (url.pathname.includes('/hotspot/')) payload = { hotspot_list: [{ sentence_id: '123', sentence: 'Example' }] };
      else if (url.pathname.includes('/comment/list/')) payload = { comments: [{ text: 'Example comment', user: { nickname: 'Example person' } }] };
      else if (url.pathname.includes('/aweme/post/')) payload = { aweme_list: works };
      else if (url.pathname.includes('work_list')) payload = { work_list: works, aweme_list: deleted ? [] : works.slice(0, 1), has_more: false };
      else throw new Error(`Unexpected request ${url.pathname}`);
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }, __webmcpRegister: d => d.tools.forEach(t => handlers.set(t.name, t.handler)),
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const c of pkg.commands) vm.runInContext(readFileSync(resolve(root, c.module), 'utf8'), context);
  const entries = pkg.commands.map(c => ({ ...c, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  const run = (name, args = {}) => handlers.get(`douyin.com.${name}`)(args);
  return { context, requests, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run,
    read: async (name, args = {}) => { let r = await run(name, args); if (r.__webcli_navigation?.resume) { context.location = new URL(r.__webcli_navigation.url); r = await run(name, args); } return r; } };
}
function bind(s, command, args, raw) { return extractBoundEntities(s.catalog.resultBindings.get(`douyin.com.${command}`), args, raw); }
function capture(s, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: 'douyin.com.videos', args: {}, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state); registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true }); return state;
}
it('reversed second owned video executes that work statistics, preserving a 19-digit ID', async () => {
  const s = setup(), raw = await s.read('videos'), state = capture(s, raw);
  const result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: 'douyin.com.stats', args: { aweme_id: ids[0] } });
  expect(await s.run('stats', result.steps[0].args)).toEqual([{ metric: 'play', value: 12 }, { metric: 'like', value: 2 }]);
});
it('caption clarification resumes the selected owned work and actual mocked update', async () => {
  const s = setup(), state = capture(s, await s.read('videos'));
  const pending = await routeContext(state, '修改作品描述第二条', { catalog: s.catalog, now: 1001 });
  expect(pending.missingFields).toEqual(['arguments.caption']);
  const result = await routeContext(JSON.parse(JSON.stringify(state)), 'Example replacement', { catalog: s.catalog, now: 1002, replyTo: pending.clarificationId });
  expect(result.steps[0]).toMatchObject({ tool: 'douyin.com.update', args: { aweme_id: ids[0], caption: 'Example replacement' } });
  await s.run('update', result.steps[0].args);
  expect(JSON.parse(s.requests.at(-1).options.body)).toEqual({ aweme_id: ids[0], desc: 'Example replacement' });
});
it('owned work delete checks exact DOM identity and verifies disappearance in the mocked API', async () => {
  const s = setup(), raw = await s.read('videos'), action = bind(s, 'videos', {}, raw).entities[0].bindings.delete;
  expect(action).toMatchObject({ ready: true, tool: 'douyin.com.delete', args: { aweme_id: ids[0] } });
  const result = await s.run('delete', action.args); expect(result[0].status).toContain(ids[0]);
});
it('reschedule binds the same work and enforces the existing allowed timing window', async () => {
  const s = setup(), raw = await s.read('videos'), action = bind(s, 'videos', {}, raw).entities[0].bindings.reschedule;
  await expect(s.run('update', { ...action.args, reschedule: '1' })).rejects.toThrow();
  expect(s.requests.every(r => r.options.method !== 'POST')).toBe(true);
  const seconds = String(Math.floor(Date.now() / 1000) + 10800); await s.run('update', { ...action.args, reschedule: seconds });
  expect(JSON.parse(s.requests.at(-1).options.body)).toEqual({ aweme_id: ids[0], publish_time: Number(seconds) });
});
it.each([['profile', 'videos'], ['whoami', 'profile']])('%s real identity follows its own creator query', async (command, target) => {
  const s = setup(), raw = await s.read(command), b = bind(s, command, {}, raw).entities[0].bindings.detail;
  expect(b).toMatchObject({ ready: true, tool: `douyin.com.${target}`, args: {} });
  expect((await s.read(target, b.args)).length).toBeGreaterThan(0);
});
it.each(['search', 'suggest', 'hot'])('hashtag %s executes and its related-video search uses the returned topic name', async action => {
  const s = setup(), args = { action, keyword: 'Example', cover: 'example-cover' }, raw = await s.read('hashtag', args), b = bind(s, 'hashtag', args, raw).entities[0].bindings.search;
  expect(b).toMatchObject({ ready: true, tool: 'douyin.com.search', args: { query: 'Example' } });
  expect((await s.read('search', b.args))[0].url).toBe(`https://www.douyin.com/video/${ids[0]}`);
});
it.each([
  ['drafts', {}], ['collections', {}], ['activities', {}], ['location', { query: 'Example' }], ['stats', { aweme_id: ids[0] }],
  ['user-videos', { sec_uid: 'MS4wLjABAAAAexample_person' }], ['search', { query: 'Example' }],
])('%s executes the real source and declares its actual terminal or missing-capability boundary', async (command, args) => {
  const s = setup(), raw = await s.read(command, args); expect(raw.length).toBeGreaterThan(0);
  const rule = s.catalog.resultBindings.get(`douyin.com.${command}`).results[0];
  expect(rule.actions).toEqual([]); expect(rule.reason.length).toBeGreaterThan(30);
  if (command === 'user-videos') expect(raw[0]).toMatchObject({ aweme_id: ids[0], top_comments: [{ text: 'Example comment' }] });
});
it('creator write preparation never sends a business POST from a public page', async () => {
  const s = setup(); s.context.location = new URL('https://www.douyin.com/');
  for (const name of ['update', 'delete']) expect(await s.run(name, { aweme_id: ids[0], caption: 'Example' })).toMatchObject({ __webcli_navigation: { resume: false } });
  expect(s.requests).toHaveLength(0);
});
