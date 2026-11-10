// Isolated dedicated browser + extension + Bridge. Only a local read-only fixture is used.
// Compare an earlier extension with --baseline-ref=<git-ref>; no source files are changed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callLocalCommand } from '../exploration-client.js';
import { connectSharedBrowser } from '../shared-browser-client.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weworker-exploration-lock-'));
const baselineRef = process.argv.find(arg => arg.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length);
const baseline = Boolean(baselineRef);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const reserve = net.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (req.url === '/api/articles') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items: [{ id: 1, title: 'Example article', url: '/article/1' }] }));
  } else {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Article fixture</title><main id="items"></main><script>fetch("/api/articles").then(r=>r.json()).then(d=>document.querySelector("main").textContent=d.items[0].title)</script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = 'http://127.0.0.1:' + server.address().port + '/';
const extension = path.join(root, 'extension');
await fs.cp(path.join(repo, 'extension'), extension, { recursive: true });
const worker = path.join(extension, 'background/service-worker.js');
const workerSource = baseline ? execFileSync('git', ['show', baselineRef + ':extension/background/service-worker.js'], { cwd: repo, encoding: 'utf8' }) : await fs.readFile(worker, 'utf8');
await fs.writeFile(worker, workerSource.replaceAll('3711', String(port)));
for (const folder of ['adapters', 'user', 'data']) await fs.mkdir(path.join(root, folder));
await fs.writeFile(path.join(root, 'adapters/.profile.json'), JSON.stringify({ schema_version: 1, profile: 'public', adapters: [] }));
const env = { ...process.env, WEWORKER_WEBCLI_DISTRIBUTION: 'desktop', WEBCLI_BRIDGE_PORT: String(port),
  WEWORKER_RESOURCES_PATH: root, WEWORKER_BROWSER_HOME: path.join(root, 'browser'), WEWORKER_BROWSER_MODE: 'dedicated',
  WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'adapters'),
  WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_METRICS_UPLOAD: 'off' };
const runner = path.join(root, 'bridge-runner.mjs');
await fs.writeFile(runner, 'import { WebSocketBridge } from ' + JSON.stringify(new URL('../bridge.js', import.meta.url).href) + ';\n' +
  'const bridge = new WebSocketBridge({ port: Number(process.env.WEBCLI_BRIDGE_PORT) }); await bridge.init(); process.send({ready:true}); process.on("message", async()=>{await bridge.shutdownBrowser();process.exit(0)});');
const child = spawn(process.execPath, [runner], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
let logs = ''; child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
const exited = new Promise(resolve => child.once('exit', resolve));
let control;
const transport = { url: 'ws://127.0.0.1:' + port, timeoutMs: 30000 };
const call = (namespace, command, args = {}) => callLocalCommand(namespace, command, args, transport);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(()=>reject(new Error('Bridge startup timed out')), 30000); child.once('message',()=>{clearTimeout(timer);resolve()}); child.once('exit',code=>{clearTimeout(timer);reject(new Error('Bridge exited '+code+' '+logs))}); });
  control = await connectSharedBrowser(transport);
  const lease = await control.request('acquire');
  await control.request('release', { leaseId: lease.leaseId });
  let caps;
  for (let i=0;i<100;i++) { caps=await call('exploration','capabilities'); if(caps.ok && caps.data.connected) break; await delay(100); }
  assert.ok(ok(caps).connected);
  const opened = ok(await call('browser','open',{session:'fixture',url:pageUrl}));
  ok(await call('browser','unbind',{session:'fixture'}));
  let starts=0, captures=0;
  for(let i=0;i<3;i++) {
    const start=await call('exploration','start',{tabId:opened.tabId,goal:'Read the article list',requestId:'lock-fixture-'+i});
    if(baseline) {
      assert.equal(start.ok,false,JSON.stringify(start)); assert.equal(start.error.code,'TAB_BUSY');
      console.log('PASS baseline reproduced TAB_BUSY before capture'); break;
    }
    const task=ok(start); starts++;
    let current;
    for(let j=0;j<180;j++) { current=ok(await call('exploration','get',{taskId:task.taskId})); if(current.status!=='collecting') break; await delay(250); }
    assert.equal(current.status,'evidence_ready',JSON.stringify(current));
    const evidence=ok(await call('exploration','evidence',{taskId:task.taskId}));
    assert.match(JSON.stringify(evidence),/api\/articles/); captures++;
  }
  if(!baseline) {
    const status=await control.request('status');
    const endpoint=new URL(status.cdpUrl); endpoint.protocol='http:'; endpoint.pathname='/json/list';
    const target=(await (await fetch(endpoint)).json()).find(item=>item.url===pageUrl);
    assert.ok(target);
    const busy=await control.request('acquire');
    await control.request('claim',{leaseId:busy.leaseId,targetId:target.id});
    const blocked=await call('exploration','start',{tabId:opened.tabId,goal:'Read fixture',requestId:'external-conflict'});
    assert.equal(blocked.ok,false); assert.match(JSON.stringify(blocked),/TAB_BUSY|SESSION_EXPIRED/);
    await control.request('release',{leaseId:busy.leaseId});
    assert.equal((await control.request('status')).activeTasks,0);
    console.log(JSON.stringify({passed:true,starts,captures,externalOwnershipStillBlocked:true,artifacts:root}));
  }
} finally {
  control?.close();
  if(child.connected) child.send({stop:true});
  const timer=setTimeout(()=>child.kill(),10000); await exited; clearTimeout(timer);
  await fs.writeFile(path.join(root,'bridge.log'),logs);
  await new Promise(resolve=>server.close(resolve));
  console.log('Isolated artifacts: '+root);
}
