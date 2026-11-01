import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplorationService } from '../exploration-service.js';
import { resolveAdapterPaths } from '../paths.js';
import { resolveAdapterCall } from '../adapter-host.js';
import { runHttpTool } from '../http-runner.js';
import { generationEvidenceDir } from '../generation-harness/package-draft.js';
import { readPackageDirectory } from '../adapter-package-files.js';
import { readGenerationEvidence } from '../generation-harness/package-inspection.js';
import { verifyRetainedPackage, verifyRepairRetention } from '../generation-harness/existing-site.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
async function setup({ behavior = 'normal', source, auth = false, mixed = false, resultId, detail = {}, asyncEffect, exactId, responseHeaders } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-write-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  let title = 'Before', effectReads = 0, responseField = 'title', beforeRead; const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, body: raw, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    for(const [name,value] of Object.entries(responseHeaders||{}))res.setHeader(name,value);
    const json=value=>JSON.stringify(value).replace('"id":"example-exact-id"','"id":'+exactId);
    if (req.method === 'PUT') {
      if (behavior === 'redirect') { res.writeHead(307, { location: '/items/example' }); res.end(); return; }
      if (behavior !== 'no-effect') title = JSON.parse(raw).title;
      if (behavior === 'hang') return;
      if (behavior === 'disconnect') { req.socket.destroy(); return; }
      res.end(json({ ok: true, id: exactId?'example-exact-id':resultId ?? 'example', [responseField]: title, live: true })); return;
    }
    if (req.url.startsWith('/records/')) { res.end(json({ id: exactId?'example-exact-id':resultId, title, ...detail })); return; }
    beforeRead?.();
    const state = !asyncEffect ? undefined : title === 'Before' ? 'idle' : ++effectReads <= asyncEffect.pendingReads ? 'pending' : 'ready';
    res.end(JSON.stringify({ id: 'example', title, state, responseOnly: 'example-unpersisted-body' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEWORKER_BUILD_PROFILE: 'public' } });
  const options = { mode: 'http', rootDir: path.join(root, 'tasks'), paths };
  const service = new ExplorationService(options);
  const started = await service.execute('start', { origin, goal: 'Update a local public example', requestId: 'example-write' });
  const taskId = started.data.taskId;
  async function call(command, args = {}) {
    const response = await service.execute(command, { taskId, ...args });
    if (service.jobs.has(taskId)) await service.jobs.get(taskId);
    return response;
  }
  if (mixed) await call('request', { request: { url: origin + '/items/example' }, reason: 'Read public example identity' });
  expect((await call('declare-write', { url: origin + '/items/example', method: 'PUT', bodyKeys: ['title'], reason: 'Author a public fixture write' })).ok).toBe(true);
  const authContract = auth ? { type: 'bearer', origin, env: 'EXAMPLE_WRITE_KEY' } : undefined;
  expect((await call('generate', { plan: { tools: [{ name: 'update_item', risk: 'write', sourceApiKind: 'action', sourceApiIndexes: [mixed ? 1 : 0],
    strategy: auth ? 'AUTH_API' : 'PUBLIC_API', ...(authContract ? { auth: authContract } : {}), writeReason: 'Update one public example title',
    strategyNote: { reason: 'Explicit example HTTP endpoint', limitations: 'One request and independent GET' } },
    ...(mixed ? [{ name: 'current_item', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0], strategy: 'PUBLIC_API', readReason: 'Read example identity', strategyNote: { reason: 'Public item', limitations: 'Local fixture' } }] : [])] } })).ok).toBe(true);
  const run = service.runs.get(taskId), tool = run.draft.toolNames[0];
  const handler = source || `module.exports = async (args, api) => {
    if (args.__confirmed !== true) return {blocked:true, requiresConfirmation:true};
    try { return await api.request({url:${JSON.stringify(origin + '/items/example')},method:'PUT',json:{title:args.title}}); }
    catch (error) { return {ok:false,errorCode:error.code}; }
  };`;
  async function edit(file, content) {
    const current = await call('draft-read', { file });
    expect((await call('draft-write', { file, content, expectedHash: current.data.hash })).ok).toBe(true);
  }
  const manifestFile = await call('draft-read', { file: 'manifest.json' });
  const manifest = JSON.parse(manifestFile.data.content);
  manifest.commands[0].schema = { type: 'object', additionalProperties: false, required: ['title'],
    properties: { title: { type: 'string' }, __confirmed: { type: 'boolean' } }, 'x-webcli-requires-confirmation': true, 'x-webcli-agent-authored': true };
  await edit('manifest.json', JSON.stringify(manifest));
  await edit(manifest.commands[0].module, handler.replaceAll('EXAMPLE_ORIGIN', origin));
  let fixture = { id: 'example-first', representativeArgs: { title: 'After' }, expectedRequest: { method: 'PUT', url: origin + '/items/example', body: { title: 'After' } },
    successResponse: { status: 200, body: { ok: true, id: 'example', title: 'After' } }, successExpectation: { ok: true, title: 'After' },
    failureResponse: { status: 409, body: { ok: false } }, failureExpectation: { ok: false, errorCode: 'HTTP_STATUS' },
    effect: { readback: { url: origin + '/items/example' }, before: { equals: { title: 'Before' } }, after: { equals: { title: 'After' } } } };
  const saveFixture = async next => {
    fixture = next || fixture;
    const current = await call('write-verification-read', { tool });
    return call('write-verification-write', { tool, fixture, expectedHash: current.data.hash });
  };
  expect((await saveFixture()).ok).toBe(true);
  if (mixed) {
    const readTool = run.draft.toolNames[1], current = await call('verification-read', { tool: readTool });
    await call('verification-write', { tool: readTool, expectedHash: current.data.hash, cases: [{ id: 'example-identity', args: {}, expect: { equals: { id: 'example' } } }] });
  }
  return { root, origin, service, options, run, taskId, tool, call, requests, paths, fixture, saveFixture, edit, manifest,
    setTitle: value => { title = value; effectReads = 0; }, setBehavior: value => { behavior = value; },
    setResponseField: value => { responseField = value; }, onRead: fn => { beforeRead = fn; } };
}

