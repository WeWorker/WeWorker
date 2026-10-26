import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplorationService } from '../exploration-service.js';
import { extractExplorationEvidence } from '../exploration-evidence.js';
import { resolveAdapterPaths } from '../paths.js';
import { buildAdapterCatalog } from '../adapter-catalog.js';
import { readPackageDirectory } from '../adapter-package-files.js';
import { verifyRetainedPackage } from '../generation-harness/existing-site.js';
import { readGenerationEvidence } from '../generation-harness/package-inspection.js';
import { createPreviewRuntimeValidator } from '../generation-harness/runtime-validator.js';

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const capture = { network: { entries: [
  { url: 'https://example.com/api/list?page=2&token=placeholder-secret', method: 'GET', status: 200, responseContentType: 'application/json',
    responsePreview: JSON.stringify({ data: { items: [{ id: 'placeholder-id', name: 'placeholder-person' }] } }) },
  { url: 'https://example.com/api/delete', method: 'GET', status: 200 },
  { url: 'https://example.org/api/list', method: 'GET', status: 200, responsePreview: '{"items":[{"id":"example-public-id"}]}' },
] } };
function setup(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-')); roots.push(root);
  for (const [key, value] of Object.entries({ WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEWORKER_BUILD_PROFILE: 'public' })) vi.stubEnv(key, value);
  const paths = resolveAdapterPaths();
  const requestExtension = vi.fn(async message => message.type === 'exploration_list_tabs' ? { tabs: [{ id: 7, url: 'https://example.com/list?token=placeholder-secret', title: 'placeholder-person' }] } : capture);
  const runtimeValidator = vi.fn(async () => ({ passed: true, executionSummary: { attempted: 1, passed: 1, failed: 0, skipped: 0 } }));
  const options = { rootDir: path.join(root, 'tasks'), paths, requestExtension, runtimeValidator,
    capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'strict_output_contract_v1'] }), ...extra };
  return { root, paths, requestExtension, runtimeValidator, options, service: new ExplorationService(options) };
}
async function start(service, requestId = 'example-request') {
  const result = await service.execute('start', { tabId: '7', goal: 'Explore list queries', requestId });
  expect(result.ok).toBe(true);
  await service.jobs.get(result.data.taskId);
  return result.data.taskId;
}
async function draft(service) {
  const taskId = await start(service);
  const result = await service.execute('generate', { taskId });
  expect(result).toMatchObject({ ok: true, data: { status: 'draft' } });
  return taskId;
}

const backgroundPlan = { tools: [{ name: 'background_list', risk: 'read', strategy: 'EXTENSION_API', sourceApiKind: 'list', sourceApiIndexes: [0],
  readReason: 'Read the observed list', strategyNote: { reason: 'Reuse the browser cookie through the background helper', alternatives: 'No page state is required', limitations: 'Requires valid login cookies' } }] };
const backgroundCapabilities = () => ({ connected: true, capabilities: ['passive_exploration_v1', 'strict_output_contract_v1', 'background_preview_v1'] });
async function authoredBackground(f) {
  const taskId = await start(f.service);
  const generated = await f.service.execute('generate', { taskId, plan: structuredClone(backgroundPlan) });
  expect(generated.ok).toBe(true);
  const run = f.service.runs.get(taskId), file = path.join(run.draft.adapterDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(manifest.commands[0].execution).toEqual({ type: 'api', runtime: 'background' });
  expect(() => f.service.assertPlannedDraft(run)).toThrow(/author the request/);
  manifest.commands[0].schema['x-webcli-agent-authored'] = true;
  fs.writeFileSync(file, JSON.stringify(manifest));
  fs.writeFileSync(path.join(run.draft.adapterDir, manifest.commands[0].module), 'window.__webcliRegisterCommand("background-list",async()=>({items:[]}));');
  const tool = 'example.com.background-list';
  const before = (await f.service.execute('verification-read', { taskId, tool })).data;
  await f.service.execute('verification-write', { taskId, tool, expectedHash: before.hash, cases: [{ id: 'example-list', args: {}, expect: { types: { items: 'array' } } }] });
  return { taskId, run, manifest, file };
}

it('preserves background metadata, requires authoring, and validates with the source tab closed', async () => {
  const f = setup({ capabilities: backgroundCapabilities });
  const { taskId } = await authoredBackground(f);
  f.requestExtension.mockClear().mockResolvedValue({ tabs: [] });
  expect((await f.service.execute('validate', { taskId })).ok).toBe(true); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  expect(f.requestExtension.mock.calls.some(([message]) => message.type === 'exploration_list_tabs')).toBe(false);
});

it('rejects old extensions before creating a background draft', async () => {
  const f = setup(); const taskId = await start(f.service);
  expect((await f.service.execute('generate', { taskId, plan: structuredClone(backgroundPlan) })).error.code).toBe('CAPABILITY_UNAVAILABLE');
});

it.each(['valid', 'page-result', 'missing-case', 'old-extension'])('dispatches background validation with no tab and rejects incomplete proof: %s', async mode => {
  const f = setup({ capabilities: backgroundCapabilities });
  const { run } = await authoredBackground(f);
  const requestExtension = vi.fn(async message => {
    expect(message).toMatchObject({ executionMode: 'background', expectedToolNames: ['example.com.background-list'] });
    expect(message).not.toHaveProperty('tabId');
    return { passed: true, executionMode: mode === 'page-result' ? 'page' : 'background', pageContextUsed: false,
      toolResults: mode === 'missing-case' ? [] : message.testCases.map(item => ({ toolName: item.toolName, caseId: item.caseId, attempted: true, passed: true })),
      executionSummary: { attempted: 1, passed: 1, failed: 0, skipped: 0 } };
  });
  const validator = createPreviewRuntimeValidator({ requestExtension, paths: f.paths, capabilities: mode === 'old-extension' ? [] : ['background_preview_v1'] });
  const result = validator({ run: f.service.facade(run), draft: run.draft, plan: run.plan, memory: run.memory, verification: run.verification });
  if (mode === 'valid') expect((await result).passed).toBe(true); else await expect(result).rejects.toThrow(/background|Background/);
  if (mode === 'old-extension') expect(requestExtension).not.toHaveBeenCalled();
});

it('returns only structural evidence and rejects mutation/cross-origin candidates for generation', async () => {
  const f = setup(); const taskId = await start(f.service);
  const evidence = await f.service.execute('evidence', { taskId });
  expect(evidence.data.candidates).toHaveLength(2);
  expect(JSON.stringify(evidence)).not.toMatch(/placeholder-secret|placeholder-person|placeholder-id/);
  expect(evidence.data.candidates[0].responseHints.listPath).toBe('data.items');
  expect(evidence.data.candidates[1].risk.level).toBe('write');
  expect(fs.readFileSync(path.join(f.options.rootDir, `${taskId}.json`), 'utf8')).not.toMatch(/placeholder-secret|placeholder-person|placeholder-id/);
  const bad = await f.service.execute('generate', { taskId, plan: { tools: [{ name: 'delete_items', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [1] }] } });
  expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_PLAN' } });
});

it.each(['navigate', 'workflow'])('requires %s capability before dispatching a page observation', async mode => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'page_sources_v1', 'page_query_v1'] }) });
  const taskId = await start(f.service);
  const result = await f.service.execute('query', { taskId, source: { mode }, values: { itemId: '007' }, reason: 'Read public detail' });
  expect(result.error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.requestExtension.mock.calls.some(([message]) => message.type === 'exploration_page_query')).toBe(false);
});

