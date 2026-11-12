import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { validateV2AdapterDir } from '../adapter-package-validation.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';
import { compileResultBindings, extractBoundEntities } from '../result-bindings.js';
import { newState, beginRound, commitRound, registerDisplay } from '../context-model.js';
import { captureResult } from '../context-profile.js';
import { routeContext } from '../context-router.js';

const root = resolve(import.meta.dirname, '../../adapters/v2ex.com');
const topic = id => ({ id, title: `Topic ${id}`, content: 'Body', member: { username: `author${id}` }, node: { title: 'Examples' }, replies: 2, url: `https://www.v2ex.com/t/${id}` });
function setup(payload, page = {}) {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), calls = [];
  const context = { URL, URLSearchParams, console, setTimeout: callback => { callback(); return 1; }, clearTimeout,
    location: new URL(page.url || 'https://www.v2ex.com/'), document: page.document,
    sessionStorage: { removeItem() {}, getItem() { return null; }, setItem() {} },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      calls.push({ action, ...args });
      if (action === 'cookies_get') return [{ name: 'A2', value: 'test-session' }];
      if (action === 'main_world_eval') return { value: await vm.runInContext(args.expression, context) };
      return { ok: true, status: 200, url: args.url, body: JSON.stringify(payload(args.url)) };
    } },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { calls, catalog: { tools: {}, resultBindings: compileResultBindings(entries) }, run: (name, args) => handlers.get(`v2ex.com.${name}`)(args) };
}

it.each([
  ['hot', {}, 'topic', { id: 101 }, 'id', '101'],
  ['latest', {}, 'topic', { id: 101 }, 'id', '101'],
  ['node', { name: 'examples' }, 'topic', { id: 101 }, 'id', '101'],
  ['user', { username: 'example' }, 'topic', { id: 101 }, 'id', '101'],
  ['topic', { id: 101 }, 'replies', { id: 101 }, 'topic_id', '101'],
  ['nodes', {}, 'node', { name: 'examples' }, 'node_name', 'examples'],
  ['member', { username: 'example' }, 'user', { username: 'example' }, 'username', 'example'],
  ['replies', { id: 101 }, 'member', { username: 'example' }, 'username', 'example'],
])('%s executes the declared follow-up using actual Adapter output', async (command, args, target, expected, key, value) => {
  const s = setup(url => {
    const u = new URL(url);
    if (u.pathname.includes('/nodes/')) return [{ name: 'examples', title: 'Examples', topics: 2, stars: 1 }];
    if (u.pathname.includes('/members/')) return { username: 'example', tagline: 'Examples' };
    if (u.pathname.includes('/replies/')) return [{ id: 501, member: { username: 'example' }, content: 'First' }, { id: 502, member: { username: 'example' }, content: 'Second' }];
    return [topic(101), topic(102)];
  });
  const raw = await s.run(command, args), state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `v2ex.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  expect(snapshot.entities.length).toBe(raw.length);
  commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: snapshot.entities.map(entity => entity.entityRef).reverse(), completeness: 'unknown', delivered: true });
  const result = await routeContext(state, raw.length === 1 ? '查看这条' : '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.kind).toBe('resolved');
  expect(result.steps[0]).toMatchObject({ tool: `v2ex.com.${target}`, args: expected });
  await s.run(target, result.steps[0].args);
  expect(new URL(s.calls.at(-1).url).searchParams.get(key)).toBe(value);
  expect(s.calls.every(call => call.action === 'browser_fetch')).toBe(true);
});

it('notifications retain distinct identities, bind returned topic links, and leave missing links unavailable', async () => {
  const items = ['/t/101#reply1', '/t/102?p=2', '/member/example'].map((href, index) => ({
    id: `n_${index + 1}`, textContent: 'Notification', querySelector: selector => selector === 'a[href^="/t/"]' && href.startsWith('/t/')
      ? { textContent: 'Topic', getAttribute: () => href } : null,
  }));
  const s = setup(() => [topic(101)], { url: 'https://www.v2ex.com/notifications', document: {
    title: 'Notifications', querySelector: () => ({}), querySelectorAll: () => items,
  } });
  const raw = await s.run('notifications', {});
  expect(raw.map(row => row.topic_id)).toEqual(['101', '102', null]);
  const extracted = extractBoundEntities(s.catalog.resultBindings.get('v2ex.com.notifications'), {}, raw);
  expect(extracted.entities.map(entity => entity.businessId)).toEqual(['n_1', 'n_2', 'n_3']);
  expect(extracted.entities.map(entity => entity.bindings.detail.ready)).toEqual([true, true, false]);
  await s.run('topic', extracted.entities[1].bindings.detail.args);
  expect(new URL(s.calls.at(-1).url).searchParams.get('id')).toBe('102');
});

it('whoami preserves its singleton response and binds the verified username', async () => {
  const s = setup(() => [topic(101)], { document: { querySelector: () => ({ innerText: 'example', getAttribute: () => '/member/example' }) } });
  const raw = await s.run('whoami', {});
  expect(raw).toMatchObject({ logged_in: true, username: 'example' });
  const extracted = extractBoundEntities(s.catalog.resultBindings.get('v2ex.com.whoami'), {}, raw);
  expect(extracted.entities[0].bindings.detail.args).toEqual({ username: 'example' });
  await s.run('user', extracted.entities[0].bindings.detail.args);
  expect(new URL(s.calls.at(-1).url).searchParams.get('username')).toBe('example');
});

it('me binds the current user and declares daily as a write without confirmation bypass flags', () => {
  const s = setup(() => []);
  const extracted = extractBoundEntities(s.catalog.resultBindings.get('v2ex.com.me'), {}, [{ username: 'example', balance: '', unread_notifications: '2', daily_reward_ready: '是' }]);
  expect(extracted.entities[0].bindings.detail.args).toEqual({ username: 'example' });
  expect(extracted.entities[0].bindings.daily).toMatchObject({ safety: 'write', args: {} });
});