async function reviewed(f) {
  expect((await f.call('validate')).ok).toBe(true);
  expect(f.run.status, JSON.stringify(f.run.runtimeSummary)).toBe('write_review_ready');
  const response = await f.call('write-review', { tool: f.tool });
  expect(response.ok).toBe(true);
  return response.data;
}

it.each(['signed','decimal','header','location','url','multi'])('verifies actual HTTP %s IDs and keeps only durable identifiers',async mode=>{
  const exact='-9007199254740993123456789';
  const f=await setup({resultId:mode==='signed'?-7:mode==='url'?'example':'007',...(mode==='decimal'?{exactId:exact}:{}),responseHeaders:{'x-resource-id':'007',location:'/records/007'}});
  const spec={url:f.origin+'/records/:id',publicId:true,responsePath:'id',identityPath:'id',expect:{equals:{title:'After'}}};
  if(mode==='signed'){spec.idType='signed-integer';f.fixture.successResponse.body.id=-1;}
  if(mode==='decimal'){spec.idType='decimal';f.fixture.successResponse.body.id='7';}
  if(mode==='header'||mode==='multi'){delete spec.responsePath;spec.responseSource={kind:'header',name:'x-resource-id'};f.fixture.successResponse.headers={'x-resource-id':'example-mock'};}
  if(mode==='url'){delete spec.responsePath;spec.responseSource={kind:'url',template:f.origin+'/items/:id'};f.fixture.successResponse.url=f.origin+'/items/example';}
  if(mode==='location'){delete spec.responsePath;spec.responseSource={kind:'header',name:'location',template:f.origin+'/records/:id'};f.fixture.successResponse.headers={location:'/records/example'};}
  f.fixture.effect.resultReadback=mode==='multi'?[spec,{...spec,responseSource:undefined,responsePath:'id'}]:spec;
  if(mode==='multi')delete f.fixture.effect.resultReadback[1].responseSource;
  expect((await f.saveFixture()).ok).toBe(true);const review=await reviewed(f);await f.call('write-verify',{tool:f.tool,reviewId:review.reviewId,confirmed:true});
  expect(f.run.status,JSON.stringify(f.run.writeExecutions)).toBe('review_ready');
  const expected=mode==='signed'?-7:mode==='decimal'?exact:mode==='url'?'example':'007';
  expect(f.run.writeExecutions[0].resultBinding).toEqual(mode==='multi'?{ids:[expected,expected]}:{id:expected});
  expect(f.requests.filter(value=>value.url.startsWith('/records/')).every(value=>value.url==='/records/'+expected)).toBe(true);
});

async function sequenceFixture(f,{before='After',bind=false}={}) {
  const first=structuredClone(f.fixture),second=structuredClone(first);second.id='second';
  const title=bind?'{{result:first}}':'Again';second.representativeArgs.title=title;second.expectedRequest.body.title=title;second.successResponse.body.title=title;second.successExpectation.title=title;second.effect.before.equals.title=before;second.effect.after.equals.title=title;
  if(bind)first.effect.resultReadback={url:f.origin+'/records/:id',publicId:true,responsePath:'id',identityPath:'id',expect:{equals:{title:'After'}}};
  expect((await f.saveFixture({cases:[first,second]})).ok).toBe(true);await f.call('validate');expect(f.run.status,JSON.stringify(f.run.runtimeSummary)).toBe('write_review_ready');
  const steps=[{id:'first',tool:f.tool,caseId:first.id},{id:'second',tool:f.tool,caseId:'second'}];
  const review=await f.call('write-sequence-review',{steps});expect(review.ok,JSON.stringify(review)).toBe(true);return {steps,review:review.data};
}

it('sequences real writes, transfers only durable actual IDs and never replays after restart',async()=>{
  const f=await setup({resultId:'actual-record-id'}),s=await sequenceFixture(f,{bind:true});expect(f.requests).toHaveLength(0);
  expect((await f.call('write-review',{tool:f.tool,caseId:'second'})).error.code).toBe('WRITE_SEQUENCE_REQUIRED');
  const args={steps:s.steps,reviewId:s.review.reviewId,confirmed:true};await f.call('write-sequence-verify',args);
  expect(f.run.writeSequenceExecutions[0].status,JSON.stringify(f.run)).toBe('verified');expect(f.run.status).toBe('review_ready');
  expect(f.requests.filter(value=>value.method==='PUT').map(value=>JSON.parse(value.body).title)).toEqual(['After','actual-record-id']);
  const count=f.requests.length;await f.call('write-sequence-verify',args);expect(f.requests).toHaveLength(count);
  const restored=new ExplorationService(f.options);await restored.execute('write-sequence-verify',{taskId:f.taskId,...args});expect(f.requests).toHaveLength(count);
  expect(JSON.stringify((await f.call('get')).data)).not.toContain('actual-record-id');
});

it('partial sequence resume obtains a new review and skips verified steps; uncertain writes cannot resume',async()=>{
  const f=await setup(),s=await sequenceFixture(f,{before:'ExternalReady'}),args={steps:s.steps,reviewId:s.review.reviewId,confirmed:true};
  await f.call('write-sequence-verify',args);expect(f.run.writeSequenceExecutions[0].status).toBe('partial');expect(f.requests.filter(value=>value.method==='PUT')).toHaveLength(1);
  f.setTitle('ExternalReady');const resumed=(await f.call('write-sequence-review',{steps:s.steps,resumeFrom:s.review.reviewId})).data;
  expect(resumed.reviewId).not.toBe(s.review.reviewId);
  await f.call('write-sequence-verify',{steps:s.steps,resumeFrom:s.review.reviewId,reviewId:resumed.reviewId,confirmed:true});expect(f.run.status).toBe('review_ready');
  expect(f.requests.filter(value=>value.method==='PUT').map(value=>JSON.parse(value.body).title)).toEqual(['After','Again']);expect(f.run.writeSequenceExecutions[1].steps[0].reused).toBe(true);
  const u=await setup({behavior:'disconnect'}),q=await sequenceFixture(u);await u.call('write-sequence-verify',{steps:q.steps,reviewId:q.review.reviewId,confirmed:true});
  expect(u.run.writeExecutions[0].status).toBe('uncertain');expect((await u.call('write-sequence-review',{steps:q.steps,resumeFrom:q.review.reviewId})).error.code).toBe('WRITE_SEQUENCE_UNCERTAIN');
  const count=u.requests.filter(value=>value.method==='PUT').length;await u.call('write-sequence-readback',{reviewId:q.review.reviewId});expect(u.requests.filter(value=>value.method==='PUT')).toHaveLength(count);
  expect(u.run.writeExecutions[0].status).toBe('uncertain');
});

