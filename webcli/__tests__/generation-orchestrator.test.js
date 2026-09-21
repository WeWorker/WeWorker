import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_STATUSES,
  GenerationHarness,
  GenerationRunStore,
  createAdapterGenerationWorkflow,
  runGenerationOrchestrator,
  resumeGenerationOrchestrator,
  validateAdapterDraft,
} from '../generation-harness/index.js';

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

const MEMORY = {
  siteKey: 'example.test',
  siteHost: 'example.test',
  siteOrigin: 'https://example.test',
  canonicalEntryUrl: 'https://example.test/list',
  recommendedStrategy: 'COOKIE_API',
  verdictPattern: 'api_driven',
  listApiCandidates: [{ url: 'https://example.test/api/list', method: 'GET' }],
  actionApiCandidates: [],
};

const PLAN_TEMPLATE = {
  type: 'tool_call',
  name: 'save_generation_plan',
  arguments: {
    summary: '生成只读查询工具',
    strategy: 'api_first',
    tools: [{ name: 'search_records', purpose: '查询记录', risk: 'read', sourceApiIndexes: [0] }],
  },
};

function planToolCall() {
  return structuredClone(PLAN_TEMPLATE);
}

function createFakeScaffoldWriter() {
  return (memory, { outputRoot }) => {
    const adapterDir = path.join(outputRoot, memory.siteKey);
    const toolsDir = path.join(adapterDir, 'webcli-generated', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), `window.__webmcpRegister({ name: "test", tools: [{ name: "${memory.siteKey}.search_records" }] });\n`);
    fs.writeFileSync(path.join(toolsDir, 'search_records.generated.js'), '// search tool');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), `${JSON.stringify({
      id: memory.siteKey,
      match: [memory.siteHost],
      support_files: ['webcli-generated/tools/search_records.generated.js'],
    }, null, 2)}\n`);
    return {
      adapterDir,
      toolNames: [`${memory.siteKey}.search_records`],
      files: {
        manifest: path.join(adapterDir, 'manifest.json'),
      },
    };
  };
}



function createOrchestratorDeps(overrides = {}) {
  const run = overrides.run;
  const memory = overrides.memory || MEMORY;
  return {
    run,
    signal: new AbortController().signal,
    store: overrides.store,
    model: overrides.model,
    memory,
    sections: {
      overview: { siteKey: memory.siteKey, listApiCount: memory.listApiCandidates?.length || 0, actionApiCount: memory.actionApiCandidates?.length || 0, previousFailurePresent: false },
      list_apis: [],
      action_apis: memory.actionApiCandidates || [],
      api_analysis: null,
      previous_failure: null,
    },
    scaffoldWriter: overrides.scaffoldWriter || createFakeScaffoldWriter(),
    staticValidator: validateAdapterDraft,
    runtimeValidator: overrides.runtimeValidator,
    adaptersDir: overrides.adaptersDir || makeTmpDir('webcli-orchestrator-adapters-'),
    semanticAnalyzer: null,
    writeGenerationHarnessProvenance: null,
  };
}

