import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHostSecretStore } from '../host-secret-store.js';

const roots = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weworker-secret-test-'));
  roots.push(root);
  return path.join(root, 'secrets');
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Stand-in only for tests; production uses the OS-backed protector.
const backend = {
  supported: true,
  protect: async value => Buffer.from(value).toString('base64'),
  unprotect: async value => Buffer.from(value, 'base64').toString('utf8'),
};

describe('host secret store', () => {
  it('isolates scopes and accounts and preserves the exact secret value', async () => {
    const directory = await fixture();
    const a = createHostSecretStore({ scope: 'provider-a', directory, backend });
    const b = createHostSecretStore({ scope: 'provider-b', directory, backend });
    expect(await a.getSecret('user-one')).toBeNull();
    expect(await a.putSecret('user-one', 'example-placeholder-一 ')).toEqual({ created: true });
    expect(await a.getSecret('user-one')).toBe('example-placeholder-一 ');
    expect(await a.getSecret('user-two')).toBeNull();
    expect(await b.getSecret('user-one')).toBeNull();
    await a.putSecret('user-one', 'example-updated-placeholder');
    expect(await a.getSecret('user-one')).toBe('example-updated-placeholder');
    const [filename] = await readdir(directory);
    expect(filename).not.toContain('user-one');
    expect(filename).not.toContain('provider-a');
    expect(await readFile(path.join(directory, filename), 'utf8')).not.toContain('example-placeholder-一');
  });

  it('has one winner across simultaneous create-only writes', async () => {
    const directory = await fixture();
    const stores = Array.from({ length: 12 }, () => createHostSecretStore({ scope: 'provider', directory, backend }));
    const results = await Promise.all(stores.map((store, index) => store.putSecret('account', `example-${index}`, { ifAbsent: true })));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(await stores[0].getSecret('account')).toBe(`example-${results.findIndex(result => result.created)}`);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it('preserves one winner across separate processes', async () => {
    const directory = await fixture();
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('../host-secret-store.js', import.meta.url))).href;
    const script = `
      const { createHostSecretStore } = await import(process.argv[1]);
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const value = Buffer.concat(chunks).toString('utf8');
      const backend = {supported:true, protect:async s=>Buffer.from(s).toString('base64'), unprotect:async s=>Buffer.from(s,'base64').toString('utf8')};
      const store = createHostSecretStore({scope:'provider', directory:process.argv[2], backend});
      process.stdout.write(JSON.stringify(await store.putSecret('account', value, {ifAbsent:true})));
    `;
    function writeInChild(value) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, directory], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Child exited ${code}`)));
        child.stdin.end(value);
      });
    }
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => writeInChild(`example-${i}`)));
    expect(results.filter(result => result.created)).toHaveLength(1);
    const store = createHostSecretStore({ scope: 'provider', directory, backend });
    expect(await store.getSecret('account')).toBe(`example-${results.findIndex(result => result.created)}`);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it('detects corrupt records and does not silently replace them on create-only writes', async () => {
    const directory = await fixture();
    const store = createHostSecretStore({ scope: 'provider', directory, backend });
    await store.putSecret('account', 'example-placeholder');
    const [filename] = await readdir(directory);
    await writeFile(path.join(directory, filename), 'invalid-ciphertext');
    await expect(store.getSecret('account')).rejects.toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
    expect(await store.putSecret('account', 'example-new', { ifAbsent: true })).toEqual({ created: false });
    await expect(store.getSecret('account')).rejects.toMatchObject({ code: 'SECRET_STORE_CORRUPT' });
  });

  it('returns sanitized errors and fails closed on unsupported platforms', async () => {
    const directory = await fixture();
    const unsupported = createHostSecretStore({ scope: 'provider', directory, backend: { supported: false } });
    await expect(unsupported.getSecret('account')).rejects.toMatchObject({ code: 'SECRET_STORE_UNSUPPORTED' });
    await expect(unsupported.putSecret('account', 'example-secret')).rejects.toMatchObject({ code: 'SECRET_STORE_UNSUPPORTED' });
    const failing = createHostSecretStore({ scope: 'provider', directory, backend: {
      supported: true, protect: async () => { throw new Error('example-secret'); }, unprotect: async () => '',
    } });
    await expect(failing.putSecret('account', 'example-secret')).rejects.toMatchObject({
      code: 'SECRET_STORE_PROTECT_FAILED', message: 'Host secret could not be protected.',
    });
    expect(() => createHostSecretStore({ scope: '../escape', directory, backend })).toThrow();
    await expect(failing.getSecret('../escape')).rejects.toMatchObject({ code: 'SECRET_STORE_INVALID_ID' });
  });

  it.runIf(process.platform === 'win32')('round-trips a placeholder using real per-user Windows DPAPI', async () => {
    const directory = await fixture();
    const store = createHostSecretStore({ scope: 'provider', directory });
    await store.putSecret('account', 'example-local-only-secret');
    expect(await store.getSecret('account')).toBe('example-local-only-secret');
    const [filename] = await readdir(directory);
    expect(await readFile(path.join(directory, filename), 'utf8')).not.toContain('example-local-only-secret');
  });
});
