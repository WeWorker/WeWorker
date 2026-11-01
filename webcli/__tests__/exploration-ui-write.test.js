import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplorationService } from '../exploration-service.js';
import { resolveAdapterPaths } from '../paths.js';
import { resolveUiWrite, validateUiWrite, uiWriteSuccess, uiWriteFailure } from '../exploration-ui-write.js';
import { uiWriteRequest } from '../../extension/background/ui-write.js';
import { adapterPermissions } from '../adapter-catalog.js';
import { readPackageDirectory } from '../adapter-package-files.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const origin = 'https://example.com', url = origin + '/items/example';

it('requires every authored write case before install and never replays a consumed earlier case',async()=>{
  const f=await setup();
  const next=structuredClone(f.fixture);next.id='second';next.representativeArgs.title='Again';next.expectedSubmission.body.title='Again';next.effect.before.equals.title='After';next.effect.after.equals.title='Again';
  expect((await f.save({cases:[f.fixture,next]})).ok).toBe(true);
  await f.call('validate');expect(f.requests).toEqual([]);
  expect((await f.call('write-review',{tool:f.tool})).error.code).toBe('WRITE_CASE_REQUIRED');
  const first=(await f.call('write-review',{tool:f.tool,caseId:f.fixture.id})).data;
  await f.call('write-verify',{tool:f.tool,caseId:f.fixture.id,reviewId:first.reviewId,confirmed:true});
  expect(f.run.status).toBe('write_review_ready');expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
  const second=(await f.call('write-review',{tool:f.tool,caseId:'second'})).data;
  await f.call('write-verify',{tool:f.tool,caseId:'second',reviewId:second.reviewId,confirmed:true});expect(f.run.status).toBe('review_ready');
  const count=f.requests.length;await f.call('write-verify',{tool:f.tool,caseId:f.fixture.id,reviewId:first.reviewId,confirmed:true});expect(f.requests).toHaveLength(count);
  expect(f.run.writeExecutions.map(value=>value.caseId)).toEqual([f.fixture.id,'second']);
});

