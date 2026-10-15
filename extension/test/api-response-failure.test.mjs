import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiResponseFailure } from '../background/api-response-failure.mjs';

test('uses response fields instead of scanning ordinary data and metadata', () => {
  for (const value of [
    { code: 0, message: 'ok', login_url: 'https://example.com/login', data: [{ title: '请先登录提示的实现' }] },
    { code: 0, data: { message: 'Access denied error tutorial', items: [{ id: 'fixture-item' }] } },
    { message: 'Login tutorial' },
    [{ message: 'Unauthorized' }],
  ]) {
    assert.equal(isApiResponseFailure(value), false, JSON.stringify(value));
    assert.equal(isApiResponseFailure(JSON.stringify(value)), false, JSON.stringify(value));
  }
});

test('recognizes document roots and response-level authentication failures', () => {
  for (const value of [
    '\uFEFF <!-- fixture --> <!doctype html><html><title>Continue</title></html>',
    '<html lang="en"><body>Continue</body></html>',
    { statusCode: '403' }, { error: { code: 401 } },
    { message: 'Authentication required' }, { msg: 'Session expired' },
    { error_description: 'Not logged in' }, { detail: '请重新登录后继续' },
  ]) assert.equal(isApiResponseFailure(value), true, JSON.stringify(value));
});

test('bounded classification does not traverse arbitrary records or cyclic objects', () => {
  const cyclic = {}; cyclic.error = cyclic;
  assert.equal(isApiResponseFailure(cyclic), false);
  assert.equal(isApiResponseFailure({ data: { items: [{ message: 'Please sign in' }] } }), false);
});
