import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextStore } from '../context-store.js';
import { contextKey } from '../context-model.js';

const fault = vi.hoisted(() => ({ stage: null }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal();
  return { ...real, open: async (path, ...args) => {
    const handle = await real.open(path, ...args);
    if (/\.[a-f0-9-]{36}\.tmp$/.test(String(path))) {
      for (const method of ['writeFile', 'sync', 'close']) {
        const original = handle[method].bind(handle);
        handle[method] = async (...values) => {
          if (fault.stage !== method) return original(...values);
          if (method === 'writeFile') await original(String(values[0]).slice(0, 12));
          if (method === 'close') await original();
          throw Object.assign(Error(`injected_${method}`), { code: 'EIO' });
        };
      }
    }
    return handle;
  } };
});

let sandbox, index = 0;
beforeAll(async () => { sandbox = await fs.mkdtemp(join(tmpdir(), 'webcli-context-fault-test-')); });
afterEach(() => { fault.stage = null; });
afterAll(async () => {
  expect(resolve(sandbox).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))).toBe(true);
  expect(sandbox.split(/[\\/]/).at(-1)).toMatch(/^webcli-context-fault-test-/);
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('atomic persistence I/O failures', () => {
  it.each(['writeFile', 'sync', 'close'])('preserves the old main when tmp %s fails', async stage => {
    const s = new ContextStore({ root: join(sandbox, `store-${index++}`) });
    const tx = update => s.transaction('id', update, { collect: false });
    await tx(() => {});
    const path = s.path(`${contextKey('id')}.json`), before = await fs.readFile(path, 'utf8');
    fault.stage = stage;
    await expect(tx(state => { state.lastInteractionAt++; })).rejects.toThrow(`injected_${stage}`);
    fault.stage = null;
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.readdir(s.root)).filter(n => n.endsWith('.tmp'))).toHaveLength(1);
    await expect(tx(() => {})).rejects.toMatchObject({ code: 'context_needs_recovery' });
    await s.recover('id');
    expect((await s.read(contextKey('id'))).lastInteractionAt).toBe(JSON.parse(before).lastInteractionAt);
  }, 120000);
});
