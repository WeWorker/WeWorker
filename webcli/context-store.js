import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contextKey, ContextError, fail, LIMITS, newState, validateState, expired } from './context-model.js';

const exec = promisify(execFile);
const unresolved = s => s.operationGuards.some(g => ['dispatching', 'unknown', 'acknowledged'].includes(g.status));
const mainName = /^[a-f0-9]{64}\.json$/;
const tmpName = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/;
const DAY = 86400000;
const aclScript = `
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544')
$encodedPaths=$env:WEBCLI_CONTEXT_PERMISSION_PATHS_BASE64
$paths=@($encodedPaths.Split([char]10) | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
foreach($p in $paths) {
  if($env:WEBCLI_CONTEXT_PERMISSION_CREATE -eq '1') {
    $item=Get-Item -LiteralPath $p -Force
    if($item.PSIsContainer) { $acl=New-Object System.Security.AccessControl.DirectorySecurity }
    else { $acl=New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    foreach($v in $allowed) {
      $identity=New-Object System.Security.Principal.SecurityIdentifier($v)
      if($item.PSIsContainer) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
      else { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow') }
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $p -AclObject $acl
  }
  $acl=Get-Acl -LiteralPath $p
  if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner' }
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  if($rules.Count -eq 0) { throw 'empty_acl' }
  foreach($rule in $rules) {
    if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) { throw 'public_acl' }
  }
}
`;

