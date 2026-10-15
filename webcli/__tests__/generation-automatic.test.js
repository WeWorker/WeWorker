import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerationHarness, GenerationRunStore, createAdapterGenerationWorkflow, createAdapterGenerationResumeWorkflow } from '../generation-harness/index.js';
import { readPackageDirectory } from '../adapter-package-files.js';
import { readOnlyV2Memory } from '../generation-harness/adapter-generation-workflow.js';
import { attributeGenerationFailure } from '../generation-harness/failure-attribution.js';
import { WebSocketBridge } from '../bridge.js';

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const memory = { siteKey: 'example.com', siteHost: 'example.com', siteOrigin: 'https://example.com', canonicalEntryUrl: 'https://example.com/',
  listApiCandidates: [{ url: 'https://example.com/api/search?keyword=:value', method: 'GET', status: 200,
    responseHints: { listPath: 'items', itemKeys: ['id', 'title'], preferredIdKey: 'id', preferredDisplayKey: 'title' } }] };
const passed = { passed: true, executionSummary: { attempted: 1, passed: 1, failed: 0, skipped: 0 } };
const mappingFailure = { passed: false, errors: [{ code: 'OUTPUT_REQUIRED_PATH_MISSING', path: 'items.*.title', toolName: 'example.com.query-list-1' }] };
function fixture({ model = vi.fn(), runtimeValidator = vi.fn(async () => passed), automaticRepairTimeoutMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-generation-')); roots.push(root);
  for (const [key, value] of Object.entries({ WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEWORKER_BUILD_PROFILE: 'public' })) vi.stubEnv(key, value);
  const store = new GenerationRunStore({ rootDir: path.join(root, 'runs') });
  const harness = new GenerationHarness({ store, workflow: createAdapterGenerationWorkflow({ model, runtimeValidator, automaticRepairTimeoutMs }), resumeWorkflow: createAdapterGenerationResumeWorkflow({ model, runtimeValidator }) });
  return { store, model, harness, runtimeValidator };
}
const start = harness => harness.start({ siteKey: memory.siteKey, goal: '搜索任意关键词', input: { mode: 'auto', memory, tabId: 7 } });
const repair = updates => ({ type: 'tool_call', name: 'repair_generated_commands', arguments: { updates } });
const update = { commandId: 'query-list-1', description: 'Search by keyword' };

it('preserves auto mode and selected evidence when Bridge creates a worker run', async () => {
  const bridge = Object.create(WebSocketBridge.prototype);
  bridge._generationWorkers = { start: vi.fn(async () => ({ id: 'fixture-run', status: 'created' })) };
  const send = vi.fn();
  await bridge._handleStartGenerationRun({ type: 'start_generation_run', id: 'fixture-request', siteKey: memory.siteKey, memory: { ...memory, apiAnalysisV2: { schemaVersion: 2, selectedEvidenceIds: ['fixture'], candidates: [] } }, mode: 'auto', tabId: 7 }, { send });
  expect(bridge._generationWorkers.start).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ mode: 'auto', memory: expect.objectContaining({ apiAnalysisV2: expect.objectContaining({ selectedEvidenceIds: ['fixture'] }) }) }) }), undefined);
  expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({ ok: true });
});

it('finishes the default fast path with full runtime evidence and zero model calls', async () => {
  const { harness, model } = fixture();
  const result = await harness.wait(start(harness).id);
  expect(result.status).toBe('awaiting_approval');
  expect(result.modelCallCount).toBe(0);
  expect(result.artifacts.provenance.mode).toBe('auto');
  expect(model).not.toHaveBeenCalled();
});

it('makes one local repair, preserves the failed draft, and revalidates every original target', async () => {
  const model = vi.fn(async () => repair([update]));
  const runtimeValidator = vi.fn().mockResolvedValueOnce(mappingFailure).mockResolvedValueOnce(passed);
  const { harness, store } = fixture({ model, runtimeValidator });
  const result = await harness.wait(start(harness).id);
  expect(result.status).toBe('awaiting_approval');
  expect(result.modelCallCount).toBe(1);
  expect(result.artifacts.automaticRepair).toMatchObject({ attempted: true, modelCalls: 1, outcome: 'passed', triggerCode: 'RUNTIME_VALIDATION_FAILED', timeoutMs: 60000 });
  const snapshot = store.load(result.id);
  expect(snapshot.artifacts.draftHistory).toHaveLength(2);
  const [before, after] = snapshot.artifacts.draftHistory.map(draft => readPackageDirectory(draft.adapterDir));
  expect(before.manifest.commands.find(command => command.id === update.commandId).description).not.toBe(update.description);
  expect(after.manifest.commands.find(command => command.id === update.commandId).description).toBe(update.description);
  expect(runtimeValidator).toHaveBeenCalledTimes(2);
  expect(runtimeValidator.mock.calls[1][0].draft.toolNames).toEqual(runtimeValidator.mock.calls[0][0].draft.toolNames);
  expect(model.mock.calls[0][0]).toMatchObject({ retryOnCrash: false, tools: [{ name: 'repair_generated_commands' }] });
});

