// Fixed upstream exports against a task-owned browser, server and journal store.
// Direct CDP and journal/export harness evidence, not upstream CLI/extension E2E.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
const arg = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const upstream = path.resolve(arg('upstream')), journalFile = path.resolve(arg('journal'));
assert.equal(JSON.parse(await fs.readFile(path.join(upstream, 'package.json'))).version, '1.8.8');
const journalBytes = await fs.readFile(journalFile);
assert.equal(createHash('sha1').update(`blob ${journalBytes.length}\0`).update(journalBytes).digest('hex'), 'b394b59aa236066003c041f926cea9248019e8d6');
const load = file => import(pathToFileURL(path.join(upstream, 'dist/src', file)).href);
const { CDPBridge } = await load('browser/cdp.js');
const { ObservationSession } = await load('observation/session.js');
const { exportObservationSession } = await load('observation/artifact.js');
const { chromium } = await import(pathToFileURL(path.resolve(arg('playwright'))).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencli-u06-audit-'));
const requests = [], held = new Set(), checks = [];
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname; requests.push(route);
  res.setHeader('cache-control', 'no-store');
  if (route === '/worker.js') { res.setHeader('content-type', 'application/javascript'); res.end("fetch('/dedicated-fetch').then(r=>r.text()).then(v=>postMessage(v))"); }
  else if (route === '/sw.js') { res.setHeader('content-type', 'application/javascript'); res.end("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/via-sw')e.respondWith(new Response('example-sw-response'))});self.addEventListener('message',e=>e.waitUntil(fetch('/service-worker-fetch').then(r=>r.text()).then(v=>e.source.postMessage(v))))"); }
  else if (route === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Example U06</title><h1>Public diagnostic fixture</h1>'); }
  else if (route === '/stream' || route === '/long') { res.setHeader('content-type', route === '/stream' ? 'text/event-stream' : 'text/plain'); res.write('data: example-first\n\n'); held.add(res); res.on('close', () => held.delete(res)); }
  else if (route === '/fail') { res.setHeader('content-length', '10000'); res.write('example-partial'); setTimeout(() => res.destroy(), 30); }
  else { res.setHeader('content-type', 'text/plain'); res.end('example-complete'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const context = await chromium.launchPersistentContext(path.join(root, 'browser'), { headless: true, executablePath: arg('chromium'), args: ['--remote-debugging-port=0'] });
const bridge = new CDPBridge();
try {
  const page = context.pages()[0]; await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const port = (await fs.readFile(path.join(root, 'browser/DevToolsActivePort'), 'utf8')).split('\n')[0];
  const upstreamPage = await bridge.connect({ cdpEndpoint: `http://127.0.0.1:${port}` });
  await upstreamPage.startNetworkCapture();
  await page.evaluate(async () => {
    await fetch('/page-fetch').then(r => r.text());
    await new Promise(resolve => { const w = new Worker('/worker.js'); w.onmessage = () => { w.terminate(); resolve(); }; });
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await fetch('/via-sw').then(r => r.text());
    await new Promise(resolve => { navigator.serviceWorker.addEventListener('message', resolve, { once: true }); navigator.serviceWorker.controller.postMessage('example'); });
    window.exampleStreams = ['/stream', '/long'].map(url => fetch(url).then(r => r.text()));
    await fetch('/fail').then(r => r.text()).catch(() => {});
  });
  await new Promise(r => setTimeout(r, 250));
  const entries = await upstreamPage.readNetworkCapture();
  const find = name => entries.find(row => new URL(row.url).pathname === name);
  assert.equal(find('/page-fetch').responsePreview, 'example-complete');
  assert.equal(find('/via-sw').responsePreview, 'example-sw-response');
  assert.ok(requests.includes('/dedicated-fetch') && requests.includes('/service-worker-fetch'));
  assert.equal(find('/dedicated-fetch'), undefined); assert.equal(find('/service-worker-fetch'), undefined);
  for (const name of ['/stream', '/long']) { assert.ok(find(name)); assert.equal(find(name).responsePreview, undefined); }
  assert.ok(find('/fail')); assert.equal(find('/fail').responsePreview, undefined);
  checks.push('direct CDP: page/SW-returned bodies captured; independently confirmed Worker fetches absent; unfinished SSE/long and failed body unavailable');
  // readNetworkCapture drains the entry array. Finish before the next capture to
  // avoid presenting the upstream drained pending-entry bookkeeping as streaming.
  for (const response of held) response.end('data: example-last\n\n');
  await page.evaluate(() => Promise.all(window.exampleStreams));
  await new Promise(r => setTimeout(r, 100));
  await page.evaluate(() => { window.exampleFinished = ['/stream','/long'].map(url => fetch(url).then(r=>r.text())); });
  for (let i=0;i<100 && held.size<2;i++) await new Promise(r=>setTimeout(r,20));
  assert.equal(held.size,2);
  for (const response of held) response.end('data: example-finished\n\n');
  await page.evaluate(() => Promise.all(window.exampleFinished));
  await new Promise(r=>setTimeout(r,100));
  const finished = await upstreamPage.readNetworkCapture();
  for (const route of ['/stream','/long']) assert.ok(finished.find(row=>new URL(row.url).pathname===route)?.responsePreview.includes('example-finished'));
  checks.push('direct CDP completed SSE/long bodies readable when captured through completion; readNetworkCapture drains entries and is not an incremental body stream');
  const stored = {}; globalThis.chrome = { storage: { session: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, structuredClone(value)) } } };
  const journal = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(journalBytes.toString(), { mode: 'strip' })).toString('base64'));
  let executions = 0;
  const execute = async cmd => { executions++; await fetch(`http://127.0.0.1:${server.address().port}/journal-execute`); return { id: cmd.id, ok: true, data: 'example-result' }; };
  await Promise.all([journal.executeWithJournal({ id: 'example-done' }, execute), journal.executeWithJournal({ id: 'example-done' }, execute)]);
  await journal.executeWithJournal({ id: 'example-done' }, execute); assert.equal(executions, 1);
  await new Promise(r => setTimeout(r, 0)); journal.__test__.reset();
  await journal.executeWithJournal({ id: 'example-done' }, execute); assert.equal(executions, 1);
  stored.opencli_command_journal_v1.lost = { status: 'started', ts: Date.now() }; journal.__test__.reset();
  assert.equal((await journal.executeWithJournal({ id: 'lost' }, execute)).errorCode, 'command_lost');
  await journal.executeWithJournal({ id: 'large' }, async cmd => ({ id: cmd.id, ok: true, data: 'x'.repeat(70000) }));
  assert.equal((await journal.executeWithJournal({ id: 'large' }, execute)).errorCode, 'result_evicted');
  assert.equal(executions, 1); checks.push('unmodified journal export: concurrent/completed/restarted same ID reuses result; lost/oversize do not execute');
  const session = new ObservationSession({ scope: { contextId: 'example-u06' } });
  session.record({ stream: 'network', url: 'https://example.com/', method: 'GET' });
  session.record({ stream: 'console', text: 'example', level: 'info' });
  session.record({ stream: 'state', snapshot: { example: true } });
  session.record({ stream: 'screenshot', format: 'png', data: (await page.screenshot()).toString('base64') });
  const before = requests.length;
  const artifact = exportObservationSession(session, { baseDir: path.join(root, 'artifacts'), status: 'failure', error: new Error('Example failure') });
  assert.equal(requests.length, before); assert.equal(executions, 1);
  checks.push({ artifactFiles: await fs.readdir(artifact.dir), exportRequests: 0 });
  const report = { upstream: '1.8.8', evidence: 'actual upstream CDPBridge plus journal/observation exports with harness storage; upstream CLI/extension transport not exercised', checks,
    network: entries.map(e => ({ route: new URL(e.url).pathname, status: e.responseStatus, bodyCaptured: typeof e.responsePreview === 'string' })), serverRequests: requests };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root, ...report }, null, 2));
} finally { bridge.close(); await context.close(); for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
