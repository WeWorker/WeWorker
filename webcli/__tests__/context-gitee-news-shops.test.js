import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { compileResultBindings } from '../result-bindings.js';
import { captureResult } from '../context-profile.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { routeContext } from '../context-router.js';

function setup(site) {
  const root = resolve(import.meta.dirname, '../../adapters', site), pkg = validateV2AdapterDir(root), handlers = new Map(), storage = new Map(), requests = [];
  const text = value => ({ textContent: value, innerText: value });
  const shops = ['100001', '100002'].map(id => ({ querySelectorAll: () => [], querySelector: selector => {
    if (selector === '.tit h4') return text(`Shop ${id}`);
    if (selector.includes('.tit') || selector.includes('data-shopid') || selector.includes('/shop/')) return { getAttribute: key => key === 'data-shopid' ? id : `https://www.dianping.com/shop/${id}` };
    return null;
  } }));
  const list = { innerText: 'Example article\n10-08 10:00\n审核中', children: [], querySelector: () => null };
  const document = { title: 'Example', body: { innerText: '' }, querySelectorAll: selector => selector === '#shop-all-list li' ? shops : [],
    querySelector: selector => {
      if (selector === '.all-content-list') return list;
      if (selector === '.shop-head' || selector === '.shop-name, .shop-head h2, .shop-head h1') return text('Example shop');
      return null;
    } };
  const projects = ['example-owner', 'other-owner'].map(owner => ({ name: `${owner}/project`, url: `https://gitee.com/${owner}/project` }));
  const context = { URL, URLSearchParams, console, document, location: new URL(site === 'toutiao.com' ? 'https://mp.toutiao.com/' : `https://${site}/`),
    setTimeout: callback => { callback(); return 1; }, clearTimeout,
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async path => ({ status: 200, json: async () => String(path).includes('status') ? { code: 0, data: { is_login: true } } : { code: 0, user_id_str: '1234567890123456789', name: 'Example creator' } }),
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      requests.push({ action, args });
      if (action === 'cookies_get') return [];
      if (action === 'main_world_eval') {
        if (site === 'toutiao.com') return { value: await vm.runInContext(args.expression, context) };
        if (args.expression.includes('fetch(')) return { value: { ok: true, user_id: '123', username: 'example-owner', name: 'Example' } };
        return { value: context.location.pathname === '/explore' ? projects : { nickname: 'Example owner', followers: '1', publicRepos: '2' } };
      }
      if (action === 'backend_fetch') {
        const body = args.url.includes('/search/') ? { hits: { hits: projects.map(row => ({ fields: { title: [row.name], url: [row.url] } })) } } : { login: 'example-owner', name: 'Example owner', public_repos: 2 };
        return { ok: true, status: 200, url: args.url, body: JSON.stringify(body) };
      }
      if (action === 'network_capture_start' || action === 'network_capture_read') return [];
      throw new Error(`Unexpected helper ${action}`);
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { requests, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run: async (command, args = {}) => {
    const handler = handlers.get(`${site}.${command}`); let result = await handler(args);
    for (let n = 0; result.__webcli_navigation?.resume && n < 3; n++) { context.location = new URL(result.__webcli_navigation.url); result = await handler(args); }
    return result;
  } };
}
function captured(s, tool, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return state;
}
it.each(['search', 'trending'])('Gitee %s preserves actual repository ownership and executes the displayed second owner profile', async command => {
  const s = setup('gitee.com'), args = command === 'search' ? { keyword: 'Example' } : {}, raw = await s.run(command, args);
  expect(raw.map(row => row.owner)).toEqual(['example-owner', 'other-owner']);
  const state = captured(s, `gitee.com.${command}`, args, raw), result = await routeContext(state, '查看所有者第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ username: 'example-owner' });
  const profile = await s.run('user', result.steps[0].args);
  expect(profile).toContainEqual({ field: 'URL', value: 'https://gitee.com/example-owner' });
});
it('Gitee account identity can open the exact returned username profile', async () => {
  const s = setup('gitee.com'), raw = await s.run('whoami'), state = captured(s, 'gitee.com.whoami', {}, raw);
  const result = await routeContext(state, '查看第一条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ username: 'example-owner' });
  expect(await s.run('user', result.steps[0].args)).toContainEqual({ field: 'URL', value: 'https://gitee.com/example-owner' });
});
it('Gitee repository detail is an explicit missing capability and is never replaced by an owner profile', async () => {
  const s = setup('gitee.com'), args = { keyword: 'Example' }, raw = await s.run('search', args), state = captured(s, 'gitee.com.search', args, raw);
  const result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps).toBeUndefined(); expect(result.reasonCode).toBe('tool_profile_unavailable');
});
it('Toutiao actual authenticated identity can open creator articles; public headlines cannot use this unrelated command', async () => {
  const s = setup('toutiao.com'), raw = await s.run('whoami'), state = captured(s, 'toutiao.com.whoami', {}, raw);
  expect(raw.user_id).toBe('1234567890123456789');
  const result = await routeContext(state, '查看我的文章第一条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: 'toutiao.com.articles', args: {} });
  expect(await s.run('articles', result.steps[0].args)).toMatchObject([{ title: 'Example article', status: '审核中' }]);
  for (const command of ['hot', 'recommend']) expect(s.catalog.resultBindings.get(`toutiao.com.${command}`).results[0].actions).toEqual([]);
});
it('Dianping runs actual shop-card extraction, reversed display selection and shop-detail extraction', async () => {
  const s = setup('dianping.com'), args = { keyword: 'Example', city: 'beijing' }, raw = await s.run('search', args);
  expect(raw.map(row => row.shop_id)).toEqual(['100001', '100002']);
  const state = captured(s, 'dianping.com.search', args, raw), result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ shop_id: '100001' });
  expect(await s.run('shop', result.steps[0].args)).toContainEqual({ field: 'shop_id', value: '100001' });
});
