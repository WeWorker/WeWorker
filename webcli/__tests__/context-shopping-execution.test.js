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
  const document = { title: 'Example', body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] };
  const context = { URL, URLSearchParams, console, document, location: new URL(`https://www.${site}/`),
    setTimeout: callback => { callback(); return 1; }, clearTimeout,
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      if (action !== 'main_world_eval') throw new Error(`Unexpected helper ${action}`);
      return { value: await vm.runInContext(args.expression, context) };
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(c => ({ ...c, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { context, requests, catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, run: async (command, args = {}) => {
    let result = await handlers.get(`${site}.${command}`)(args);
    for (let n = 0; result.__webcli_navigation && n < 3; n++) {
      const nav = result.__webcli_navigation; context.location = new URL(nav.url);
      if (!nav.resume) return nav.result || result;
      result = await handlers.get(`${site}.${command}`)(args);
    }
    return result;
  } };
}
function captured(s, command, args, raw) {
  const state = newState(1000); beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: command, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(e => e.entityRef).reverse(), completeness: 'unknown', delivered: true });
  return state;
}
function fish() {
  const s = setup('goofish.com');
  s.context.lib = { mtop: { request: async req => {
    s.requests.push(req);
    return req.api.endsWith('pc.search') ? { ret: ['SUCCESS::OK'], data: { resultList: ['10001', '10002'].map(id => ({
      data: { item: { main: { clickParam: { args: { item_id: id } }, exContent: { title: `Example ${id}` } } } },
    })) } } : { ret: ['SUCCESS::OK'], data: { itemDO: { itemId: req.data.itemId, title: `Example ${req.data.itemId}` }, sellerDO: { sellerId: '20001', nick: 'Example seller' } } };
  } } };
  return s;
}
it('Goofish executes real search normalization, reversed display second, selected item API and seller-message clarification', async () => {
  const s = fish(), args = { query: 'Example' }, raw = await s.run('search', args);
  expect(raw.map(row => row.item_id)).toEqual(['10001', '10002']);
  const state = captured(s, 'goofish.com.search', args, raw), result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ item_id: '10001' });
  const detail = await s.run('item', result.steps[0].args);
  expect(s.requests.at(-1).data.itemId).toBe('10001');
  expect(detail[0]).toMatchObject({ item_id: '10001', seller_id: '20001' });
  const selected = captured(s, 'goofish.com.item', result.steps[0].args, detail);
  const question = await routeContext(selected, '联系卖家第一条', { catalog: s.catalog, now: 1001 });
  expect(question).toMatchObject({ kind: 'needs_input', missingFields: ['arguments.text'] });
  const reply = await routeContext(selected, 'Example message', { catalog: s.catalog, now: 1002, replyTo: question.clarificationId });
  expect(reply.executionEligibility).toBe('write_allowed');
  expect(reply.steps[0]).toMatchObject({ tool: 'goofish.com.chat', args: { item_id: '10001', user_id: '20001', text: 'Example message' } });
});
function inbox(s, resolved = true) {
  const links = ['10001', '10002'].map((id, i) => ({ href: `https://www.goofish.com/im?itemId=${id}&peerUserId=2000${i + 1}`, getAttribute: () => '', closest: () => ({
    textContent: 'Example conversation', className: '', querySelector: selector => selector.includes('name') ? { textContent: `Example ${id}` } : null,
  }) }));
  s.context.document.querySelectorAll = selector => selector.startsWith('a[href*="/im"]') && resolved ? links : selector.includes('conversation-item') ? [{
    querySelectorAll: () => [{ tagName: 'SPAN', children: [], textContent: 'Unresolved peer' }], querySelector: () => null,
  }] : [];
}
it('Goofish inbox follows stable IDs after reversed display, reads actual messages and prepares a reply to the same conversation', async () => {
  const s = fish(); inbox(s);
  const raw = await s.run('inbox'), state = captured(s, 'goofish.com.inbox', {}, raw);
  const result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ item_id: '10001', user_id: '20001' });
  expect(result.steps[0].args).not.toHaveProperty('rank');
  s.context.document.querySelectorAll = selector => selector.includes('message-row') ? [{ querySelector: () => ({ textContent: 'Example message' }) }] : [];
  const messages = await s.run('messages', result.steps[0].args);
  expect(messages[0]).toMatchObject({ item_id: '10001', peer_user_id: '20001', message: 'Example message' });
  const selected = captured(s, 'goofish.com.messages', result.steps[0].args, messages);
  const question = await routeContext(selected, '回复消息第一条', { catalog: s.catalog, now: 1001 });
  const reply = await routeContext(selected, 'Example reply', { catalog: s.catalog, now: 1002, replyTo: question.clarificationId });
  expect(reply.steps[0].args).toEqual({ item_id: '10001', user_id: '20001', text: 'Example reply' });
});
it('Goofish unresolved conversation cannot fall back to a changing page rank', async () => {
  const s = fish(); inbox(s, false);
  const raw = await s.run('inbox'), state = captured(s, 'goofish.com.inbox', {}, raw);
  expect(raw[0]).toMatchObject({ rank: 1, item_id: '', peer_user_id: '' });
  expect((await routeContext(state, '查看第一条', { catalog: s.catalog, now: 1001 })).steps).toBeUndefined();
});
it.each(['search-products', 'view-cart'])('JD %s runs actual card extraction and opens the displayed second SKU', async command => {
  const s = setup('jd.com');
  const cards = ['10001', '10002'].map(id => ({ closest: () => null, getAttribute: key => key === 'data-sku' ? id : '', querySelector: selector => {
    if (selector.includes('goods_title') || selector.includes('_name_')) return { textContent: `Example ${id}`, getAttribute: () => '', querySelectorAll: () => [] };
    if (selector.includes('a[')) return { textContent: `Example ${id}`, getAttribute: () => `https://item.jd.com/${id}.html` };
    return null;
  }, querySelectorAll: () => [] }));
  s.context.document.querySelector = () => cards[0];
  s.context.document.querySelectorAll = selector => selector.includes('data-sku') || selector.includes('_product-item_') ? cards : [];
  const args = command === 'search-products' ? { keyword: 'Example' } : {}, raw = await s.run(command, args);
  const state = captured(s, `jd.com.${command}`, args, raw), result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ sku: '10001' });
  expect(await s.run('open-product', result.steps[0].args)).toMatchObject({ sku: '10001', productUrl: 'https://item.jd.com/10001.html' });
});
function checkout(s) {
  let clicks = 0;
  const button = { textContent: '立即购买', children: [], closest: () => null, getBoundingClientRect: () => ({ width: 1, height: 1 }), click: () => clicks++ };
  s.context.document.querySelector = selector => selector === '.bottom-btns-root' ? { closest: () => null, querySelectorAll: () => [button] } :
    selector.startsWith('iframe') && clicks ? { getAttribute: () => 'https://pc-settlement-lite-pro.pf.jd.com/example-checkout' } : null;
  return () => clicks;
}
it('JD selected product produces an identity-bound buy decision; actual handler rejects another page before clicking', async () => {
  const s = setup('jd.com'), raw = await s.run('open-product', { sku: '10001' }), state = captured(s, 'jd.com.open-product', { sku: '10001' }, raw);
  const decision = await routeContext(state, '立即购买第一条', { catalog: s.catalog, now: 1001 });
  expect(decision.steps[0].args).toEqual({ sku: '10001' });
  const clicks = checkout(s); s.context.location = new URL('https://item.jd.com/10002.html');
  expect(await s.run('buy-now', decision.steps[0].args)).toMatchObject({ error: 'Product changed' }); expect(clicks()).toBe(0);
  s.context.location = new URL('https://item.jd.com/10001.html');
  expect(await s.run('buy-now', decision.steps[0].args)).toMatchObject({ status: 'success', checkoutUrl: 'https://pc-settlement-lite-pro.pf.jd.com/example-checkout' });
  expect(clicks()).toBe(1);
});
it('JD rechecks SKU after waiting for a buy button and never silently cleans malformed identifiers', async () => {
  const s = setup('jd.com'), clicks = checkout(s), query = s.context.document.querySelector;
  s.context.location = new URL('https://item.jd.com/10001.html');
  s.context.document.querySelector = selector => { if (selector === '.bottom-btns-root') s.context.location = new URL('https://item.jd.com/10002.html'); return query(selector); };
  expect(await s.run('buy-now', { sku: '10001' })).toMatchObject({ error: 'Product changed' }); expect(clicks()).toBe(0);
  for (const args of [{ sku: 'bad10001' }, { url: 'https://item.jd.com/10002.html', sku: '10001' }, { url: 'https://item.jd.com/example' }, { url: 'https://example.com/10001.html' }]) {
    expect(await s.run('open-product', args)).toHaveProperty('error');
  }
});
