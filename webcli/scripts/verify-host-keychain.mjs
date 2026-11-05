// Run on macOS with Node >=20. Uses a disposable fake secret; no website needed.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createKeychainSecretStore } from '../host-keychain-store.js';
if (process.platform !== 'darwin') throw new Error('Run this acceptance check on macOS.');
const probe = process.argv[2] === '--probe-read';
const scope = probe ? process.argv[3] : `keychain-check.${randomUUID()}`;
if (!/^keychain-check\.[a-f0-9-]+$/.test(scope)) throw new Error('Invalid test scope.');
const store = createKeychainSecretStore({scope});
const value = 'disposable-keychain-test-value';
if (probe) {
  if (await store.getSecret('probe') !== value) throw new Error('Child-process read failed.');
  console.log('child-read-ok');
} else {
  try {
    await store.putSecret('probe',value,{ifAbsent:true});
    if (await store.getSecret('probe') !== value) throw new Error('Readback failed.');
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--probe-read',scope],{encoding:'utf8',timeout:60000});
    if(child.status!==0||!child.stdout.includes('child-read-ok')) throw new Error('Cross-process Keychain read failed; check system authorization.');
    console.log('PASS: save, read, and a new process can read the disposable Keychain entry.');
  } finally { await store.deleteSecret('probe'); }
  if(await store.getSecret('probe')!==null) throw new Error('Delete verification failed.');
  console.log('PASS: disposable entry removed. No website connection was used.');
}
