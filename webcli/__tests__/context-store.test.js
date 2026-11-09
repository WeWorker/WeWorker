import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContextStore } from '../context-store.js';
import { contextKey, beginRound, commitRound } from '../context-model.js';

let sandbox;
const stores = [];
async function store(options = {}) {
  const root = join(sandbox, `store-${stores.length}`);
  const result = new ContextStore({ root, ...options });
  stores.push(result);
  await result.init();
  return result;
}
const tx = (s, id, f = () => {}) => s.transaction(id, f, { collect: false });
async function child(code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { cwd: resolve('..'), windowsHide: true });
  let stdout = '', stderr = '';
  proc.stdout.on('data', c => { stdout += c; }); proc.stderr.on('data', c => { stderr += c; });
  const status = await new Promise((done, reject) => { proc.once('close', done); proc.once('error', reject); });
  return { status, stdout, stderr };
}
beforeAll(async () => { sandbox = await fs.mkdtemp(join(tmpdir(), 'webcli-context-store-test-')); });

it('verifies private paths with Unicode and shell metacharacters without JSON shell parsing', async () => {
  const s = await store({ root: join(sandbox, "私有 [a] $(name) 'quoted'") });
  await tx(s, 'unicode-path');
  expect((await s.read(contextKey('unicode-path'))).storageVersion).toBe(1);
});
afterAll(async () => {
  const checked = resolve(sandbox);
  expect(checked.startsWith(resolve(tmpdir()) + '\\') || checked.startsWith(resolve(tmpdir()) + '/')).toBe(true);
  expect(checked.split(/[\\/]/).at(-1)).toMatch(/^webcli-context-store-test-/);
  await fs.rm(checked, { recursive: true, force: true });
});