it('generates declared HTTP writes, runs no-network mocks, verifies a real effect and installs with ordinary call confirmation', async () => {
  const f = await setup();
  expect((await f.call('evidence')).data.candidates[0]).toMatchObject({ declared: true, status: null, observation: { executed: false } });
  const review = await reviewed(f);
  expect(f.requests).toHaveLength(0);
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
  expect((await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: false })).error.code).toBe('CONFIRMATION_REQUIRED');
  const args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  const calls = await Promise.all([f.call('write-verify', args), f.call('write-verify', args)]);
  expect(calls.every(result => result.ok)).toBe(true);
  expect(f.run.status).toBe('review_ready');
  expect(f.requests.map(item => item.method)).toEqual(['GET', 'PUT', 'GET']);
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'verified', dispatched: true, responseVerified: true, effectVerified: true });
  await f.call('validate');
  await f.call('write-verify', args);
  expect(f.requests).toHaveLength(3);
  const installReview = await f.call('review');
  await f.call('install', { reviewId: installReview.data.reviewId, confirmed: true });
  expect(f.run.status).toBe('installed');
  const match = resolveAdapterCall(f.tool, { paths: f.paths });
  await expect(runHttpTool(match, { title: 'Ordinary' })).rejects.toMatchObject({ code: 'HTTP_CONFIRMATION_REQUIRED' });
  expect((await runHttpTool(match, { title: 'Ordinary', __confirmed: true })).result).toMatchObject({ ok: true, title: 'Ordinary' });
  const stored = fs.readFileSync(path.join(f.options.rootDir, f.taskId + '.json'), 'utf8');
  expect(stored).not.toContain('example-unpersisted-body');
  expect(fs.existsSync(path.join(match.adapter.root, 'write-verification.json'))).toBe(false);
  const knowledge = await f.service.execute('knowledge-read', { site: f.run.siteKey });
  const saved = await f.call('knowledge-save', { expectedHash: knowledge.data.hash });
  expect(saved.data.knowledge.commands[f.tool].writeVerification).toMatchObject({ kind: 'http_single_write_v1', replayAllowed: false, fixture: { id: 'example-first' } });
});

it.each(['disconnect', 'no-effect', 'redirect'])('does not repeat or certify a %s write; independent readback stays available', async behavior => {
  const f = await setup({ behavior }), review = await reviewed(f);
  const args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', dispatched: true });
  expect(f.run.status).toBe('write_review_ready');
  const before = f.requests.length;
  await f.call('write-verify', args);
  expect(f.requests).toHaveLength(before);
  const restored = new ExplorationService(f.options);
  await restored.execute('write-verify', { taskId: f.taskId, ...args });
  expect(f.requests).toHaveLength(before);
  const readback = await f.call('write-readback', { reviewId: review.reviewId });
  expect(readback).toMatchObject({ ok: true, data: { passed: behavior === 'disconnect', writeReplayed: false, originalStatus: 'uncertain' } });
  expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(1);
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
});

it('checks preconditions before dispatch and consumes even a failed attempt', async () => {
  const f = await setup(), review = await reviewed(f);
  f.setTitle('Different');
  const args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'not_dispatched', dispatched: false, error: { code: 'WRITE_PRECONDITION_FAILED' } });
  f.setTitle('Before');
  await f.call('write-verify', args);
  expect(f.requests.map(item => item.method)).toEqual(['GET']);
});

it('cancel and Bridge restart preserve uncertain effects and prevent redispatch', async () => {
  const f = await setup({ behavior: 'hang' }), review = await reviewed(f);
  const args = { taskId: f.taskId, tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.service.execute('write-verify', args);
  await vi.waitFor(() => expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(1));
  const restored = new ExplorationService(f.options);
  const recovered = restored.runs.get(f.taskId);
  expect(recovered).toMatchObject({ status: 'interrupted', writeExecutions: [{ status: 'uncertain', dispatched: true }] });
  expect((await restored.execute('write-verify', args)).ok).toBe(true);
  expect(f.requests).toHaveLength(2);
  await f.service.execute('cancel', { taskId: f.taskId }); await f.service.jobs.get(f.taskId);
  expect(f.run).toMatchObject({ status: 'cancelled', writeExecutions: [{ status: 'uncertain' }] });
  expect((await f.call('write-readback', { reviewId: review.reviewId })).data.passed).toBe(true);
  await f.service.execute('write-verify', args);
  expect(f.requests.map(item => item.method)).toEqual(['GET', 'PUT', 'GET']);
});

it('binds exact requests and rejects caught extra attempts even when the first write succeeds', async () => {
  const f = await setup(), review = await reviewed(f);
  // Mocks use one success call; a second call only in real conditions is a contract violation.
  // This is a host-only verification test of the actual guard, not author permission.
  const original = fs.readFileSync(path.join(f.run.draft.adapterDir, f.manifest.commands[0].module), 'utf8');
  const modified = original.replace('return await api.request(', 'const result = await api.request(').replace("json:{title:args.title}});", "json:{title:args.title}}); if (result.live) { try { await api.request({url:'EXAMPLE_ORIGIN/items/example',method:'PUT',json:{title:'Second'}}); } catch {} } return result;").replaceAll('EXAMPLE_ORIGIN', f.origin);
  await f.edit(f.manifest.commands[0].module, modified);
  expect((await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true })).error.code).toBe('VALIDATION_REQUIRED');
  const next = await reviewed(f);
  await f.call('write-verify', { tool: f.tool, reviewId: next.reviewId, confirmed: true });
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', error: { code: 'WRITE_RESULT_MISMATCH' } });
  expect(f.requests.map(item => item.method)).toEqual(['GET', 'PUT']);
});

