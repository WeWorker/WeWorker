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

function setup({ title = 'Example product', seller = true } = {}) {
  const root = resolve(import.meta.dirname, '../../adapters/1688.com'), pkg = validateV2AdapterDir(root), handlers = new Map(), storage = new Map(), helpers = [];
  const context = { URL, URLSearchParams, console, setTimeout: callback => { callback(); return 1; }, clearTimeout,
    location: new URL('https://s.1688.com/selloffer/offer_search.htm?keywords=Example'),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      helpers.push({ action, args });
      if (action === 'cookies_get') return [{ name: '__cn_logon__', value: 'true' }, { name: 'unb', value: 'example-user' }];
      if (action !== 'main_world_eval') throw new Error(`Unexpected helper ${action}`);
      // Page extraction is mocked; real package navigation, normalization and handlers execute below.
      return { value: { href: context.location.href, title, bodyText: '', body_text: 'Example', offerTitle: title,
        offerId: /\/offer\/(\d+)/.exec(context.location.pathname)?.[1],
        seller: seller ? { companyName: 'Example supplier', winportUrl: 'https://example-supplier.1688.com' } : {},
        gallery: { mainImage: ['https://example.org/product.jpg'] },
        candidates: ['100001', '100002'].map(id => ({ item_url: `https://detail.1688.com/offer/${id}.html`, title,
          seller_url: seller ? 'https://example-supplier.1688.com' : '', container_text: '' })), next_url: '',
      } };
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { helpers, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run: async (command, args = {}) => {
    const handler = handlers.get(`1688.com.${command}`); let result = await handler(args);
    // Store can visit the profile and contact page within the same host operation.
    for (let n = 0; result.__webcli_navigation && n < 4; n++) { context.location = new URL(result.__webcli_navigation.url); result = await handler(args); }
    return result;
  } };
}
function captured(s, command, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `1688.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return state;
}
it.each([
  ['search', { query: 'Example' }, '查看第二条', 'item'],
  ['search', { query: 'Example' }, '查看素材第二条', 'assets'],
  ['search', { query: 'Example' }, '列出下载链接第二条', 'download'],
  ['item', { input: '100001' }, '查看素材第一条', 'assets'],
  ['assets', { input: '100001' }, '查看第一条', 'item'],
  ['assets', { input: '100001' }, '列出下载链接第一条', 'download'],
])('1688 %s resolves %s and executes the actual %s handler', async (source, args, text, target) => {
  const s = setup(), raw = await s.run(source, args), state = captured(s, source, args, raw);
  const result = await routeContext(state, text, { catalog: s.catalog, now: 1001 });
  expect(result.steps[0]).toMatchObject({ tool: `1688.com.${target}`, args: { input: 'https://detail.1688.com/offer/100001.html' } });
  const output = await s.run(target, result.steps[0].args);
  expect(Array.isArray(output)).toBe(true); expect(output.length).toBeGreaterThan(0);
  if (target === 'download') expect(output[0]).toMatchObject({ type: 'image', url: 'https://example.org/product.jpg' });
  else expect(output[0].offer_id).toBe('100001');
});
it.each(['search', 'item'])('1688 %s exposes only the actual supplier URL and leaves absent suppliers unavailable', async source => {
  for (const seller of [true, false]) {
    const s = setup({ seller }), args = source === 'search' ? { query: 'Example' } : { input: '100001' }, raw = await s.run(source, args);
    const extracted = extractBoundEntities(s.catalog.resultBindings.get(`1688.com.${source}`), args, raw);
    const action = extracted.entities[0].bindings.store;
    expect(action.ready).toBe(seller);
    if (seller) expect(action.args).toEqual({ input: 'https://example-supplier.1688.com' });
  }
});
it.each(['search', 'item', 'assets'])('1688 %s preserves an unknown product title and uses the returned URL as its display label', async source => {
  const s = setup({ title: '' }), args = source === 'search' ? { query: 'Example' } : { input: '100001' }, raw = await s.run(source, args);
  expect(raw[0].title).toBeNull();
  const extracted = extractBoundEntities(s.catalog.resultBindings.get(`1688.com.${source}`), args, raw);
  expect(extracted.entities[0].title).toBe('https://detail.1688.com/offer/100001.html');
});