it('rejects duplicate, nested or oversized write suites without replacing authored evidence',async()=>{
  const f=await setup();
  for(const cases of [[f.fixture],[f.fixture,f.fixture],[{cases:[f.fixture]},f.fixture],Array.from({length:11},(_,i)=>({...f.fixture,id:'case'+i}))])expect((await f.save({cases})).error.code).toBe('INVALID_WRITE_CASE');
});
export async function setup(behavior = 'normal', resultId = 'example', receiptId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-write-test-')); roots.push(root);
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEWORKER_BUILD_PROFILE: 'public' } });
  let title = 'Before', caps = true, document = { frameId: 'example', loaderId: 'first', url: origin + '/editor' };
  const requests = [];
  const options = { rootDir: path.join(root, 'tasks'), paths,
    capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', ...(caps ? ['page_write_v1', 'ui_write_v1', 'ui_write_result_v1'] : [])] }),
    requestExtension: vi.fn(async msg => {
      if (msg.type === 'exploration_list_tabs') return { tabs: [{ id: 7, url: origin + '/editor' }] };
      if (msg.type !== 'exploration_page_write') return { network: { entries: [] } };
      const { request, expectedDocument } = msg.payload;
      if (expectedDocument && JSON.stringify(expectedDocument) !== JSON.stringify(document)) return { ok: false, error: { code: 'PAGE_WRITE_DOCUMENT_CHANGED' }, dispatched: false };
      requests.push(request);
      if (request.method !== 'GET') {
        if (behavior !== 'noeffect') title = request.body.title;
        if (behavior === 'lost') return { ok: false, error: { code: 'PAGE_WRITE_NETWORK_ERROR' }, dispatched: true };
      }
      const detail = request.url.includes('/resources/');
      const reply = { ok: true, value: request.method === 'GET' ? { title, id: detail ? (behavior === 'wrong-id' ? String(receiptId) : receiptId) : resultId }
        : { ...uiWriteSuccess, ...(receiptId !== undefined && behavior !== 'missing-id' ? { resultId: receiptId } : {}) }, document: { ...document } };
      if (behavior === 'navigation' && request.method === 'GET') document.loaderId = 'changed';
      if (behavior === 'detail-navigation' && request.method === 'GET' && title === 'After') document.loaderId = 'changed';
      return reply;
    }) };
  const service = new ExplorationService(options);
  const taskId = (await service.execute('start', { tabId: 7, goal: 'Update public example', requestId: 'example' })).data.taskId;
  await service.jobs.get(taskId);
  const call = async (command, args = {}) => {
    const reply = await service.execute(command, { taskId, ...args });
    await service.jobs.get(taskId); return reply;
  };
  await call('declare-write', { url, method: 'POST', bodyKeys: ['title'], reason: 'Public example write' });
  const plan = { tools: [{ name: 'update_title', risk: 'write', sourceApiKind: 'action', sourceApiIndexes: [0], strategy: 'UI_SELECTOR',
    pagePathname: '/editor', uiWrite: { form: '#editor', inputMode: 'native-setter-no-events', inputs: [{ selector: '#title', name: 'title', parameter: 'title' }],
      submit: { selector: '#save', text: 'Save' }, confirmation: { selector: '#receipt', attribute: 'data-title', parameter: 'title' } }, writeReason: 'Edit example title', strategyNote: { reason: 'Browser session', alternatives: 'This public fixture only exposes the browser-authenticated update endpoint.', limitations: 'One JSON request' } }] };
  if (receiptId !== undefined) plan.tools[0].uiWrite.result = { attribute: 'data-result-id', publicId: true, idType: typeof receiptId === 'number' ? 'integer' : 'string' };
  const generated = await call('generate', { plan });
  expect(generated, JSON.stringify(generated)).toMatchObject({ ok: true });
  const run = service.runs.get(taskId), tool = run.draft.toolNames[0];
  const fixture = { id: 'example', representativeArgs: { title: 'After' }, expectedSubmission: { url, method: 'POST', body: { title: 'After' } },
    effect: { identityPath: 'id', argumentPaths: { title: 'title' }, readback: { url }, before: { equals: { id: 'example', title: 'Before' } }, after: { equals: { id: 'example', title: 'After' } } } };
  if (receiptId !== undefined) fixture.effect.resultReadback = { url: origin + '/resources/:id', publicId: true, idType: typeof receiptId === 'number' ? 'integer' : 'string',
    responsePath: 'resultId', identityPath: 'id', expect: { equals: { title: 'After' } } };
  const save = async value => call('write-verification-write', { tool, fixture: value, expectedHash: (await call('write-verification-read', { tool })).data.hash });
  expect((await save(fixture)).ok).toBe(true);
  await call('validate'); expect(run.status, JSON.stringify(run)).toBe('write_review_ready');
  const review = (await call('write-review', { tool })).data;
  return { root, service, run, tool, call, review, requests, options, fixture, save, setCaps: value => { caps = value; }, setTitle: value => { title = value; } };
}

