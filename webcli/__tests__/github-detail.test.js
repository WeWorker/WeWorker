import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { createHostAdapterRuntime } from '../../extension/background/host-adapter-runtime.js';

const source = readFileSync(new URL('../../adapters/github.com/extension/internal/legacy.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../../adapters/github.com/manifest.json', import.meta.url)));
const base = 'https://github.com/example/project';
function page(url, { links = [], title = 'Example issue', body = 'Example body', missing = false, store = new Map() } = {}) {
  const location = new URL(url);
  const context = { URL, console, location, setTimeout: fn => setTimeout(fn, 0),
    sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    document: { title: missing ? 'Page not found · GitHub' : title,
      querySelector: selector => selector.includes('issue-title') ? (title ? { innerText: title } : null)
        : selector.includes('markdown-body') ? (body === null ? null : { innerText: body }) : null,
      querySelectorAll: selector => selector.startsWith('a[') ? links.map(href => ({ getAttribute: () => href })) : [],
    }, __webmcpRegister() {},
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  return args => context.__github_com_internal.invoke('github.com.get_issue_or_pr_detail', args);
}

describe('GitHub detail navigation and completion', () => {
  it.each(['issues', 'pulls'])('completes %s list navigation in one invocation', async section => {
    const detail = `${base}/${section === 'pulls' ? 'pull' : 'issues'}/123`;
    const store = new Map();
    let operation = page(`${base}/${section}`, { links: ['https://example.org/issues/9', detail], store });
    const navigations = [];
    const runtime = createHostAdapterRuntime({ bundle: async () => [], prepare: async () => {}, clear: async () => {}, inject: async () => {},
      navigate: async (_tab, target) => { navigations.push(target); operation = page(target, { store }); return target; },
    });
    const result = await runtime.execute(1, manifest, `${base}/${section}`, () => operation({ issue_url: `${base}/${section}`, max_comments: 0 }), { id: 'get-issue-or-pr-detail' });
    expect(navigations).toEqual([detail]);
    expect(result).toMatchObject({ title: 'Example issue', body_summary: 'Example body', comments_count: 0, url: detail });
  });

  it('supports direct navigation, relative list links and empty bodies', async () => {
    expect((await page('https://github.com/')({ issue_url: `${base}/issues/123` })).__webcli_navigation.url).toBe(`${base}/issues/123`);
    expect((await page(`${base}/issues`, { links: ['/example/project/issues/123'] })({ issue_url: `${base}/issues` })).__webcli_navigation.url).toBe(`${base}/issues/123`);
    expect(await page(`${base}/issues/123`, { body: '' })({})).toMatchObject({ title: 'Example issue', body_summary: '' });
  });

  it('reports missing, unloaded, login and invalid pages', async () => {
    await expect(page(`${base}/issues/123`, { missing: true, title: '', body: null })({})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(page(`${base}/issues/123`, { title: '', body: null })({})).rejects.toMatchObject({ code: 'NOT_READY' });
    await expect(page('https://github.com/login')({ issue_url: `${base}/issues/123` })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(page(`${base}/issues/123`)({ issue_url: 'https://example.org/issues/123' })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('rejects forged or expired continuations', async () => {
    const other = 'https://github.com/other/project/issues/123';
    for (const at of [Date.now(), Date.now() - 180000]) {
      const store = new Map([['__weworker_github_detail_navigation', JSON.stringify({ list: `${base}/issues`, detail: other, at })]]);
      expect((await page(other, { store })({ issue_url: `${base}/issues` })).__webcli_navigation.url).toBe(`${base}/issues`);
    }
  });
});
