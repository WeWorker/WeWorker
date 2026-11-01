/** Host-only, per-user secret storage; never expose this interface to Adapter code. */
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, link, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { defaultBackend } from './credential-vault.js';
import { createKeychainSecretStore } from './host-keychain-store.js';
import { withHostAccountLock } from './host-account-lock.js';

const MAX_SECRET_BYTES = 64 * 1024;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw fail('SECRET_STORE_INVALID_ID', 'Invalid host secret identifier.');
  }
  return value;
}

function assertBackend(backend) {
  if (backend?.supported !== true || typeof backend.protect !== 'function' || typeof backend.unprotect !== 'function') {
    throw fail('SECRET_STORE_UNSUPPORTED', 'Secure host secret storage is unavailable on this platform.');
  }
}

/**
 * scope is a host-owned constant, not a model or Adapter argument. key is a
 * host-owned account/environment identifier. Neither is placed in the path.
 * putSecret(ifAbsent) is atomic across processes and never replaces a record.
 */
export function createHostSecretStore({
  scope,
  directory = path.join(homedir(), '.webcli', 'host-secrets'),
  backend,
  platform = process.platform,
  keychainLoad,
} = {}) {
  const namespace = assertIdentifier(scope);
  const withAccountLock = (key, fn, options) => withHostAccountLock(JSON.stringify(['host-lifecycle', namespace, assertIdentifier(key)]), fn, options);
  if (platform === 'darwin' && backend === undefined) return Object.freeze({ ...createKeychainSecretStore({scope:namespace, load:keychainLoad}), withAccountLock });
  backend ??= defaultBackend(platform);
  const root = path.resolve(directory);

  function fileFor(key) {
    const id = assertIdentifier(key);
    const digest = createHash('sha256').update(JSON.stringify([namespace, id])).digest('hex');
    return { id, path: path.join(root, `${digest}.secret`) };
  }

  async function ensureDirectory(create) {
    try {
      if (create) await mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid store directory');
      return true;
    } catch (err) {
      if (!create && err?.code === 'ENOENT') return false;
      throw fail('SECRET_STORE_IO', 'Host secret store is unavailable.');
    }
  }

  async function getSecret(key) {
    const file = fileFor(key);
    assertBackend(backend);
    if (!await ensureDirectory(false)) return null;
    let handle;
    try {
      handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CIPHERTEXT_BYTES) {
        throw fail('SECRET_STORE_CORRUPT', 'Host secret record is invalid.');
      }
      const ciphertext = (await handle.readFile('utf8')).trim();
      let record;
      try { record = JSON.parse(await backend.unprotect(ciphertext)); }
      catch { throw fail('SECRET_STORE_CORRUPT', 'Host secret record cannot be decrypted.'); }
      if (record?.version !== 1 || record.scope !== namespace || record.key !== file.id ||
          typeof record.value !== 'string' || !record.value || Buffer.byteLength(record.value) > MAX_SECRET_BYTES) {
        throw fail('SECRET_STORE_CORRUPT', 'Host secret record is invalid.');
      }
      return record.value;
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      if (err?.code === 'SECRET_STORE_CORRUPT') throw err;
      throw fail('SECRET_STORE_IO', 'Host secret record could not be read.');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function putSecret(key, value, { ifAbsent = false } = {}) {
    const file = fileFor(key);
    assertBackend(backend);
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
      throw fail('SECRET_STORE_INVALID_VALUE', 'Invalid host secret value.');
    }
    if (typeof ifAbsent !== 'boolean') throw fail('SECRET_STORE_INVALID_VALUE', 'Invalid host secret write mode.');
    let ciphertext;
    try { ciphertext = await backend.protect(JSON.stringify({ version: 1, scope: namespace, key: file.id, value })); }
    catch { throw fail('SECRET_STORE_PROTECT_FAILED', 'Host secret could not be protected.'); }
    if (typeof ciphertext !== 'string' || !ciphertext || Buffer.byteLength(ciphertext) > MAX_CIPHERTEXT_BYTES) {
      throw fail('SECRET_STORE_PROTECT_FAILED', 'Host secret could not be protected.');
    }
    await ensureDirectory(true);
    const tempPath = path.join(root, `.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(ciphertext, 'utf8');
      await handle.close();
      handle = null;
      if (ifAbsent) {
        try { await link(tempPath, file.path); }
        catch (err) {
          if (err?.code === 'EEXIST') return { created: false };
          throw err;
        }
      } else {
        await rename(tempPath, file.path);
      }
      return { created: true };
    } catch {
      throw fail('SECRET_STORE_IO', 'Host secret record could not be saved.');
    } finally {
      await handle?.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
    }
  }

  async function deleteSecret(key) {
    const file = fileFor(key); assertBackend(backend);
    if (!await ensureDirectory(false)) return false;
    try { await unlink(file.path); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw fail('SECRET_STORE_IO', 'Host secret could not be removed.'); }
  }
  return Object.freeze({ getSecret, putSecret, deleteSecret, withAccountLock });
}