it('mock checks raw handler confirmation and failure interpretation without host credentials', async () => {
  const f = await setup({ auth: true });
  const review = await reviewed(f); // No EXAMPLE_WRITE_KEY exists.
  expect(f.requests).toHaveLength(0);
  vi.stubEnv('EXAMPLE_WRITE_KEY', 'example-write-placeholder');
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.status).toBe('review_ready');
  expect(f.requests.every(item => item.auth === 'Bearer example-write-placeholder')).toBe(true);
  expect(fs.readFileSync(path.join(f.options.rootDir, f.taskId + '.json'), 'utf8')).not.toContain('example-write-placeholder');
  const bad = await setup({ source: "module.exports = async (args,api) => { const __confirmed = args.__confirmed; return api.request({url:'EXAMPLE_ORIGIN/items/example',method:'PUT',json:{title:args.title}}); };" });
  await bad.call('validate');
  expect(bad.run.runtimeSummary.errors.some(item => item.code === 'WRITE_IO_BEFORE_CONFIRMATION')).toBe(true);
  expect(bad.requests).toHaveLength(0);
});

it('invalidates proof and review when fixtures or package bytes change, including external sidecar edits', async () => {
  const f = await setup(), review = await reviewed(f);
  const file = path.join(generationEvidenceDir(f.run.draft.adapterDir), 'write-verification.json');
  const fixtures = JSON.parse(fs.readFileSync(file)); fixtures.commands['update-item'].id = 'example-second'; fs.writeFileSync(file, JSON.stringify(fixtures));
  expect((await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true })).error.code).toBe('VALIDATION_REQUIRED');
  expect(f.requests).toHaveLength(0);
  expect((await f.call('verification-write', { tool: f.tool, cases: [], expectedHash: '' })).error.code).toBe('WRITE_CASE_REQUIRED');
  expect((await f.saveFixture({ ...f.fixture, representativeArgs: { title: 'After', __confirmed: true } })).error.code).toBe('INVALID_WRITE_CASE');
  expect((await f.saveFixture({ ...f.fixture, effect: { ...f.fixture.effect, before: f.fixture.effect.after } })).error.code).toBe('INVALID_WRITE_CASE');
  expect((await f.saveFixture({ ...f.fixture, expectedRequest: { ...f.fixture.expectedRequest, url: f.origin + '/other' } })).error.code).toBe('INVALID_WRITE_CASE');
});

it('recovers a cancellation saved while dispatch is still in flight and retains the original review identity', async () => {
  const f = await setup(), review = await reviewed(f);
  f.run.status = 'cancelled';
  f.run.writeExecutions = [{ reviewId: review.reviewId, tool: f.tool, status: 'dispatching', dispatched: true }];
  f.service.save(f.run);
  const restored = new ExplorationService(f.options);
  expect(restored.runs.get(f.taskId)).toMatchObject({ status: 'cancelled', writeExecutions: [{ status: 'uncertain', error: { code: 'WRITE_INTERRUPTED' } }] });
  expect((await restored.execute('write-verify', { taskId: f.taskId, tool: f.tool, reviewId: review.reviewId, confirmed: true })).ok).toBe(true);
  expect(f.requests).toHaveLength(0);
});

it('requires saving the dispatch marker before performing network I/O', async () => {
  const f = await setup(), review = await reviewed(f);
  const save = f.service.save.bind(f.service);
  f.service.save = run => {
    if (run.writeExecutions?.some(item => item.status === 'dispatching')) throw new Error('Example storage failure');
    save(run);
  };
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.requests.map(item => item.method)).toEqual(['GET']);
  expect(f.run.writeExecutions[0].status).toBe('uncertain');
});

it('verifies mixed read/write plans without executing writes through the ordinary read validator', async () => {
  const f = await setup({ mixed: true }), review = await reviewed(f);
  expect(f.requests.map(item => item.method)).toEqual(['GET', 'GET']);
  expect(f.run.runtimeSummary.executionSummary).toEqual({ attempted: 1, passed: 1, skipped: 0, failed: 0 });
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.status).toBe('review_ready');
  expect(f.requests.map(item => item.method)).toEqual(['GET', 'GET', 'GET', 'PUT', 'GET']);
  await f.call('validate');
  expect(f.run.status).toBe('review_ready');
  expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(1);
});

it('cancels a running write mock without overwriting the terminal task state', async () => {
  const f = await setup({ source: 'module.exports = args => { if (args.__confirmed !== true) return {blocked:true,requiresConfirmation:true}; while(true) {} };' });
  await f.service.execute('validate', { taskId: f.taskId });
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.service.execute('cancel', { taskId: f.taskId });
  await f.service.jobs.get(f.taskId);
  expect(f.run.status).toBe('cancelled');
  expect(f.run.runtimeDigest).toBe(null);
  expect(f.requests).toHaveLength(0);
});

it('matches JSON content-type after host normalization and rejects unreviewed extra headers before dispatch', async () => {
  const f = await setup();
  expect((await f.saveFixture({ ...f.fixture, expectedRequest: { ...f.fixture.expectedRequest, headers: { 'content-type': 'application/json' } } })).ok).toBe(true);
  const review = await reviewed(f);
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.status).toBe('review_ready');
  const extra = await setup({ source: `module.exports = async (args,api) => {
    if (args.__confirmed !== true) return {blocked:true,requiresConfirmation:true};
    try { return await api.request({url:'EXAMPLE_ORIGIN/items/example',method:'PUT',json:{title:args.title},headers:{'x-example':'unreviewed'}}); }
    catch (error) { return {ok:false,errorCode:error.code}; }
  };` });
  await extra.call('validate');
  expect(extra.run.status).toBe('draft');
  expect(extra.run.runtimeSummary.errors[0].code).toBe('WRITE_REQUEST_MISMATCH');
  expect(extra.requests).toHaveLength(0);
});

async function resultFixture(f) {
  const fixture = structuredClone(f.fixture);
  fixture.effect.resultReadback = { url: f.origin + '/records/:id', publicId: true, responsePath: 'id', identityPath: 'id', expect: { equals: { title: 'After' } } };
  expect((await f.saveFixture(fixture)).ok).toBe(true);
  return reviewed(f);
}