describe('private context file transactions', () => {
  it('rejects path IDs before touching the filesystem', async () => {
    const s = new ContextStore({ root: join(sandbox, 'not-created') });
    await expect(tx(s, '../escape')).rejects.toMatchObject({ code: 'context_invalid_id' });
    await expect(fs.stat(s.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists committed state across independent Node processes without caller JSON', async () => {
    const s = await store({ now: () => 1000 });
    await tx(s, 'uuid1', state => { beginRound(state, '查询请求单', 1000); commitRound(state); });
    const result = await child(`import {ContextStore} from './webcli/context-store.js'; const s=new ContextStore({root:process.argv[1],now:()=>1000}); console.log(JSON.stringify(await s.status('uuid1')));`, [s.root]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'active', revision: 1, rounds: 1 });
    expect(await fs.readdir(s.root)).toEqual([`${contextKey('uuid1')}.json`]);
  }, 90000);
  it('keeps case-sensitive IDs isolated and reports missing without creating history', async () => {
    const s = await store(); await tx(s, 'UUID');
    expect(await s.status('uuid')).toMatchObject({ state: 'missing' });
    expect(await s.status('UUID')).toMatchObject({ revision: 1 });
  }, 90000);
  it('rejects a concurrent process while the real owner is live', async () => {
    const s = await store();
    await tx(s, 'busy', async () => {
      const result = await child(`import {ContextStore} from './webcli/context-store.js'; try {await new ContextStore({root:process.argv[1]}).status('busy')}catch(e){console.log(e.code);process.exitCode=e.exitCode}`, [s.root]);
      expect(result.status).toBe(4); expect(result.stdout.trim()).toBe('context_busy');
      await expect(s.recover('busy')).rejects.toMatchObject({ code: 'context_busy' });
    });
    expect(await s.status('busy')).toMatchObject({ revision: 1 });
  }, 90000);
  it('does not overwrite a changed epoch or revision', async () => {
    const s = await store(); await tx(s, 'revision');
    await expect(s.transaction('revision', () => {}, { revision: 0, collect: false })).rejects.toMatchObject({ code: 'context_revision_conflict' });
    await expect(s.transaction('revision', () => {}, { epoch: 'old', collect: false })).rejects.toMatchObject({ code: 'context_revision_conflict' });
    expect(await s.status('revision')).toMatchObject({ revision: 1 });
  }, 90000);
  it('preserves corrupt and unsupported main files byte for byte', async () => {
    const s = await store(); await tx(s, 'corrupt');
    const path = s.path(`${contextKey('corrupt')}.json`);
    for (const [body, code] of [['{', 'context_corrupt'], ['{"storageVersion":999}', 'context_version_unsupported']]) {
      await fs.writeFile(path, body);
      await expect(tx(s, 'corrupt')).rejects.toMatchObject({ code });
      expect(await fs.readFile(path, 'utf8')).toBe(body);
    }
  }, 90000);
  it('keeps the old committed file after replace failure and never promotes the tmp', async () => {
    const s = await store(); await tx(s, 'atomic');
    const path = s.path(`${contextKey('atomic')}.json`), old = await fs.readFile(path, 'utf8');
    s.beforeReplace = () => { throw new Error('injected_rename_failure'); };
    await expect(tx(s, 'atomic', state => { state.lastInteractionAt++; })).rejects.toThrow('injected_rename_failure');
    expect(await fs.readFile(path, 'utf8')).toBe(old);
    expect((await fs.readdir(s.root)).filter(n => n.endsWith('.tmp'))).toHaveLength(1);
    s.beforeReplace = undefined;
    await expect(tx(s, 'atomic')).rejects.toMatchObject({ code: 'context_needs_recovery' });
    expect(await s.recover('atomic')).toMatchObject({ temporaryFilesRemoved: 1 });
    expect((await fs.readdir(s.root)).filter(n => n.endsWith('.tmp'))).toHaveLength(0);
    expect(await s.status('atomic')).toMatchObject({ revision: 2 });
  }, 90000);
  it.each(['before_replace', 'after_replace'])('exposes a complete committed file after a real process exits %s', async boundary => {
    const s = await store(); await tx(s, 'crash-atomic');
    const path = s.path(`${contextKey('crash-atomic')}.json`), before = await fs.readFile(path, 'utf8');
    const result = await child(`import {ContextStore} from './webcli/context-store.js';
      const s=new ContextStore({root:process.argv[1]});
      if(process.argv[2]==='before_replace') s.beforeReplace=()=>process.exit(23);
      await s.transaction('crash-atomic',async(state,{persist})=>{state.lastInteractionAt=12345;await persist();process.exit(24);},{collect:false});`, [s.root, boundary]);
    expect(result.status).toBe(boundary === 'before_replace' ? 23 : 24);
    const body = await fs.readFile(path, 'utf8');
    if (boundary === 'before_replace') {
      expect(body).toBe(before);
      expect((await fs.readdir(s.root)).filter(n => n.endsWith('.tmp'))).toHaveLength(1);
      await expect(s.recover('crash-atomic')).rejects.toMatchObject({ code: 'storage_busy' });
    } else {
      expect(JSON.parse(body)).toMatchObject({ revision: 2, lastInteractionAt: 12345 });
      expect((await fs.readdir(s.root)).filter(n => n.endsWith('.tmp'))).toHaveLength(0);
      await expect(s.recover('crash-atomic')).resolves.toMatchObject({ state: 'recovered' });
    }
  }, 120000);
  it('does not release a lock whose exact owner token changed', async () => {
    const s = await store(), lock = await s.lock(`${contextKey('owner')}.lock`);
    await fs.writeFile(join(lock.path, 'owner.json'), JSON.stringify({ ...lock.owner, token: 'replacement' }));
    await expect(s.unlock(lock)).rejects.toMatchObject({ code: 'context_lock_owner_changed' });
    expect((await fs.stat(lock.path)).isDirectory()).toBe(true);
  }, 90000);
  it('recovers a genuinely terminated process and converts dispatching to unknown without replay', async () => {
    const s = await store();
    await tx(s, 'crash', state => { state.operationGuards.push({ status: 'dispatching', operationId: 'synthetic' }); });
    const result = await child(`import {ContextStore} from './webcli/context-store.js';import {contextKey} from './webcli/context-model.js';const s=new ContextStore({root:process.argv[1]});await s.init();await s.lock(contextKey('crash')+'.lock');process.exit(0);`, [s.root]);
    expect(result.status).toBe(0);
    const owner = await s.readJSON(join(s.path(`${contextKey('crash')}.lock`), 'owner.json'), 2048);
    expect(owner.pid).not.toBe(process.pid);
    expect(await s.recover('crash')).toMatchObject({ state: 'recovered', unresolved: true });
    const state = await s.read(contextKey('crash'));
    expect(state.operationGuards).toEqual([{ status: 'unknown', operationId: 'synthetic' }]);
  }, 90000);
  it('does not steal an incomplete owner or an old live owner', async () => {
    const s = await store(), lock = await s.lock(`${contextKey('old')}.lock`);
    await fs.writeFile(join(lock.path, 'owner.json'), JSON.stringify({ ...lock.owner, createdAt: 1 }));
    await expect(s.recover('old')).rejects.toMatchObject({ code: 'context_busy' });
    await fs.writeFile(join(lock.path, 'owner.json'), '{}');
    await expect(s.recover('old')).rejects.toMatchObject({ code: 'context_needs_recovery' });
  }, 90000);
  it('keeps a lock with a missing owner for explicit manual recovery', async () => {
    const s = await store(), path = s.path(`${contextKey('missing-owner')}.lock`);
    await fs.mkdir(path);
    await expect(s.recover('missing-owner')).rejects.toMatchObject({ code: 'context_needs_recovery' });
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  }, 90000);
  it('rejects hard-linked main files before reading an external target', async () => {
    const s = await store(), target = join(sandbox, 'hardlink-target');
    await fs.writeFile(target, 'external sentinel');
    await fs.link(target, s.path(`${contextKey('linked')}.json`));
    await expect(s.status('linked')).rejects.toMatchObject({ code: 'context_unsafe_path' });
    expect(await fs.readFile(target, 'utf8')).toBe('external sentinel');
  }, 90000);
  it.skipIf(process.platform !== 'win32')('retries a real Windows sharing conflict without deleting the old main', async () => {
    const s = await store(); await tx(s, 'occupied');
    const path = s.path(`${contextKey('occupied')}.json`), before = await fs.readFile(path, 'utf8');
    let holder, closed;
    s.beforeReplace = async () => {
      holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f=[IO.File]::Open($env:WEBCLI_CONTEXT_TEST_FILE,'Open','Read','Read');[Console]::WriteLine('ready');[Console]::ReadLine() | Out-Null;$f.Dispose()"], {
        env: { ...process.env, WEBCLI_CONTEXT_TEST_FILE: path }, windowsHide: true,
      });
      closed = new Promise((done, reject) => { holder.once('close', done); holder.once('error', reject); });
      await new Promise((done, reject) => {
        const timer = setTimeout(() => reject(Error('holder_start_timeout')), 10000);
        holder.stdout.on('data', data => { if (String(data).includes('ready')) { clearTimeout(timer); done(); } });
        holder.once('error', error => { clearTimeout(timer); reject(error); });
      });
    };
    try { await expect(tx(s, 'occupied')).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EACCES|EBUSY/) }); }
    finally { if (holder) { holder.stdin.end('\n'); await closed; } }
    expect(await fs.readFile(path, 'utf8')).toBe(before);
  }, 90000);
  it('serializes capacity admission and keeps existing state when the last slot is taken', async () => {
    const s = await store({ limits: { files: 1 } }); await tx(s, 'first');
    await expect(tx(s, 'second')).rejects.toMatchObject({ code: 'context_store_full' });
    expect(await s.status('first')).toMatchObject({ revision: 1 });
    expect(await s.status('second')).toMatchObject({ state: 'missing' });
    const lock = await s.lock('maintenance.lock');
    await expect(tx(s, 'first')).rejects.toMatchObject({ code: 'storage_busy' });
    await s.unlock(lock);
  }, 90000);
  it('reserves replacement bytes before creating a tmp', async () => {
    const s = await store({ limits: { rootBytes: 4096 } });
    await expect(tx(s, 'full')).rejects.toMatchObject({ code: 'context_store_full' });
    expect(await fs.readdir(s.root)).toEqual([]);
  }, 90000);
  it('rejects linked roots without reading or changing the target', async () => {
    const target = join(sandbox, 'external-target'), link = join(sandbox, 'linked-store');
    await fs.mkdir(target); await fs.writeFile(join(target, 'sentinel'), 'unchanged');
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(tx(new ContextStore({ root: link }), 'unsafe')).rejects.toMatchObject({ code: 'context_unsafe_path' });
    expect(await fs.readFile(join(target, 'sentinel'), 'utf8')).toBe('unchanged');
  });
  it('checks actual private OS permissions on created state', async () => {
    const s = await store(); await tx(s, 'private');
    await expect(s.private([s.root, s.path(`${contextKey('private')}.json`)])).resolves.toBeUndefined();
    if (process.platform !== 'win32') {
      await fs.chmod(s.path(`${contextKey('private')}.json`), 0o644);
      await expect(s.status('private')).rejects.toMatchObject({ code: 'context_private_permissions_unverified' });
    } else {
      await promisify(execFile)('icacls.exe', [s.path(`${contextKey('private')}.json`), '/grant', '*S-1-1-0:(R)'], { windowsHide: true });
      await expect(s.status('private')).rejects.toMatchObject({ code: 'context_private_permissions_unverified' });
    }
  }, 90000);
});