it('cancels the exact in-flight workflow, discards late evidence and requires variation for every generated parameter', async () => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'page_sources_v1', 'page_query_v1', 'page_workflow_v1', 'strict_output_contract_v1'] }) });
  const source = { mode: 'workflow', steps: [
    { pathname: '/list', query: { mode: 'navigate', resultPathname: '/list', result: { strategy: 'DOM_STATE', path: ['publicResults'] } } },
    { pathname: '/list', query: { mode: 'filter', resultPathname: '/list', trigger: { kind: 'filter', selector: '#category', parameter: 'category', description: 'Public category' }, matchResult: { category: 'category' }, result: { strategy: 'DOM_STATE', path: ['publicResults'] } } },
  ] };
  let finish; const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_page_query' ? new Promise(resolve => { finish = resolve; }) : original(message));
  const taskId = await start(f.service);
  await f.service.execute('query', { taskId, source, values: { category: 'example-private-observation' }, reason: 'Read filtered public content' });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const operationId = f.requestExtension.mock.calls.find(([message]) => message.type === 'exploration_page_query')[0].payload.operationId;
  await f.service.execute('cancel', { taskId });
  expect(f.requestExtension.mock.calls.some(([message]) => message.type === 'exploration_cancel_workflow' && message.operationId === operationId && message.tabId === 7)).toBe(true);
  finish({ ok: true, shape: { type: 'object' } }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.pageSourceCount).toBe(0);
  const nextId = await start(f.service, 'example-second-workflow');
  f.requestExtension.mockImplementation(message => message.type === 'exploration_page_query' ? { ok: true, shape: { type: 'object' } } : original(message));
  await f.service.execute('query', { taskId: nextId, source, values: { category: 'example-private-observation' }, reason: 'Read filtered content' }); await f.service.jobs.get(nextId);
  expect(fs.readFileSync(path.join(f.options.rootDir, `${nextId}.json`), 'utf8')).not.toContain('example-private-observation');
  const evidence = (await f.service.execute('evidence', { taskId: nextId })).data;
  const generated = await f.service.execute('generate', { taskId: nextId, plan: { tools: [{ name: 'workflow', strategy: 'UI_SELECTOR', sourcePageId: evidence.pageSources[0].id, risk: 'read', readReason: 'Public filter' }] } });
  expect(generated.ok).toBe(true);
  expect((await f.service.execute('validate', { taskId: nextId })).error.code).toBe('VERIFICATION_REQUIRED');
  const tool = generated.data.toolNames[0]; const before = (await f.service.execute('verification-read', { taskId: nextId, tool })).data;
  await f.service.execute('verification-write', { taskId: nextId, tool, expectedHash: before.hash, cases: ['books', 'music'].map((category, index) => ({ id: 'case-' + index, args: { category }, expect: { equals: { 'data.category': category } } })) });
  f.runtimeValidator.mockResolvedValue({ passed: true, executionSummary: { attempted: 2, passed: 2, failed: 0, skipped: 0 } });
  expect((await f.service.execute('validate', { taskId: nextId })).ok).toBe(true); await f.service.jobs.get(nextId);
  expect((await f.service.execute('get', { taskId: nextId })).data.status).toBe('review_ready');
});

it('deduplicates concurrent starts and persists identity across a new service process', async () => {
  const f = setup();
  const args = { tabId: '7', goal: 'Explore', requestId: 'same' };
  const [a, b] = await Promise.all([f.service.execute('start', args), f.service.execute('start', args)]);
  expect(a.data.taskId).toBe(b.data.taskId);
  await f.service.jobs.get(a.data.taskId);
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('start', args)).data.taskId).toBe(a.data.taskId);
  expect((await restored.execute('start', { ...args, goal: 'Different' })).error.code).toBe('REQUEST_CONFLICT');
  expect(f.requestExtension.mock.calls.filter(([msg]) => msg.type === 'exploration_capture_passive')).toHaveLength(1);
});

it('cancellation wins over late capture and restart never replays browser actions', async () => {
  let finish;
  const f = setup();
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_capture_passive' ? new Promise(resolve => { finish = resolve; }) : original(message));
  const response = await f.service.execute('start', { tabId: 7, goal: 'Explore', requestId: 'cancel' });
  const taskId = response.data.taskId;
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('get', { taskId })).data.status).toBe('interrupted');
  await f.service.execute('cancel', { taskId }); finish(capture); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data).toMatchObject({ status: 'cancelled', candidateCount: 0 });
});

it('does not accept evidence if tab origin changes while capture is in flight', async () => {
  const f = setup(); let tabs = 0;
  f.requestExtension.mockImplementation(async message => message.type === 'exploration_list_tabs'
    ? { tabs: [{ id: 7, url: ++tabs > 2 ? 'https://example.org/' : 'https://example.com/' }] } : capture);
  const taskId = await start(f.service);
  expect((await f.service.execute('get', { taskId })).data).toMatchObject({ status: 'failed', error: { code: 'TAB_CHANGED' } });
});

it('rejects invalid params and traversal; repairs invalid draft JSON with hash guarded writes', async () => {
  const { service } = setup();
  expect((await service.execute('start', { tabId: '1.5', goal: 'x', requestId: 'x' })).error.code).toBe('INVALID_ARGUMENT');
  expect((await service.execute('tabs', { url: 'https://example.com' })).error.code).toBe('INVALID_ARGUMENT');
  const taskId = await draft(service);
  expect((await service.execute('draft-read', { taskId, file: '../outside' })).error.code).toBe('INVALID_ARGUMENT');
  const before = (await service.execute('draft-read', { taskId, file: 'manifest.json' })).data;
  expect((await service.execute('draft-write', { taskId, file: 'manifest.json', expectedHash: 'old', content: '{}' })).error.code).toBe('STALE_DRAFT');
  expect((await service.execute('draft-write', { taskId, file: 'manifest.json', expectedHash: before.hash, content: '{' })).ok).toBe(true);
  const broken = (await service.execute('draft-read', { taskId, file: 'manifest.json' })).data;
  expect((await service.execute('draft-write', { taskId, file: 'manifest.json', expectedHash: broken.hash, content: before.content })).ok).toBe(true);
});

it('generates, verifies, reviews and installs using existing package machinery without a model', async () => {
  const f = setup(); const taskId = await draft(f.service);
  expect(buildAdapterCatalog({ paths: f.paths }).effective).toHaveLength(0);
  expect((await f.service.execute('review', { taskId })).error.code).toBe('VALIDATION_REQUIRED');
  expect((await f.service.execute('validate', { taskId })).ok).toBe(true);
  await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  const reviewed = await f.service.execute('review', { taskId });
  expect(reviewed.ok).toBe(true);
  expect((await f.service.execute('install', { taskId, reviewId: reviewed.data.reviewId })).error.code).toBe('CONFIRMATION_REQUIRED');
  expect((await f.service.execute('install', { taskId, reviewId: 'stale', confirmed: true })).error.code).toBe('STALE_REVIEW');
  expect((await f.service.execute('install', { taskId, reviewId: reviewed.data.reviewId, confirmed: 'true' })).ok).toBe(true);
  await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('installed');
  expect(buildAdapterCatalog({ paths: f.paths }).effective[0].name).toBe('example.com');
});

it('does not permit skipped runtime validation or editing after validation to install', async () => {
  const f = setup({ runtimeValidator: async () => ({ passed: true, executionSummary: { attempted: 0, passed: 0, skipped: 1, failed: 0 } }) });
  const taskId = await draft(f.service);
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('review', { taskId })).error.code).toBe('VALIDATION_REQUIRED');
  const good = setup(); const goodId = await draft(good.service);
  await good.service.execute('validate', { taskId: goodId }); await good.service.jobs.get(goodId);
  const file = (await good.service.execute('draft-read', { taskId: goodId, file: 'manifest.json' })).data;
  await good.service.execute('draft-write', { taskId: goodId, file: 'manifest.json', content: file.content + '\n', expectedHash: file.hash });
  expect((await good.service.execute('review', { taskId: goodId })).error.code).toBe('VALIDATION_REQUIRED');
});

it('does not trust scalar values embedded in supplied evidence shapes', () => {
  const evidence = extractExplorationEvidence({ entries: [{ url: 'https://example.com/api/list', responseEvidence: { bodyKind: 'json', bodyShape: { type: 'object', properties: { name: { type: 'string', example: 'placeholder-secret' } } } } }] }, 'https://example.com');
  expect(JSON.stringify(evidence)).not.toContain('placeholder-secret');
});

