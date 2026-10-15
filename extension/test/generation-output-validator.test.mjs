import assert from 'node:assert/strict';
import test from 'node:test';
import { validateGenerationPreviewOutputV2 } from '../background/generation-output-validator.js';

const body = { code: 0, data: { items: [{ id: 'fixture-item', title: 'Fixture lesson' }] } };
const contract = {
  kind: 'captured_sample',
  capturedShape: { rootKind: 'object', containsKinds: ['object', 'array'], rootKeys: ['code', 'data'] },
  verificationFixture: {
    requiredPaths: ['data.items'], types: { 'data.items': 'array' }, notEmpty: ['data.items'],
  },
};
const envelope = (data, overrides = {}) => ({
  ok: true, status: 200, url: 'https://example.com/api/search', data,
  rawText: JSON.stringify(data), ...overrides,
});

test('validates captured business paths inside the generated fetch envelope', () => {
  const result = validateGenerationPreviewOutputV2(envelope(body), contract);
  assert.equal(result.passed, true, JSON.stringify(result.errors));
});

test('keeps direct responses and ordinary data fields on their original path', () => {
  assert.equal(validateGenerationPreviewOutputV2(body, contract).passed, true);
  assert.equal(validateGenerationPreviewOutputV2({ data: body }, contract).passed, false);
});

test('rejects empty and wrong-type business data inside a generated envelope', () => {
  const empty = validateGenerationPreviewOutputV2(envelope({ code: 0, data: { items: [] } }), contract);
  assert.equal(empty.passed, false);
  assert.ok(empty.errors.some(error => error.code === 'OUTPUT_EXPECTED_NON_EMPTY'));
  const wrongType = validateGenerationPreviewOutputV2(envelope({ code: 0, data: { items: 'fixture' } }), contract);
  assert.equal(wrongType.passed, false);
  assert.ok(wrongType.errors.some(error => error.code === 'OUTPUT_FIELD_TYPE_MISMATCH'));
});

test('rejects a failed generated HTTP envelope even when its data matches the capture', () => {
  const result = validateGenerationPreviewOutputV2(envelope(body, { ok: false, status: 503 }), contract);
  assert.equal(result.passed, false);
  assert.ok(result.errors.some(error => error.code === 'OUTPUT_HTTP_ERROR'));
});

test('still inspects the whole generated envelope for sensitive output and HTML', () => {
  assert.equal(validateGenerationPreviewOutputV2(envelope(body, { api_key: 'fixture-only-placeholder' }), contract).passed, false);
  assert.equal(validateGenerationPreviewOutputV2(envelope(body, { rawText: '<!doctype html><title>login</title>' }), contract).passed, false);
});

test('keeps a capture that already has a fetch-shaped envelope at its original level', () => {
  const direct = envelope(body);
  const directContract = {
    kind: 'captured_sample',
    capturedShape: { rootKind: 'object', containsKinds: ['object', 'array'], rootKeys: Object.keys(direct) },
    verificationFixture: { types: { 'data.data.items': 'array' }, notEmpty: ['data.data.items'] },
  };
  assert.equal(validateGenerationPreviewOutputV2(direct, directContract).passed, true);
});

test('accepts search results about login, captcha, and HTML with legacy generated fixtures', () => {
  const legacyContract = {
    ...contract,
    verificationFixture: { ...contract.verificationFixture, source: 'captured_response', mustNotContain: ['login', 'captcha', 'access denied'] },
  };
  for (const title of ['实现登录功能教程', 'Login tutorial', 'Captcha implementation', 'Fix access denied errors', '<html> 标签教程']) {
    const response = { code: 0, data: { items: [{ id: 'fixture-item', title }] } };
    for (const output of [response, envelope(response)]) {
      const result = validateGenerationPreviewOutputV2(output, legacyContract);
      assert.equal(result.passed, true, JSON.stringify({ title, errors: result.errors }));
    }
  }
});

test('rejects actual authentication errors and HTML including wrapped responses', () => {
  for (const response of [
    '请先登录', 'Please log in to continue', '<!doctype html><html><title>Sign in</title></html>',
    { code: 401, message: 'Unauthorized' },
    { code: -1, message: '未登录，请先登录' },
    { error: { message: 'Captcha required' } },
    { error: 'Access denied' },
  ]) {
    for (const output of [response, envelope(response)]) {
      const result = validateGenerationPreviewOutputV2(output);
      assert.equal(result.passed, false, JSON.stringify(response));
      assert.ok(result.errors.some(error => error.code === 'LOGIN_OR_HTML_RESPONSE'));
    }
  }
});

test('continues enforcing explicit business forbidden content assertions', () => {
  const result = validateGenerationPreviewOutputV2(body, {
    ...contract,
    verificationFixture: { ...contract.verificationFixture, mustNotContain: ['Fixture lesson'] },
  });
  assert.ok(result.errors.some(error => error.code === 'OUTPUT_FORBIDDEN_CONTENT'));
  const explicitLogin = validateGenerationPreviewOutputV2({ items: [{ title: 'Login tutorial' }] }, {
    verificationFixture: { source: 'captured_response', mustNotContain: ['login'] },
  });
  assert.ok(explicitLogin.errors.some(error => error.code === 'OUTPUT_FORBIDDEN_CONTENT'));
});
