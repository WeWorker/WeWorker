import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authErrorFields,
  authRequiredError,
  displayUrl,
  evaluateCookieCheck,
  isLoginPageUrl,
  loginHosts,
  loginStartUrl,
  siteDisplayName,
} from '../background/site-auth.js';

const sso = {
  name: 'itsm.example.com', match: ['itsm.example.com'],
  auth: { login_url: 'https://sso.example.com/login', login_hosts: ['*.passport.example.com'] },
};
const sameHost = {
  name: 'zhihu.example.com', match: ['www.example.com'],
  auth: { login_url: 'https://www.example.com/signin' },
};
const rootLogin = { name: 'mail.example.com', match: ['mail.example.com'], auth: { login_url: 'https://mail.example.com/' } };
const undeclared = { name: 'erp.example.com', match: ['erp.example.com'], runtime_allowed_hosts: ['cdn.example.com'] };

test('declared login hosts, the login URL host and its path are login pages', () => {
  assert.deepEqual(loginHosts(sso).sort(), ['*.passport.example.com', 'sso.example.com']);
  assert.equal(isLoginPageUrl(sso, 'https://sso.example.com/anything?return=1'), true);
  assert.equal(isLoginPageUrl(sso, 'https://cn.passport.example.com/'), true);
  assert.equal(isLoginPageUrl(sso, 'https://itsm.example.com/tickets'), false);
  // A login path on a business host.
  assert.deepEqual(loginHosts(sameHost), []);
  assert.equal(isLoginPageUrl(sameHost, 'https://www.example.com/signin?next=%2F'), true);
  assert.equal(isLoginPageUrl(sameHost, 'https://www.example.com/signin/sms'), true);
  assert.equal(isLoginPageUrl(sameHost, 'https://www.example.com/signing-up'), false);
  assert.equal(isLoginPageUrl(sameHost, 'https://www.example.com/'), false);
});

test('a site-root login URL only counts inside the login flow', () => {
  assert.equal(isLoginPageUrl(rootLogin, 'https://mail.example.com/'), false);
  assert.equal(isLoginPageUrl(rootLogin, 'https://mail.example.com/', { root: true }), true);
  assert.equal(isLoginPageUrl(rootLogin, 'https://mail.example.com/cgi-bin/frame', { root: true }), false);
});

test('undeclared SSO redirects are recognised only outside the package hosts', () => {
  assert.equal(isLoginPageUrl(undeclared, 'https://passport.corp.example.org/cas/login'), true);
  assert.equal(isLoginPageUrl(undeclared, 'https://idp.example.org/oauth/authorize?client=1'), true);
  assert.equal(isLoginPageUrl(undeclared, 'https://login.example.org/'), true);
  // The package's own pages, even with "login" in the path, are business pages without a declaration.
  assert.equal(isLoginPageUrl(undeclared, 'https://erp.example.com/login-history'), false);
  assert.equal(isLoginPageUrl(undeclared, 'https://erp.example.com/login'), false);
  assert.equal(isLoginPageUrl(undeclared, 'https://cdn.example.com/login'), false);
  assert.equal(isLoginPageUrl(undeclared, 'https://other.example.org/products'), false);
  assert.equal(isLoginPageUrl(undeclared, 'chrome://newtab/'), false);
});

test('the login flow starts from the declared page, else the homepage or first host', () => {
  assert.equal(loginStartUrl(sso), 'https://sso.example.com/login');
  assert.equal(loginStartUrl({ ...undeclared, homepage_url: 'https://erp.example.com/home' }), 'https://erp.example.com/home');
  assert.equal(loginStartUrl({ ...undeclared, homepage_url: 'https://elsewhere.example.net/' }), 'https://erp.example.com/');
  assert.equal(displayUrl('https://sso.example.com/login?ticket=fixture#x'), 'https://sso.example.com/login');
});

test('cookie checks support all, any, equals and not', () => {
  const jar = [{ name: 'sid', value: 'fixture' }, { name: 'guest', value: 'F' }, { name: 'empty', value: '' }];
  assert.equal(evaluateCookieCheck({ all: ['sid'] }, jar), true);
  assert.equal(evaluateCookieCheck({ all: ['sid', 'empty'] }, jar), false);
  assert.equal(evaluateCookieCheck({ any: ['missing', 'sid'] }, jar), true);
  assert.equal(evaluateCookieCheck({ equals: { guest: 'F' } }, jar), true);
  assert.equal(evaluateCookieCheck({ equals: { guest: 'T' } }, jar), false);
  assert.equal(evaluateCookieCheck({ all: ['sid'], not: { guest: 'F' } }, jar), false);
});

test('structured auth fields keep only the site and phase', () => {
  const error = authRequiredError({ site: 'itsm.example.com', pageUrl: 'https://sso.example.com/login', phase: 'navigation' });
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.deepEqual(authErrorFields(error), { site: 'itsm.example.com', phase: 'navigation', pageUrl: 'https://sso.example.com/login' });
  const thrown = Object.assign(new Error('x'), { code: 'AUTH_REQUIRED', details: { phase: 'weird', secret: 'fixture' } });
  assert.deepEqual(authErrorFields(thrown, sso), { site: 'itsm.example.com', phase: 'handler' });
  assert.equal(authErrorFields(new Error('other')), null);
  assert.equal(siteDisplayName({ name: 'a.example.com', i18n: { zh: { name: '示例' } } }), '示例');
  assert.equal(siteDisplayName({ name: 'a.example.com', auth: { display_name: '示例站' } }), '示例站');
});