it('uses exact UI review, zero live mocks, one consumed submission, install permission and durable knowledge', async () => {
  const f = await setup(); expect(f.requests).toEqual([]);
  expect(f.review.page.ui.inputMode).toBe('native-setter-no-events');
  expect(f.review.page.idempotency).toBeUndefined();
  const args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  expect((await f.call('write-verify', { ...args, confirmed: false })).error.code).toBe('CONFIRMATION_REQUIRED');
  await Promise.all([f.call('write-verify', args), f.call('write-verify', args)]);
  expect(f.run.status, JSON.stringify(f.run.writeExecutions)).toBe('review_ready');
  expect(f.requests.map(v => v.method)).toEqual(['GET', 'POST', 'GET']);
  const review = (await f.call('review')).data;
  expect(review.permissions.some(v => v.startsWith('ui-write:'))).toBe(true);
  await f.call('install', { reviewId: review.reviewId, confirmed: true }); expect(f.run.status).toBe('installed');
  const knowledge = await f.service.execute('knowledge-read', { site: f.run.siteKey });
  const saved = await f.call('knowledge-save', { expectedHash: knowledge.data.hash });
  expect(saved.data.knowledge.commands[f.tool].writeVerification).toMatchObject({ kind: 'ui_single_submit_v1', replayAllowed: false });
  const restored = new ExplorationService(f.options);
  await restored.execute('write-verify', { taskId: f.run.taskId, ...args }); expect(f.requests).toHaveLength(3);
});
it.each(['lost', 'noeffect', 'navigation'])('uncertain %s cannot replay or install; independent readback only', async behavior => {
  const f = await setup(behavior), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0].status).toBe('uncertain');
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
  await f.call('write-verify', args);
  expect(f.requests.filter(v => v.method === 'POST')).toHaveLength(behavior === 'navigation' ? 0 : 1);
  expect((await f.call('write-readback', { reviewId: args.reviewId })).data.passed).toBe(behavior === 'lost');
});
it.each(['caps', 'before', 'save'])('no submission after %s preflight failure or same-review retry', async mode => {
  const f = await setup(), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  if (mode === 'caps') f.setCaps(false);
  if (mode === 'before') f.setTitle('Different');
  if (mode === 'save') { const save = f.service.save.bind(f.service); f.service.save = run => { if (run.writeExecutions?.[0]?.status === 'dispatching') throw new Error('Example storage unavailable'); save(run); }; }
  await f.call('write-verify', args); await f.call('write-verify', args);
  expect(f.requests.some(v => v.method === 'POST')).toBe(false);
});
it('binds all inputs and changed correlation to independent after fields; forbids fabricated response IDs', async () => {
  const f = await setup();
  for (const effect of [{ identityPath: 'title' }, { identityPath: '$.id' }, { argumentPaths: {} }, { argumentPaths: { title: '$.title' } }, { after: { equals: { title: 'Wrong' } } },
    { before: { equals: { title: 'After', count: 0 } }, after: { equals: { title: 'After', count: 1 } } }, { resultReadback: {} }]) {
    expect((await f.save({ ...f.fixture, effect: { ...f.fixture.effect, ...effect } })).ok).toBe(false);
  }
  const bad = structuredClone(f.fixture); bad.expectedSubmission.body.title = 'Wrong'; expect((await f.save(bad)).ok).toBe(false);
});
it('validates route, controls, args and immutable module on both call paths', async () => {
  const f = await setup(), pkg = readPackageDirectory(f.run.draft.adapterDir), command = pkg.commands[0], args = { title: '007 示例', __confirmed: true };
  expect(uiWriteRequest(command, args)).toEqual(resolveUiWrite(command, args));
  for (const bad of [{}, { ...args, __confirmed: 'true' }, { ...args, title: 1 }, { ...args, extra: 'value' }, { ...args, title: 'one\ntwo' }]) {
    expect(() => resolveUiWrite(command, bad)).toThrow(); expect(() => uiWriteRequest(command, bad)).toThrow();
  }
  for (const patch of [{ requires_confirmation: false }, { runtime: 'http' }, { safety: 'read' }, { pageWrite: {} }, { uiWrite: { ...command.uiWrite, url: 'https://example.org/items/example' } },
    { uiWrite: { ...command.uiWrite, inputMode: 'input-events' } }, { uiWrite: { ...command.uiWrite, confirmation: { selector: '#receipt', attribute: 'data-title', parameter: 'unknown' } } }]) expect(() => validateUiWrite({ ...command, ...patch })).toThrow();
  const permissions = adapterPermissions(pkg.manifest), manifest = structuredClone(pkg.manifest); manifest.commands[0].uiWrite.submit.text = 'Other';
  expect(adapterPermissions(manifest)).not.toEqual(permissions);
  fs.appendFileSync(path.join(f.run.draft.adapterDir, command.module), '\n// changed'); expect(() => readPackageDirectory(f.run.draft.adapterDir)).toThrow(/fixed registration/);
});

