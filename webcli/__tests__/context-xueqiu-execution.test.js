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

const root = resolve(import.meta.dirname, '../../adapters/xueqiu.com');
function setup({ missingMoney = false } = {}) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), requests = [];
  const stocks = [{ symbol: '00700', code: '00700', exchange: 'HK', name: 'First' }, { symbol: 'EXAMPLE', code: 'EXAMPLE', name: 'Second' }];
  const context = { URL, URLSearchParams, console, setTimeout: callback => { callback(); return 1; }, clearTimeout,
    location: new URL('https://xueqiu.com/'), document: { cookie: 'u=123; cookiesu=device' },
    sessionStorage: { removeItem() {}, getItem() { return null; }, setItem() {} },
    fetch: async url => {
      const u = new URL(url); requests.push(u);
      let payload;
      if (u.pathname === '/stock/search.json') payload = { stocks };
      else if (u.pathname.endsWith('/portfolio/list.json')) payload = { data: { stocks: [{ id: -7, name: 'First', symbol_count: 1 }, { id: 0, name: 'Second', symbol_count: 1 }] } };
      else if (u.pathname.endsWith('/portfolio/stock/list.json')) payload = { data: { stocks } };
      else if (u.pathname.endsWith('/hot_stock/list.json')) payload = { data: { items: stocks } };
      else if (u.pathname.endsWith('/batch/quote.json')) payload = { data: { items: [{ quote: { symbol: u.searchParams.get('symbol'), name: 'First' } }] } };
      else if (u.pathname.endsWith('/kline.json')) payload = { data: { column: ['timestamp', 'open', 'high', 'low', 'close', 'volume'], item: [[1700000000000, 1, 2, 0, 1, 10]] } };
      else if (u.pathname.includes('/event/')) payload = { data: { items: [{ subtype: 2, timestamp: 1700000000000, message: 'Report' }] } };
      else if (u.pathname.includes('/symbol/search/status')) payload = { list: [{ id: 1, description: 'Discussion', user: { id: 123, screen_name: 'Example' } }] };
      else if (u.pathname.endsWith('/home_timeline.json')) payload = { home_timeline: [{ id: 1, description: 'Example timeline', user: { id: 123, screen_name: 'Example' } }] };
      else if (u.pathname.endsWith('/listV3.json')) payload = { list: [{ id: 2, description: 'Example hot post', user: { id: 123, screen_name: 'Example' } }] };
      else if (u.pathname.endsWith('/assets/gain')) payload = { data: { amount: missingMoney ? null : '100', items: [{ summary_type: 'FUND', invest_account_list: [{ invest_account_id: 'example-account', invest_account_name: 'Example account' }] }] } };
      else if (u.pathname.endsWith('/assets/summary')) payload = { data: { items: [{ fd_code: '000001', fd_name: 'Example fund', market_value: missingMoney ? ' ' : '100' }] } };
      else throw new Error(`Unexpected request: ${u.pathname}`);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload, text: async () => JSON.stringify(payload) };
    },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      if (action === 'cookies_get') return [{ name: 'xq_a_token', value: 'test-session' }];
      if (action === 'main_world_eval') return { value: await vm.runInContext(args.expression, context) };
      throw new Error(`Unexpected helper: ${action}`);
    } },
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { context, requests, catalog: { tools: {}, resultBindings: compileResultBindings(entries) }, run: (name, args = {}) => handlers.get(`xueqiu.com.${name}`)(args) };
}

it.each(['comments', 'feed', 'hot', 'fund-holdings', 'fund-snapshot'])('%s executes its source and declares the actual boundary instead of mapping posts or fund codes to stock tools', async command => {
  const s = setup(), args = command === 'comments' ? { symbol: '00700' } : {};
  let raw = await s.run(command, args);
  if (raw.__webcli_navigation?.resume) { s.context.location = new URL(raw.__webcli_navigation.url); raw = await s.run(command, args); }
  expect(raw.length).toBeGreaterThan(0);
  const rules = s.catalog.resultBindings.get(`xueqiu.com.${command}`).results;
  expect(rules).toHaveLength(1); expect(rules[0].actions).toEqual([]); expect(rules[0].reason.length).toBeGreaterThan(30);
  if (command === 'fund-holdings') expect(raw[0]).toMatchObject({ accountId: 'example-account', fdCode: '000001', marketValue: 100 });
  if (command === 'fund-snapshot') expect(raw[0]).toMatchObject({ totalAssetAmount: 100, holdings: [{ fdCode: '000001' }] });
});

it('fund snapshot preserves null and blank amounts as unknown instead of inventing zero balances', async () => {
  const s = setup({ missingMoney: true }); s.context.location = new URL('https://danjuanfunds.com/my-money');
  const [row] = await s.run('fund-snapshot');
  expect(row.totalAssetAmount).toBeNull(); expect(row.holdings[0].marketValue).toBeNull();
});

it.each([
  ['search', { query: 'Example' }, 'stock', { symbol: '00700' }],
  ['hot-stock', {}, 'stock', { symbol: '00700' }],
  ['watchlist', { pid: '-7', limit: 2 }, 'stock', { symbol: '00700' }],
  ['groups', {}, 'watchlist', { pid: '-7' }],
  ['stock', { symbol: '00700' }, 'comments', { symbol: '00700' }],
  ['whoami', {}, 'groups', {}],
])('%s executes the actual source and its follow-up without losing symbol or group identity', async (command, args, target, expected) => {
  const s = setup(), raw = await s.run(command, args), state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `xueqiu.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  const single = snapshot.entities.length === 1;
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(entity => entity.entityRef).reverse(), completeness: 'unknown', delivered: true });
  const result = await routeContext(state, single ? '查看这条' : '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.kind).toBe('resolved'); expect(result.steps[0]).toMatchObject({ tool: `xueqiu.com.${target}`, args: expected });
  const detail = await s.run(target, result.steps[0].args);
  expect(Array.isArray(detail)).toBe(true); expect(detail.length).toBeGreaterThan(0);
  if (expected.symbol) expect(s.requests.at(-1).searchParams.get('symbol')).toBe('00700');
  if (expected.pid) expect(s.requests.at(-1).searchParams.get('pid')).toBe('-7');
});

it.each(['comments', 'kline', 'earnings'])('search declares and executes the %s alternative with the same stock symbol', async actionId => {
  const s = setup(), raw = await s.run('search', { query: 'Example' });
  const extracted = extractBoundEntities(s.catalog.resultBindings.get('xueqiu.com.search'), { query: 'Example' }, raw);
  const action = extracted.entities[0].bindings[actionId];
  expect(action.ready).toBe(true); expect(action.args).toEqual({ symbol: '00700' });
  await s.run(action.tool.slice('xueqiu.com.'.length), action.args);
  expect(s.requests.at(-1).searchParams.get('symbol')).toBe('00700');
});

it('retains group zero as a string rather than substituting the default group', async () => {
  const s = setup(), raw = await s.run('groups');
  const extracted = extractBoundEntities(s.catalog.resultBindings.get('xueqiu.com.groups'), {}, raw);
  expect(extracted.entities[1].bindings.detail.args).toEqual({ pid: '0' });
  await s.run('watchlist', extracted.entities[1].bindings.detail.args);
  expect(s.requests.at(-1).searchParams.get('pid')).toBe('0');
});