it('bounds safe probes to inspected read actions and persists only their network structures', async () => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'safe_api_probe_v1'] }) });
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => {
    if (message.type === 'exploration_safe_actions_inspect') return { candidates: [{ id: 'safe-1', kind: 'search', risk: 'read', requiresValue: true, label: 'placeholder-person' }, { id: 'unsafe', kind: 'delete', risk: 'write' }] };
    if (message.type === 'exploration_safe_probe_run') return { networkDelta: { entries: [{ ...capture.network.entries[0], url: 'https://example.com/api/search?q=private-query' }] } };
    return original(message);
  });
  const taskId = await start(f.service);
  expect((await f.service.execute('probe', { taskId, candidateId: 'safe-1', value: 'test' })).error.code).toBe('STALE_ACTION');
  for (let i = 0; i < 3; i++) {
    const actions = await f.service.execute('actions', { taskId });
    expect(actions.data.candidates).toHaveLength(1);
    expect(JSON.stringify(actions)).not.toContain('placeholder-person');
    expect((await f.service.execute('probe', { taskId, candidateId: 'safe-1' })).error.code).toBe('INVALID_ARGUMENT');
    expect((await f.service.execute('probe', { taskId, candidateId: 'safe-1', value: 'test' })).ok).toBe(true);
    await f.service.jobs.get(taskId);
  }
  expect((await f.service.execute('probe', { taskId, candidateId: 'safe-1', value: 'test' })).error.code).toBe('PROBE_LIMIT');
  expect(JSON.stringify((await f.service.execute('evidence', { taskId })).data)).not.toContain('private-query');
});

it('runs the actual preview validator and generated JavaScript before standalone installation', async () => {
  const f = setup({ runtimeValidator: undefined });
  const original = f.requestExtension.getMockImplementation();
  const requests = [];
  f.requestExtension.mockImplementation(async message => {
    if (message.type === 'exploration_capture_passive') return { entries: [{ url: 'https://example.com/api/list', method: 'GET', status: 200, responsePreview: '{"data":[{"id":"fixture-id"}]}' }] };
    if (message.type !== 'validate_generation_preview') return original(message);
    const tools = [];
    const context = vm.createContext({ URL, URLSearchParams, location: { origin: 'https://example.com' },
      __webmcpRegister: adapter => tools.push(...adapter.tools),
      fetch: async url => { requests.push(String(url)); return { ok: true, status: 200, text: async () => '{"data":[{"id":"fixture-id"}]}' }; } });
    vm.runInContext('var window = globalThis', context);
    for (const script of message.previewBundle.scripts) vm.runInContext(script.source, context);
    if (!message.testCases) return { passed: true, tools: tools.map(({ handler, ...tool }) => tool) };
    // The real extension reports login utilities as skipped. Only requested
    // generated tools belong in this workflow's strict all-executed gate.
    expect(message.testCases).toHaveLength(1);
    expect(message.testCases[0].toolName).not.toMatch(/check[-_]login/);
    const executable = message.testCases.filter(test => test.execute);
    expect(executable).toHaveLength(1);
    for (const test of executable) {
      const tool = tools.find(tool => tool.name === test.toolName);
      const output = await tool.handler(test.args || {});
      expect(output.ok).toBe(true);
    }
    return { passed: true, executionSummary: { attempted: executable.length, passed: executable.length, failed: 0, skipped: message.testCases.length - executable.length } };
  });
  const taskId = await draft(f.service);
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  expect(requests).toEqual(['https://example.com/api/list']);
  const review = (await f.service.execute('review', { taskId })).data;
  await f.service.execute('install', { taskId, reviewId: review.reviewId, confirmed: true }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('installed');
});

it('grants only explicit API origins and binds grants to the idempotency key and draft permissions', async () => {
  const f = setup();
  const args = { tabId: 7, goal: 'Explore API', requestId: 'origins', allowedOrigins: ['https://example.org'] };
  for (const allowedOrigins of ['https://example.org', ['https://example.org/path'], ['https://user:placeholder@example.org'], ['file:///example'], ['https://example.org/']]) {
    expect((await f.service.execute('start', { ...args, allowedOrigins })).error.code).toBe('INVALID_ARGUMENT');
  }
  const started = await f.service.execute('start', args); expect(started.ok).toBe(true);
  const taskId = started.data.taskId; await f.service.jobs.get(taskId);
  expect((await f.service.execute('start', { ...args, allowedOrigins: ['https://example.org', 'https://example.org'] })).data.taskId).toBe(taskId);
  expect((await f.service.execute('start', { ...args, allowedOrigins: [] })).error.code).toBe('REQUEST_CONFLICT');
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  const index = evidence.candidates.findIndex(item => new URL(item.url).origin === 'https://example.org');
  expect(index).toBeGreaterThanOrEqual(0);
  expect((await f.service.execute('generate', { taskId, plan: { tools: [{ name: 'query_items', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [index] }] } })).ok).toBe(true);
  const manifest = JSON.parse((await f.service.execute('draft-read', { taskId, file: 'manifest.json' })).data.content);
  expect(manifest.runtime_allowed_hosts).toContain('example.org');
  expect(extractExplorationEvidence({ entries: [{ url: 'https://example.net/api/list' }] }, 'https://example.com', ['https://example.org'])).toEqual([]);
});

it('shares tab leases with browser commands and holds cancellation leases until the browser request settles', async () => {
  const { BrowserService } = await import('../browser-service.js');
  const { TabOperationLocks } = await import('../tab-operation-locks.js');
  const tabLocks = new TabOperationLocks(); const f = setup({ tabLocks });
  const browser = new BrowserService({ rootDir: path.join(f.root, 'browser'), tabLocks,
    capabilities: () => ({ connected: true, capabilities: ['browser_commands_v1'] }),
    requestExtension: async message => message.type === 'exploration_list_tabs' ? { tabs: [{ id: 7, url: 'https://example.com' }] } : { ok: true, data: { identity: 'example-identity' } } });
  await browser.execute('bind', { session: 'work', tabId: 7 });
  let finish; const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_capture_passive' ? new Promise(resolve => { finish = resolve; }) : original(message));
  const taskId = (await f.service.execute('start', { tabId: 7, goal: 'Explore', requestId: 'shared' })).data.taskId;
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect((await browser.execute('click', { session: 'work', selector: '#next' })).error.code).toBe('TAB_BUSY');
  await f.service.execute('cancel', { taskId });
  expect((await browser.execute('state', { session: 'work' })).error.code).toBe('TAB_BUSY');
  finish(capture); await f.service.jobs.get(taskId);
  expect((await browser.execute('state', { session: 'work' })).ok).toBe(true);
  const release = tabLocks.acquire(7);
  const blocked = await f.service.execute('start', { tabId: 7, goal: 'Explore', requestId: 'blocked' });
  expect(blocked.error.code).toBe('TAB_BUSY'); release();
  const retry = await f.service.execute('start', { tabId: 7, goal: 'Explore', requestId: 'blocked' });
  expect(retry.data.status).toBe('collecting');
  await vi.waitFor(() => expect(f.requestExtension.mock.calls.filter(([msg]) => msg.type === 'exploration_capture_passive')).toHaveLength(2));
  finish(capture); await f.service.jobs.get(retry.data.taskId);
});

it('generates more than two authored queries with JSON/form POST and rejects mutation or unresolved GraphQL', async () => {
  const f = setup(); const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_capture_passive' ? { entries: [
    { url: 'https://example.com/api/search', method: 'POST', status: 200, requestBody: '{"keyword":"placeholder-private"}' },
    { url: 'https://example.com/api/query', method: 'POST', status: 200, requestBody: 'keyword=placeholder-private' },
    { url: 'https://example.com/graphql', method: 'POST', status: 200, requestBody: '{"query":"query List { items { id } }","variables":{"keyword":"placeholder-private"}}' },
    { url: 'https://example.com/graphql?operation=mutation', method: 'POST', status: 200, requestBody: '{"query":"mutation Delete { deleteItem(id: 1) }"}' },
    { url: 'https://example.com/query', method: 'POST', status: 200, requestBody: '{"op":"delete"}' },
    { url: 'https://example.com/graphql/persisted', method: 'POST', status: 200, requestBody: '{"extensions":{"persistedQuery":{"sha256Hash":"placeholder-hash"}}}' },
  ].map(item => ({ ...item, responsePreview: '{"items":[{"id":"example-public-id"}]}' })) } : original(message));
  const taskId = await start(f.service);
  const evidence = (await f.service.execute('evidence', { taskId })).data.candidates;
  expect(evidence.map(item => item.risk.level)).toEqual(['read', 'read', 'read', 'write', 'write', 'unknown']);
  expect(JSON.stringify(evidence)).not.toMatch(/placeholder-private|query List|Delete|placeholder-hash/);
  const tools = [0, 1, 2].map(i => ({ name: `query_${i}`, risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [i], readReason: 'Observed lookup response; no mutation operation.' }));
  expect((await f.service.execute('generate', { taskId, plan: { tools: [{ ...tools[0], readReason: undefined }] } })).error.code).toBe('INVALID_PLAN');
  for (const index of [3, 4, 5]) expect((await f.service.execute('generate', { taskId, plan: { tools: [{ ...tools[0], sourceApiIndexes: [index] }] } })).error.code).toBe('INVALID_PLAN');
  const generated = await f.service.execute('generate', { taskId, plan: { tools } }); expect(generated.ok).toBe(true);
  expect(generated.data.toolNames).toHaveLength(3);
  const commands = [];
  for (let i = 0; i < 3; i++) commands.push((await f.service.execute('draft-read', { taskId, file: `extension/commands/query-${i}.js` })).data.content);
  expect(commands[0]).toContain('sendJson('); expect(commands[1]).toContain('postForm('); expect(commands[2]).toContain('sendJson(');
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.validation.passed).toBe(true);
});

