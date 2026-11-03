import { expect, it, vi } from 'vitest';
import { callDevelopment } from '../development-client.js';

const digest = 'a'.repeat(64), reviewId = 'b'.repeat(64);
const env = { WEWORKER_EXPLORATION_INSTANCE_ID: 'exploration-placeholder',
  WEWORKER_BACKEND_INSTANCE_ID: 'backend-placeholder', WEWORKER_HTTP_TOKEN: 'test-token-placeholder' };
const args = { toolkit_id: 'demo', expected_digest: digest };
const review = { name: 'demo.example.com', version: '1.0.0', profile: 'public', digest, reviewId,
  permissions: ['runtime:wewright'], addedPermissions: [], sourceChange: false, downgrade: false,
  overwritesNewerBase: false, applied: false, changedTools: ['read_page'] };
const status = () => Response.json({ service: 'weworker-backend', runtime_mode: 'managed', backend_instance_id: env.WEWORKER_BACKEND_INSTANCE_ID });
const apply = { ...args, review_id: reviewId, confirmed: true };
const receipt = { name: review.name, version: '1.0.0', digest, revision: 1, refreshed: true, acknowledged: true };
const mock = (value = review) => vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(Response.json(value));

it('reviews through the authenticated desktop host without installing', async () => {
  const fetch = mock();
  const result = await callDevelopment('review', args, { fetch, env });
  expect(result).toMatchObject({ ok: true, data: { ...review, review_id: reviewId } });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8765/status');
  expect(fetch.mock.calls[1][0]).toBe('http://127.0.0.1:8765/api/website-exploration/toolkits/demo/install-review');
  for (const [, options] of fetch.mock.calls) {
    expect(options.method).toBe('GET');
    expect(options.headers['X-WeWorker-Auth']).toBe(env.WEWORKER_HTTP_TOKEN);
    expect(options.redirect).toBe('error');
  }
  expect(JSON.stringify(result)).not.toContain(env.WEWORKER_HTTP_TOKEN);
});

it('requires credentials and confirmation before contacting the host', async () => {
  const fetch = vi.fn();
  expect((await callDevelopment('review', args, { fetch, env: { WEWORKER_EXPLORATION_INSTANCE_ID: 'placeholder' } })).error.code).toBe('HOST_AUTH_REQUIRED');
  expect((await callDevelopment('apply', { ...apply, confirmed: false }, { fetch, env })).error.code).toBe('CONFIRMATION_REQUIRED');
  expect((await callDevelopment('apply', { ...apply, accept_changes: 'true' }, { fetch, env })).error.code).toBe('INVALID_ARGUMENT');
  expect((await callDevelopment('review', { ...args, toolkit_id: '../demo' }, { fetch, env })).error.code).toBe('INVALID_ARGUMENT');
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects unknown desktop instances and failed authentication', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ service: 'weworker-backend', runtime_mode: 'managed', backend_instance_id: 'other' }));
  expect((await callDevelopment('review', args, { fetch, env })).error.code).toBe('HOST_IDENTITY_MISMATCH');
  expect(fetch).toHaveBeenCalledTimes(1);
  const denied = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 }));
  expect((await callDevelopment('review', args, { fetch: denied, env })).error.code).toBe('HOST_AUTH_FAILED');
});

it('refuses changed packages and stale review IDs before posting apply', async () => {
  for (const [value, error] of [[{ ...review, digest: 'c'.repeat(64) }, 'STALE_PACKAGE'], [{ ...review, reviewId: 'c'.repeat(64) }, 'STALE_REVIEW']]) {
    const fetch = mock(value);
    expect((await callDevelopment('apply', apply, { fetch, env })).error.code).toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  }
});

it.each(['sourceChange', 'downgrade', 'addedPermissions', 'overwritesNewerBase'])('requires explicit approval of %s', async field => {
  const changed = { ...review, [field]: field === 'addedPermissions' ? ['host:example.org'] : true };
  const fetch = mock(changed);
  expect((await callDevelopment('apply', apply, { fetch, env })).error.code).toBe('INSTALL_CHANGES_NOT_ACCEPTED');
  expect(fetch).toHaveBeenCalledTimes(2);
  const accepted = mock(changed).mockResolvedValueOnce(Response.json(receipt));
  expect((await callDevelopment('apply', { ...apply, accept_changes: true }, { fetch: accepted, env })).ok).toBe(true);
});

it('applies only the original review and reports all completion stages', async () => {
  const fetch = mock().mockResolvedValueOnce(Response.json(receipt));
  expect(await callDevelopment('apply', apply, { fetch, env })).toMatchObject({ ok: true, data: { ...receipt, installed: true, applied: true } });
  expect(fetch.mock.calls[2][0]).toBe('http://127.0.0.1:8765/api/website-exploration/toolkits/demo/install-apply');
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ reviewId, acceptChanges: false });
});

it.each(['refreshed', 'acknowledged'])('does not hide partial installation when %s fails', async field => {
  const fetch = mock().mockResolvedValueOnce(Response.json({ ...receipt, [field]: false }));
  expect(await callDevelopment('apply', apply, { fetch, env })).toMatchObject({ ok: false, error: { code: 'APPLY_INCOMPLETE' }, data: { installed: true, applied: false, [field]: false } });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('never retries after a lost installation response or changed host review', async () => {
  const broken = mock().mockRejectedValueOnce(new Error('private transport information'));
  const result = await callDevelopment('apply', apply, { fetch: broken, env });
  expect(result.error.code).toBe('OUTCOME_UNKNOWN');
  expect(JSON.stringify(result)).not.toContain('private');
  expect(broken).toHaveBeenCalledTimes(3);
  const conflict = mock().mockResolvedValueOnce(Response.json({ detail: 'Review changed' }, { status: 409 }));
  expect((await callDevelopment('apply', apply, { fetch: conflict, env })).error.code).toBe('INSTALL_APPLY_FAILED');
  expect(conflict).toHaveBeenCalledTimes(3);
});

it('does not report success for a mismatched receipt', async () => {
  const fetch = mock().mockResolvedValueOnce(Response.json({ ...receipt, digest: 'c'.repeat(64) }));
  expect((await callDevelopment('apply', apply, { fetch, env })).error.code).toBe('OUTCOME_UNKNOWN');
});