describe('generation orchestrator (agent mode)', () => {
  it('repairs a missing registration by creating a new tool file, without shrinking the plan', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-new-file-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'repair missing planned tool' }));
    const scaffoldWriter = (memory, options) => {
      const draft = createFakeScaffoldWriter()(memory, options);
      fs.writeFileSync(path.join(draft.adapterDir, 'index.js'), 'window.__webmcpRegister({tools:[]});');
      return { ...draft, toolNames: [] };
    };
    const model = vi.fn()
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockImplementationOnce(async ({ messages }) => {
        expect(JSON.stringify(messages)).toContain('MISSING_PLANNED_TOOL');
        return { type: 'tool_call', name: 'write_draft_file', arguments: {
          path: 'new/query.js', content: 'window.fixtureTools = [{name:"example.test.search_records"}];', reason: '补齐计划工具',
        } };
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'write_draft_file', arguments: {
        path: 'manifest.json', content: JSON.stringify({ id: MEMORY.siteKey, match: [MEMORY.siteHost], support_files: ['new/query.js'] }), reason: '注入新工具',
      } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'write_draft_file', arguments: {
        path: 'index.js', content: 'window.__webmcpRegister({tools:window.fixtureTools});', reason: '注册计划工具',
      } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '完成' } })
      .mockResolvedValueOnce({ type: 'final', content: 'done' });
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, errors: [] });
    const result = await runGenerationOrchestrator(createOrchestratorDeps({ run, store, model, scaffoldWriter, runtimeValidator }));
    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(runtimeValidator.mock.calls[0][0].draft.toolNames).toEqual(['example.test.search_records']);
    expect(run.snapshot.artifacts.draft.toolNames).toEqual(['example.test.search_records']);
  });
  it('pauses instead of planning a write from opaque or truncated request evidence', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-incomplete-write-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'write safety' }));
    const memory = {
      ...MEMORY,
      actionApiCandidates: [{
        actionName: 'submit_request',
        toolName: 'example.test.submit_request_draft',
        method: 'POST',
        url: 'https://example.test/api/request/submit',
        requestEvidence: {
          version: 'request-evidence-v1',
          bodyKind: 'opaque',
          bodyShape: null,
          bodyKeys: [],
          bodyFullSize: 4096,
          bodyTruncated: true,
          bodyOmitted: true,
        },
      }],
    };
    const model = vi.fn().mockResolvedValueOnce({
      type: 'tool_call',
      name: 'save_generation_plan',
      arguments: {
        summary: '提交申请',
        strategy: 'action_only',
        tools: [{ name: 'submit_request', purpose: '提交申请', risk: 'write', sourceApiIndexes: [0] }],
      },
    });

    const paused = await runGenerationOrchestrator(createOrchestratorDeps({ run, store, model, memory, runtimeValidator: vi.fn() }));

    expect(paused.status).toBe(GENERATION_STATUSES.NEEDS_USER_INPUT);
    expect(paused.pendingQuestion.question).toContain('请求体证据不完整');
    expect(run.snapshot.artifacts.draft).toBeUndefined();
  });

  it('wires resume through the bridge protocol and worker command surface', async () => {
    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const webcliRoot = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), '..');
    const bridgeSource = fs2.readFileSync(path2.join(webcliRoot, 'bridge.js'), 'utf8');
    expect(bridgeSource).toContain("msg.type === 'resume_generation_run'");
    expect(bridgeSource).toContain('_handleResumeGenerationRun');
    expect(bridgeSource).toContain("type: 'resume_generation_run_result'");
    const controllerSource = fs2.readFileSync(path2.join(webcliRoot, 'generation-worker-controller.js'), 'utf8');
    expect(controllerSource).toContain("this.#spawn('resume'");
    const workerSource = fs2.readFileSync(path2.join(webcliRoot, 'generation-worker.js'), 'utf8');
    expect(workerSource).toContain("command === 'resume'");
    expect(workerSource).toContain('harness.resume(');
  });

  it('drives plan → scaffold → validate → finish autonomously to awaiting approval', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-happy-store-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'agent mode' }));
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'overview' } })
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '工具已验证' } })
      .mockResolvedValueOnce({ type: 'final', content: 'done' });

    const result = await runGenerationOrchestrator(createOrchestratorDeps({ run, store, model, runtimeValidator }));

    expect(result.pause).toBe(true);
    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(run.snapshot.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(run.snapshot.artifacts.plan.tools).toHaveLength(1);
    expect(run.snapshot.artifacts.staticValidation.passed).toBe(true);
    expect(runtimeValidator).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledTimes(7);
  });

  it('survives the impossible-fixture failure by marking the tool unverifiable (run 6208043a regression)', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-fixture-store-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'fixture regression' }));
    const runtimeValidator = vi.fn()
      .mockResolvedValueOnce({
        passed: false,
        validator: 'adapter_runtime_validator_v1',
        errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING', message: '路径不存在: data.list.*.id', path: 'data.list.*.id', toolName: 'example.test.search_records' }],
      })
      .mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [], warnings: [] });
    const model = vi.fn()
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'mark_tool_unverifiable',
        arguments: { toolName: 'example.test.search_records', reason: 'fixture 断言不可能满足，转人工验证' },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '已转人工' } })
      .mockResolvedValueOnce({ type: 'final', content: 'marked' });

    const result = await runGenerationOrchestrator(createOrchestratorDeps({ run, store, model, runtimeValidator }));

    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(run.snapshot.artifacts.plan.tools[0].unverifiable).toMatchObject({ reason: 'fixture 断言不可能满足，转人工验证' });
    expect(runtimeValidator).toHaveBeenCalledTimes(2);
  });

  it('recovers when the model emits valid JSON without the action envelope (run 697af04a regression)', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-envelope-store-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'envelope regression' }));
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '完成' } })
      .mockResolvedValueOnce({ type: 'final', content: 'repaired and done' });

    const result = await runGenerationOrchestrator(createOrchestratorDeps({ run, store, model, runtimeValidator }));

    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(model).toHaveBeenCalledTimes(7);
  });

  it('falls back to deterministic completion when the orchestrator exhausts its step budget', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-budget-store-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'budget regression' }));
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValue({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'overview' } });

    const result = await runGenerationOrchestrator(createOrchestratorDeps({ run, store, model, runtimeValidator }));

    expect(result.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    const traceText = JSON.stringify(store.readTrace(run.id));
    expect(traceText).toContain('orchestration_loop_incomplete');
    expect(traceText).toContain('orchestrated_fallback_finished');
  });

  it('pauses on request_user_input and resumes with the user answer in conversation', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-pause-store-') });
    const run = await import('../generation-harness/generation-run.js').then(({ GenerationRun }) => GenerationRun.create({ store, siteKey: MEMORY.siteKey, goal: 'pause resume' }));
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const pauseModel = vi.fn()
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'request_user_input',
        arguments: { question: '目标页面需要登录，请登录后告诉我', context: 'runtime 验证返回 LOGIN_REQUIRED' },
      });

    const deps = createOrchestratorDeps({ run, store, model: pauseModel, runtimeValidator });
    const paused = await runGenerationOrchestrator(deps);

    expect(paused.pause).toBe(true);
    expect(paused.status).toBe(GENERATION_STATUSES.NEEDS_USER_INPUT);
    expect(paused.pendingQuestion.question).toContain('登录');
    expect(run.snapshot.status).toBe(GENERATION_STATUSES.NEEDS_USER_INPUT);
    expect(run.snapshot.artifacts.orchestrationState.messages).toHaveLength(7);

    const resumeModel = vi.fn()
      .mockImplementationOnce(async ({ messages }) => {
        const serialized = JSON.stringify(messages);
        expect(serialized).toContain('request_user_input');
        expect(serialized).toContain('已重新登录页面');
        return { type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} };
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '登录后验证通过' } })
      .mockResolvedValueOnce({ type: 'final', content: 'resumed done' });

    const resumed = await resumeGenerationOrchestrator({ ...deps, model: resumeModel }, '已重新登录页面');
    expect(resumed.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(run.snapshot.artifacts.pendingQuestion).toBeNull();
  });

  it('runs the classic path when mode is not agent or runtime validation is unavailable', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-mode-store-') });
    const harness = new GenerationHarness({
      store,
      workflow: createAdapterGenerationWorkflow({
        model: vi.fn()
          .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_generation_context', arguments: { section: 'overview' } })
          .mockResolvedValueOnce(planToolCall())
          .mockResolvedValueOnce({ type: 'final', content: 'plan saved' }),
        scaffoldWriter: createFakeScaffoldWriter(),
        runtimeValidator: null,
      }),
    });
    const started = harness.start({
      siteKey: MEMORY.siteKey,
      goal: 'classic default',
      input: { memory: MEMORY, mode: 'agent' },
    });
    await harness.wait(started.id);

    expect(started.status === GENERATION_STATUSES.AWAITING_APPROVAL || harness.get(started.id).status === GENERATION_STATUSES.AWAITING_APPROVAL).toBe(true);
    const traceText = JSON.stringify(store.readTrace(started.id));
    expect(traceText).not.toContain('orchestration_loop_model_started');
  });

  it('supports harness-level pause and resume through the resume workflow', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-orch-harness-store-') });
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce(planToolCall())
      .mockResolvedValueOnce({ type: 'tool_call', name: 'scaffold_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'request_user_input',
        arguments: { question: '需要确认日期范围吗？' },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'finish_run', arguments: { summary: '完成' } })
      .mockResolvedValueOnce({ type: 'final', content: 'harness resumed' });
    const { createAdapterGenerationResumeWorkflow } = await import('../generation-harness/adapter-generation-workflow.js');
    const harness = new GenerationHarness({
      store,
      workflow: createAdapterGenerationWorkflow({
        model,
        scaffoldWriter: createFakeScaffoldWriter(),
        runtimeValidator,
      }),
      resumeWorkflow: createAdapterGenerationResumeWorkflow({
        model,
        scaffoldWriter: createFakeScaffoldWriter(),
        runtimeValidator,
      }),
    });
    const started = harness.start({
      siteKey: MEMORY.siteKey,
      goal: 'harness pause resume',
      input: { memory: MEMORY, mode: 'agent' },
    });
    await harness.wait(started.id);
    expect(harness.get(started.id).status).toBe(GENERATION_STATUSES.NEEDS_USER_INPUT);

    const resumed = await harness.resume(started.id, '默认最近 30 天');
    await harness.wait(started.id);
    expect(resumed.id).toBe(started.id);
    expect(harness.get(started.id).status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
  });
});