it('adds authored helpers without overwriting files, invalidates approval and exports a structural trace', async () => {
  const f = setup(); const taskId = await draft(f.service);
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('draft-add', { taskId, file: '../escape.js', content: '' })).error.code).toBe('INVALID_ARGUMENT');
  const helper = { taskId, file: 'extension/internal/example-helper.js', content: 'window.exampleHelper = value => value;' };
  expect((await f.service.execute('draft-add', helper)).ok).toBe(true);
  expect((await f.service.execute('draft-add', helper)).error.code).toBe('FILE_EXISTS');
  expect((await f.service.execute('review', { taskId })).error.code).toBe('VALIDATION_REQUIRED');
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  const trace = (await f.service.execute('trace', { taskId })).data;
  expect(trace.files).toContain(helper.file); expect(trace.structuralOnly).toBe(true);
  expect(JSON.stringify(trace)).not.toMatch(/window.exampleHelper|placeholder-secret|placeholder-person/);
});

it('persists hash-bound authored verification cases and invalidates previous approval', async () => {
  const f = setup(); const taskId = await draft(f.service);
  const tool = (await f.service.execute('get', { taskId })).data.toolNames[0];
  const before = (await f.service.execute('verification-read', { taskId, tool })).data;
  const cases = [{ id: 'example-page', args: { page: 2 }, expect: { rowCount: { path: 'data.items', min: 1 } } }];
  expect((await f.service.execute('verification-write', { taskId, tool, expectedHash: 'stale', cases })).error.code).toBe('STALE_VERIFICATION');
  expect((await f.service.execute('verification-write', { taskId, tool, expectedHash: before.hash, cases })).ok).toBe(true);
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect(f.runtimeValidator.mock.calls[0][0].verification[tool][0].args).toEqual({ page: 2 });
  const restored = new ExplorationService(f.options);
  const current = (await restored.execute('verification-read', { taskId, tool })).data;
  expect(current.cases[0].id).toBe('example-page');
  const oldExtension = new ExplorationService({ ...f.options, capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1'] }) });
  expect((await oldExtension.execute('validate', { taskId })).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect((await oldExtension.execute('verification-write', { taskId, tool, expectedHash: current.hash, cases })).error.code).toBe('CAPABILITY_UNAVAILABLE');
  await restored.execute('verification-write', { taskId, tool, expectedHash: current.hash, cases });
  expect((await restored.execute('review', { taskId })).error.code).toBe('VALIDATION_REQUIRED');
});

it('promotes only validated structural evidence and authored cases into site knowledge', async () => {
  const f = setup(); const taskId = await draft(f.service);
  const known = (await f.service.execute('knowledge-read', { site: 'example.com' })).data;
  expect((await f.service.execute('knowledge-save', { taskId, expectedHash: known.hash })).error.code).toBe('VALIDATION_REQUIRED');
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  const saved = await f.service.execute('knowledge-save', { taskId, expectedHash: known.hash, notes: 'Example query verified.' });
  expect(saved.ok).toBe(true); expect(saved.data.knowledge.endpoints).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toMatch(/placeholder-person|placeholder-id|placeholder-secret/);
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('knowledge-read', { site: 'example.com' })).data.knowledge.notes[0].text).toBe('Example query verified.');
});

async function installedForRepair(f, { withKnowledge = true } = {}) {
  const taskId = await draft(f.service);
  const tool = f.service.runs.get(taskId).draft.toolNames[0];
  const verification = (await f.service.execute('verification-read', { taskId, tool })).data;
  await f.service.execute('verification-write', { taskId, tool, expectedHash: verification.hash,
    cases: [{ id: 'example-query', args: {}, expect: { requiredPaths: ['data'] } }] });
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  const review = (await f.service.execute('review', { taskId })).data;
  await f.service.execute('install', { taskId, reviewId: review.reviewId, confirmed: true }); await f.service.jobs.get(taskId);
  expect(f.service.runs.get(taskId).status).toBe('installed');
  if (withKnowledge) {
    const known = (await f.service.execute('knowledge-read', { site: 'example.com' })).data;
    expect((await f.service.execute('knowledge-save', { taskId, expectedHash: known.hash })).ok).toBe(true);
  }
  const info = (await f.service.execute('repair-info', { site: 'example.com' })).data;
  const id = tool.slice('example.com.'.length);
  const plan = { tools: [{ name: id, risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0] }] };
  const repairId = await start(f.service, 'example-repair');
  const args = { taskId: repairId, site: info.site, expectedDigest: info.digest, plan };
  return { taskId: repairId, info, args, tool, id };
}

it('repairs only selected installed commands, imports cases, revalidates and publishes without changing shared files', async () => {
  const f = setup(); const { taskId, info, args, tool } = await installedForRepair(f);
  const before = readPackageDirectory(buildAdapterCatalog({ paths: f.paths }).effective[0].root);
  const created = await f.service.execute('repair', args);
  expect(created).toMatchObject({ ok: true, data: { status: 'draft', repair: { digest: info.digest, knowledge: { importedTools: [tool] } } } });
  const run = f.service.runs.get(taskId);
  const file = run.editableFiles.find(file => file !== 'manifest.json');
  const old = (await f.service.execute('draft-read', { taskId, file })).data;
  await f.service.execute('draft-write', { taskId, file, expectedHash: old.hash, content: old.content + '\n// Example repair\n' });
  // Author-controlled evidence cannot grant a repair exception to other callers.
  expect(() => verifyRetainedPackage(readPackageDirectory(run.draft.adapterDir), readGenerationEvidence(run.draft.adapterDir), { paths: f.paths })).toThrow(/已有工具文件/);
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('get', { taskId })).data.repair.commandIds).toEqual([args.plan.tools[0].name]);
  await restored.execute('validate', { taskId }); await restored.jobs.get(taskId);
  expect((await restored.execute('get', { taskId })).data.status).toBe('review_ready');
  const review = (await restored.execute('review', { taskId })).data;
  expect(review.repair.commandIds).toEqual(run.repairScope.commandIds);
  await restored.execute('install', { taskId, reviewId: review.reviewId, confirmed: true }); await restored.jobs.get(taskId);
  expect((await restored.execute('get', { taskId })).data.status).toBe('installed');
  const after = readPackageDirectory(buildAdapterCatalog({ paths: f.paths }).effective[0].root);
  for (const [name, contents] of before.files) if (!run.editableFiles.includes(name)) expect(after.files.get(name)).toEqual(contents);
  expect(after.digest).not.toBe(before.digest);
  expect(after.manifest.commands).toEqual(before.manifest.commands);
});