it('reads the actual response ID, persists only that binding, installs and recovers without trusting handler mapping', async () => {
  const f = await setup({ resultId: '007示例', source: `module.exports = async (args,api) => {
    if (args.__confirmed !== true) return {blocked:true,requiresConfirmation:true};
    try { const value = await api.request({url:'EXAMPLE_ORIGIN/items/example',method:'PUT',json:{title:args.title}}); return {ok:value.ok,title:value.title,id:'fabricated'}; }
    catch(error) { return {ok:false,errorCode:error.code}; }
  };` });
  const review = await resultFixture(f), args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  expect(f.requests).toHaveLength(0);
  await f.call('write-verify', args);
  expect(f.run.status).toBe('review_ready');
  expect(f.requests.map(r => r.url)).toEqual(['/items/example', '/items/example', '/items/example', '/records/007%E7%A4%BA%E4%BE%8B']);
  expect(f.run.writeExecutions[0].resultBinding).toEqual({ id: '007示例' });
  expect(JSON.stringify((await f.call('get')).data)).not.toContain('007示例');
  expect(JSON.stringify((await f.call('write-review', { tool: f.tool })).data)).not.toContain('007示例');
  const reviewedExecution = (await f.call('write-review', { tool: f.tool })).data.execution;
  expect(reviewedExecution).not.toHaveProperty('effect');
  expect(reviewedExecution).not.toHaveProperty('http');
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('write-readback', { taskId: f.taskId, reviewId: args.reviewId })).data.passed).toBe(true);
  await restored.execute('write-verify', { taskId: f.taskId, ...args });
  expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  const installReview = await f.call('review');
  await f.call('install', { reviewId: installReview.data.reviewId, confirmed: true });
  expect(f.run.status).toBe('installed');
  const knowledge = await f.service.execute('knowledge-read', { site: f.run.siteKey });
  const saved = await f.call('knowledge-save', { expectedHash: knowledge.data.hash });
  expect(JSON.stringify(saved)).not.toContain('007示例');
});

it.each([{ id: 'different' }, { title: 'Different' }])('requires both exact resource identity and content: %j', async detail => {
  const f = await setup({ resultId: 'example-generated', detail }), review = await resultFixture(f);
  const args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', error: { code: 'WRITE_EFFECT_MISMATCH' } });
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
  expect((await f.call('write-readback', { reviewId: review.reviewId })).data.passed).toBe(false);
  await f.call('write-verify', args);
  expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
});

it.each(['../unintended', '%2f', 7])('never dispatches detail GET for an invalid actual ID %j', async resultId => {
  const f = await setup({ resultId }), review = await resultFixture(f);
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', error: { code: 'WRITE_RESULT_ID_INVALID' } });
  expect(f.requests.map(r => r.method)).toEqual(['GET', 'PUT']);
  const count = f.requests.length;
  expect((await f.call('write-readback', { reviewId: review.reviewId })).error.code).toBe('WRITE_RESULT_ID_UNAVAILABLE');
  expect(f.requests).toHaveLength(count);
});

it('does not invent a mock ID or reissue a lost response write during recovery', async () => {
  const f = await setup({ behavior: 'disconnect', resultId: 'unseen' }), review = await resultFixture(f);
  const args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('write-readback', { taskId: f.taskId, reviewId: args.reviewId })).error.code).toBe('WRITE_RESULT_ID_UNAVAILABLE');
  await restored.execute('write-verify', { taskId: f.taskId, ...args });
  expect(f.requests.map(r => r.method)).toEqual(['GET', 'PUT']);
});

it('saves the actual ID before an authored handler fails and never upgrades failure on readback', async () => {
  const f = await setup({ resultId: 'example-generated', source: `module.exports = async (args,api) => {
    if (args.__confirmed !== true) return {blocked:true,requiresConfirmation:true};
    try { const value = await api.request({url:'EXAMPLE_ORIGIN/items/example',method:'PUT',json:{title:args.title}}); if(value.live) return {ok:false}; return value; }
    catch(error) { return {ok:false,errorCode:error.code}; }
  };` }), review = await resultFixture(f);
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.writeExecutions[0].status).toBe('uncertain');
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('write-readback', { taskId: f.taskId, reviewId: review.reviewId })).data.passed).toBe(true);
  expect((await restored.execute('review', { taskId: f.taskId })).error.code).toBe('VALIDATION_REQUIRED');
});

it('never uses a host credential echoed as a result ID or persists it', async () => {
  vi.stubEnv('EXAMPLE_WRITE_KEY', 'example-credential-placeholder');
  const f = await setup({ auth: true, resultId: 'example-credential-placeholder' }), review = await resultFixture(f);
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', error: { code: 'WRITE_RESULT_ID_INVALID' } });
  expect(f.requests.map(r => r.method)).toEqual(['GET', 'PUT']);
  expect(fs.readFileSync(path.join(f.options.rootDir, f.taskId + '.json'), 'utf8')).not.toContain('example-credential-placeholder');
});

it('stops effect GETs if the response ID cannot be durably saved', async () => {
  const f = await setup({ resultId: 'example-generated' }), review = await resultFixture(f);
  const save = f.service.save.bind(f.service); let failed = false;
  f.service.save = run => {
    if (!failed && run.writeExecutions?.[0]?.resultBinding) { failed = true; throw Object.assign(new Error('Example storage failure'), { code: 'EXAMPLE_STORE_UNAVAILABLE' }); }
    save(run);
  };
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', error: { code: 'EXAMPLE_STORE_UNAVAILABLE' } });
  expect(f.requests.map(r => r.method)).toEqual(['GET', 'PUT']);
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
});

it.each([0, Number.MAX_SAFE_INTEGER])('verifies and restores numeric response ID %s without changing its type', async resultId => {
  const f = await setup({ resultId }), fixture = structuredClone(f.fixture);
  fixture.successResponse.body.id = 1;
  fixture.effect.resultReadback = { url: f.origin + '/records/:id', publicId: true, idType: 'integer', responsePath: 'id', identityPath: 'id', expect: { equals: { title: 'After' } } };
  expect((await f.saveFixture(fixture)).ok).toBe(true);
  const review = await reviewed(f), args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'verified', resultBinding: { id: resultId } });
  expect(f.requests.at(-1).url).toBe('/records/' + resultId);
  const restored = new ExplorationService(f.options);
  expect(restored.runs.get(f.taskId).writeExecutions[0].resultBinding.id).toBe(resultId);
  expect((await restored.execute('write-readback', { taskId: f.taskId, reviewId: review.reviewId })).data.passed).toBe(true);
  await restored.execute('write-verify', { taskId: f.taskId, ...args });
  expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
});

