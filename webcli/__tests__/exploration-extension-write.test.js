import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplorationService } from '../exploration-service.js';
import { resolveAdapterPaths } from '../paths.js';
import { buildExtensionWriteTool, resolvePageWrite, validatePageWrite } from '../exploration-extension-write.js';
import { pageWriteRequest } from '../../extension/background/page-write.js';
import { adapterPermissions } from '../adapter-catalog.js';
import { readPackageDirectory } from '../adapter-package-files.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const origin = 'https://example.com', url = origin + '/items/example';
async function setup(behavior = 'normal', resultId = 'example') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-write-test-')); roots.push(root);
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEWORKER_BUILD_PROFILE: 'public' } });
  let title = 'Before', caps = true, document = { frameId: 'example', loaderId: 'first', url: origin + '/editor' };
  const requests = [];
  const options = { rootDir: path.join(root, 'tasks'), paths,
    capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', ...(caps ? ['page_write_v1'] : [])] }),
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
      const reply = { ok: true, value: { ok: true, title, id: resultId }, document: { ...document } };
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
  const plan = { tools: [{ name: 'update_title', risk: 'write', sourceApiKind: 'action', sourceApiIndexes: [0], strategy: 'PAGE_FETCH',
    pagePathname: '/editor', bodyParameters: { title: 'title' }, idempotency: { header: 'idempotency-key', serverDeduplicates: true }, writeReason: 'Edit example title', strategyNote: { reason: 'Browser session', alternatives: 'This public fixture only exposes the browser-authenticated update endpoint.', limitations: 'One JSON request' } }] };
  const generated = await call('generate', { plan });
  expect(generated, JSON.stringify(generated)).toMatchObject({ ok: true });
  const run = service.runs.get(taskId), tool = run.draft.toolNames[0];
  const fixture = { id: 'example', representativeArgs: { title: 'After' }, expectedRequest: { url, method: 'POST', body: { title: 'After' } },
    successResponse: { status: 200, body: { ok: true, title: 'After' } }, successExpectation: { ok: true, title: 'After' },
    failureResponse: { status: 409, body: {} }, failureExpectation: { ok: false, errorCode: 'PAGE_WRITE_HTTP_STATUS' },
    effect: { readback: { url }, before: { equals: { title: 'Before' } }, after: { equals: { title: 'After' } } } };
  const save = async value => call('write-verification-write', { tool, fixture: value, expectedHash: (await call('write-verification-read', { tool })).data.hash });
  expect((await save(fixture)).ok).toBe(true);
  await call('validate'); expect(run.status, JSON.stringify(run)).toBe('write_review_ready');
  const review = (await call('write-review', { tool })).data;
  return { root, service, run, tool, call, review, requests, options, fixture, save, setCaps: value => { caps = value; }, setTitle: value => { title = value; } };
}

it('reuses write ledger, exact fixtures, install and knowledge without live validation writes', async () => {
  const f = await setup(); expect(f.requests).toEqual([]);
  expect(f.review.page).toMatchObject({ tabId: 7, route: { origin, pathname: '/editor' } });
  const args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  expect((await f.call('write-verify', { ...args, confirmed: false })).error.code).toBe('CONFIRMATION_REQUIRED');
  await Promise.all([f.call('write-verify', args), f.call('write-verify', args)]);
  expect(f.run.status).toBe('review_ready');
  expect(f.requests.map(request => request.method)).toEqual(['GET', 'POST', 'GET']);
  const review = (await f.call('review')).data;
  expect(review.permissions.some(value => value.startsWith('page-write:'))).toBe(true);
  await f.call('install', { reviewId: review.reviewId, confirmed: true }); expect(f.run.status).toBe('installed');
  const knowledge = await f.service.execute('knowledge-read', { site: f.run.siteKey });
  const saved = await f.call('knowledge-save', { expectedHash: knowledge.data.hash });
  expect(saved.data.knowledge.commands[f.tool].writeVerification).toMatchObject({ kind: 'extension_single_write_v1', replayAllowed: false });
  const restored = new ExplorationService(f.options);
  await restored.execute('write-verify', { taskId: f.run.taskId, ...args }); expect(f.requests).toHaveLength(3);
});