it('refuses protected files, added helpers and manifest changes outside the selected schema/description', async () => {
  const f = setup(); const { taskId, args } = await installedForRepair(f);
  expect((await f.service.execute('repair', { ...args, expectedDigest: 'stale' })).error.code).toBe('ADAPTER_BASE_CHANGED');
  expect((await f.service.execute('repair', { ...args, plan: { tools: [{ ...args.plan.tools[0], name: 'missing-command' }] } })).error.code).toBe('REPAIR_SCOPE_CHANGED');
  expect((await f.service.execute('repair', args)).ok).toBe(true);
  const run = f.service.runs.get(taskId), read = file => f.service.execute('draft-read', { taskId, file });
  const protectedFile = run.draftFiles.find(file => file.startsWith('extension/internal/'));
  const prior = (await read(protectedFile)).data;
  expect((await f.service.execute('draft-write', { taskId, file: protectedFile, expectedHash: prior.hash, content: prior.content + '\n' })).error.code).toBe('REPAIR_SCOPE_CHANGED');
  expect((await f.service.execute('draft-add', { taskId, file: 'extension/internal/new-helper.js', content: '' })).error.code).toBe('REPAIR_SCOPE_CHANGED');
  const original = (await read('manifest.json')).data.content;
  for (const change of [
    manifest => manifest.match.push('example.org'),
    manifest => { manifest.commands.find(item => item.id === args.plan.tools[0].name).safety = 'write'; },
    manifest => { manifest.commands.find(item => item.id !== args.plan.tools[0].name).description += ' modified'; },
  ]) {
    const manifest = JSON.parse(original); change(manifest);
    const current = (await read('manifest.json')).data;
    await f.service.execute('draft-write', { taskId, file: 'manifest.json', expectedHash: current.hash, content: JSON.stringify(manifest) });
    await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
    expect((await f.service.execute('get', { taskId })).data.validation.passed).toBe(false);
    expect((await f.service.execute('review', { taskId })).ok).toBe(false);
  }
});

it('requires authored cases for repairs and refuses a baseline changed after validation', async () => {
  const f = setup(); const { taskId, args, tool } = await installedForRepair(f, { withKnowledge: false });
  await f.service.execute('repair', args);
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const cases = (await f.service.execute('verification-read', { taskId, tool })).data;
  await f.service.execute('verification-write', { taskId, tool, expectedHash: cases.hash,
    cases: [{ id: 'query', args: {}, expect: { requiredPaths: ['data'] } }] });
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  const active = buildAdapterCatalog({ paths: f.paths }).effective[0];
  const manifestPath = path.join(active.root, 'manifest.json');
  fs.appendFileSync(manifestPath, '\n');
  expect((await f.service.execute('review', { taskId })).ok).toBe(false);
});

it('generates and installs a page-only command without API candidates, requiring fresh observation and authored cases', async () => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'strict_output_contract_v1', 'page_sources_v1'] }) });
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(async msg => msg.type === 'exploration_capture_passive' ? { entries: [] }
    : msg.type === 'exploration_observe_page' ? { ok: true, shape: { type: 'array', length: 1, items: { type: 'string', value: 'example-private-content' } } } : original(msg));
  const taskId = await start(f.service);
  expect((await f.service.execute('generate', { taskId })).error.code).toBe('NO_READ_EVIDENCE');
  const source = { strategy: 'DOM_STATE', path: ['exampleState', 'items'] };
  await f.service.execute('observe', { taskId, source, reason: 'Public item state has no API endpoint.' }); await f.service.jobs.get(taskId);
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  expect(evidence.candidates).toEqual([]); expect(evidence.pageSources).toHaveLength(1);
  expect(JSON.stringify(evidence)).not.toContain('example-private-content');
  const plan = { tools: [{ name: 'read_page', risk: 'read', strategy: 'DOM_STATE', sourcePageId: evidence.pageSources[0].id, readReason: 'Only reads the observed public state.' }] };
  const generated = await f.service.execute('generate', { taskId, plan }); expect(generated.ok).toBe(true);
  const run = f.service.runs.get(taskId);
  expect(readGenerationEvidence(run.draft.adapterDir).commands['read-page'].generationSource.version).toBe('page-source-v1');
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const tool = generated.data.toolNames[0], current = (await f.service.execute('verification-read', { taskId, tool })).data;
  await f.service.execute('verification-write', { taskId, tool, expectedHash: current.hash, cases: [{ id: 'items', args: {}, expect: { types: { data: 'array' }, rowCount: { path: 'data', min: 1 } } }] });
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  const review = (await f.service.execute('review', { taskId })).data;
  await f.service.execute('install', { taskId, reviewId: review.reviewId, confirmed: true }); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('installed');
  const known = (await f.service.execute('knowledge-read', { site: 'example.com' })).data;
  const saved = await f.service.execute('knowledge-save', { taskId, expectedHash: known.hash });
  expect(saved.data.knowledge.endpoints).toEqual([]); expect(saved.data.knowledge.pages).toHaveLength(1);
  expect(new ExplorationService(f.options).runs.get(taskId).pageSources[0].id).toBe(evidence.pageSources[0].id);
});

it('combines API and page plans and rejects mismatched page strategy or stale observations', async () => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'strict_output_contract_v1', 'page_sources_v1'] }) });
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(async msg => msg.type === 'exploration_observe_page' ? { ok: true, shape: { type: 'object' } } : original(msg));
  const taskId = await start(f.service);
  await f.service.execute('observe', { taskId, source: { strategy: 'UI_SELECTOR', selector: '.item', fields: { title: {} } }, reason: 'Read visible rows.' }); await f.service.jobs.get(taskId);
  const sourcePageId = f.service.runs.get(taskId).pageSources[0].id;
  const tool = { name: 'page_items', risk: 'read', sourcePageId, strategy: 'UI_SELECTOR', readReason: 'Only reads visible rows.' };
  for (const changed of [{ strategy: 'DOM_STATE' }, { sourcePageId: 'page-v1-missing' }, { sourceApiIndexes: [0] }]) {
    expect((await f.service.execute('generate', { taskId, plan: { tools: [{ ...tool, ...changed }] } })).error.code).toBe('INVALID_PLAN');
  }
  const plan = { tools: [tool, { name: 'api_items', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0] }] };
  const result = await f.service.execute('generate', { taskId, plan }); expect(result.ok).toBe(true);
  const sources = readGenerationEvidence(f.service.runs.get(taskId).draft.adapterDir).commands;
  expect(sources['page-items'].generationSource.version).toBe('page-source-v1');
  expect(sources['api-items'].generationSource.version).toBe('api-source-v2');
  expect((await f.service.execute('observe', { taskId, source: {}, reason: 'Changed' })).error.code).toBe('INVALID_STATE');
});

it('binds dynamic endpoint segments to required string arguments and requires varying authored cases', async () => {
  const f = setup(); const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(msg => msg.type === 'exploration_capture_passive' ? { entries: [{
    url: 'https://example.com/api/groups/12345/items/67890?lang=en', method: 'GET', status: 200,
    responsePreview: '{"data":{"groupId":"12345","itemId":"67890"}}',
  }] } : original(msg));
  const taskId = await start(f.service);
  expect((await f.service.execute('generate', { taskId })).error.code).toBe('PATH_PLAN_REQUIRED');
  const tool = { name: 'read_item', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0], readReason: 'Reads one public item.' };
  expect((await f.service.execute('generate', { taskId, plan: { tools: [tool] } })).error.code).toBe('INVALID_PLAN');
  tool.pathParameters = [{ segmentIndex: 2, name: 'groupId', description: 'Group ID' }, { segmentIndex: 4, name: 'itemId', description: 'Item ID' }];
  const generated = await f.service.execute('generate', { taskId, plan: { tools: [tool] } });
  expect(generated.ok).toBe(true);
  const manifest = JSON.parse((await f.service.execute('draft-read', { taskId, file: 'manifest.json' })).data.content);
  const command = manifest.commands.find(item => item.id === 'read-item');
  expect(command.schema.required).toEqual(expect.arrayContaining(['groupId', 'itemId']));
  expect(command.schema.properties.groupId.type).toBe('string');
  const source = (await f.service.execute('draft-read', { taskId, file: command.module })).data.content;
  expect(source).not.toMatch(/12345|67890/);
  expect(source).toContain('resolvePathRequest');
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const toolName = generated.data.toolNames[0];
  const current = (await f.service.execute('verification-read', { taskId, tool: toolName })).data;
  const cases = [{ id: 'first', args: { groupId: 'example-group', itemId: 'example-one' }, expect: { equals: { 'data.data.itemId': 'example-one' } } },
    { id: 'second', args: { groupId: 'example-group', itemId: 'example-one' }, expect: { equals: { 'data.data.itemId': 'example-two' } } }];
  await f.service.execute('verification-write', { taskId, tool: toolName, expectedHash: current.hash, cases });
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const updated = (await f.service.execute('verification-read', { taskId, tool: toolName })).data;
  cases[1].args.itemId = 'example-two';
  await f.service.execute('verification-write', { taskId, tool: toolName, expectedHash: updated.hash, cases });
  f.runtimeValidator.mockResolvedValue({ passed: true, executionSummary: { attempted: 2, passed: 2, failed: 0, skipped: 0 } });
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  expect(f.service.runs.get(taskId).status).toBe('review_ready');
  const known = (await f.service.execute('knowledge-read', { site: 'example.com' })).data;
  const saved = await f.service.execute('knowledge-save', { taskId, expectedHash: known.hash });
  expect(saved.data.knowledge.commands[toolName].pathParameters).toEqual(tool.pathParameters);
});

