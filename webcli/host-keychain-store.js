import { createHash } from 'node:crypto';
import { withHostAccountLock } from './host-account-lock.js';

// Native Keychain API: secret values never enter subprocess arguments or files.
export function createKeychainSecretStore({ scope, load = () => import('@napi-rs/keyring') }) {
  const id = key => {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/.test(key)) throw new Error('Invalid host secret identifier.');
    return createHash('sha256').update(JSON.stringify([scope, key])).digest('hex');
  };
  const entry = async key => {
    const account = id(key);
    try { const { AsyncEntry } = await load(); return new AsyncEntry('WeWorker.HostSecrets.v1', account); }
    catch { throw Object.assign(new Error('Keychain backend unavailable.'), {code:'SECRET_STORE_UNSUPPORTED'}); }
  };
  async function getSecret(key) {
    const item = await entry(key);
    try { return (await item.getPassword()) ?? null; }
    catch { throw Object.assign(new Error('Keychain access failed. Unlock or allow access and retry.'), {code:'SECRET_STORE_IO'}); }
  }
  async function putSecret(key, value, {ifAbsent = false} = {}) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 65536 || typeof ifAbsent !== 'boolean') throw new Error('Invalid host secret value.');
    return withHostAccountLock('keychain-write:' + id(key), async () => {
      const item = await entry(key);
      try {
        if (ifAbsent && (await item.getPassword()) != null) return {created:false};
        await item.setPassword(value);
        return {created:true};
      } catch { throw Object.assign(new Error('Keychain secret could not be saved.'), {code:'SECRET_STORE_IO'}); }
    });
  }
  async function deleteSecret(key) {
    return withHostAccountLock('keychain-write:' + id(key), async () => {
      const item = await entry(key);
      try { return await item.deleteCredential(); }
      catch { throw Object.assign(new Error('Keychain secret could not be removed.'), {code:'SECRET_STORE_IO'}); }
    });
  }
  return Object.freeze({getSecret,putSecret,deleteSecret});
}