async function pollFixture(f, maxAttempts = 3, intervalMs = 250) {
  const fixture = structuredClone(f.fixture);
  fixture.effect.after.equals.state = 'ready';
  fixture.effect.poll = { maxAttempts, intervalMs, pending: { equals: { state: 'pending' } } };
  expect((await f.saveFixture(fixture)).ok).toBe(true);
  return reviewed(f);
}

it('binds polling to precise review and installs only after delayed real GET effects match', async () => {
  const f = await setup({ asyncEffect: { pendingReads: 2 } }), old = await reviewed(f), review = await pollFixture(f);
  expect(review.reviewId).not.toBe(old.reviewId);
  expect(review.fixture.effect.poll).toMatchObject({ maxAttempts: 3, intervalMs: 250 });
  expect(f.requests).toHaveLength(0);
  expect((await f.call('write-verify', { tool: f.tool, reviewId: old.reviewId, confirmed: true })).error.code).toBe('STALE_REVIEW');
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'verified', effectAttempts: 3 });
  expect(f.requests.map(r => r.method)).toEqual(['GET', 'PUT', 'GET', 'GET', 'GET']);
  const install = (await f.call('review')).data;
  await f.call('install', { reviewId: install.reviewId, confirmed: true }); expect(f.run.status).toBe('installed');
});

it('keeps exhausted polling uncertain after restart and later successful recovery', async () => {
  const asyncEffect = { pendingReads: 100 }, f = await setup({ asyncEffect }), review = await pollFixture(f, 2);
  const args = { tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0]).toMatchObject({ status: 'uncertain', effectAttempts: 2 });
  asyncEffect.pendingReads = 0;
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('write-readback', { taskId: f.taskId, reviewId: review.reviewId })).data).toMatchObject({ passed: true, attempts: 1, originalStatus: 'uncertain' });
  await restored.execute('write-verify', { taskId: f.taskId, ...args });
  expect(f.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  expect((await restored.execute('review', { taskId: f.taskId })).error.code).toBe('VALIDATION_REQUIRED');
});

it('cancels waiting polls and independently cancels recovery on a terminal task without unlocking it', async () => {
  const f = await setup({ asyncEffect: { pendingReads: 100 } }), review = await pollFixture(f, 3, 5000);
  const args = { taskId: f.taskId, tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.service.execute('write-verify', args);
  await vi.waitFor(() => expect(f.requests).toHaveLength(3));
  await f.service.execute('cancel', { taskId: f.taskId }); await f.service.jobs.get(f.taskId);
  expect(f.run.status).toBe('cancelled'); expect(f.run.writeExecutions[0].status).toBe('uncertain');
  const reading = f.service.execute('write-readback', { taskId: f.taskId, reviewId: review.reviewId });
  await vi.waitFor(() => expect(f.requests).toHaveLength(4));
  expect((await f.service.execute('write-readback', { taskId: f.taskId, reviewId: review.reviewId })).error.code).toBe('TASK_BUSY');
  await f.service.execute('cancel', { taskId: f.taskId });
  expect((await reading).error.code).toBe('WRITE_READBACK_CANCELLED');
  expect(f.run.status).toBe('cancelled'); expect(f.service.readbacks.size).toBe(0);
  await f.service.execute('write-verify', args);
  expect(f.requests).toHaveLength(4);
});

async function installedWrite(f, { knowledge = true } = {}) {
  const review = await reviewed(f);
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  expect(f.run.status).toBe('review_ready');
  const install = (await f.call('review')).data;
  expect((await f.call('install', { reviewId: install.reviewId, confirmed: true })).ok).toBe(true);
  expect(f.run.status).toBe('installed');
  if (knowledge) {
    const old = (await f.service.execute('knowledge-read', { site: f.run.siteKey })).data;
    expect((await f.call('knowledge-save', { expectedHash: old.hash })).ok).toBe(true);
  }
  f.setTitle('Before'); f.requests.length = 0;
  return review;
}

async function repairWrite(f, { mixed = false, create = true, requestId = 'example-repair' } = {}) {
  const info = (await f.service.execute('repair-info', { site: f.run.siteKey })).data;
  const taskId = (await f.service.execute('start', { origin: f.origin, goal: 'Repair public example mapping', requestId })).data.taskId;
  const call = async (command, args = {}) => {
    const reply = await f.service.execute(command, { taskId, ...args });
    await f.service.jobs.get(taskId); return reply;
  };
  if (mixed) await call('request', { request: { url: f.origin + '/items/example' }, reason: 'Observe public example' });
  await call('declare-write', { url: f.origin + '/items/example', method: 'PUT', bodyKeys: ['title'], reason: 'Declare repair without replaying a write' });
  const plan = structuredClone(f.run.plan);
  plan.tools = plan.tools.filter(tool => mixed || tool.risk === 'write').map(tool => ({ ...tool, name: tool.name.replace(/_/g, '-'), sourceApiIndexes: [tool.risk === 'write' && mixed ? 1 : 0] }));
  const args = { site: info.site, expectedDigest: info.digest, plan };
  const response = create ? await call('repair', args) : null;
  if (create) expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { status: 'draft' } });
  const run = f.service.runs.get(taskId);
  const edit = async (file, content) => {
    const old = (await call('draft-read', { file })).data;
    return call('draft-write', { file, content, expectedHash: old.hash });
  };
  return { ...f, run, taskId, call, edit, args, info, response };
}