it.each(['intercept', 'query'])('observes %s without persisting supplied values, requires distinct cases and generates a permissioned page command', async command => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'page_sources_v1', 'intercept_read_v1', 'page_query_v1', 'strict_output_contract_v1'] }) });
  const taskId = await start(f.service);
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(async message => message.type === (command === 'intercept' ? 'exploration_intercept_read' : 'exploration_page_query')
    ? { ok: true, shape: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } } } : original(message));
  const source = { ...(command === 'intercept' ? { sourceApiIndex: 0 } : { result: { strategy: 'DOM_STATE', path: ['publicRows'] }, resultPathname: '/list' }), trigger: { kind: 'search', selector: '#search', parameter: 'keyword', description: 'Public query' }, matchQuery: { page: 'keyword' } };
  expect((await f.service.execute(command, { taskId, source, values: { keyword: 'example-observation-only' }, reason: 'Public query result' })).ok).toBe(true);
  await f.service.jobs.get(taskId);
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  const strategy = command === 'intercept' ? 'INTERCEPT' : 'UI_SELECTOR';
  expect(evidence.pageSources[0].source.strategy).toBe(strategy);
  expect(fs.readFileSync(path.join(f.options.rootDir, `${taskId}.json`), 'utf8')).not.toContain('example-observation-only');
  expect((await f.service.execute('generate', { taskId, plan: { tools: [{ name: 'query_intercept', risk: 'read', strategy, sourcePageId: evidence.pageSources[0].id, readReason: 'Public read query', purpose: 'Search public items' }] } })).ok).toBe(true);
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const tool = 'example.com.query-intercept';
  const writeCases = async values => {
    const current = (await f.service.execute('verification-read', { taskId, tool })).data;
    return f.service.execute('verification-write', { taskId, tool, expectedHash: current.hash, cases: values.map((keyword, i) => ({ id: 'case-' + i, args: { keyword }, expect: { requiredPaths: ['data'] } })) });
  };
  expect((await writeCases(['Example', 'Example'])).ok).toBe(true);
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  expect((await writeCases(['Example', 'Another'])).ok).toBe(true);
  f.runtimeValidator.mockResolvedValue({ passed: true, executionSummary: { attempted: 2, passed: 2, failed: 0, skipped: 0 } });
  expect((await f.service.execute('validate', { taskId })).ok).toBe(true);
  await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
  const old = setup(); const oldId = await start(old.service);
  expect((await old.service.execute(command, { taskId: oldId, source, reason: 'Query', values: { keyword: 'Example' } })).error.code).toBe('CAPABILITY_UNAVAILABLE');
});

it('preserves failed attempts, rejects stale replan and moves API generation to observed DOM with fresh approval', async () => {
  const f = setup({ capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'page_sources_v1', 'strict_output_contract_v1'] }) });
  const taskId = await draft(f.service), tool = (await f.service.execute('get', { taskId })).data.toolNames[0];
  const cases = (await f.service.execute('verification-read', { taskId, tool })).data;
  await f.service.execute('verification-write', { taskId, tool, expectedHash: cases.hash, cases: [{ id: 'example-case', args: {}, expect: { requiredPaths: ['data'] } }] });
  f.runtimeValidator.mockResolvedValue({ passed: false, executionSummary: { attempted: 1, passed: 0, skipped: 0, failed: 1 }, errors: [{ code: 'RESPONSE_NOT_JSON' }] });
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  const previous = (await f.service.execute('draft-read', { taskId })).data;
  const oldSource = (await f.service.execute('draft-read', { taskId, file: 'manifest.json' })).data;
  expect((await f.service.execute('replan', { taskId, expectedDraftHash: 'stale', reason: 'Use visible content' })).error.code).toBe('STALE_DRAFT');
  const result = await f.service.execute('replan', { taskId, expectedDraftHash: previous.draftHash, reason: 'Response changed; visible rows still expose the intended data' });
  expect(result.data).toMatchObject({ status: 'evidence_ready', preservedRevisions: 1, draftRevision: 2, validation: null });
  expect((await f.service.execute('review', { taskId })).ok).toBe(false);
  const old = (await f.service.execute('revision-read', { taskId, revision: 1 })).data;
  expect(old.runtimeValidation.passed).toBe(false); expect(old.verification[tool]).toHaveLength(1);
  expect((await f.service.execute('revision-read', { taskId, revision: 1, file: 'manifest.json' })).data.content).toBe(oldSource.content);
  const source = { strategy: 'UI_SELECTOR', selector: '.row', fields: { title: { selector: 'h3' } } };
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(async msg => msg.type === 'exploration_observe_page' ? { ok: true, shape: { type: 'object' } } : original(msg));
  await f.service.execute('observe', { taskId, source, reason: 'Read public row titles' }); await f.service.jobs.get(taskId);
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  expect((await f.service.execute('generate', { taskId, plan: { tools: [{ name: tool.slice('example.com.'.length).replace(/-/g, '_'), risk: 'read', strategy: 'UI_SELECTOR', sourcePageId: evidence.pageSources[0].id,
    readReason: 'Read public visible rows', strategyNote: { reason: 'Current visible headings have a stable semantic selector', limitations: 'Rendered rows only' } }] } })).ok).toBe(true);
  expect((await f.service.execute('verification-read', { taskId, tool })).data.cases).toEqual([]);
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const restored = new ExplorationService(f.options);
  expect((await restored.execute('revisions', { taskId })).data.revisions).toHaveLength(1);
  expect((await restored.execute('revision-read', { taskId, revision: 1, file: 'manifest.json' })).data.content).toBe(oldSource.content);
  const trace = (await restored.execute('trace', { taskId })).data;
  expect(trace.plannedTools[0].strategyNote.limitations).toBe('Rendered rows only');
  expect(trace.revisions[0].runtimeValidation.passed).toBe(false);
});

it('draft hash includes authored cases and raw malformed manifest, and replan revokes a successful review', async () => {
  const f = setup(); const taskId = await draft(f.service);
  await f.service.execute('validate', { taskId }); await f.service.jobs.get(taskId);
  const reviewed = await f.service.execute('review', { taskId }); expect(reviewed.ok).toBe(true);
  const before = (await f.service.execute('draft-read', { taskId })).data;
  const manifest = (await f.service.execute('draft-read', { taskId, file: 'manifest.json' })).data;
  await f.service.execute('draft-write', { taskId, file: 'manifest.json', expectedHash: manifest.hash, content: '{invalid' });
  expect((await f.service.execute('replan', { taskId, expectedDraftHash: before.draftHash, reason: 'Correct the source strategy' })).error.code).toBe('STALE_DRAFT');
  const current = (await f.service.execute('draft-read', { taskId })).data;
  expect((await f.service.execute('replan', { taskId, expectedDraftHash: current.draftHash, reason: 'Correct the source strategy' })).ok).toBe(true);
  expect((await f.service.execute('install', { taskId, reviewId: reviewed.data.reviewId, confirmed: true })).ok).toBe(false);
  expect((await f.service.execute('revision-read', { taskId, revision: 1, file: 'manifest.json' })).data.content).toBe('{invalid');
});

