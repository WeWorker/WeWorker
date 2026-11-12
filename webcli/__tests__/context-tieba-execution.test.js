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

const root = resolve(import.meta.dirname, '../../adapters/tieba.baidu.com');
function setup() {
  const pkg = validateV2AdapterDir(root), handlers = new Map(), calls = [];
  const storage = new Map();
  const context = { URL, URLSearchParams, console, setTimeout: callback => { callback(); return 1; }, clearTimeout,
    location: new URL('https://tieba.baidu.com/'),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
    __webmcpWecliRuntime: { requestPrivileged: async (action, args) => {
      calls.push({ action, ...args });
      if (action === 'cookies_get') return [];
      if (action === 'backend_fetch') return { ok: true, status: 200, url: args.url, body: JSON.stringify({ page_data: { feed_list: [101, 102].map(id => ({
        layout: 'feed', feed: { business_info_map: { thread_id: String(id), title: `Topic ${id}` }, components: [] },
      })) } }) };
      if (action === 'main_world_eval') {
        if (context.location.pathname.startsWith('/p/')) return { value: { pageMeta: { pathname: context.location.pathname, pn: context.location.searchParams.get('pn') }, mainPost: { title: 'Actual thread', contentText: 'Body' }, replies: [] } };
        return { value: [101, 102].map(id => ({ id: String(id), title: `Topic ${id}`, url: `https://tieba.baidu.com/p/${id}`, forum: 'Examples' })) };
      }
      throw new Error(`Unexpected helper: ${action}`);
    } },
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { calls, catalog: { tools: {}, resultBindings: compileResultBindings(entries) }, run: async (name, args) => {
    const handler = handlers.get(`tieba.baidu.com.${name}`);
    let result = await handler(args);
    if (result.__webcli_navigation) {
      context.location = new URL(result.__webcli_navigation.url);
      result = await handler(args);
    }
    return result;
  } };
}

it.each([
  ['posts', { forum: 'Examples' }, 'read', { id: '101' }],
  ['search', { keyword: 'Examples' }, 'read', { id: '101' }],
  ['hot', {}, 'search', { keyword: 'Topic 101' }],
])('%s runs actual query, resolves the displayed second result, and calls %s', async (command, args, target, expected) => {
  const s = setup(), raw = await s.run(command, args), state = newState(1000);
  beginRound(state, null, 1000);
  const snapshot = captureResult(state, { tool: `tieba.baidu.com.${command}`, args, raw, exitCode: 0, now: 1000, catalog: s.catalog, roundId: state.activeRound.roundId });
  expect(snapshot.entities).toHaveLength(2); commitRound(state);
  registerDisplay(state, { epoch: state.sessionEpoch, revision: state.revision, roundId: snapshot.sourceRoundId, snapshotId: snapshot.snapshotId,
    order: ['e2', 'e1'], completeness: 'unknown', delivered: true });
  const result = await routeContext(state, '查看第二条', { catalog: s.catalog, now: 1001 });
  expect(result.kind).toBe('resolved');
  expect(result.steps[0]).toMatchObject({ tool: `tieba.baidu.com.${target}`, args: expected });
  const detail = await s.run(target, result.steps[0].args);
  expect(detail).toHaveLength(target === 'read' ? 1 : 2);
  if (target === 'read') expect(detail[0].content).toBe('Actual thread Body');
  expect(s.calls.length).toBeGreaterThanOrEqual(2);
});
