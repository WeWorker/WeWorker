import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostHelpers } from '../host-helpers.js';

const fixture = vi.hoisted(() => ({ selected: null, execute: vi.fn() }));
vi.mock('../host-cli-provider.js', () => ({ executeHostCli: fixture.execute }));
vi.mock('../adapter-host.js', () => ({ resolveAdapterCall: () => fixture.selected }));
const resources = [];
afterEach(() => { for (const close of resources.splice(0)) close(); vi.clearAllMocks(); });

function setup(args = {}, safety = 'read') {
  const match = { adapter: { name: 'example.com', source: 'builtin', manifest: { name: 'example.com', match: ['example.com'] } },
    snapshot: { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' },
    command: { id: 'query', runtime: 'extension', execution: { type: 'api', runtime: 'background' }, safety } };
  fixture.selected = match;
  const send = vi.fn(async () => ({ cookies: [{ name: 'fixture', value: 'placeholder' }] }));
  const controller = new AbortController();
  const helper = createHostHelpers(match, args, send, controller);
  resources.push(helper.close);
  return { helper, send, controller, match };
}

describe('browser host helpers', () => {
  it('uses the reviewed provider gate and refuses duplicate calls and foreign credential scopes', async () => {
    const { helper, send } = setup({ limit: 2 });
    fixture.execute.mockImplementation(async request => {
      expect(request.adapter).toMatchObject({ name: 'example.com', digest: 'a'.repeat(64) });
      await expect(request.credentials.cookies({ url: 'https://unrelated.example.org/' })).rejects.toThrow(/scope/);
      return { count: (await request.credentials.cookies({ url: 'https://example.com/' })).length };
    });
    expect(await helper.request('host_cli_call', { args: { limit: 2 } })).toEqual({ count: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(helper.request('host_cli_call', { args: {} })).rejects.toMatchObject({ code: 'HOST_CLI_ALREADY_CALLED' });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });
  it('retains write argument binding and dispatch evidence without a retired confirmation control', async () => {
    const changed = setup({ value: 1 }, 'write');
    await expect(changed.helper.request('host_cli_call', { args: { value: 2 } })).rejects.toMatchObject({ code: 'HOST_CLI_INVALID_ARGUMENT' });
    expect(fixture.execute).not.toHaveBeenCalled();
    const approved = setup({ value: 1 }, 'write');
    fixture.execute.mockImplementation(async request => { request.markWriteDispatched(); throw new Error('fixture secret must be redacted'); });
    await expect(approved.helper.request('host_cli_call', { args: { value: 1 } })).rejects.toMatchObject({ code: 'HOST_CLI_OUTCOME_UNKNOWN', message: 'Host CLI operation failed; it was not retried.' });
  });
  it('propagates parent cancellation to provider work and removes its IPC listener', async () => {
    const before = process.listenerCount('message');
    const { helper } = setup();
    fixture.execute.mockImplementation(request => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const pending = helper.request('host_cli_call', { args: {} });
    process.emit('message', { type: 'webcli:cancel' });
    await expect(pending).rejects.toMatchObject({ code: 'HOST_CLI_FAILED' });
    helper.close();
    expect(process.listenerCount('message')).toBe(before);
  });
  it('reads only invocation-provided files and preserves existing file helper output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-file-fixture-'));
    resources.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'input.txt');
    writeFileSync(file, 'fixture text');
    const { helper } = setup({ file });
    await expect(helper.request('backend_file_read', { path: join(root, 'unrequested.txt') })).rejects.toMatchObject({ code: 'HOST_FILE_DENIED' });
    expect(await helper.request('backend_file_read', { path: file, encoding: 'utf8' })).toMatchObject({ content: 'fixture text', size: 12 });
    await expect(helper.request('unknown_helper')).rejects.toMatchObject({ code: 'HOST_UNSUPPORTED_HELPER' });
  });
});
