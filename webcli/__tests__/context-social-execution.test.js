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

function setup(site, url) {
  const root = resolve(import.meta.dirname, '../../adapters', site), pkg = validateV2AdapterDir(root), handlers = new Map(), storage = new Map();
  let clicked = 0;
  const text = value => ({ innerText: value, textContent: value, getAttribute: () => '' });
  const control = { get innerText() { return clicked ? 'Unstar' : 'Star'; }, getAttribute: () => '', click: () => clicked++ };
  const reply = { textContent: 'Example comment', querySelector: () => text('Example comment') };
  const context = { URL, URLSearchParams, console, setTimeout: callback => { callback(); return 1; }, clearTimeout, location: new URL(url),
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { title: 'Example page', querySelector: selector => {
      if (selector.includes('issue-title') || selector.includes('h1') || selector.includes('video-title')) return text('Example title');
      if (selector.includes('comment-body')) return text('Example body');
      return null;
    }, querySelectorAll: selector => {
      if (selector === 'button, summary, a') return [control];
      if (selector.includes('bili-comment-thread-renderer')) return [reply];
      return [];
    } },
    __webmcpRegister: definition => definition.tools.forEach(tool => handlers.set(tool.name, tool.handler)),
  };
  context.window = context; vm.createContext(context); vm.runInContext(buildV2Bootstrap(pkg.manifest), context);
  for (const file of readdirSync(resolve(root, 'extension/internal')).sort()) vm.runInContext(readFileSync(resolve(root, 'extension/internal', file), 'utf8'), context);
  for (const command of pkg.commands) vm.runInContext(readFileSync(resolve(root, command.module), 'utf8'), context);
  const entries = pkg.commands.map(command => ({ ...command, adapterId: pkg.name, sourceFingerprint: 'test-package' }));
  return { catalog: { entries, tools: {}, resultBindings: compileResultBindings(entries) }, setUrl: url => { context.location = new URL(url); }, clicks: () => clicked,
    run: async (command, args = {}) => {
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
    order: snapshot.entities.map(e => e.entityRef), completeness: 'unknown', delivered: true });
  return state;
}
it('GitHub actual repository detail offers a Star with its required business option and the actual handler clicks once', async () => {
  const s = setup('github.com', 'https://github.com/example/project');
  const raw = await s.run('get-repository-detail', {}), state = captured(s, 'github.com.get-repository-detail', {}, raw);
  const result = await routeContext(state, '收藏第一条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ repository_url: 'https://github.com/example/project', confirm: true });
  expect(await s.run('star-current-repository', result.steps[0].args)).toMatchObject({ starred: true, changed: true });
  expect(s.clicks()).toBe(1);
  expect(await s.run('star-current-repository', result.steps[0].args)).toMatchObject({ starred: true, changed: false });
  expect(s.clicks()).toBe(1);
});
it.each(['issues', 'pull'])('GitHub %s detail retains its actual repository URL and resumes the repository read through host navigation', async kind => {
  const s = setup('github.com', `https://github.com/example/project/${kind}/12`), raw = await s.run('get-issue-or-pr-detail', {});
  const state = captured(s, 'github.com.get-issue-or-pr-detail', {}, raw);
  const result = await routeContext(state, '查看仓库第一条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ repository_url: 'https://github.com/example/project' });
  expect(await s.run('get-repository-detail', result.steps[0].args)).toMatchObject({ full_name: 'example/project' });
  expect(s.clicks()).toBe(0);
});
it('Bilibili comments remain bound to the selected video even when the active page has changed', async () => {
  const url = 'https://www.bilibili.com/video/BVexample1', s = setup('bilibili.com', url);
  const raw = await s.run('open-video-detail', {}), state = captured(s, 'bilibili.com.open-video-detail', {}, raw);
  const result = await routeContext(state, '查看评论第一条', { catalog: s.catalog, now: 1001 });
  expect(result.steps[0].args).toEqual({ video_url: url });
  s.setUrl('https://www.bilibili.com/video/BVother2');
  expect(await s.run('read-comments', result.steps[0].args)).toMatchObject({ video_id: 'BVexample1', count: 1 });
});
it.each(['https://example.org/video/BVexample1', 'https://user@www.bilibili.com/video/BVexample1'])('Bilibili rejects untrusted comment targets %s', async video_url => {
  const s = setup('bilibili.com', 'https://www.bilibili.com/video/BVexample1');
  await expect(s.run('read-comments', { video_url })).rejects.toThrow('Use a Bilibili video URL');
});
it('Juejin candidate discovery is explicitly an unimplemented inspector, not a list of actionable content', async () => {
  const s = setup('juejin.cn', 'https://juejin.cn/');
  expect(await s.run('list-detail-candidates')).toEqual({ mode: 'inspect_only', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] });
  const rule = s.catalog.resultBindings.get('juejin.cn.list-detail-candidates').results[0];
  expect(rule.actions).toEqual([]); expect(rule.reason).toContain('stub');
});