it('repairs installed HTTP write mappings using historical data, fresh consent, numeric IDs and bounded effect polling', async () => {
  const f = await setup({ mixed: true, resultId: 731, asyncEffect: { pendingReads: 1 } });
  const fixture = structuredClone(f.fixture);
  fixture.successResponse.body.id = 1;
  fixture.effect.resultReadback = { url: f.origin + '/records/:id', publicId: true, idType: 'integer', responsePath: 'id', identityPath: 'id', expect: { equals: { title: 'After' } } };
  fixture.effect.after.equals.state = 'ready';
  fixture.effect.poll = { maxAttempts: 3, intervalMs: 250, pending: { equals: { state: 'pending' } } };
  await f.saveFixture(fixture);
  const priorReview = await installedWrite(f);
  const installed = resolveAdapterCall(f.tool, { paths: f.paths }).adapter.root, before = readPackageDirectory(installed);
  f.setResponseField('label');
  const r = await repairWrite(f);
  expect(f.requests).toEqual([]);
  expect(r.run.repairKnowledge.importedWriteTools).toEqual([f.tool]);
  expect(r.run.writeExecutions || []).toEqual([]);
  expect(r.run.preWriteDigest).toBeFalsy();
  expect(JSON.stringify(r.response)).not.toContain('"id":731');
  const old = (await r.call('write-verification-read', { tool: r.tool })).data;
  const next = structuredClone(old.fixture);
  next.successResponse.body.label = next.successResponse.body.title; delete next.successResponse.body.title;
  await r.call('write-verification-write', { tool: r.tool, expectedHash: old.hash, fixture: next });
  await r.call('validate');
  expect(r.run.status).toBe('draft'); expect(f.requests).toEqual([]);
  const module = f.manifest.commands[0].module;
  const source = fs.readFileSync(path.join(r.run.draft.adapterDir, module), 'utf8')
    .replace('return await api.request(', 'const value = await api.request(')
    .replace('json:{title:args.title}});', 'json:{title:args.title}}); return {ok:value.ok,title:value.label};');
  expect((await r.edit(module, source)).ok).toBe(true);
  const review = await reviewed(r);
  expect(review).toMatchObject({ consumed: false, execution: null, repair: { writeCommandIds: ['update-item'], authorizationInherited: false } });
  expect(review.reviewId).not.toBe(priorReview.reviewId);
  expect((await r.call('write-verify', { tool: r.tool, reviewId: priorReview.reviewId, confirmed: true })).error.code).toBe('STALE_REVIEW');
  expect((await r.call('write-verify', { tool: r.tool, reviewId: review.reviewId })).error.code).toBe('CONFIRMATION_REQUIRED');
  expect(f.requests).toEqual([]);
  await r.call('write-verify', { tool: r.tool, reviewId: review.reviewId, confirmed: true });
  expect(r.run.status).toBe('review_ready');
  expect(r.run.writeExecutions[0].resultBinding).toEqual({ id: 731 });
  expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(1);
  expect(f.requests.filter(item => item.url === '/records/731')).toHaveLength(1);
  const install = (await r.call('review')).data;
  await r.call('install', { reviewId: install.reviewId, confirmed: true });
  expect(r.run.status).toBe('installed');
  const after = readPackageDirectory(installed);
  for (const [name, bytes] of before.files) if (!r.run.editableFiles.includes(name)) expect(after.files.get(name)).toEqual(bytes);
  expect(after.manifest.commands[1]).toEqual(before.manifest.commands[1]);
  expect((await runHttpTool(resolveAdapterCall(r.tool, { paths: f.paths }), { title: 'Ordinary', __confirmed: true })).result).toMatchObject({ ok: true, title: 'Ordinary' });
  expect((await runHttpTool(resolveAdapterCall(f.run.draft.toolNames[1], { paths: f.paths }), {})).result.id).toBe('example');
  const knowledge = (await r.service.execute('knowledge-read', { site: r.run.siteKey })).data;
  const saved = await r.call('knowledge-save', { expectedHash: knowledge.hash });
  expect(saved.ok).toBe(true); expect(JSON.stringify(saved)).not.toContain('"id":731');
});

it('revalidates mixed repair read cases without running the selected write in the read validator', async () => {
  const f = await setup({ mixed: true }); await installedWrite(f);
  const r = await repairWrite(f, { mixed: true });
  expect(r.run.repairKnowledge.importedTools).toEqual([f.run.draft.toolNames[1]]);
  const cases = r.run.verification; r.run.verification = {};
  expect((await r.call('validate')).error.code).toBe('VERIFICATION_REQUIRED');
  r.run.verification = cases;
  await reviewed(r);
  expect(f.requests.every(item => item.method === 'GET')).toBe(true);
  expect(r.run.runtimeSummary.executionSummary).toEqual({ attempted: 1, passed: 1, skipped: 0, failed: 0 });
});

it.each(['missing', 'digest', 'kind', 'invalid'])('skips %s historical write fixtures and never imports authorization', async variation => {
  const f = await setup(); await installedWrite(f, { knowledge: variation !== 'missing' });
  if (variation !== 'missing') {
    const file = f.service.knowledge.file(f.run.siteKey), data = JSON.parse(fs.readFileSync(file));
    const record = data.commands[f.tool];
    if (variation === 'digest') record.packageDigest = 'example-stale-digest';
    if (variation === 'kind') record.writeVerification.kind = 'ui_single_submit_v1';
    if (variation === 'invalid') record.writeVerification.fixture.representativeArgs.__confirmed = true;
    record.writeExecutions = f.run.writeExecutions;
    fs.writeFileSync(file, JSON.stringify(data));
  }
  const r = await repairWrite(f);
  expect(r.run.repairKnowledge.importedWriteTools).toEqual([]);
  expect(r.run.repairKnowledge.skippedWriteTools).toEqual([{ tool: f.tool, code: variation === 'missing' ? 'WRITE_FIXTURE_MISSING' : variation === 'invalid' ? 'INVALID_WRITE_CASE' : 'WRITE_KNOWLEDGE_BASE_MISMATCH' }]);
  expect(r.run.writeExecutions || []).toEqual([]);
  await r.call('validate'); expect(r.run.status).toBe('draft');
  expect((await r.call('review')).ok).toBe(false); expect(f.requests).toEqual([]);
});