it('does not accept strategy labels whose execution the generator does not implement', async () => {
  const f = setup(); const taskId = await start(f.service);
  const plan = { tools: [{ name: 'search', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0], strategy: 'UNKNOWN_API' }] };
  expect((await f.service.execute('generate', { taskId, plan })).error.code).toBe('STRATEGY_UNSUPPORTED');
});

it('detects externally changed revision bytes and bounds preserved attempts without resetting the current draft', async () => {
  const f = setup(); const taskId = await draft(f.service);
  const before = (await f.service.execute('draft-read', { taskId })).data;
  await f.service.execute('replan', { taskId, expectedDraftHash: before.draftHash, reason: 'Compare another observed source' });
  const run = f.service.runs.get(taskId);
  fs.appendFileSync(path.join(run.revisions[0].draft.adapterDir, 'manifest.json'), '\n');
  expect((await f.service.execute('revision-read', { taskId, revision: 1 })).error.code).toBe('REVISION_CHANGED');
  expect((await f.service.execute('revision-read', { taskId, revision: 1, file: 'manifest.json' })).error.code).toBe('REVISION_CHANGED');
  await f.service.execute('generate', { taskId });
  const current = (await f.service.execute('draft-read', { taskId })).data;
  run.revisions = Array.from({ length: 20 }, (_, i) => ({ ...run.revisions[0], revision: i + 1 }));
  expect((await f.service.execute('replan', { taskId, expectedDraftHash: current.draftHash, reason: 'Compare another source' })).error.code).toBe('REVISION_LIMIT');
  expect((await f.service.execute('draft-read', { taskId })).data.draftHash).toBe(current.draftHash);
  expect(run.status).toBe('draft');
});

it('requires an explicit strategy plan for ambiguous JSON and rejects successful non-JSON evidence', async () => {
  const f = setup(); const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(msg => msg.type === 'exploration_capture_passive' ? { entries: [
    { url: 'https://example.com/api/search', method: 'GET', status: 200, responsePreview: '{"code":0}' },
  ] } : original(msg));
  const taskId = await start(f.service);
  expect((await f.service.execute('analyze', { taskId })).data.candidates[0].verdict).toBe('maybe_data');
  expect((await f.service.execute('generate', { taskId })).error.code).toBe('STRATEGY_PLAN_REQUIRED');
  f.service.runs.get(taskId).candidates[0].responseEvidence = { bodyKind: 'opaque' };
  expect((await f.service.execute('generate', { taskId })).error.code).toBe('NO_READ_EVIDENCE');
});

it('authored case edits invalidate replan hashes and active/terminal tasks cannot be reset', async () => {
  const f = setup(); const taskId = await draft(f.service);
  const before = (await f.service.execute('draft-read', { taskId })).data;
  const tool = f.service.runs.get(taskId).draft.toolNames[0];
  const v = (await f.service.execute('verification-read', { taskId, tool })).data;
  await f.service.execute('verification-write', { taskId, tool, expectedHash: v.hash, cases: [{ id: 'example', args: {}, expect: { requiredPaths: ['data'] } }] });
  expect((await f.service.execute('replan', { taskId, expectedDraftHash: before.draftHash, reason: 'Choose a different source' })).error.code).toBe('STALE_DRAFT');
  const current = (await f.service.execute('draft-read', { taskId })).data;
  const run = f.service.runs.get(taskId);
  for (const [status, error] of [['validating', 'TASK_BUSY'], ['installing', 'TASK_BUSY'], ['installed', 'INVALID_STATE'], ['cancelled', 'INVALID_STATE']]) {
    run.status = status;
    expect((await f.service.execute('replan', { taskId, expectedDraftHash: current.draftHash, reason: 'Choose a different source' })).error.code).toBe(error);
  }
});

it.each([false, true])('requires query capability and independent author values without retaining observation values (workflow=%s)', async workflow => {
  const capabilities = ['passive_exploration_v1', 'page_sources_v1', 'page_query_v1', 'page_navigation_v1', 'page_workflow_v1', 'strict_output_contract_v1'];
  const f = setup({ capabilities: () => ({ connected: true, capabilities }) });
  const taskId = await start(f.service), result = { strategy: 'DOM_STATE', path: ['publicRows'] };
  const navigate = { mode: 'navigate', resultPathname: '/items', queryParameters: [
    { name: 'keyword', queryKey: 'q', description: 'Public query' }, { name: 'category', queryKey: 'category', description: 'Public category' },
  ], result };
  const source = workflow ? { mode: 'workflow', steps: [
    { pathname: '/list', query: { mode: 'navigate', resultPathname: '/list', result } },
    { pathname: '/list', query: navigate },
  ] } : navigate;
  const args = { taskId, source, values: { keyword: 'example-unretained-query', category: 'example-unretained-category' }, reason: 'Explicit public query' };
  expect((await f.service.execute('query', args)).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.requestExtension.mock.calls.some(([message]) => message.type === 'exploration_page_query')).toBe(false);
  capabilities.push('page_navigation_query_v1');
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_page_query' ? { ok: true, shape: { type: 'object' } } : original(message));
  expect((await f.service.execute('query', args)).ok).toBe(true); await f.service.jobs.get(taskId);
  expect(fs.readFileSync(path.join(f.options.rootDir, `${taskId}.json`), 'utf8')).not.toContain('example-unretained');
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  const generated = await f.service.execute('generate', { taskId, plan: { tools: [{ name: 'query_navigation', risk: 'read', strategy: 'UI_SELECTOR', sourcePageId: evidence.pageSources[0].id, readReason: 'Read public query pages' }] } });
  expect(generated.ok).toBe(true); const tool = generated.data.toolNames[0];
  const writeCases = async categories => {
    const before = (await f.service.execute('verification-read', { taskId, tool })).data;
    expect((await f.service.execute('verification-write', { taskId, tool, expectedHash: before.hash, cases: categories.map((category, i) => ({ id: 'case-' + i, args: { keyword: 'example-' + i, category }, expect: { requiredPaths: ['data'] } })) })).ok).toBe(true);
  };
  await writeCases(['books', 'books']);
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  await writeCases(['books', 'music']);
  capabilities.pop();
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.runtimeValidator).not.toHaveBeenCalled();
  capabilities.push('page_navigation_query_v1');
  f.runtimeValidator.mockResolvedValue({ passed: true, executionSummary: { attempted: 2, passed: 2, failed: 0, skipped: 0 } });
  expect((await f.service.execute('validate', { taskId })).ok).toBe(true); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
});