it.each(['lost', 'noeffect', 'navigation'])('does not certify or replay %s and preserves independent readback', async behavior => {
  const f = await setup(behavior), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
  await f.call('write-verify', args);
  expect(f.run.writeExecutions[0].status).toBe('uncertain');
  expect((await f.call('review')).error.code).toBe('VALIDATION_REQUIRED');
  await f.call('write-verify', args);
  expect(f.requests.filter(request => request.method === 'POST')).toHaveLength(behavior === 'navigation' ? 0 : 1);
  expect((await f.call('write-readback', { reviewId: args.reviewId })).data.passed).toBe(behavior === 'lost');
});

it('fails before dispatch for unavailable capabilities, failed preconditions and failed durable save', async () => {
  for (const mode of ['caps', 'before', 'save']) {
    const f = await setup(), args = { tool: f.tool, reviewId: f.review.reviewId, confirmed: true };
    if (mode === 'caps') f.setCaps(false);
    if (mode === 'before') f.setTitle('Different');
    if (mode === 'save') { const save = f.service.save.bind(f.service); f.service.save = run => { if (run.writeExecutions?.[0]?.status === 'dispatching') throw new Error('Example store unavailable'); save(run); }; }
    await f.call('write-verify', args);
    expect(f.requests.some(request => request.method === 'POST')).toBe(false);
    await f.call('write-verify', args); expect(f.requests.some(request => request.method === 'POST')).toBe(false);
  }
});

it('binds module, route, fixture body and full request permissions', async () => {
  const f = await setup();
  const changed = structuredClone(f.fixture); changed.expectedRequest.body.title = 'Different';
  expect((await f.save(changed)).error.code).toBe('INVALID_WRITE_CASE');
  const pkg = readPackageDirectory(f.run.draft.adapterDir), command = pkg.commands[0];
  const args = { title: '007 示例', __confirmed: true };
  expect(pageWriteRequest(command, args)).toEqual(resolvePageWrite(command, args));
  for (const bad of [{}, { title: 1, __confirmed: true }, { ...args, extra: 'value' }]) {
    expect(() => resolvePageWrite(command, bad)).toThrow(); expect(() => pageWriteRequest(command, bad)).toThrow();
  }
  for (const patch of [{ runtime: 'http' }, { safety: 'read' }, { pageWrite: { ...command.pageWrite, url: 'https://example.org/items/example' } }]) expect(() => validatePageWrite({ ...command, ...patch })).toThrow();
  expect(() => validatePageWrite({ ...command, pageWrite: { ...command.pageWrite, idempotency: undefined } })).toThrow(/idempotency/);
  expect(f.review.page.idempotency.key).toMatch(/^[a-f0-9]{64}$/);
  const before = adapterPermissions(pkg.manifest);
  const manifest = structuredClone(pkg.manifest); manifest.commands[0].pageRoute.pathname = '/other';
  expect(adapterPermissions(manifest)).not.toEqual(before);
  fs.appendFileSync(path.join(f.run.draft.adapterDir, command.module), '\nfetch("https://example.com/");');
  expect(() => readPackageDirectory(f.run.draft.adapterDir)).toThrow(/fixed registration/);
});

it.each(['normal', 'detail-navigation'])('keeps dynamic resource GET on the original page document: %s', async behavior => {
  const f = await setup(behavior, '007示例');
  const fixture = structuredClone(f.fixture);
  fixture.successResponse.body.id = 'example-mock';
  fixture.effect.resultReadback = { url: origin + '/records/:id', publicId: true, responsePath: 'id', identityPath: 'id', expect: { equals: { title: 'After' } } };
  expect((await f.save(fixture)).ok).toBe(true);
  await f.call('validate');
  const review = (await f.call('write-review', { tool: f.tool })).data;
  expect(review.reviewId).not.toBe(f.review.reviewId);
  await f.call('write-verify', { tool: f.tool, reviewId: review.reviewId, confirmed: true });
  const execution = f.run.writeExecutions[0];
  expect(execution.status).toBe(behavior === 'normal' ? 'verified' : 'uncertain');
  expect(execution.resultBinding).toEqual({ id: '007示例' });
  expect(f.requests.filter(r => r.url.includes('/records/'))).toHaveLength(behavior === 'normal' ? 1 : 0);
  if (behavior === 'normal') expect(f.requests.at(-1).url).toBe(origin + '/records/007%E7%A4%BA%E4%BE%8B');
  else expect(execution.error.code).toBe('PAGE_WRITE_DOCUMENT_CHANGED');
});
