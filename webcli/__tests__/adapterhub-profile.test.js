import { afterEach, describe, expect, it, vi } from 'vitest';
import profile from '../adapterhub-profile.json' with { type: 'json' };
import { listAdapters, publishAdapter, resolveEndpoint } from '../adapterhub-client.js';

const original = process.env.WEBCLI_ADAPTERHUB_ENDPOINT;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (original === undefined) delete process.env.WEBCLI_ADAPTERHUB_ENDPOINT;
  else process.env.WEBCLI_ADAPTERHUB_ENDPOINT = original;
});

describe('AdapterHub deployment endpoint', () => {
  it('uses only the explicitly configured default', () => {
    delete process.env.WEBCLI_ADAPTERHUB_ENDPOINT;
    if (profile.endpoint) expect(resolveEndpoint()).toBe(profile.endpoint.replace(/\/+$/, ''));
    else expect(() => resolveEndpoint()).toThrow('端点为空');
  });
  it('allows remote HTTP, HTTPS and loopback endpoints without profile exceptions', () => {
    for (const endpoint of ['https://hub.example.com/api/', 'http://hub.example.com/adapterhub/', 'http://127.0.0.1:12345/']) {
      process.env.WEBCLI_ADAPTERHUB_ENDPOINT = endpoint;
      expect(resolveEndpoint()).toBe(endpoint.replace(/\/+$/, ''));
    }
  });
  it('rejects non-HTTP protocols and invalid URLs', () => {
    for (const endpoint of ['ftp://hub.example.com', 'file:///tmp/hub', 'data:text/plain,fixture', 'invalid']) {
      process.env.WEBCLI_ADAPTERHUB_ENDPOINT = endpoint;
      expect(() => resolveEndpoint()).toThrow();
    }
  });
});

describe('AdapterHub HTTP requests', () => {
  it.each(['http', 'https'])('publishes over %s while preserving the endpoint path and credentials', async protocol => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', `${protocol}://hub.example.com/adapterhub/`);
    vi.stubEnv('ADAPTERHUB_TOKEN', 'placeholder-adapterhub-token');
    const result = { name: 'example', version: '1.0.0' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', fetchMock);
    const buffer = Buffer.from('placeholder-package');

    await expect(publishAdapter(buffer)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${protocol}://hub.example.com/adapterhub/api/v1/adapters`, expect.objectContaining({
      method: 'POST', body: buffer, redirect: 'manual',
      headers: expect.objectContaining({ authorization: 'Bearer placeholder-adapterhub-token', 'content-type': 'application/octet-stream' }),
    }));
  });

  it.each(['http', 'https'])('follows a publish redirect to %s', async protocol => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', 'https://hub.example.com/adapterhub/');
    vi.stubEnv('ADAPTERHUB_TOKEN', 'placeholder-adapterhub-token');
    const target = `${protocol}://hub.example.com/adapterhub/upload`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: target } }))
      .mockResolvedValueOnce(Response.json({ published: true }));
    vi.stubGlobal('fetch', fetchMock);
    const buffer = Buffer.from('placeholder-package');

    await expect(publishAdapter(buffer)).resolves.toEqual({ published: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, target, expect.objectContaining({
      method: 'POST', body: buffer,
      headers: expect.objectContaining({ authorization: 'Bearer placeholder-adapterhub-token' }),
    }));
  });

  it.each(['file:///tmp/package.adapt', 'ftp://example.com/package.adapt', 'data:text/plain,fixture'])('rejects non-HTTP redirect %s', async target => {
    vi.stubEnv('WEBCLI_ADAPTERHUB_ENDPOINT', 'http://hub.example.com/adapterhub/');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: target } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAdapters()).rejects.toThrow('重定向必须使用 HTTP 或 HTTPS');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