it.each(['TARGET_TAB_NOT_FOUND', 'LOGIN_REQUIRED', 'OUTPUT_HTTP_ERROR', 'SENSITIVE_OUTPUT_DETECTED', 'CAPTURE_BOUND_CONTRACT_MISMATCH', 'UNKNOWN_FAILURE'])('does not ask a model to fix environment/evidence failures: %s', async code => {
  const { harness, model } = fixture({ runtimeValidator: vi.fn(async () => ({ passed: false, errors: [{ code }] })) });
  const result = await harness.wait(start(harness).id);
  expect(result.status).toBe(['TARGET_TAB_NOT_FOUND', 'LOGIN_REQUIRED'].includes(code) ? 'needs_user_input' : 'failed');
  expect(model).not.toHaveBeenCalled();
});

it('stops after one unsuccessful repair instead of starting a new plan', async () => {
  const model = vi.fn(async () => repair([update]));
  const { harness } = fixture({ model, runtimeValidator: vi.fn(async () => mappingFailure) });
  const result = await harness.wait(start(harness).id);
  expect(result.status).toBe('failed');
  expect(model).toHaveBeenCalledOnce();
  expect(result.artifacts.automaticRepair.outcome).toBe('failed');
});

it('times out a stuck model, propagates cancellation and never applies a late response', async () => {
  let respond;
  let repairSignal;
  const model = vi.fn(({ signal }) => { repairSignal = signal; return new Promise(resolve => { respond = resolve; }); });
  const { harness, store } = fixture({ model, runtimeValidator: vi.fn(async () => mappingFailure), automaticRepairTimeoutMs: 30 });
  const result = await harness.wait(start(harness).id);
  expect(result.status).toBe('failed');
  expect(result.lastError.code).toBe('AUTOMATIC_REPAIR_TIMEOUT');
  expect(repairSignal.aborted).toBe(true);
  const draft = store.load(result.id).artifacts.draft;
  const before = readPackageDirectory(draft.adapterDir).digest;
  respond(repair([update]));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(readPackageDirectory(draft.adapterDir).digest).toBe(before);
  expect(model).toHaveBeenCalledOnce();
});

it.each([{}, { attempted: 0, passed: 0, failed: 0, skipped: 1 }, { attempted: 1, passed: 0, failed: 1, skipped: 0 }])('rejects nominal success without complete execution: %j', async executionSummary => {
  const { harness, model } = fixture({ runtimeValidator: vi.fn(async () => ({ passed: true, executionSummary })) });
  const result = await harness.wait(start(harness).id);
  expect(result.status).toBe('failed');
  expect(result.lastError.code).toBe('RUNTIME_EXECUTION_REQUIRED');
  expect(model).not.toHaveBeenCalled();
});

it('resumes page validation without regenerating or using model calls', async () => {
  const runtimeValidator = vi.fn().mockResolvedValueOnce({ passed: false, errors: [{ code: 'TARGET_TAB_NOT_FOUND' }] }).mockResolvedValueOnce(passed);
  const { harness, model, store } = fixture({ runtimeValidator });
  const run = start(harness);
  expect((await harness.wait(run.id)).status).toBe('needs_user_input');
  const draft = store.load(run.id).artifacts.draft;
  await harness.resume(run.id, 'Page ready');
  expect((await harness.wait(run.id)).status).toBe('awaiting_approval');
  expect(store.load(run.id).artifacts.draft).toEqual(draft);
  expect(model).not.toHaveBeenCalled();
});

it('rejects an attempt to modify an unselected command', async () => {
  const { harness } = fixture({ model: vi.fn(async () => repair([{ ...update, commandId: 'check-login-status' }])), runtimeValidator: vi.fn(async () => mappingFailure) });
  expect((await harness.wait(start(harness).id)).status).toBe('failed');
});

