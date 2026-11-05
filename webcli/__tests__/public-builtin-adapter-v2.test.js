import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { validateV2AdapterDir } from '../adapter-package-v2.js';
import { buildV2Bootstrap, v2CommandDef } from '../../extension/background/v2-loader.js';

const root = resolve(import.meta.dirname, '../../adapters');
const adapterIds = [
  'bilibili.com',
  'jd.com',
  'juejin.cn',
  'mail.163.com',
  'mail.qq.com',
  'nnfp.jss.com.cn',
  'xiaohongshu.com',
];

function loadPackage(adapterId) {
  const adapterRoot = join(root, adapterId);
  const pkg = validateV2AdapterDir(adapterRoot);
  const sandbox = {
    captured: [],
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: class { observe() {} disconnect() {} },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { href: 'https://example.com/', origin: 'https://example.com' },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__webmcpRegister = (adapter) => sandbox.captured.push(adapter || {});
  vm.runInNewContext(buildV2Bootstrap(pkg.manifest), sandbox, { filename: 'v2-bootstrap.js' });
  vm.runInNewContext(readFileSync(join(adapterRoot, 'extension/internal/legacy.js'), 'utf8'), sandbox, { filename: 'extension/internal/legacy.js' });
  for (const command of pkg.manifest.commands) {
    vm.runInNewContext(readFileSync(join(adapterRoot, command.module), 'utf8'), sandbox, { filename: command.module });
  }
  return { pkg, sandbox };
}

describe('public built-in Adapter v2 packages', () => {
  it('migrates the complete public profile without legacy fallback', () => {
    const packages = adapterIds.map(loadPackage);
    expect(packages.map(({ pkg }) => pkg.name).sort()).toEqual([...adapterIds].sort());
    for (const { pkg, sandbox } of packages) {
      expect(sandbox.captured, pkg.name).toHaveLength(pkg.commands.length);
      expect(sandbox.captured.flatMap((adapter) => adapter.tools.map((tool) => tool.name))).toEqual(
        pkg.manifest.commands.map((command) => `${pkg.name}.${command.id}`),
      );
    }
  });

  it('opens QQ mail on wx.mail.qq.com and still accepts the classic host', () => {
    const { pkg } = loadPackage('mail.qq.com');
    expect(pkg.manifest.homepage_url).toBe('https://wx.mail.qq.com/');
    expect(pkg.manifest.auth.login_url).toBe('https://wx.mail.qq.com/');
    expect(pkg.manifest.match[0]).toBe('wx.mail.qq.com');
    expect(pkg.manifest.match).toContain('mail.qq.com');
    expect(pkg.manifest.domains).toEqual(expect.arrayContaining(['mail.qq.com', 'wx.mail.qq.com']));
  });

  it('preserves JD command-specific settlement routing and old command aliases', () => {
    const { pkg } = loadPackage('jd.com');
    const checkout = v2CommandDef(pkg.manifest, pkg.manifest.commands.find((command) => command.id === 'pay-now'));
    const product = v2CommandDef(pkg.manifest, pkg.manifest.commands.find((command) => command.id === 'buy-now'));
    expect(checkout).toMatchObject({
      routeDomain: 'pc-settlement-lite-pro.pf.jd.com',
      tabDomain: 'pc-settlement-lite-pro.pf.jd.com',
    });
    // jd.com redirects to www.jd.com, so the first declared host is the real page host.
    expect(product).toMatchObject({
      routeDomain: 'www.jd.com',
      tabDomain: 'www.jd.com',
      excludeTabDomain: 'pc-settlement-lite-pro.pf.jd.com',
    });
    expect(pkg.commands.find((command) => command.id === 'pay-now').aliases).toEqual(['pay_now']);
  });
});