it.each([false, true])('requires hash capability and independent author values without retaining observation values (workflow=%s)', async workflow => {
  const capabilities = ['passive_exploration_v1', 'page_sources_v1', 'page_query_v1', 'page_navigation_v1', 'page_workflow_v1', 'strict_output_contract_v1'];
  const f = setup({ capabilities: () => ({ connected: true, capabilities }) });
  const taskId = await start(f.service), result = { strategy: 'DOM_STATE', path: ['publicRows'] };
  const navigate = { mode: 'navigate', resultPathname: '/items', hashNavigation: { template: 'items', queryParameters: [{ name: 'keyword', queryKey: 'q', description: 'Public query' }, { name: 'category', queryKey: 'category', description: 'Public category' }], matchResult: { keyword: 'keyword', category: 'category' }, freshnessPath: 'revision', sameTarget: 'reload' }, result };
  const source = workflow ? { mode: 'workflow', steps: [
    { pathname: '/list', query: { mode: 'navigate', resultPathname: '/list', result } },
    { pathname: '/list', query: navigate },
  ] } : navigate;
  const args = { taskId, source, values: { keyword: 'example-unretained-query', category: 'example-unretained-category' }, reason: 'Explicit public query' };
  expect((await f.service.execute('query', args)).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.requestExtension.mock.calls.some(([message]) => message.type === 'exploration_page_query')).toBe(false);
  capabilities.push('page_navigation_hash_v1');
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_page_query' ? { ok: true, shape: { type: 'object' } } : original(message));
  expect((await f.service.execute('query', args)).ok).toBe(true); await f.service.jobs.get(taskId);
  expect(fs.readFileSync(path.join(f.options.rootDir, `${taskId}.json`), 'utf8')).not.toContain('example-unretained');
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  const generated = await f.service.execute('generate', { taskId, plan: { tools: [{ name: 'query_navigation', risk: 'read', strategy: 'UI_SELECTOR', sourcePageId: evidence.pageSources[0].id, readReason: 'Read public query pages' }] } });
  expect(generated.ok).toBe(true); const tool = generated.data.toolNames[0];
  const writeCases = async categories => {
    const before = (await f.service.execute('verification-read', { taskId, tool })).data;
    expect((await f.service.execute('verification-write', { taskId, tool, expectedHash: before.hash, cases: categories.map((category, i) => ({ id: 'case-' + i, args: { keyword: 'example-' + i, category }, expect: { requiredPaths: ['data'] } })) })).ok).toBe(true);
  };
  await writeCases(['books', 'books']);
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  await writeCases(['books', 'music']);
  capabilities.pop();
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.runtimeValidator).not.toHaveBeenCalled();
  capabilities.push('page_navigation_hash_v1');
  f.runtimeValidator.mockResolvedValue({ passed: true, executionSummary: { attempted: 2, passed: 2, failed: 0, skipped: 0 } });
  expect((await f.service.execute('validate', { taskId })).ok).toBe(true); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
});


it('requires control capability before observation and validation with no fallback dispatch', async () => {
  const capabilities = ['passive_exploration_v1', 'page_sources_v1', 'page_query_v1', 'page_workflow_v1', 'strict_output_contract_v1'];
  const f = setup({ capabilities: () => ({ connected: true, capabilities }) });
  const taskId = await start(f.service), result = { strategy: 'DOM_STATE', path: ['publicRows'] };
  const source = { mode: 'workflow', steps: [
    { pathname: '/list', query: { mode: 'navigate', resultPathname: '/list', result } },
    { pathname: '/list', when: { path: 'hasNext', equals: true }, repeat: { maxIterations: 3, until: { path: 'hasNext', equals: false } },
      query: { mode: 'filter', resultPathname: '/list', trigger: { kind: 'pagination', selector: '#next' }, result } },
  ] };
  const args = { taskId, source, reason: 'Explicit public conditional pagination' };
  expect((await f.service.execute('query', args)).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.requestExtension.mock.calls.some(([message]) => message.type === 'exploration_page_query')).toBe(false);
  capabilities.push('page_workflow_control_v1');
  const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => message.type === 'exploration_page_query' ? { ok: true, shape: { type: 'object' } } : original(message));
  expect((await f.service.execute('query', args)).ok).toBe(true); await f.service.jobs.get(taskId);
  const evidence = (await f.service.execute('evidence', { taskId })).data;
  const generated = await f.service.execute('generate', { taskId, plan: { tools: [{ name: 'read_pages', risk: 'read', strategy: 'UI_SELECTOR', sourcePageId: evidence.pageSources[0].id, readReason: 'Read public pages' }] } });
  expect(generated.ok).toBe(true); const tool = generated.data.toolNames[0];
  const before = (await f.service.execute('verification-read', { taskId, tool })).data;
  expect((await f.service.execute('verification-write', { taskId, tool, expectedHash: before.hash, cases: [{ id: 'page-case', args: {}, expect: { equals: { 'data.hasNext': false } } }] })).ok).toBe(true);
  capabilities.pop();
  expect((await f.service.execute('validate', { taskId })).error.code).toBe('CAPABILITY_UNAVAILABLE');
  expect(f.runtimeValidator).not.toHaveBeenCalled();
  capabilities.push('page_workflow_control_v1');
  expect((await f.service.execute('validate', { taskId })).ok).toBe(true); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.status).toBe('review_ready');
});


it('requires declared task origins for page navigation and limits cross-origin task checks to explicit read routes', async () => {
  const capabilities = ['passive_exploration_v1', 'page_sources_v1', 'page_query_v1', 'page_navigation_v1'];
  const f = setup({ capabilities: () => ({ connected: true, capabilities }) });
  const taskId = await start(f.service);
  const source = { mode: 'navigate', resultOrigin: 'https://example.org', resultPathname: '/items/:id', pathParameters: [{ name: 'itemId', segmentIndex: 1, description: 'Public ID' }], result: { strategy: 'DOM_STATE', path: ['publicItem'] } };
  const args = { taskId, source, values: { itemId: '007' }, reason: 'Read declared public detail' };
  expect((await f.service.execute('query', args)).error.code).toBe('CAPABILITY_UNAVAILABLE');
  capabilities.push('page_navigation_origin_v1');
  expect((await f.service.execute('query', args)).ok).toBe(true); await f.service.jobs.get(taskId);
  expect((await f.service.execute('get', { taskId })).data.error.code).toBe('PAGE_ORIGIN_NOT_ALLOWED');
  expect(f.requestExtension.mock.calls.some(([m]) => m.type === 'exploration_page_query')).toBe(false);
  const started = await f.service.execute('start', { tabId: 7, goal: 'Public destination', requestId: 'example-cross-origin', allowedOrigins: ['https://example.org'] });
  const nextId = started.data.taskId; await f.service.jobs.get(nextId);
  let cross = false; const original = f.requestExtension.getMockImplementation();
  f.requestExtension.mockImplementation(message => {
    if (message.type === 'exploration_page_query') { cross = true; return { ok: true, shape: { type: 'object' } }; }
    if (message.type === 'exploration_list_tabs' && cross) return { tabs: [{ id: 7, url: 'https://example.org/items/007' }] };
    return original(message);
  });
  expect((await f.service.execute('query', { ...args, taskId: nextId })).ok).toBe(true); await f.service.jobs.get(nextId);
  expect((await f.service.execute('get', { taskId: nextId })).data.status).toBe('evidence_ready');
  const run = f.service.runs.get(nextId);
  await expect(f.service.checkTab(run)).rejects.toMatchObject({ code: 'TAB_CHANGED' });
  await expect(f.service.checkTab(run, [{ origin: 'https://example.org', pathname: '/different' }])).rejects.toMatchObject({ code: 'TAB_CHANGED' });
  expect((await f.service.checkTab(run, [{ origin: 'https://example.org', pathname: '/items/:id' }])).id).toBe(7);
});

it('returns explicit reuse and rejects a changed plan without modifying the draft',async()=>{
 const f=setup();const taskId=await start(f.service);
 const plan={tools:[{name:'list_items',purpose:'Read items',risk:'read',sourceApiKind:'list',sourceApiIndexes:[0]}]};
 expect((await f.service.execute('generate',{taskId,plan})).ok).toBe(true);
 const before=(await f.service.execute('draft-read',{taskId})).data;
 expect((await f.service.execute('generate',{taskId,plan})).data.generation).toMatchObject({reused:true,applied:false});
 const changed=structuredClone(plan);changed.tools[0].name='renamed_items';
 expect((await f.service.execute('generate',{taskId,plan:changed})).error.code).toBe('PLAN_CONFLICT');
 expect((await f.service.execute('draft-read',{taskId})).data.draftHash).toBe(before.draftHash);
 expect(before.helperContract.PAGE_FETCH.fetchGet).toContain('parsedResponseBody');
 f.service.runs.get(taskId).verificationWarnings={'example.com.list-items':[{code:'VERIFICATION_CHANGED'}]};
 expect((await f.service.execute('replan',{taskId,expectedDraftHash:before.draftHash,reason:'Use a meaningful final name'})).ok).toBe(true);
 expect(f.service.runs.get(taskId).verificationWarnings).toEqual({});
 expect(f.service.runs.get(taskId).generationRequestDigest).toBeNull();
 expect((await f.service.execute('revisions',{taskId})).data.revisions[0].verificationWarnings['example.com.list-items'][0].code).toBe('VERIFICATION_CHANGED');
 expect((await f.service.execute('generate',{taskId,plan:changed})).data.toolNames).toContain('example.com.renamed-items');
});
