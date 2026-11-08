import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { createHostRuntime } from '../host-runtime.js';

describe('host Adapter runtime compatibility', () => {
  for (const serialized of [false, true]) {
    const create = serialized ? vm.runInNewContext(`(${createHostRuntime.toString()})`) : createHostRuntime;
    it(`preserves response bodies and default request headers (serialized=${serialized})`, async () => {
      const request = vi.fn().mockResolvedValueOnce({ ok: true, body: '{"value":1}' })
        .mockResolvedValueOnce({ ok: true, headers: { 'Content-Type': 'application/json' }, body: 'false' })
        .mockResolvedValueOnce({ ok: true, body: 'plain response' })
        .mockResolvedValueOnce({ ok: true, headers: { 'content-type': 'application/json' }, body: '{invalid' })
        .mockResolvedValueOnce({ ok: true, status: 204, body: '' });
      const runtime = create('example.com', 'example.com', request);
      expect(await runtime.fetchJson('https://example.com/api')).toEqual({ value: 1 });
      expect(request.mock.calls[0]).toEqual(['backend_fetch', { url: 'https://example.com/api', options: { method: 'GET', headers: { Accept: 'application/json' } } }]);
      expect(await runtime.fetchJson('https://example.com/api', { method: 'POST', headers: { Accept: 'text/plain' }, body: '{}' })).toBe(false);
      expect(request.mock.calls[1][1].options).toEqual({ method: 'POST', headers: { Accept: 'text/plain' }, body: '{}' });
      expect(await runtime.fetchJson('https://example.com/api')).toBe('plain response');
      expect(await runtime.fetchJson('https://example.com/api')).toBe('{invalid');
      expect(await runtime.fetchJson('https://example.com/api')).toBe('');
    });
    it(`retains error details for Adapter authentication handling without retry (serialized=${serialized})`, async () => {
      const request = vi.fn().mockResolvedValue({ ok: false, status: 401, body: '{"message":"sign in"}' });
      const runtime = create('example.com', 'example.com', request);
      await expect(runtime.fetchJson('https://example.com/api')).rejects.toMatchObject({ code: 'HTTP_ERROR', details: { status: 401, body: { message: 'sign in' } } });
      expect(request).toHaveBeenCalledTimes(1);
      expect(runtime.createRuntimeError('AUTH_REQUIRED', 'Sign in', { action: 'login' })).toMatchObject({ code: 'AUTH_REQUIRED', details: { action: 'login' } });
    });
  }
});
