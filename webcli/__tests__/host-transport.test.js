import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readHostConfiguration, requestHost, hasHostConfiguration } from '../host-client.js';
import vm from 'node:vm';
import { runHostPageAdapter, isPageCommand } from '../host-page.js';
import { runHostBackgroundAdapter, callHost } from '../host-call.js';
import { installAdapter } from '../adapter-install-store.js';
import { resolveAdapterCall } from '../adapter-host.js';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.unstubAllEnvs(); });
async function server(handle) {
  const instance = createServer(handle);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => { instance.closeAllConnections(); return new Promise(resolve => instance.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${instance.address().port}/webcli/v1`, token: 'a'.repeat(64) };
}
async function cli(command, config, args = {}, entry = 'index.js') {
  const root = mkdtempSync(join(tmpdir(), 'webcli-host-cli-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  try {
    return await promisify(execFile)(process.execPath, [resolve(entry), ...command, '--args', JSON.stringify(args)], {
      timeout: 5000, env: { ...process.env, HOME: root, WEBCLI_HOST_ENDPOINT: config.endpoint, WEBCLI_HOST_TOKEN: config.token },
    });
  } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

describe('explicit browser host transport', () => {
  it('selects conditional execution from argument presence without converting invalid values', () => {
    const command = { runtime: 'extension', execution: { type: 'api', runtime: 'background', pageWhenAbsent: 'record' } };
    expect(isPageCommand(command, {})).toBe(true);
    for (const record of ['', null, false, 'fixture-id']) expect(isPageCommand(command, { record })).toBe(false);
  });
  it('keeps the default route and rejects partial, non-loopback and malformed configuration', () => {
    expect(hasHostConfiguration({})).toBe(false);
    expect(readHostConfiguration({})).toBeNull();
    for (const endpoint of ['', 'https://127.0.0.1:1234/webcli/v1', 'http://example.com:1234/webcli/v1', 'http://127.0.0.1:1234/webcli/v1?x=1']) {
      expect(() => readHostConfiguration({ WEBCLI_HOST_ENDPOINT: endpoint, WEBCLI_HOST_TOKEN: 'a'.repeat(64) })).toThrow(/loopback/);
    }
    expect(() => readHostConfiguration({ WEBCLI_HOST_TOKEN: 'a'.repeat(64) })).toThrow();
  });
  it.each(['index.js', 'npm-entry.js'])('runs %s and sends one authenticated host call without starting Bridge', async entry => {
    const received = [];
    const config = await server(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      res.end(JSON.stringify({ schemaVersion: 1, ok: true, result: { host: 'fixture' } }));
    });
    const result = await cli(['call', 'browser.doctor'], config, {}, entry);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { host: 'fixture' } });
    expect(result.stderr).not.toMatch(/Bridge|starting/i);
    expect(received).toEqual([{ auth: `Bearer ${config.token}`, body: { operation: 'browser', command: 'doctor', args: {}, schemaVersion: 1 } }]);
  });
  it('fails closed for dead hosts and lifecycle commands', async () => {
    const config = await server((_req, res) => res.end('{}'));
    await cleanup.shift()();
    const result = await cli(['call', 'browser.open'], config, { url: 'https://example.com' });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'HOST_UNAVAILABLE' } });
    expect(result.stderr).not.toMatch(/Bridge not running/);
    const lifecycle = await cli(['service', 'start'], config);
    expect(lifecycle.code).toBe(1);
    expect(lifecycle.stderr).toMatch(/Host mode only/);
  });
  it('routes help flags to host capabilities instead of advertising extension-only commands', async () => {
    const received = [];
    const config = await server(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks)));
      res.end(JSON.stringify({ schemaVersion: 1, ok: true, result: { commands: ['doctor'] } }));
    });
    const result = await cli(['call', 'browser.open', '--help'], config);
    expect(JSON.parse(result.stdout).result.commands).toEqual(['doctor']);
    expect(received[0].command).toBe('help');
  });
  it('does not retry timeouts or invalid protocol responses', async () => {
    let calls = 0;
    const config = await server(() => { calls++; });
    await expect(requestHost({ operation: 'browser' }, { config, timeoutMs: 30 })).rejects.toMatchObject({ code: 'HOST_TIMEOUT' });
    expect(calls).toBe(1);
    const invalid = await server((_req, res) => res.end('<html>unexpected</html>'));
    await expect(requestHost({}, { config: invalid })).rejects.toMatchObject({ code: 'HOST_PROTOCOL_ERROR' });
  });
  it('executes verified background sources with host fetch and preserves confirmation/type checks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'webcli-host-adapter-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [name, value] of Object.entries({ WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin'), WEWORKER_USER_ADAPTERS_DIR: join(root, 'user'), WEBCLI_ADAPTERS_DIR: join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: join(root, 'data') })) vi.stubEnv(name, value);
    const manifest = { schema_version: 2, name: 'example.com', version: '1.0.0', description: 'Public fixture', match: ['example.com'], commands: [
      { id: 'read', aliases: ['query'], description: 'Read fixture', runtime: 'extension', execution: { type: 'api', runtime: 'background' }, module: 'extension/commands/read.js', safety: 'read', schema: { type: 'object', properties: { limit: { type: 'integer', default: 1 } }, additionalProperties: false } },
      { id: 'write', description: 'Write fixture', runtime: 'extension', execution: { type: 'api', runtime: 'background' }, module: 'extension/commands/write.js', safety: 'write', schema: { type: 'object', properties: {} } },
      { id: 'page', description: 'Read fixture page', runtime: 'extension', module: 'extension/commands/page.js', safety: 'read', schema: { type: 'object', properties: { limit: { type: 'integer', default: 3 } }, additionalProperties: false } },
    ] };
    installAdapter({ files: new Map([
      ['manifest.json', JSON.stringify(manifest)],
      ['extension/commands/read.js', `__webcliRegisterCommand('read', args => {
        setTimeout(() => window.__webmcpWecliRuntime.fetchJson('https://example.com/late'), 50);
        return window.__webmcpWecliRuntime.fetchJson('https://example.com/api?limit=' + args.limit);
      });`],
      ['extension/commands/write.js', `__webcliRegisterCommand('write', () => ({written: true}));`],
      ['extension/commands/page.js', `__webcliRegisterCommand('page', args => ({title:document.title,limit:args.limit}));`],
    ]), origin: { kind: 'local' } });
    const send = vi.fn(async request => request.operation === 'adapter.fetch' ? { ok: true, body: '{"fixture":true}' } : { ready: true });
    expect(await runHostBackgroundAdapter(resolveAdapterCall('example.com.read'), {}, send)).toEqual({ fixture: true });
    expect(send.mock.calls[1][0]).toMatchObject({ operation: 'adapter.fetch', url: 'https://example.com/api?limit=1' });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(send).toHaveBeenCalledTimes(2);
    await expect(runHostBackgroundAdapter(resolveAdapterCall('example.com.read'), { limit: '1' }, send)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(runHostBackgroundAdapter(resolveAdapterCall('example.com.write'), {}, send)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(runHostBackgroundAdapter(resolveAdapterCall('example.com.page'), {}, send)).rejects.toMatchObject({ code: 'HOST_UNSUPPORTED_RUNTIME' });
    const pageSend = vi.fn(async request => {
      if (request.operation !== 'adapter.page') return { ready: true };
      const context = vm.createContext({ document: { title: 'Public fixture title' } });
      vm.runInContext('globalThis.window = globalThis', context);
      return JSON.parse(await vm.runInContext(request.script, context));
    });
    expect(await runHostPageAdapter(resolveAdapterCall('example.com.page'), {}, pageSend)).toEqual({ ok: true, result: { title: 'Public fixture title', limit: 3 } });
    expect(pageSend.mock.calls[0][0]).toMatchObject({ operation: 'adapter.prepare', pageHosts: ['example.com'], write: false });
    expect(pageSend.mock.calls[1][0].initialUrl).toBe('https://example.com/');
    await expect(runHostPageAdapter(resolveAdapterCall('example.com.page'), { unexpected: 1 }, pageSend)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(runHostPageAdapter(resolveAdapterCall('example.com.page'), { limit: '3' }, pageSend)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    const requests = [];
    const aliasHost = await server(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks)); requests.push(request);
      res.end(JSON.stringify({ schemaVersion: 1, ok: true, result: request.operation === 'adapter.fetch' ? { ok: true, body: '{"fixture":true}' } : { ready: true } }));
    });
    vi.stubEnv('WEBCLI_HOST_ENDPOINT', aliasHost.endpoint); vi.stubEnv('WEBCLI_HOST_TOKEN', aliasHost.token);
    expect(await callHost('example.com.query')).toEqual({ fixture: true });
    expect(requests[0]).toMatchObject({ operation: 'adapter.prepare', commandId: 'read', invokedCommand: 'example.com.query' });
    const stale = resolveAdapterCall('example.com.page');
    stale.snapshot.digest = 'a'.repeat(64);
    await expect(runHostPageAdapter(stale, {}, pageSend)).rejects.toMatchObject({ code: 'STALE_ADAPTER_SNAPSHOT' });

  });
});
