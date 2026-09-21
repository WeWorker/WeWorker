import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_STATUSES,
  GenerationHarness,
  GenerationRunStore,
  createAdapterGenerationWorkflow,
} from '../generation-harness/index.js';

const tmpDirs = [];

function createStore() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-adapter-workflow-'));
  tmpDirs.push(rootDir);
  return new GenerationRunStore({ rootDir });
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('adapter generation workflow', () => {
  it('plans, drafts and statically validates in an isolated run directory', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'inspect_generation_context',
        arguments: { section: 'overview' },
      })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'inspect_generation_context',
        arguments: { section: 'list_apis' },
      })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'save_generation_plan',
        arguments: {
          summary: '生成房间查询工具',
          strategy: 'api_first',
          tools: [{
            name: 'query_rooms',
            purpose: '查询房间',
            risk: 'read',
            sourceApiIndexes: [0],
          }],
        },
      })
      .mockResolvedValueOnce({ type: 'final', content: 'plan saved' });

    const adaptersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-workflow-adapters-'));
    tmpDirs.push(adaptersDir);
    const store = createStore();
    const harness = new GenerationHarness({
      store,
      workflow: createAdapterGenerationWorkflow({
        model,
        adaptersDir,
      }),
    });
    const started = harness.start({
      siteKey: 'example.test',
      goal: 'generate query tools',
      input: {
        memory: {
          siteKey: 'example.test',
          siteHost: 'example.test',
          siteOrigin: 'https://example.test',
          canonicalEntryUrl: 'https://example.test/app',
          updatedAt: '2026-07-22T00:00:00.000Z',
          firstCapturedAt: '2026-07-22T00:00:00.000Z',
          captureCount: 1,
          workflowVersion: 'test-v1',
          workflowVersionsSeen: ['test-v1'],
          lastSourceUrl: 'https://example.test/app',
          canonicalResultUrl: 'https://example.test/app',
          verdictPattern: 'api_driven',
          recommendedStrategy: 'api_first',
          verdictReason: 'Found a reusable room list API.',
          search: {},
          listApiCandidates: [{
            method: 'GET',
            url: 'https://example.test/api/rooms?page=1',
            responsePreview: JSON.stringify({ data: { list: [{ id: 'r1', name: 'Room 1' }] } }),
          }],
          actionApiCandidates: [],
          actionCaptureHistory: [],
          resultSignals: {},
          detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
          pagination: {
            attempted: false,
            verified: false,
            mode: '',
            targetPage: null,
            activePageBefore: null,
            activePageAfter: null,
            reason: '',
          },
        },
      },
    });
    const result = await harness.wait(started.id);

    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(result.result.pause).toBe(true);
    expect(result.artifacts.staticValidation.passed).toBe(true);
    expect(result.artifacts.draft.adapterDir).toContain(started.id);
    expect(result.artifacts.draft.toolNames).toContain('example.test.query_rooms');
    expect(result.artifacts.draft.semanticEnhancement.analysisSource).toBe('harness_plan');
    expect(result.modelCallCount).toBe(4);
    expect(JSON.stringify(result)).not.toContain(os.homedir());
    expect(result.artifacts.draft.files.manifest).toMatch(/^<run-root>\//);
    const internalSnapshot = store.load(started.id);
    expect(fs.existsSync(internalSnapshot.artifacts.draft.files.manifest)).toBe(true);
  });

  it('feeds runtime validation failures back into the revision loop', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'overview' } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'list_apis' } })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'save_generation_plan',
        arguments: {
          summary: '生成查询工具',
          strategy: 'api_first',
          tools: [{ name: 'runtime.test.search_records', purpose: '查询记录', risk: 'read', sourceApiIndexes: [0] }],
        },
      })
      .mockResolvedValueOnce({ type: 'final', content: 'plan saved' })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'runtime issue reviewed' });
    const runtimeValidator = vi.fn()
      .mockResolvedValueOnce({
        passed: false,
        validator: 'adapter_runtime_validator_v1',
        errors: [{ code: 'OUTPUT_CONTRACT_MISMATCH', toolName: 'runtime.test.search_records', message: 'items missing' }],
        toolResults: [],
      })
      .mockResolvedValueOnce({
        passed: true,
        validator: 'adapter_runtime_validator_v1',
        errors: [],
        toolResults: [{ toolName: 'runtime.test.search_records', attempted: true, passed: true }],
      });
    const adaptersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-runtime-repair-adapters-'));
    tmpDirs.push(adaptersDir);
    const harness = new GenerationHarness({
      store: createStore(),
      workflow: createAdapterGenerationWorkflow({
        model,
        adaptersDir,
        runtimeValidator,
      }),
    });
    const started = harness.start({
      siteKey: 'runtime.test',
      goal: 'generate and runtime validate query tools',
      input: {
        memory: {
          siteKey: 'runtime.test',
          siteHost: 'runtime.test',
          siteOrigin: 'https://runtime.test',
          canonicalEntryUrl: 'https://runtime.test/app',
          canonicalResultUrl: 'https://runtime.test/app',
          lastSourceUrl: 'https://runtime.test/app',
          updatedAt: '2026-07-22T00:00:00.000Z',
          firstCapturedAt: '2026-07-22T00:00:00.000Z',
          captureCount: 1,
          workflowVersion: 'test-v1',
          workflowVersionsSeen: ['test-v1'],
          verdictPattern: 'api_driven',
          recommendedStrategy: 'api_first',
          verdictReason: 'Found a reusable API.',
          search: {},
          listApiCandidates: [{
            method: 'GET',
            url: 'https://runtime.test/api/items?page=1',
            responsePreview: JSON.stringify({ data: { list: [{ id: '1' }] } }),
          }],
          actionApiCandidates: [],
          actionCaptureHistory: [],
          resultSignals: {},
          detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
          pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
        },
      },
    });
    const result = await harness.wait(started.id);

    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(result.revisionCount).toBe(1);
    expect(runtimeValidator).toHaveBeenCalledTimes(2);
    expect(result.artifacts.runtimeValidation.passed).toBe(true);
  });

  it('restricts V2 generation to verified read-only API evidence', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'overview' } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'api_analysis' } })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'save_generation_plan',
        arguments: {
          summary: '生成只读房间查询工具',
          strategy: 'api_first',
          tools: [
            { name: 'query_rooms', purpose: '查询房间', risk: 'read', sourceApiIndexes: [0] },
            { name: 'book_room', purpose: '预订房间', risk: 'write', sourceApiIndexes: [0] },
          ],
        },
      })
      .mockResolvedValueOnce({ type: 'final', content: 'plan saved' });
    const adaptersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-v2-read-only-adapters-'));
    tmpDirs.push(adaptersDir);
    const harness = new GenerationHarness({
      store: createStore(),
      workflow: createAdapterGenerationWorkflow({ model, adaptersDir }),
    });
    const responseShape = {
      kind: 'object',
      topLevelKeys: ['data'],
      listPath: 'data.list',
      itemKeys: ['id', 'name'],
      valueTypes: { id: 'string', name: 'string' },
      rowCount: 1,
      truncated: false,
    };
    const verifiedEvidence = {
      evidenceId: 'GET /api/rooms?page',
      endpointFamily: 'GET /api/rooms?page',
      method: 'GET',
      origin: 'https://v2.example.test',
      path: '/api/rooms',
      queryKeys: ['page'],
      status: 200,
      contentType: 'application/json',
      sourceSteps: ['final_network'],
      requestShape: { kind: 'none', keys: [], graphqlOperationName: '', graphqlOperationType: '' },
      responseShape,
      verdict: 'likely_data',
      score: 20,
      signals: ['api_url'],
      risk: 'read',
      strategyNote: {
        strategy: 'COOKIE_API',
        contract: 'stable',
        authSource: 'cookie',
        replayStatus: 'verified',
        replayRequired: false,
        evidenceIds: ['GET /api/rooms?page'],
        reasons: ['replay_verified:browser_page'],
      },
      verificationFixture: {
        source: 'captured_response',
        status: [200],
        contentTypes: ['application/json'],
        rowCount: { min: 1, max: 20 },
        requiredPaths: ['data.list'],
        types: { 'data.list.*.id': 'string', 'data.list.*.name': 'string' },
        notEmpty: ['data.list.*.id'],
        mustNotContain: ['login', 'captcha', 'access denied'],
        mustBeTruthy: ['data.list.*.id'],
      },
      observedUrl: 'https://v2.example.test/api/rooms?page=%3Avalue',
      replay: {
        transport: 'browser_page',
        status: 200,
        ok: true,
        contentType: 'application/json',
        nonEmpty: true,
        responseShape,
        durationMs: 3,
        errorCode: '',
      },
    };
    const started = harness.start({
      siteKey: 'v2.example.test',
      goal: 'generate read-only tools',
      input: {
        memory: {
          siteKey: 'v2.example.test',
          siteHost: 'v2.example.test',
          siteOrigin: 'https://v2.example.test',
          canonicalEntryUrl: 'https://v2.example.test/app',
          canonicalResultUrl: 'https://v2.example.test/app',
          lastSourceUrl: 'https://v2.example.test/app',
          updatedAt: '2026-08-21T00:00:00.000Z',
          firstCapturedAt: '2026-08-21T00:00:00.000Z',
          captureCount: 1,
          workflowVersion: 'exploration-evidence-v2-persisted',
          workflowVersionsSeen: ['exploration-evidence-v2-persisted'],
          verdictPattern: 'api_driven',
          recommendedStrategy: 'COOKIE_API',
          verdictReason: '',
          search: {},
          listApiCandidates: [{
            method: 'GET',
            url: 'https://v2.example.test/api/rooms?page=%3Avalue',
            responsePreview: JSON.stringify({ data: { list: [{ id: '<string>', name: '<string>' }] } }),
            apiEvidence: verifiedEvidence,
          }],
          apiAnalysisV2: {
            schemaVersion: 2,
            candidates: [verifiedEvidence],
            likelyDataCount: 1,
            maybeDataCount: 0,
            noiseCount: 0,
            blockedCount: 0,
            recommendedNextProbe: 'replay_top_candidate',
          },
          actionApiCandidates: [{
            toolName: 'v2.example.test.book_room_draft',
            method: 'POST',
            url: 'https://v2.example.test/api/rooms/book',
            actionName: 'book_room',
            mode: 'intercept',
            intercepted: true,
          }],
          actionCaptureHistory: [],
          resultSignals: {},
          detailHints: { mode: '', bestCandidateHref: '', bestCandidateText: '', networkDetailCandidates: [] },
          pagination: { attempted: false, verified: false, mode: '', targetPage: null, activePageBefore: null, activePageAfter: null, reason: '' },
        },
      },
    });
    const result = await harness.wait(started.id);

    expect(result.status).toBe(GENERATION_STATUSES.FAILED);
    // OpenCLI 对齐后，不完整写证据只能生成待 agent 改写的安全骨架，不能直接发布。
    expect(result.artifacts.plan.tools.map((tool) => tool.name)).toEqual(['query_rooms', 'book_room']);
    expect(result.artifacts.draft.toolNames).toContain('v2.example.test.query_rooms');
    expect(result.artifacts.draft.toolNames.join('\n')).toMatch(/book_room/);
    expect(result.artifacts.draft.toolNames.join('\n')).not.toMatch(/cancel_room/);
    expect(result.artifacts.staticValidation.errors.map((item) => item.code)).toEqual(expect.arrayContaining([
      'WRITE_AGENT_AUTHORING_REQUIRED',
      'MISSING_WRITE_VERIFICATION',
    ]));
  });
});
