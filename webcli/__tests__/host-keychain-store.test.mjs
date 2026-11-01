import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHostSecretStore } from '../host-secret-store.js';
import { withHostAccountLock } from '../host-account-lock.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

function fixture() {
  const values = new Map(); let denied = false;
  class AsyncEntry {
    constructor(service,account) { this.key = service + account; }
    async getPassword() { if(denied) throw Error('fixture-secret'); return values.get(this.key); }
    async setPassword(value) { if(denied) throw Error('fixture-secret'); values.set(this.key,value); }
    async deleteCredential() { return values.delete(this.key); }
  }
  return { load:async()=>({AsyncEntry}), deny:()=>{denied=true;} };
}
test('Keychain store isolates scope/account and atomically preserves an existing value', async()=>{
  const f=fixture(),scope=randomUUID();
  const store=createHostSecretStore({scope,platform:'darwin',keychainLoad:f.load});
  assert.equal(await store.getSecret('one'),null);
  const results=await Promise.all([store.putSecret('one','fixture-a',{ifAbsent:true}),store.putSecret('one','fixture-b',{ifAbsent:true})]);
  assert.equal(results.filter(x=>x.created).length,1);
  assert.equal(await store.getSecret('one'),'fixture-a');
  assert.equal(await store.getSecret('two'),null);
  assert.equal(await createHostSecretStore({scope:'other',platform:'darwin',keychainLoad:f.load}).getSecret('one'),null);
  await store.putSecret('one','fixture-new'); assert.equal(await store.getSecret('one'),'fixture-new');
  await store.deleteSecret('one'); assert.equal(await store.getSecret('one'),null);
});
test('Keychain denial is an error rather than missing credentials and never echoes a secret', async()=>{
  const f=fixture(); f.deny();
  const store=createHostSecretStore({scope:randomUUID(),platform:'darwin',keychainLoad:f.load});
  await assert.rejects(store.getSecret('one'),e=>e.code==='SECRET_STORE_IO'&&!e.message.includes('fixture-secret'));
  await assert.rejects(store.putSecret('one','fixture-secret'),e=>e.code==='SECRET_STORE_IO'&&!e.message.includes('fixture-secret'));
});
test('account lock serializes operations, releases on failure, and honors cancellation',async()=>{
  const id=randomUUID(),events=[];
  await Promise.all([withHostAccountLock(id,async()=>{events.push('first');await new Promise(r=>setTimeout(r,100));events.push('done');}),withHostAccountLock(id,async()=>{events.push('second');})]);
  assert.deepEqual(events,['first','done','second']);
  await assert.rejects(withHostAccountLock(id,async()=>{throw Error('test');}));
  assert.equal(await withHostAccountLock(id,async()=>42),42);
  await assert.rejects(withHostAccountLock(id,()=>assert.fail(),{signal:AbortSignal.abort()}),{code:'SECRET_STORE_CANCELLED'});
});
test('cross-process account lock releases after its owner exits unexpectedly',async t=>{
  const id=randomUUID();
  const moduleUrl=new URL('../host-account-lock.js',import.meta.url).href;
  const script=`import {withHostAccountLock} from ${JSON.stringify(moduleUrl)};await withHostAccountLock(${JSON.stringify(id)},()=>new Promise(()=>{console.log('locked');setInterval(()=>{},1000)}));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  t.onTestFinished(()=>child.kill());
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Lock child exited early')));});
  await assert.rejects(withHostAccountLock(id,()=>assert.fail(),{timeoutMs:100}),{code:'SECRET_STORE_BUSY'});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
  assert.equal(await withHostAccountLock(id,async()=>true),true);
});