// The alternate root/clock/limits are trusted in-process test seams, never CLI flags or environment overrides.
export class ContextStore {
  constructor({ root = join(homedir(), '.webcli', 'contexts', 'v1'), now = Date.now, limits = {}, beforeReplace } = {}) {
    this.root = resolve(root);
    this.now = now;
    this.limits = { ...LIMITS, ...limits };
    this.beforeReplace = beforeReplace;
  }
  path(name) {
    if (basename(name) !== name || name === '.' || name === '..') fail('context_invalid_path');
    return join(this.root, name);
  }
  async safe(path, directory = false) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('context_unsafe_path');
    return stat;
  }
  async private(paths, create = false) {
    if (process.platform === 'win32') {
      try {
        await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', aclScript], {
          env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
            PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
            WEBCLI_CONTEXT_PERMISSION_PATHS_BASE64: paths.map(path => Buffer.from(path, 'utf8').toString('base64')).join('\n'), WEBCLI_CONTEXT_PERMISSION_CREATE: create ? '1' : '0' },
          windowsHide: true, timeout: 10000, maxBuffer: 4096,
        });
      } catch (e) {
        const error = new ContextError('context_private_permissions_unverified');
        const reason = e.killed ? 'acl_check_timeout' : /FullyQualifiedErrorId\s*:\s*([\w,.-]+)/.exec(e.stderr || '')?.[1] || String(e.code || 'acl_check_failed');
        error.permissionFailure = /^[\w,.-]{1,160}$/.test(reason) ? reason : 'acl_check_failed';
        error.message += ` (${error.permissionFailure})`;
        throw error;
      }
    } else {
      for (const path of paths) {
        if (create) await fs.chmod(path, (await fs.lstat(path)).isDirectory() ? 0o700 : 0o600);
        const stat = await fs.lstat(path);
        if (stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('context_private_permissions_unverified');
      }
    }
  }
  async init() {
    const chain = [];
    for (let p = this.root; p !== dirname(p); p = dirname(p)) chain.unshift(p);
    for (const p of chain) {
      let created = false;
      try { await this.safe(p, true); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        try { await fs.mkdir(p, { mode: 0o700 }); created = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await this.safe(p, true);
      }
      if (created) await this.private([p], true);
    }
    await this.private([this.root]);
  }
  async readJSON(path, limit, { ownerCreated = false } = {}) {
    const stat = await this.safe(path);
    if (stat.size > limit) fail('context_limit');
    if (!ownerCreated) await this.private([path]);
    let value;
    try { value = JSON.parse(await fs.readFile(path, 'utf8')); }
    catch (e) { if (e instanceof SyntaxError) fail('context_corrupt'); throw e; }
    return value;
  }
  async writeNew(path, data) {
    const handle = await fs.open(path, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    // New exclusive files inherit the verified root's protected inheritable Windows ACL.
    // POSIX open('wx', 0600) already prevents group/other access.
  }
  async lock(name, busy = 'context_busy') {
    const path = this.path(name);
    try { await fs.mkdir(path, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') { await this.safe(path, true); fail(busy, 4); } throw e; }
    const owner = { version: 1, pid: process.pid, token: randomUUID(), createdAt: this.now() };
    try {
      await this.writeNew(join(path, 'owner.json'), JSON.stringify(owner));
    } catch (e) {
      // Only the directory just created by this invocation is eligible here.
      try { await fs.unlink(join(path, 'owner.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rmdir(path);
      throw e;
    }
    return { path, owner };
  }
  async unlock(lock) {
    await this.safe(lock.path, true);
    const actual = await this.readJSON(join(lock.path, 'owner.json'), 2048, { ownerCreated: true });
    if (actual.token !== lock.owner.token || actual.pid !== process.pid) fail('context_lock_owner_changed');
    await fs.unlink(join(lock.path, 'owner.json'));
    await fs.rmdir(lock.path);
  }
  async read(key) {
    try { return validateState(await this.readJSON(this.path(`${key}.json`), this.limits.file)); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async usage() {
    let files = 0, mainBytes = 0, rootBytes = 0;
    const names = await fs.readdir(this.root);
    for (const name of names) {
      const path = this.path(name), stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) fail('context_unsafe_path');
      if (stat.isFile()) {
        rootBytes += stat.size;
        if (mainName.test(name)) { files++; mainBytes += stat.size; }
      } else if (stat.isDirectory() && (name === 'maintenance.lock' || /^[a-f0-9]{64}\.lock$/.test(name))) {
        for (const child of await fs.readdir(path)) rootBytes += (await this.safe(join(path, child))).size;
      } else fail('context_unsafe_path');
    }
    return { files, mainBytes, rootBytes };
  }
  async atomic(key, state, { maintenanceHeld = false, increment = true } = {}) {
    if (increment) state.revision++;
    validateState(state);
    const data = JSON.stringify(state), size = Buffer.byteLength(data);
    if (size > this.limits.file) fail('context_limit');
    const maintenance = maintenanceHeld ? null : await this.lock('maintenance.lock', 'storage_busy');
    let tmp;
    try {
      if ((await fs.readdir(this.root)).some(n => n.startsWith(`${key}.`) && n.endsWith('.tmp'))) fail('context_needs_recovery');
      // The main was validated once under this session lock; only its allocation size is needed now.
      let oldSize = 0, exists = true;
      try { oldSize = (await this.safe(this.path(`${key}.json`))).size; }
      catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
      const usage = await this.usage();
      if (usage.files + (exists ? 0 : 1) > this.limits.files || usage.mainBytes - oldSize + size > this.limits.mainBytes ||
          usage.rootBytes + size + 4096 > this.limits.rootBytes) fail('context_store_full');
      tmp = this.path(`${key}.${randomUUID()}.tmp`);
      await this.writeNew(tmp, data);
      await this.beforeReplace?.();
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(tmp, this.path(`${key}.json`)); break; }
        catch (e) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt === 3) throw e;
          await new Promise(r => setTimeout(r, 25 * (attempt + 1)));
        }
      }
      tmp = null;
      if (process.platform !== 'win32') {
        const handle = await fs.open(this.root, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      }
    } finally {
      // Failure leaves an uncommitted tmp for explicit recovery, never a replacement main.
      if (maintenance) await this.unlock(maintenance);
    }
  }
  async transaction(id, update, { create = true, epoch, revision, collect = true } = {}) {
    const key = contextKey(id);
    await this.init();
    const lock = await this.lock(`${key}.lock`);
    let result;
    try {
      let state = await this.read(key);
      if (!state && !create) fail('context_not_found');
      const created = !state;
      state ??= newState(this.now());
      if ((epoch !== undefined && epoch !== state.sessionEpoch) || (revision !== undefined && revision !== state.revision)) fail('context_revision_conflict', 4);
      result = await update(state, { created, persist: () => this.atomic(key, state) });
      await this.atomic(key, state);
    } finally { await this.unlock(lock); }
    if (collect) await this.collect().catch(() => {});
    return result;
  }
  async status(id) {
    const key = contextKey(id);
    await this.init();
    const lock = await this.lock(`${key}.lock`);
    try {
      const s = await this.read(key);
      return s ? { contextProtocolVersion: 1, state: expired(s, this.now()) ? 'expired' : 'active', epoch: s.sessionEpoch,
        revision: s.revision, rounds: s.rounds.length, unresolved: s.operationGuards.filter(g => ['dispatching', 'unknown', 'acknowledged'].includes(g.status)).length } : { state: 'missing', rounds: 0, unresolved: 0 };
    } finally { await this.unlock(lock); }
  }
  async verifyOperation(id, { epoch, operationId, verify } = {}) {
    if (typeof epoch !== 'string' || typeof operationId !== 'string' || typeof verify !== 'function') fail('context_verification_required', 2);
    return this.transaction(id, async state => {
      const guard = state.operationGuards.find(g => g.operationId === operationId);
      if (!guard || !['dispatching', 'unknown', 'acknowledged', 'verified_success', 'failed'].includes(guard.status)) fail('context_stale_operation', 4);
      // Only trusted host code supplies this lookup; no CLI command accepts verification JSON.
      const proof = await verify(Object.freeze({ ...guard }));
      if (proof?.operationId !== operationId || proof.requestId !== guard.requestId || proof.profile !== guard.profile ||
          !['verified_success', 'failed'].includes(proof.status) ||
          (['verified_success', 'failed'].includes(guard.status) && proof.status !== guard.status)) fail('context_verification_failed');
      guard.status = proof.status; guard.verifiedAt = this.now();
      return { operationId, status: guard.status, revision: state.revision + 1 };
    }, { create: false, epoch });
  }
  async recover(id) {
    const key = contextKey(id);
    await this.init();
    const maintenance = await this.lock('maintenance.lock', 'storage_busy');
    let lock;
    try {
      const path = this.path(`${key}.lock`);
      let exists = true;
      try { await this.safe(path, true); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
      if (exists) {
        let owner;
        try { owner = await this.readJSON(join(path, 'owner.json'), 2048); }
        catch (e) { if (e.code === 'ENOENT') fail('context_needs_recovery'); throw e; }
        if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') fail('context_needs_recovery');
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (e) { if (e.code === 'ESRCH') dead = true; }
        if (!dead) fail('context_busy', 4);
        if (JSON.stringify(await this.readJSON(join(path, 'owner.json'), 2048)) !== JSON.stringify(owner)) fail('context_needs_recovery');
        await fs.unlink(join(path, 'owner.json')); await fs.rmdir(path);
      }
      lock = await this.lock(`${key}.lock`);
      const state = await this.read(key);
      let recovered = 0;
      for (const name of await fs.readdir(this.root)) {
        if (tmpName.test(name) && name.startsWith(`${key}.`)) { await this.safe(this.path(name)); await fs.unlink(this.path(name)); recovered++; }
      }
      if (state) {
        for (const g of state.operationGuards) if (g.status === 'dispatching') g.status = 'unknown';
        await this.atomic(key, state, { maintenanceHeld: true });
      }
      return { state: state ? 'recovered' : 'missing', temporaryFilesRemoved: recovered, unresolved: state ? unresolved(state) : false };
    } finally { if (lock) await this.unlock(lock); await this.unlock(maintenance); }
  }
  async collect({ dryRun = false } = {}) {
    await this.init();
    const maintenance = await this.lock('maintenance.lock', 'storage_busy');
    const started = this.now(), budgetStart = performance.now(), counts = { examined: 0, expired: 0, removed: 0, temporaryFilesRemoved: 0, skipped: 0, dryRun };
    try {
      let cursor = { lastRun: 0, after: '' };
      try { cursor = await this.readJSON(this.path('gc-state.json'), 2048); }
      catch (e) { if (e.code !== 'ENOENT') return { ...counts, skipped: 1 }; }
      if (!Number.isFinite(cursor.lastRun) || typeof cursor.after !== 'string') return { ...counts, skipped: 1 };
      if (!dryRun && started >= cursor.lastRun && started - cursor.lastRun < 900000) return counts;
      const entries = await fs.readdir(this.root);
      const names = [...new Set(entries.filter(n => mainName.test(n) || tmpName.test(n)).map(n => `${n.slice(0, 64)}.json`))].sort();
      const ordered = [...names.filter(n => n > cursor.after), ...names.filter(n => n <= cursor.after)];
      for (const name of ordered) {
        // A single filesystem/ACL operation may exceed the budget; allow one item so the cursor still advances.
        if (counts.examined >= 50 || (counts.examined > 0 && performance.now() - budgetStart >= 100)) break;
        counts.examined++; cursor.after = name;
        let lock;
        try {
          const key = name.slice(0, -5);
          lock = await this.lock(`${key}.lock`);
          const s = await this.read(key);
          if (s && unresolved(s)) { counts.skipped++; continue; }
          const temporary = entries.filter(n => tmpName.test(n) && n.startsWith(`${key}.`));
          // Holding the context lock proves no protocol writer owns its one uncommitted tmp.
          if (temporary.length > 1) { counts.skipped++; continue; }
          for (const tmp of temporary) {
            await this.safe(this.path(tmp));
            await this.private([this.path(tmp)]);
            if (!dryRun) await fs.unlink(this.path(tmp));
            counts.temporaryFilesRemoved++;
          }
          if (!s || !expired(s, this.now())) { counts.skipped++; continue; }
          counts.expired++;
          if (s.status === 'expired' && Number.isFinite(s.expiredAt) && this.now() >= s.expiredAt + 7 * DAY) {
            if (!dryRun) await fs.unlink(this.path(name));
            counts.removed++;
          } else if (!dryRun && s.status !== 'expired') {
            const marker = newState(s.createdAt);
            Object.assign(marker, { status: 'expired', sessionEpoch: s.sessionEpoch, revision: s.revision,
              lastInteractionAt: s.lastInteractionAt, expiredAt: this.now() });
            await this.atomic(key, marker, { maintenanceHeld: true });
          }
        } catch (e) { if (e instanceof ContextError || e.code === 'ENOENT') counts.skipped++; else throw e; }
        finally { if (lock) await this.unlock(lock); }
      }
      if (!dryRun) {
        // Metadata is bounded and contains no user data; do not promote a partial cursor after a crash.
        const path = this.path('gc-state.json');
        try { await this.safe(path); await this.private([path]); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        const handle = await fs.open(path, 'w', 0o600);
        try { await handle.writeFile(JSON.stringify({ lastRun: started, after: cursor.after })); await handle.sync(); }
        finally { await handle.close(); }
      }
      return counts;
    } finally { await this.unlock(maintenance); }
  }
}
