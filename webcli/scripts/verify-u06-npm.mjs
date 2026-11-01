// Exercise the actual temporary npm installation against a copy of an existing
// successful HTTP acceptance task. No new Adapter, global install or browser.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expectedPackagedWorker } from './prepare-package-extension.js';
const arg=name=>process.argv.find(v=>v.startsWith('--'+name+'='))?.slice(name.length+3);
const installed=path.resolve(arg('npm-dir')),fixture=path.resolve(arg('http-fixture'));
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'webcli-u06-npm-')),checks=[];
let bridge;
console.log('Artifacts: '+root);
try{
  const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(3712,'127.0.0.1',resolve)});await new Promise(r=>probe.close(r));
  for(const name of ['data','user','builtin'])await fs.cp(path.join(fixture,name),path.join(root,name),{recursive:true});
  await fs.mkdir(path.join(root,'home'));
  const env={...process.env,USERPROFILE:path.join(root,'home'),HOME:path.join(root,'home'),WEBCLI_BRIDGE_PORT:'3712',WEWORKER_BROWSER_MODE:'system',WEWORKER_BROWSER_HOME:path.join(root,'browser'),
    WEWORKER_BUILTIN_ADAPTERS_DIR:path.join(root,'builtin'),WEWORKER_USER_ADAPTERS_DIR:path.join(root,'user'),WEBCLI_ADAPTERS_DIR:path.join(root,'user'),WEWORKER_ADAPTER_DATA_DIR:path.join(root,'data'),WEWORKER_BUILD_PROFILE:'public',WEBCLI_METRICS:'off',WEBCLI_METRICS_UPLOAD:'off'};
  delete env.WEWORKER_RESOURCES_PATH;delete env.WEBCLI_PROFILE;
  const entry=path.join(installed,'npm-entry.js');
  const raw=async args=>{try{return await exec(process.execPath,[entry,...args],{env,windowsHide:true,maxBuffer:2*1024*1024,timeout:30000});}catch(error){if(!error.stdout)throw error;return error;}};
  const tasks=path.join(root,'data/adapter-workspaces/public/http-exploration');
  const taskId=(await fs.readdir(tasks)).find(name=>/^http-.*\.json$/.test(name)).slice(0,-5);
  const before=await raw(['call','exploration.export','--args',JSON.stringify({taskId,directory:path.join(root,'offline')})]);
  assert.equal(before.code,1);assert.equal(JSON.parse(before.stdout).error.code,'BRIDGE_UNAVAILABLE');
  await assert.rejects(fs.access(path.join(root,'offline')));checks.push('actual npm export with no Bridge fails without auto-start or output directory');
  const log=await fs.open(path.join(root,'bridge.log'),'a');
  bridge=spawn(process.execPath,[entry,'--service'],{env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});await log.close();
  let ready=false;
  for(let i=0;i<100;i++){ready=await new Promise(r=>{const socket=net.connect(3712,'127.0.0.1');socket.once('connect',()=>{socket.destroy();r(true)});socket.once('error',()=>r(false));});if(ready)break;assert.equal(bridge.exitCode,null);await new Promise(r=>setTimeout(r,100));}
  assert.equal(ready,true);
  const directory=path.join(root,'artifact');
  const out=await raw(['call','exploration.export','--args',JSON.stringify({taskId,directory})]);
  assert.equal(out.code,undefined);assert.equal(JSON.parse(out.stdout).data.complete,true);
  const receipt=JSON.parse(await fs.readFile(path.join(directory,'receipt.json')));
  assert.equal(receipt.sections.knowledge.status,'available');assert.equal(receipt.sections.network.reason,'NOT_APPLICABLE_HOST_HTTP');assert.equal(receipt.currentEffectVerified,false);
  checks.push('actual npm CLI/Bridge export reads retained real HTTP task, installed package and author evidence');
  const unavailable=await raw(['call','exploration.export','--args',JSON.stringify({taskId,directory:path.join(root,'unsupported'),screenshot:true,traceIds:['abcdef123456']})]);
  assert.equal(unavailable.code,1);assert.equal(JSON.parse(unavailable.stdout).data.complete,false);checks.push('requested unavailable host screenshot/extension call trace remains partial with exit 1');
  const resources=[];
  for(const file of ['diagnostic-export.js','exploration-service.js','exploration-client.js','exploration-commands.js','bridge.js','index.js']){
    assert.deepEqual(await fs.readFile(path.join(installed,file)),await fs.readFile(path.join(source,file)));resources.push(file);
  }
  for(const file of ['background/browser-commands.js','content/injector.js']){
    const bytes=await fs.readFile(path.join(source,'../extension',file));assert.deepEqual(await fs.readFile(path.join(installed,'extension',file)),bytes);assert.deepEqual(await fs.readFile(path.join(source,'../weworker/build/extension-dist',file)),bytes);resources.push('extension/'+file);
  }
  const worker=await fs.readFile(path.join(source,'../extension/background/service-worker.js'));
  assert.deepEqual(await fs.readFile(path.join(source,'../weworker/build/extension-dist/background/service-worker.js')),worker);
  assert.deepEqual(await fs.readFile(path.join(installed,'extension/background/service-worker.js')),expectedPackagedWorker(worker));
  checks.push('source/prepared/actual npm resources match; worker differs only by existing npm port contract');
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify({passed:true,checks,resources},null,2));console.log(JSON.stringify({checks},null,2));
}finally{if(bridge&&bridge.exitCode===null){const closed=new Promise(r=>bridge.once('exit',r));bridge.kill('SIGTERM');await closed;}}