it('does not apply a response after the user cancels a repair', async () => {
  let respond;
  const model = vi.fn(() => new Promise(resolve => { respond = resolve; }));
  const { harness, store } = fixture({ model, runtimeValidator: vi.fn(async () => mappingFailure) });
  const run = start(harness);
  for (let i = 0; i < 100 && !respond; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(model).toHaveBeenCalledOnce();
  const draft = store.load(run.id).artifacts.draft;
  const before = readPackageDirectory(draft.adapterDir).digest;
  harness.cancel(run.id);
  expect((await harness.wait(run.id)).status).toBe('cancelled');
  respond(repair([update]));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(readPackageDirectory(draft.adapterDir).digest).toBe(before);
});

it('keeps the one-repair budget and failed evidence across a page pause and resume', async () => {
  const model = vi.fn(async () => repair([update]));
  const runtimeValidator = vi.fn().mockResolvedValueOnce(mappingFailure)
    .mockResolvedValueOnce({ passed: false, errors: [{ code: 'TARGET_TAB_NOT_FOUND' }] })
    .mockResolvedValueOnce(mappingFailure);
  const { harness, store } = fixture({ model, runtimeValidator });
  const run = start(harness);
  expect((await harness.wait(run.id)).status).toBe('needs_user_input');
  const draft = store.load(run.id).artifacts.draft;
  await harness.resume(run.id, 'Page ready');
  const result = await harness.wait(run.id);
  expect(result.status).toBe('failed');
  expect(store.load(run.id).artifacts.draft).toEqual(draft);
  expect(result.artifacts.initialValidationFailure.code).toBe('RUNTIME_VALIDATION_FAILED');
  expect(model).toHaveBeenCalledOnce();
});

it('generates only the explicitly selected verified read candidates', () => {
  const candidates = ['search', 'recommend'].map(evidenceId => ({ evidenceId, risk: 'read', strategyNote: { replayStatus: 'verified' } }));
  const result = readOnlyV2Memory({ ...memory, apiAnalysisV2: { schemaVersion: 2, candidates, selectedEvidenceIds: ['search'] }, listApiCandidates: candidates.map(apiEvidence => ({ url: 'https://example.com/api/' + apiEvidence.evidenceId, apiEvidence })) });
  expect(result.listApiCandidates.map(candidate => candidate.apiEvidence.evidenceId)).toEqual(['search']);
});

it('does not treat a verified unrelated endpoint as a completed target', async () => {
  const { harness, model } = fixture();
  const unrelated = { evidenceId: 'suggest', risk: 'read', strategyNote: { replayStatus: 'verified' } };
  const inputMemory = { ...memory, apiAnalysisV2: { schemaVersion: 2, candidates: [unrelated] }, listApiCandidates: [{ url: 'https://example.com/api/suggest', method: 'GET', apiEvidence: unrelated }] };
  const run = harness.start({ siteKey: memory.siteKey, goal: 'Search videos', input: { mode: 'auto', memory: inputMemory } });
  const result = await harness.wait(run.id);
  expect(result.status).toBe('failed');
  expect(result.lastError.code).toBe('EXPLORATION_TARGET_NOT_CONFIRMED');
  expect(model).not.toHaveBeenCalled();
  expect(attributeGenerationFailure(result)).toMatchObject({ category: 'user_action', summary: expect.stringContaining('无关接口') });
});

it('rejects partial plans when an explicitly selected target cannot be generated safely', async () => {
  const { harness, model, runtimeValidator } = fixture();
  const candidates = ['search', 'create'].map(id => ({ evidenceId: id, risk: 'read', strategyNote: { replayStatus: 'verified' } }));
  const inputMemory = { ...memory,
    apiAnalysisV2: { schemaVersion: 2, candidates, selectedEvidenceIds: ['search', 'create'] },
    listApiCandidates: candidates.map(apiEvidence => ({ ...memory.listApiCandidates[0], url: `https://example.com/api/${apiEvidence.evidenceId}?keyword=:value`, apiEvidence })),
  };
  const run = harness.start({ siteKey: memory.siteKey, goal: 'Cover both selected targets', input: { mode: 'auto', memory: inputMemory } });
  const result = await harness.wait(run.id);
  expect(result.status).toBe('failed');
  expect(result.lastError.code).toBe('EXPLORATION_TARGET_NOT_CONFIRMED');
  expect(runtimeValidator).not.toHaveBeenCalled();
  expect(model).not.toHaveBeenCalled();
});
