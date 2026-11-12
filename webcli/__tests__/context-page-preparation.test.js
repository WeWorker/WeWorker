import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const sites = ['arxiv.org', '1688.com', 'goofish.com', 'gitee.com', 'smzdm.com', 'tieba.baidu.com', 'v2ex.com', 'weibo.com', 'weread.qq.com', 'toutiao.com', 'xueqiu.com', 'x.com'];
function page(site, access = 'write') {
  const source = readFileSync(resolve(import.meta.dirname, '../../adapters', site, 'extension/internal/opencli.js'), 'utf8');
  const start = source.indexOf('var Page = class {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  };', start);
  expect(end).toBeGreaterThan(start);
  const storage = new Map();
  const context = vm.createContext({ URL, Date, location: new URL('https://example.com/start'),
    domains: { fixture: ['example.com'] }, domainSuffix: {}, helper: async () => ({ value: 'probe' }),
    ArgumentError: Error, AuthRequiredError: Error, CommandExecutionError: Error,
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
  });
  vm.runInContext(source.slice(start, end + 5), context);
  return new context.Page({ site: 'fixture', name: 'example', access });
}
it.each(sites)('%s initial write navigation declares preparation before any page execution', async site => {
  const p = page(site);
  await expect(p.goto('https://example.com/target')).rejects.toThrow('Navigation required');
  expect(p.pending).toMatchObject({ __webcli_navigation: { resume: false, phase: 'prepare', result: { status: 'prepared', executed: false } } });
});
it.each(sites)('%s cannot claim preparation after a page evaluation may have written', async site => {
  const p = page(site);
  await p.evaluate('() => true');
  await expect(p.goto('https://example.com/target')).rejects.toThrow('Navigation required');
  expect(p.pending.__webcli_navigation).not.toHaveProperty('phase');
});
it.each(sites)('%s read navigation still resumes without a preparation receipt', async site => {
  const p = page(site, 'read');
  await expect(p.goto('https://example.com/target')).rejects.toThrow('Navigation required');
  expect(p.pending.__webcli_navigation).toMatchObject({ resume: true });
  expect(p.pending.__webcli_navigation).not.toHaveProperty('phase');
});

function xhsPage() {
  const storage = new Map();
  const context = vm.createContext({ URL, Date, console, location: new URL('https://www.xiaohongshu.com/explore'),
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    __webmcpWecliRuntime: { requestPrivileged: async () => ({ value: { ok: true, value: true } }) },
  });
  context.window = context;
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../../adapters/xiaohongshu.com/extension/internal/opencli.js'), 'utf8'), context);
  return new context.__xhsOpenCLI.Page({ name: 'download', access: 'write' }, {});
}
it('Xiaohongshu initial write navigation declares preparation', async () => {
  await expect(xhsPage().goto('https://www.xiaohongshu.com/explore/123456789012345678901234')).rejects.toMatchObject({
    result: { __webcli_navigation: { phase: 'prepare', resume: false } },
  });
});
it('Xiaohongshu cannot claim preparation after page evaluation may have written', async () => {
  const p = xhsPage(); await p.evaluate('() => true');
  try { await p.goto('https://www.xiaohongshu.com/explore/123456789012345678901234'); }
  catch (error) {
    expect(error.result.__webcli_navigation).toMatchObject({ resume: false });
    expect(error.result.__webcli_navigation).not.toHaveProperty('phase');
    return;
  }
  throw new Error('Expected terminal write navigation');
});