it('rejects changing risk, strategy, origin or authentication during write repair planning', async () => {
  const f = await setup({ auth: true }); vi.stubEnv('EXAMPLE_WRITE_KEY', 'example-write-placeholder');
  await installedWrite(f);
  const r = await repairWrite(f, { create: false });
  for (const change of [tool => { tool.risk = 'read'; }, tool => { tool.strategy = 'PUBLIC_API'; delete tool.auth; },
    tool => { tool.auth.env = 'EXAMPLE_OTHER_KEY'; }, tool => { tool.auth.origin = 'https://example.org'; }]) {
    const args = structuredClone(r.args); change(args.plan.tools[0]);
    expect((await r.call('repair', args)).ok).toBe(false);
  }
  expect(f.requests).toEqual([]);
  expect((await r.call('repair', r.args)).ok).toBe(true);
});

it('protects shared bytes, sibling reads/writes, runtime and grants even against forged source scope', async () => {
  const f = await setup({ mixed: true }); await installedWrite(f);
  const r = await repairWrite(f), pkg = readPackageDirectory(r.run.draft.adapterDir);
  const before = readPackageDirectory(resolveAdapterCall(f.tool, { paths: f.paths }).adapter.root);
  const module = f.manifest.commands[0].module;
  await r.edit(module, pkg.files.get(module).toString() + '\n// repaired mapping\n');
  const evidence = readGenerationEvidence(r.run.draft.adapterDir);
  evidence.repairScope = r.run.repairScope;
  expect(() => verifyRetainedPackage(readPackageDirectory(r.run.draft.adapterDir), evidence, { paths: f.paths })).toThrow();
  expect(() => verifyRepairRetention(before, pkg, { ...r.run.repairScope, writeCommandIds: [] })).toThrow();
  for (const change of [
    manifest => { manifest.commands[0].safety = 'read'; },
    manifest => { manifest.commands[0].runtime = 'extension'; },
    manifest => { manifest.commands[0].http.origins.push('https://example.org'); },
    manifest => { manifest.commands[1].description += ' changed'; },
    manifest => { manifest.match.push('example.org'); },
  ]) {
    const next = { ...pkg, manifest: structuredClone(pkg.manifest) }; change(next.manifest);
    expect(() => verifyRepairRetention(before, next, r.run.repairScope)).toThrow();
  }
  const shared = [...before.files.keys()].find(name => name !== 'manifest.json' && !r.run.editableFiles.includes(name));
  expect(shared).toBeTruthy();
  expect((await r.edit(shared, 'modified shared bytes')).error.code).toBe('REPAIR_SCOPE_CHANGED');
  const siblingWrite = { ...before.manifest.commands[0], id: 'retained-write', module: 'http/commands/retained-write.js' };
  const withWrite = { ...before, manifest: { ...before.manifest, commands: [...before.manifest.commands, siblingWrite] }, files: new Map([...before.files, [siblingWrite.module, Buffer.from('throw new Error("MUST_NOT_RUN")')]]) };
  const changed = { ...withWrite, files: new Map(withWrite.files) }; changed.files.set(siblingWrite.module, Buffer.from('changed'));
  expect(() => verifyRepairRetention(withWrite, changed, r.run.repairScope)).toThrow();
});

it.each(['review', 'dispatch', 'before-read', 'install'])('rejects an installed baseline changed before %s', async phase => {
  const f = await setup(); await installedWrite(f);
  const r = await repairWrite(f), review = await reviewed(r);
  const mutate = () => fs.appendFileSync(path.join(resolveAdapterCall(f.tool, { paths: f.paths }).adapter.root, 'manifest.json'), '\n');
  if (phase === 'before-read') f.onRead(mutate);
  else if (phase !== 'install') mutate();
  if (phase === 'review') expect((await r.call('write-review', { tool: f.tool })).error.code).toBe('ADAPTER_BASE_CHANGED');
  else {
    const result = await r.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
    if (phase === 'dispatch') expect(result.error.code).toBe('ADAPTER_BASE_CHANGED');
    if (phase === 'before-read') expect(r.run.writeExecutions[0]).toMatchObject({ status: 'not_dispatched', dispatched: false, error: { code: 'ADAPTER_BASE_CHANGED' } });
    if (phase === 'install') {
      const install = (await r.call('review')).data; mutate();
      expect((await r.call('install', { reviewId: install.reviewId, confirmed: true })).error.code).toBe('ADAPTER_BASE_CHANGED');
    }
  }
  expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(phase === 'install' ? 1 : 0);
});

it('binds identical repair reviews to their own task and preserves cancelled or interrupted writes without replay', async () => {
  const f = await setup(); await installedWrite(f);
  const r = await repairWrite(f), review = await reviewed(r);
  const other = await repairWrite(f, { requestId: 'example-other-repair' }), otherReview = await reviewed(other);
  expect(otherReview.reviewId).not.toBe(review.reviewId);
  expect((await other.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true })).error.code).toBe('STALE_REVIEW');
  f.setBehavior('hang');
  const args = { taskId: r.taskId, tool: f.tool, reviewId: review.reviewId, confirmed: true };
  await f.service.execute('write-verify', args);
  await vi.waitFor(() => expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(1));
  const restored = new ExplorationService(f.options);
  expect(restored.runs.get(r.taskId).writeExecutions[0].status).toBe('uncertain');
  await restored.execute('write-verify', args);
  await f.service.execute('cancel', { taskId: r.taskId }); await f.service.jobs.get(r.taskId);
  expect(r.run.status).toBe('cancelled');
  expect((await r.call('write-readback', { reviewId: review.reviewId })).data.passed).toBe(true);
  expect((await r.call('review')).ok).toBe(false);
  expect(f.requests.filter(item => item.method === 'PUT')).toHaveLength(1);
});


it('revalidates imported fixtures against the newly declared source before making a repair executable', async () => {
  const f = await setup(); await installedWrite(f);
  const r = await repairWrite(f, { create: false });
  await r.call('declare-write', { url: f.origin + '/items/other', method: 'PUT', bodyKeys: ['title'], reason: 'Explicit public replacement route' });
  r.args.plan.tools[0].sourceApiIndexes = [1];
  expect((await r.call('repair', r.args)).ok).toBe(true);
  expect(r.run.repairKnowledge.skippedWriteTools).toEqual([{ tool: f.tool, code: 'INVALID_WRITE_CASE' }]);
  await r.call('validate'); expect(r.run.status).toBe('draft');
  expect((await r.call('write-review', { tool: f.tool })).ok).toBe(false);
  expect(f.requests).toEqual([]);
});