describe('expiry and bounded collection', () => {
  it('rechecks a scanned candidate under its lock and preserves renewed activity', async () => {
    let now = 1000;
    const s = await store({ now: () => now }); await tx(s, 'renewed'); now += 86400000;
    const key = contextKey('renewed'), originalLock = s.lock.bind(s);
    s.lock = async (...args) => {
      if (args[0] === `${key}.lock`) {
        // Simulate a completed newer commit between candidate discovery and the locked read.
        const path = s.path(`${key}.json`), state = JSON.parse(await fs.readFile(path, 'utf8'));
        state.lastInteractionAt = now; state.revision++;
        await fs.writeFile(path, JSON.stringify(state));
      }
      return originalLock(...args);
    };
    expect(await s.collect()).toMatchObject({ examined: 1, expired: 0 });
    expect((await s.read(key)).status).toBe('active');
    expect(await s.collect()).toMatchObject({ examined: 0 });
  }, 90000);
  it('collects an orphan tmp without a main but leaves non-protocol files alone', async () => {
    const s = await store(); s.beforeReplace = () => { throw Error('injected_before_replace'); };
    await expect(tx(s, 'uncommitted')).rejects.toThrow('injected_before_replace');
    await s.writeNew(s.path('foreign.tmp'), 'sentinel');
    expect(await s.collect()).toMatchObject({ examined: 1, temporaryFilesRemoved: 1 });
    expect(await fs.readdir(s.root)).toEqual(expect.arrayContaining(['foreign.tmp', 'gc-state.json']));
    expect(await fs.readFile(s.path('foreign.tmp'), 'utf8')).toBe('sentinel');
    expect(await s.status('uncommitted')).toMatchObject({ state: 'missing' });
  }, 90000);
  it('collects only unlocked protocol tmp files and dry-run leaves them intact', async () => {
    const s = await store(); await tx(s, 'orphan');
    s.beforeReplace = () => { throw Error('injected_before_replace'); };
    await expect(tx(s, 'orphan')).rejects.toThrow('injected_before_replace');
    s.beforeReplace = undefined;
    const tmp = (await fs.readdir(s.root)).find(n => n.endsWith('.tmp'));
    const before = await fs.readFile(s.path(`${contextKey('orphan')}.json`), 'utf8');
    expect(await s.collect({ dryRun: true })).toMatchObject({ temporaryFilesRemoved: 1 });
    expect(await fs.readFile(s.path(tmp), 'utf8')).not.toBe('');
    const lock = await s.lock(`${contextKey('orphan')}.lock`);
    expect(await s.collect({ dryRun: true })).toMatchObject({ temporaryFilesRemoved: 0, skipped: 1 });
    await s.unlock(lock);
    expect(await s.collect()).toMatchObject({ temporaryFilesRemoved: 1 });
    await expect(fs.stat(s.path(tmp))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(s.path(`${contextKey('orphan')}.json`), 'utf8')).toBe(before);
  }, 120000);
  it('preserves tmp files when the main has unresolved facts or is corrupt', async () => {
    for (const kind of ['unknown', 'corrupt']) {
      const s = await store(); await tx(s, kind, state => { if (kind === 'unknown') state.operationGuards.push({ status: 'unknown' }); });
      s.beforeReplace = () => { throw Error('injected_before_replace'); };
      await expect(tx(s, kind)).rejects.toThrow('injected_before_replace');
      if (kind === 'corrupt') await fs.writeFile(s.path(`${contextKey(kind)}.json`), '{');
      expect(await s.collect()).toMatchObject({ temporaryFilesRemoved: 0 });
      expect((await fs.readdir(s.root)).filter(n => n.endsWith('.tmp'))).toHaveLength(1);
    }
  }, 120000);
  it('status and prune dry-run neither renew nor rewrite expired history', async () => {
    let now = 1000;
    const s = await store({ now: () => now });
    await tx(s, 'expired', state => { beginRound(state, 'synthetic user content', now); commitRound(state); });
    now += 86400000;
    const path = s.path(`${contextKey('expired')}.json`), before = await fs.readFile(path, 'utf8');
    expect(await s.status('expired')).toMatchObject({ state: 'expired' });
    expect(await s.collect({ dryRun: true })).toMatchObject({ expired: 1, dryRun: true });
    expect(await fs.readFile(path, 'utf8')).toBe(before);
    expect((await fs.readdir(s.root)).includes('gc-state.json')).toBe(false);
  }, 90000);
  it('clears expired content into a marker, retains it seven days, then removes only that main', async () => {
    let now = 1000;
    const s = await store({ now: () => now });
    await tx(s, 'gc', state => { beginRound(state, 'synthetic private content', now); commitRound(state); });
    const epoch = (await s.status('gc')).epoch;
    now += 86400000;
    expect(await s.collect()).toMatchObject({ expired: 1, removed: 0 });
    const state = await s.read(contextKey('gc'));
    expect(state).toMatchObject({ status: 'expired', sessionEpoch: epoch, rounds: [] });
    expect(JSON.stringify(state)).not.toContain('synthetic private content');
    now += 6 * 86400000; expect(await s.collect()).toMatchObject({ removed: 0 });
    now += 86400000; expect(await s.collect()).toMatchObject({ removed: 1 });
    expect(await s.status('gc')).toMatchObject({ state: 'missing' });
    await tx(s, 'gc');
    expect((await s.status('gc')).epoch).not.toBe(epoch);
  }, 120000);
  it('preserves unknown facts across idle expiry and does not reclaim a live lock', async () => {
    let now = 1000;
    const s = await store({ now: () => now });
    await tx(s, 'unknown', state => { state.operationGuards.push({ status: 'unknown' }); });
    now += 86400000;
    expect(await s.collect()).toMatchObject({ expired: 0, removed: 0 });
    expect(await s.status('unknown')).toMatchObject({ state: 'expired', unresolved: 1 });
    const lock = await s.lock(`${contextKey('unknown')}.lock`);
    expect(await s.collect({ dryRun: true })).toMatchObject({ skipped: 1 });
    await s.unlock(lock);
  }, 90000);
  it('does not fail a committed transaction because optional maintenance fails', async () => {
    const s = await store(); s.collect = async () => { throw new Error('injected_gc_failure'); };
    await expect(s.transaction('committed', () => 'saved')).resolves.toBe('saved');
    expect(await s.status('committed')).toMatchObject({ revision: 1 });
  }, 90000);
});
