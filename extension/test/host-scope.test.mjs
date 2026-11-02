import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  adapterHelperPatterns,
  adapterPagePatterns,
  adapterPrimaryHost,
  createRouteRedirects,
  hostMatchesPattern,
  isAdapterPageHost,
  isDeclaredRouteHost,
  pickRecentScopeTab,
  pickRouteTab,
  sameDomainFamily,
  siteDomainProblem,
} from '../background/host-scope.js';
import { assertAdapterNavigationUrl } from '../background/host-adapter-runtime.js';
import { isLoginPageUrl, loginStartUrl } from '../background/site-auth.js';

const shop = {
  name: 'shop.example.com', match: ['www.example.com'], domains: ['example.com', 'example.hk'],
  runtime_allowed_hosts: ['api.example.org'], homepage_url: 'https://www.example.com/',
};

test('WebCLI uses a byte-identical copy of the scope rules', () => {
  const extension = readFileSync(new URL('../background/host-scope.js', import.meta.url), 'utf8');
  const webcli = readFileSync(new URL('../../webcli/host-scope.js', import.meta.url), 'utf8');
  assert.equal(webcli, extension);
});

test('patterns: exact hosts, and *.domain for the domain and every subdomain', () => {
  assert.equal(hostMatchesPattern('www.example.com', 'www.example.com'), true);
  assert.equal(hostMatchesPattern('order.example.com', 'www.example.com'), false);
  assert.equal(hostMatchesPattern('example.com', '*.example.com'), true);
  assert.equal(hostMatchesPattern('a.b.example.com', '*.example.com'), true);
  assert.equal(hostMatchesPattern('badexample.com', '*.example.com'), false);
  assert.equal(hostMatchesPattern('Order.Example.com.', '*.example.com'), true);
  assert.deepEqual(adapterPagePatterns(shop), ['www.example.com', '*.example.com', '*.example.hk']);
  assert.deepEqual(adapterHelperPatterns(shop), ['www.example.com', '*.example.com', '*.example.hk', 'api.example.org']);
});

test('page scope covers declared site domains and nothing else', () => {
  for (const host of ['www.example.com', 'order.example.com', 'example.hk', 'order.example.hk']) {
    assert.equal(isAdapterPageHost(shop, host), true, host);
  }
  for (const host of ['example.net', 'api.example.org', 'example.com.evil.test', 'xexample.hk']) {
    assert.equal(isAdapterPageHost(shop, host), false, host);
  }
  // Helper hosts allow terminal navigation only.
  assert.throws(() => assertAdapterNavigationUrl(shop, 'https://api.example.org/', true), /not allowed/);
  assert.equal(assertAdapterNavigationUrl(shop, 'https://api.example.org/', false), 'https://api.example.org/');
  assert.equal(assertAdapterNavigationUrl(shop, 'https://order.example.hk/list', true), 'https://order.example.hk/list');
});

test('the primary host is the first exact match host, then the homepage, then the first domain', () => {
  assert.equal(adapterPrimaryHost(shop), 'www.example.com');
  assert.equal(adapterPrimaryHost({ match: ['*.example.com'], homepage_url: 'https://m.example.com/' }), 'm.example.com');
  assert.equal(adapterPrimaryHost({ match: ['*.example.com'] }), 'example.com');
  assert.equal(adapterPrimaryHost({ domains: ['example.com'] }), 'example.com');
});

test('site domains must be registrable domains, never public suffixes or wildcards', () => {
  assert.equal(siteDomainProblem('example.com'), null);
  assert.equal(siteDomainProblem('example.hk'), null);
  assert.equal(siteDomainProblem('shop.example.co.uk'), null);
  for (const value of ['com', 'co.uk', 'com.cn', 'github.io', 'vercel.app', '*.example.com', 'Example.com',
    'https://example.com', 'example.com:443', '127.0.0.1', '', ' example.com', 'exa_mple.com', 'example.123']) {
    assert.notEqual(siteDomainProblem(value), null, value);
  }
});

test('domain family: a shared registrable domain, never a shared public suffix', () => {
  assert.equal(sameDomainFamily('sso.example.com', 'passport.example.com'), true);
  assert.equal(sameDomainFamily('example.com', 'example.com'), true);
  assert.equal(sameDomainFamily('a.example.co.uk', 'login.example.co.uk'), true);
  assert.equal(sameDomainFamily('foo.co.uk', 'bar.co.uk'), false);
  assert.equal(sameDomainFamily('account.other.example.org', 'passport.example.com'), false);
  assert.equal(sameDomainFamily('weixin.example.net', 'passport.example.com'), false);
});

