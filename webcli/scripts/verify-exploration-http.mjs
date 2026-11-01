#!/usr/bin/env node
// Browser-free, real CLI/Bridge/HTTP acceptance using only isolated local fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyHttpWrites } from './write-acceptance.mjs';
import { verifyWriteResults } from './write-result-acceptance.mjs';
import { verifyWriteSequences } from './write-sequence-acceptance.mjs';
import { verifyWriteRepairs } from './write-repair-acceptance.mjs';
import { verifySharedRepairs } from './shared-repair-acceptance.mjs';

const exec = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcli-http-discovery-'));
const copy = path.join(root, 'webcli'), checks = [], requests = [];
let bridge, server, drift = false;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
console.log('Artifacts: ' + root);
async function stopBridge() {
  if (!bridge || bridge.exitCode !== null) return;
  const done = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await done;
}
try {
  const portProbe = net.createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const bridgePort = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  await fs.cp(source, copy, { recursive: true, filter: entry => !['node_modules', '__tests__', 'extension', 'adapters', 'e2e-results'].includes(path.basename(entry)) });
  await fs.symlink(path.join(source, 'node_modules'), path.join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.cp(path.resolve(source, '../weworker/build/extension-dist'), path.join(copy, 'extension'), { recursive: true });
  for (const file of ['index.js', 'bridge.js', 'exploration-client.js']) {
    const target = path.join(copy, file);
    let content = (await fs.readFile(target, 'utf8')).replaceAll('3711', String(bridgePort));
    if (file === 'index.js') content = content.replaceAll('homedir()', JSON.stringify(path.join(root, 'cli-home')));
    await fs.writeFile(target, content);
  }
  let cliEntry = path.join(copy, 'index.js');
  let bridgeArgs = [path.join(copy, 'acceptance-bridge.mjs')];
  if (process.argv.includes('--bundled')) {
    cliEntry = path.join(copy, 'webcli.cjs');
    const isolatedBundle = async relative => (await fs.readFile(path.resolve(source, relative), 'utf8'))
      .replaceAll('3711', String(bridgePort))
      .replace(/\(0, import_os\d+\.homedir\)\(\)|\bimport_(?:node_)?os\d*\.default\.homedir\(\)/g, JSON.stringify(path.join(root, 'cli-home')));
    await fs.writeFile(cliEntry, await isolatedBundle('../weworker/build/webcli-dist/webcli.cjs'));
    const bridgeEntry = path.join(copy, 'bridge.cjs');
    await fs.writeFile(bridgeEntry, await isolatedBundle('../weworker/build/bridge-dist/bridge.cjs'));
    bridgeArgs = [bridgeEntry, '--service'];
  }
  const env = { ...process.env, WEWORKER_BUILD_PROFILE: 'public', WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'),
    WEBCLI_BRIDGE_PORT: String(bridgePort), WEWORKER_WEBCLI_DISTRIBUTION: 'desktop', WEWORKER_BROWSER_MODE: 'system',
    WEWORKER_BROWSER_HOME: path.join(root, 'browser-state'),
    WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEBCLI_PROFILE: 'example-offline',
    WEBCLI_METRICS: 'off', WEBCLI_METRICS_UPLOAD: 'off', EXAMPLE_DISCOVERY_KEY: 'example-auth-placeholder' };
  delete env.WEWORKER_RESOURCES_PATH;
  await fs.mkdir(env.WEWORKER_BUILTIN_ADAPTERS_DIR);
  await fs.writeFile(path.join(copy, 'acceptance-bridge.mjs'), "import {WebSocketBridge} from './bridge.js'; new WebSocketBridge();\n");
  async function startBridge() {
    const log = await fs.open(path.join(root, 'bridge.log'), 'a');
    bridge = spawn(process.execPath, bridgeArgs, { env, stdio: ['ignore', log.fd, log.fd] }); await log.close();
    for (let i = 0; i < 50; i++) {
      const ready = await new Promise(resolve => { const socket = net.connect(bridgePort, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
      if (ready) return;
      assert.equal(bridge.exitCode, null); await delay(100);
    }
    throw new Error('Isolated Bridge did not start.');
  }
  async function call(command, args = {}, expected = true) {
    let out;
    try { out = await exec(process.execPath, [cliEntry, 'call', command, '--args', JSON.stringify(args), '--output-format=json'], { env, timeout: 25000 }); }
    catch (error) { if (expected) throw error; out = error; }
    const result = JSON.parse(out.stdout); if (expected) assert.notEqual(result.ok, false, JSON.stringify(result)); return result;
  }
  async function waitTask(taskId, expected) {
    for (let i = 0; i < 60; i++) {
      const state = (await call('exploration.get', { taskId })).data;
      if (state.status === expected) return state;
      assert.notEqual(state.status, 'failed', JSON.stringify(state.error)); await delay(100);
    }
    throw new Error('Task did not reach ' + expected);
  }
  server = http.createServer(async (req, res) => {
    requests.push({ path: new URL(req.url, 'http://localhost').pathname, authenticated: req.headers.authorization === 'Bearer example-auth-placeholder' });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/slow') return;
    if (req.url === '/openapi.json') { res.end(JSON.stringify({ openapi: '3.1.0', servers: [{ url: '/' }],
      paths: { '/list': { get: { parameters: [{ name: 'id', in: 'query', schema: { type: 'string', example: 'example-unpersisted-input' } }], responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } } } })); return; }
    if (req.headers.authorization !== 'Bearer example-auth-placeholder') { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ [drift ? 'newId' : 'id']: new URL(req.url, 'http://localhost').searchParams.get('id'), title: 'example-unpersisted-response' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await startBridge();
  if (process.argv.includes('--write-sequences-only')) await verifyWriteSequences({ call, startBridge, stopBridge, pass });
  else {
  assert.ok((await call('profile.list')).data.profiles.every(profile => profile.contextId === 'legacy' && !profile.online));
  const auth = { type: 'bearer', origin, env: 'EXAMPLE_DISCOVERY_KEY' };
  const start = { mode: 'http', origin, auth, goal: 'Read example API', requestId: 'example-http-start' };
  const started = await call('exploration.start', start), taskId = started.data.taskId;
  assert.match(taskId, /^http-/); assert.equal(requests.length, 0);
  assert.equal((await call('exploration.start', start)).data.taskId, taskId);
  pass('zero-browser start, explicit host auth, offline profile ignored, duplicate start sends no requests');
  await call('exploration.discover', { taskId, url: origin + '/openapi.json', reason: 'Inspect example API specification' }); await waitTask(taskId, 'evidence_ready');
  const evidence = (await call('exploration.evidence', { taskId })).data;
  assert.equal(evidence.candidates.length, 0); assert.equal(evidence.discoveries[0].operations.length, 1); assert.equal(requests.length, 1);
  pass('OpenAPI document discovers structure without executing operations');
  await call('exploration.request', { taskId, request: { url: origin + '/list?id=example-unpersisted-input' }, reason: 'Verify the documented read endpoint' }); await waitTask(taskId, 'evidence_ready');
  const plan = { tools: [{ name: 'items', strategy: 'AUTH_API', auth, risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0],
    readReason: 'Read-only GET list', strategyNote: { reason: 'Documented and observed HTTP endpoint', limitations: 'Example service only' } }] };
  const generated = await call('exploration.generate', { taskId, plan }), tool = generated.data.toolNames[0];
  const before = await call('exploration.verification-read', { taskId, tool });
  await call('exploration.verification-write', { taskId, tool, expectedHash: before.data.hash,
    cases: ['007', '008'].map(id => ({ id: 'example-' + id, args: { id }, expect: { equals: { id } } })) });
  await call('exploration.validate', { taskId }); await waitTask(taskId, 'review_ready');
  const review = await call('exploration.review', { taskId });
  await call('exploration.install', { taskId, reviewId: review.data.reviewId, confirmed: true }); await waitTask(taskId, 'installed');
  assert.equal((await call(tool, { id: '009' })).id, '009');
  const site = generated.data.adapter;
  const knowledge = await call('exploration.knowledge-read', { mode: 'http', site });
  const originalMapping = { meaning: 'Public item identifier', source: 'Response id property' };
  await call('exploration.knowledge-save', { taskId, expectedHash: knowledge.data.hash, fields: { id: originalMapping } });
  pass('host HTTP evidence → generation → two authored cases → reviewed installation → ordinary CLI call → knowledge');
  if (process.argv.includes('--u06-only')) {
    const directory=path.join(root,'u06-http-export'), before=requests.length;
    const output=await call('exploration.export',{taskId,directory});
    assert.equal(output.ok,true);assert.equal(output.data.complete,true);assert.equal(requests.length,before);
    const receipt=JSON.parse(await fs.readFile(path.join(directory,'receipt.json')));
    assert.equal(receipt.environment.runtime,'host-http');assert.equal(receipt.currentEffectVerified,false);
    assert.equal(receipt.sections.network.reason,'NOT_APPLICABLE_HOST_HTTP');
    assert.equal(receipt.sections.knowledge.status,'available');
    const knowledgeRows=(await fs.readFile(path.join(directory,'knowledge.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(knowledgeRows[0].status,'HISTORICAL_READ_CASES');assert.equal(knowledgeRows[0].cases,2);
    const text=(await Promise.all((await fs.readdir(directory)).map(name=>fs.readFile(path.join(directory,name),'utf8')))).join('');
    assert.doesNotMatch(text,/example-auth-placeholder|example-unpersisted-(?:input|response)|"args"|"expect"/);
    pass('U06 host HTTP export binds real installed digest and author history, declares browser limits, sends zero new requests');
  }
  if (process.argv.includes('--u01') || process.argv.includes('--u01-only')) {
    const knowledgeDir = path.join(env.WEWORKER_ADAPTER_DATA_DIR, 'adapter-workspaces/public/http-exploration/knowledge');
    const count = requests.length;
    const report = JSON.parse((await exec(process.execPath, [cliEntry, 'adapter', 'verify', '--installed', site,
      '--knowledge-dir', knowledgeDir, '--require-evidence', '--output-format=json'], { env })).stdout);
    assert.equal(report.ok, true); assert.equal(report.executed, false); assert.equal(report.evidenceComplete, true);
    assert.equal(report.results[0].evidence[0].status, 'HISTORICAL_READ_CASES');
    assert.equal(report.results[0].evidence[0].cases, 2); assert.equal(requests.length, count);
    assert.doesNotMatch(JSON.stringify(report), /example-auth-placeholder|example-unpersisted-(?:input|response)|"args"|"expect"/);
    pass('U01 actual authored cases and matching installed digest aggregate without any new request or raw evidence disclosure');
  }
  if (!process.argv.includes('--u01-only') && !process.argv.includes('--u06-only')) {
  await stopBridge(); const beforeRestart = requests.length; await startBridge();
  assert.equal((await call('exploration.get', { taskId })).data.status, 'installed');
  assert.equal((await call('exploration.list', { mode: 'http' })).data.tasks[0].taskId, taskId);
  assert.equal(requests.length, beforeRestart);
  assert.equal((await call('exploration.knowledge-read', { mode: 'http', site })).data.stale, false);
  pass('Bridge restart restores HTTP task and knowledge without replay or browser');
  drift = true;
  const repairId = (await call('exploration.start', { ...start, requestId: 'example-http-repair' })).data.taskId;
  const info = (await call('exploration.repair-info', { mode: 'http', site })).data;
  await call('exploration.request', { taskId: repairId, request: { url: origin + '/list?id=example' }, reason: 'Observe response field change' }); await waitTask(repairId, 'evidence_ready');
  await call('exploration.repair', { taskId: repairId, site, expectedDigest: info.digest, plan });
  await call('exploration.validate', { taskId: repairId }); await waitTask(repairId, 'draft');
  const file = 'http/commands/items.js', old = (await call('exploration.draft-read', { taskId: repairId, file })).data;
  await call('exploration.draft-write', { taskId: repairId, file, expectedHash: old.hash,
    content: old.content.replace('return api.request(request);', 'const result = await api.request(request); return {id: result.newId};') });
  await call('exploration.validate', { taskId: repairId }); await waitTask(repairId, 'review_ready');
  const repaired = await call('exploration.review', { taskId: repairId });
  await call('exploration.install', { taskId: repairId, reviewId: repaired.data.reviewId, confirmed: true }); await waitTask(repairId, 'installed');
  assert.equal((await call(tool, { id: '010' })).id, '010');
  pass('actual response drift fails saved cases; host-only scoped repair revalidates, installs and runs');
  const priorKnowledge = (await call('exploration.knowledge-read', { mode: 'http', site })).data;
  const mapping = { meaning: 'Public item identifier', source: 'Verified response newId mapped to id' };
  const revisions = [{ field: 'id', expected: originalMapping, replacement: mapping, reason: 'Observed field drift and both repaired cases passed', evidence: { tool, path: 'id', caseIds: ['example-007', 'example-008'] } }];
  assert.equal((await call('exploration.knowledge-save', { taskId: repairId, expectedHash: priorKnowledge.hash, fields: { id: mapping } }, false)).error.code, 'FIELD_CONFLICT');
  assert.equal((await call('exploration.knowledge-revise', { taskId, expectedHash: priorKnowledge.hash, revisions }, false)).error.code, 'ADAPTER_BASE_CHANGED');
  const requestCount = requests.length;
  const revisedKnowledge = (await call('exploration.knowledge-revise', { taskId: repairId, expectedHash: priorKnowledge.hash, revisions })).data;
  assert.deepEqual(revisedKnowledge.knowledge.fields.id, { ...mapping, verifiedAt: revisedKnowledge.knowledge.verifiedAt });
  assert.equal(revisedKnowledge.knowledge.fieldRevisions[0].previous.source, originalMapping.source);
  assert.equal(revisedKnowledge.knowledge.fieldRevisions[0].evidence.kind, 'read_cases');
  assert.equal((await call('exploration.knowledge-revise', { taskId: repairId, expectedHash: priorKnowledge.hash, revisions }, false)).error.code, 'STALE_KNOWLEDGE');
  await stopBridge(); await startBridge();
  const restoredKnowledge = (await call('exploration.knowledge-read', { mode: 'http', site })).data;
  assert.equal(restoredKnowledge.hash, revisedKnowledge.hash); assert.equal(requests.length, requestCount);
  pass('explicit field revision after real drift repair: current cases, old mapping/history, stale hash and old package rejection, restart persistence and zero replay');
  const slowId = (await call('exploration.start', { ...start, requestId: 'example-http-cancel' })).data.taskId;
  await call('exploration.request', { taskId: slowId, request: { url: origin + '/slow' }, reason: 'Inspect cancellable example query' });
  for (let i = 0; i < 30 && !requests.some(req => req.path === '/slow'); i++) await delay(100);
  assert.equal(requests.filter(req => req.path === '/slow').length, 1);
  await call('exploration.cancel', { taskId: slowId }); assert.equal((await call('exploration.get', { taskId: slowId })).data.status, 'cancelled');
  const afterCancel = requests.length; await stopBridge(); await startBridge();
  assert.equal((await call('exploration.get', { taskId: slowId })).data.status, 'cancelled'); assert.equal(requests.length, afterCancel);
  pass('cancellation aborts HTTP and remains terminal across Bridge restart without replay');
  const interruptedId = (await call('exploration.start', { ...start, requestId: 'example-http-interrupted' })).data.taskId;
  await call('exploration.request', { taskId: interruptedId, request: { url: origin + '/slow' }, reason: 'Inspect interrupted example query' });
  for (let i = 0; i < 30 && requests.filter(req => req.path === '/slow').length < 2; i++) await delay(100);
  assert.equal(requests.filter(req => req.path === '/slow').length, 2);
  const beforeInterruptedRestart = requests.length; await stopBridge(); await startBridge();
  const interrupted = (await call('exploration.get', { taskId: interruptedId })).data;
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.requestCount, 1);
  assert.equal(requests.length, beforeInterruptedRestart);
  pass('restart during an in-flight HTTP operation preserves its budget and marks interrupted without replay');
  await verifyHttpWrites({ call, waitTask, startBridge, stopBridge, pass });
  await verifyWriteResults({ call, startBridge, stopBridge, pass });
  await verifyWriteSequences({ call, startBridge, stopBridge, pass });
  await verifyWriteRepairs({ call, waitTask, startBridge, stopBridge, pass });
  await verifySharedRepairs({ call, waitTask, startBridge, stopBridge, pass });
  async function assertClean(target) {
    const stat = await fs.stat(target).catch(() => null); if (!stat) return;
    if (stat.isDirectory()) { for (const name of await fs.readdir(target)) await assertClean(path.join(target, name)); }
    else assert.doesNotMatch(await fs.readFile(target, 'utf8'), /example-auth-placeholder|example-unpersisted-(?:input|response)|example-result-body-not-retained/);
  }
  for (const target of [path.join(root, 'bridge.log'), env.WEWORKER_ADAPTER_DATA_DIR, env.WEWORKER_USER_ADAPTERS_DIR]) await assertClean(target);
  assert.ok((await call('profile.list')).data.profiles.every(profile => profile.contextId === 'legacy' && !profile.online));
  pass('no browser ever connected; credentials/request/response values absent from logs, tasks, knowledge and installed package');
  }
  }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ passed: true, bundledCliAndBridge: process.argv.includes('--bundled'), checks, requests }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ passed: false, checks, error: error.message }, null, 2));
  throw error;
} finally {
  await stopBridge(); if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