it.each(['007示例', 0, 73])('retains only actual UI receipt ID %s and verifies its resource after fixed effects', async id => {
  const f = await setup('normal', 'example', id), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  expect(f.requests).toEqual([]);
  expect(f.review.responseIdPolicy).toContain('fresh correlated page receipt');
  await f.call('write-verify', args);
  expect(f.run.status, JSON.stringify(f.run.writeExecutions)).toBe('review_ready');
  expect(f.requests.map(v => v.method)).toEqual(['GET', 'POST', 'GET', 'GET']);
  expect(f.requests.at(-1).url).toBe(origin + '/resources/' + encodeURIComponent(id));
  expect(f.run.writeExecutions[0].resultBinding).toEqual({ id });
  expect((await f.call('get')).data.writeExecutions[0].resultBinding).toBeUndefined();
  expect((await f.call('write-review', { tool: f.tool })).data.execution.resultBinding).toBeUndefined();
  const restored = new ExplorationService(f.options);
  await restored.execute('write-verify', { taskId: f.run.taskId, ...args });
  expect(f.requests).toHaveLength(4);
  expect((await restored.execute('write-readback', { taskId: f.run.taskId, reviewId: args.reviewId })).data.passed).toBe(true);
  const review = (await f.call('review')).data;
  await f.call('install', { reviewId: review.reviewId, confirmed: true });
  expect(f.run.status).toBe('installed');
});
it.each(['missing-id', 'wrong-id', 'detail-navigation', 'lost'])('UI ID %s is uncertain and never replayed or guessed', async behavior => {
  const f = await setup(behavior, 'example', 73), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0].status).toBe('uncertain');
  const restored = new ExplorationService(f.options);
  await restored.execute('write-verify', { taskId: f.run.taskId, ...args });
  const before = f.requests.length;
  const recovery = await restored.execute('write-readback', { taskId: f.run.taskId, reviewId: args.reviewId });
  if (['missing-id', 'lost'].includes(behavior)) {
    expect(recovery.error.code).toBe('WRITE_RESULT_ID_UNAVAILABLE'); expect(f.requests).toHaveLength(before);
  }
  expect(f.requests.filter(v => v.method === 'POST')).toHaveLength(1);
  expect((await restored.execute('review', { taskId: f.run.taskId })).error.code).toBe('VALIDATION_REQUIRED');
});
it('requires matching UI ID type/path, resource input proof, capability and exact review', async () => {
  const f = await setup('normal', 'example', 73);
  for (const patch of [{ responsePath: 'mockId' }, { idType: 'string' }, { expect: { equals: { title: 'Wrong' } } }]) {
    const fixture = structuredClone(f.fixture); Object.assign(fixture.effect.resultReadback, patch);
    expect((await f.save(fixture)).ok).toBe(false);
  }
  const fixture = structuredClone(f.fixture); delete fixture.effect.resultReadback;
  expect((await f.save(fixture)).ok).toBe(false);
  f.service.capabilities = () => ({ connected: true, capabilities: ['passive_exploration_v1', 'page_write_v1', 'ui_write_v1'] });
  expect((await f.call('validate')).error.code).toBe('CAPABILITY_UNAVAILABLE');
  await f.call('write-verify', { tool: f.tool, reviewId: f.review.reviewId, confirmed: true });
  expect(f.requests).toEqual([]);
});

it('failed durable UI ID capture stops before any after GET; same review remains consumed', async () => {
  const f = await setup('normal', 'example', 73), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  const save = f.service.save.bind(f.service);
  let failed = false;
  f.service.save = run => {
    if (run.writeExecutions?.[0]?.resultBinding && !failed) { failed = true; throw new Error('Example durable ID storage failure'); }
    save(run);
  };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0].status).toBe('uncertain');
  expect(f.requests.map(v => v.method)).toEqual(['GET', 'POST']);
  await f.call('write-verify', args);
  expect(f.requests).toHaveLength(2);
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
});
it('changing the UI resource GET invalidates the old exact review without a submission', async () => {
  const f = await setup('normal', 'example', 73);
  const next = structuredClone(f.fixture); next.effect.resultReadback.url = origin + '/other-resources/:id';
  expect((await f.save(next)).ok).toBe(true);
  await f.call('validate');
  const changed = (await f.call('write-review', { tool: f.tool })).data;
  expect(changed.reviewId).not.toBe(f.review.reviewId);
  expect((await f.call('write-verify', { tool: f.tool, reviewId: f.review.reviewId, confirmed: true })).error.code).toBe('STALE_REVIEW');
  expect(f.requests).toEqual([]);
  const pkg = readPackageDirectory(f.run.draft.adapterDir), manifest = structuredClone(pkg.manifest);
  manifest.commands[0].uiWrite.result.attribute = 'data-new-id';
  expect(adapterPermissions(manifest)).not.toEqual(adapterPermissions(pkg.manifest));
});

it('validates exact date/popup declarations and binds popup changes into permission review',async()=>{
  const f=await setup();const pkg=readPackageDirectory(f.run.draft.adapterDir),command=structuredClone(pkg.manifest.commands[0]);
  command.uiWrite.version=2;command.uiWrite.inputMode='native-input-change';
  command.uiWrite.inputs[0].kind='date';expect(()=>validateUiWrite(command)).not.toThrow();
  Object.assign(command.uiWrite.inputs[0],{kind:'choice',popup:'#choices',option:'[role=option]'});
  expect(()=>validateUiWrite(command)).not.toThrow();
  const baseline=adapterPermissions({...pkg.manifest,commands:[command]});
  command.uiWrite.inputs[0].popup='#other';expect(adapterPermissions({...pkg.manifest,commands:[command]})).not.toEqual(baseline);
  for(const patch of [{popup:''},{option:''},{script:'example'},{kind:'file'}]){
    const invalid=structuredClone(command);Object.assign(invalid.uiWrite.inputs[0],patch);expect(()=>validateUiWrite(invalid)).toThrow();
  }
  command.uiWrite.inputMode='native-setter-no-events';expect(()=>validateUiWrite(command)).toThrow();
});