test('route fields may name any host inside the scope', () => {
  assert.equal(isDeclaredRouteHost(shop, 'www.example.com'), true);
  assert.equal(isDeclaredRouteHost(shop, 'order.example.hk'), true);
  assert.equal(isDeclaredRouteHost(shop, '*.example.com'), false);
  assert.equal(isDeclaredRouteHost(shop, 'order.example.net'), false);
  assert.equal(isDeclaredRouteHost({ match: ['*.example.com'] }, '*.example.com'), true);
});

test('tabs: the route host first, then the host it was redirected to, never excluded hosts', () => {
  const tabs = [
    { id: 1, url: 'https://pay.example.com/', lastAccessed: 50 },
    { id: 2, url: 'https://order.example.hk/list', lastAccessed: 10 },
    { id: 3, url: 'https://www.example.com/', lastAccessed: 20 },
    { id: 4, url: 'https://elsewhere.test/', lastAccessed: 99 },
  ];
  assert.equal(pickRouteTab(tabs, 'www.example.com')?.id, 3);
  assert.equal(pickRouteTab(tabs, 'order.example.com'), null);
  assert.equal(pickRouteTab(tabs, 'order.example.com', { aliases: ['order.example.hk'] })?.id, 2);
  assert.equal(pickRecentScopeTab(tabs, shop)?.id, 1);
  assert.equal(pickRecentScopeTab(tabs, shop, 'pay.example.com')?.id, 3);
});

test('tabs: prefer active matches, then last access time and a stable ID tie-break', () => {
  const sameHost = [
    { id: 11, url: 'https://www.example.com/', lastAccessed: 100 },
    { id: 12, url: 'https://www.example.com/', lastAccessed: 20, active: true },
    { id: 13, url: 'https://www.example.com/', lastAccessed: 40, active: true },
  ];
  assert.equal(pickRouteTab(sameHost, 'www.example.com')?.id, 13);
  assert.equal(pickRouteTab(sameHost.filter((tab) => !tab.active), 'www.example.com')?.id, 11);
  assert.equal(pickRouteTab([
    { id: 20, url: 'https://www.example.com/', lastAccessed: 5 },
    { id: 21, url: 'https://www.example.com/', lastAccessed: 5 },
  ], 'www.example.com')?.id, 21);
  assert.equal(pickRecentScopeTab([
    { id: 30, url: 'https://order.example.com/', lastAccessed: 100 },
    { id: 31, url: 'https://order.example.com/', lastAccessed: 1, active: true },
  ], shop)?.id, 31);
});

test('redirect memory keeps only redirects that stay inside the scope', () => {
  const redirects = createRouteRedirects(2);
  redirects.note(shop, 'https://order.example.com/', 'https://order.example.hk/list');
  redirects.note(shop, 'https://www.example.com/', 'https://www.example.com/home');
  redirects.note(shop, 'https://cart.example.com/', 'https://cart.example.net/');
  assert.deepEqual(redirects.aliases(shop, 'order.example.com'), ['order.example.hk']);
  assert.deepEqual(redirects.aliases(shop, 'www.example.com'), []);
  assert.deepEqual(redirects.aliases(shop, 'cart.example.com'), []);
  // Another package never sees these redirects; the memory is bounded.
  assert.deepEqual(redirects.aliases({ ...shop, name: 'other' }, 'order.example.com'), []);
  redirects.note(shop, 'https://a.example.com/', 'https://a.example.hk/');
  redirects.note(shop, 'https://b.example.com/', 'https://b.example.hk/');
  assert.deepEqual(redirects.aliases(shop, 'order.example.com'), []);
});

test('login rules: login hosts inside a site domain are still recognised as login pages', () => {
  const site = { ...shop, auth: { login_url: 'https://passport.example.com/login', login_hosts: ['passport.example.com'] } };
  assert.equal(isLoginPageUrl(site, 'https://passport.example.com/login'), true);
  // Generic SSO hosts are recognised when only covered by `domains`, not when named in `match`.
  assert.equal(isLoginPageUrl(shop, 'https://sso.example.hk/redirect'), true);
  assert.equal(isLoginPageUrl({ ...shop, match: ['www.example.com', 'sso.example.hk'] }, 'https://sso.example.hk/redirect'), false);
  assert.equal(isLoginPageUrl(shop, 'https://order.example.hk/list'), false);
  assert.equal(loginStartUrl({ name: 'x', domains: ['example.com'] }), 'https://example.com/');
});
