import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_STATUSES,
  GenerationRun,
  GenerationRunStore,
  reviseAdapterDraft,
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

describe('adapter draft revision loop', () => {
  it('lets the model repair only files inside an isolated draft and revalidates deterministically', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-store-') });
    const previousRoot = makeTmpDir('webcli-revision-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({
      id: 'example.test',
      match: ['example.test'],
      support_files: [],
    }));

    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'repair draft' });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const initialValidation = validateAdapterDraft({ adapterDir, expectedSiteKey: 'example.test' });
    expect(initialValidation.passed).toBe(false);

    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'read_draft_file', arguments: { path: 'index.js' } })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'write_draft_file',
        arguments: {
          path: 'index.js',
          content: 'window.__webmcpRegister({ name: "test", tools: [] });\n',
          reason: '修复未闭合的对象字面量',
        },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'validation passed' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: {
        revision: 0,
        rootDir: previousRoot,
        adapterDir,
        toolNames: ['example.test.search_records'],
      },
      validation: initialValidation,
      staticValidator: validateAdapterDraft,
    });

    expect(revised.validation.passed).toBe(true);
    expect(revised.draft.revision).toBe(1);
    expect(revised.writes).toEqual([{ path: 'index.js', reason: '修复未闭合的对象字面量' }]);
    expect(fs.readFileSync(path.join(revised.draft.adapterDir, 'index.js'), 'utf8')).toContain('__webmcpRegister');
    expect(fs.readFileSync(path.join(adapterDir, 'index.js'), 'utf8')).toBe('window.__webmcpRegister({');
  });

  it('allows realistic multi-file investigation beyond the old six-step limit', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-long-store-') });
    const previousRoot = makeTmpDir('webcli-revision-long-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({ id: 'example.test', match: ['example.test'], support_files: [] }));
    fs.writeFileSync(path.join(adapterDir, 'README.md'), 'draft notes');

    const run = GenerationRun.create({
      store,
      siteKey: 'example.test',
      goal: 'repair after investigation',
      budget: { maxSteps: 30, maxModelCalls: 30 },
    });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const initialValidation = validateAdapterDraft({ adapterDir, expectedSiteKey: 'example.test' });
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'list_draft_files', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'read_draft_file', arguments: { path: 'index.js' } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'read_draft_file', arguments: { path: 'manifest.json' } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'read_draft_file', arguments: { path: 'README.md' } })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'read_draft_file', arguments: { path: 'index.js' } })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'write_draft_file',
        arguments: {
          path: 'index.js',
          content: 'window.__webmcpRegister({ name: "test", tools: [] });\n',
          reason: 'complete registration',
        },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'validation passed' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records'] },
      validation: initialValidation,
      staticValidator: validateAdapterDraft,
    });

    expect(revised.validation.passed).toBe(true);
    expect(revised.loopSteps).toBe(9);
    expect(revised.incomplete).toBe(false);
  });

  it('can rerun runtime validation inside a runtime-directed revision', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-runtime-store-') });
    const previousRoot = makeTmpDir('webcli-revision-runtime-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({ name: "test", tools: [] });\n');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({ id: 'example.test', match: ['example.test'], support_files: [] }));

    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'repair runtime output' });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'runtime validation passed' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records'] },
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING' }] },
      staticValidator: validateAdapterDraft,
      runtimeValidator,
      plan: { tools: [{ name: 'example.test.search_records', risk: 'read' }] },
      memory: { siteKey: 'example.test', listApiCandidates: [] },
    });

    expect(runtimeValidator).toHaveBeenCalledTimes(1);
    expect(revised.runtimeValidation).toMatchObject({ passed: true });
    expect(revised.incomplete).toBe(false);
  });

  it('returns an incomplete revision instead of killing the run when the tool loop reaches its step limit', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-incomplete-store-') });
    const previousRoot = makeTmpDir('webcli-revision-incomplete-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({ name: "test", tools: [] });\n');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({ id: 'example.test', match: ['example.test'], support_files: [] }));

    const run = GenerationRun.create({
      store,
      siteKey: 'example.test',
      goal: 'continue after step limit',
      budget: { maxSteps: 30, maxModelCalls: 30 },
    });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const model = vi.fn().mockResolvedValue({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records'] },
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_CONTRACT_MISMATCH' }] },
      staticValidator: validateAdapterDraft,
    });

    expect(revised.incomplete).toBe(true);
    expect(revised.loopErrorCode).toBe('TOOL_LOOP_MAX_STEPS');
    expect(revised.validation.passed).toBe(true);
    expect(run.snapshot.revisionCount).toBe(1);

    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const recoveryModel = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'runtime validation passed on remaining revision' });
    const recovered = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model: recoveryModel,
      draft: revised.draft,
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING' }] },
      staticValidator: validateAdapterDraft,
      runtimeValidator,
      plan: { tools: [{ name: 'example.test.search_records', risk: 'read' }] },
      memory: { siteKey: 'example.test', listApiCandidates: [] },
    });

    expect(recovered.incomplete).toBe(false);
    expect(recovered.runtimeValidation).toMatchObject({ passed: true });
    expect(run.snapshot.revisionCount).toBe(2);
  });

  function writeTwoToolDraft(adapterDir) {
    const toolsDir = path.join(adapterDir, 'webcli-generated', 'tools');
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({ name: "test", tools: [] });\n');
    fs.writeFileSync(path.join(toolsDir, 'search_records.generated.js'), '// search tool');
    fs.writeFileSync(path.join(toolsDir, 'getuserinfo.generated.js'), '// userinfo tool');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({
      id: 'example.test',
      match: ['example.test'],
      support_files: [
        'webcli-generated/tools/search_records.generated.js',
        'webcli-generated/tools/getuserinfo.generated.js',
      ],
    }));
  }

  it('drops a planned tool deterministically and keeps the draft consistent', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-drop-store-') });
    const previousRoot = makeTmpDir('webcli-revision-drop-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    writeTwoToolDraft(adapterDir);

    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'drop broken tool' });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'drop_planned_tool',
        arguments: { toolName: 'example.test.getuserinfo', reason: '运行验证反复失败且不可修复' },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'dropped and revalidated' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records', 'example.test.getuserinfo'] },
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING', toolName: 'example.test.getuserinfo' }] },
      staticValidator: validateAdapterDraft,
      plan: { tools: [{ name: 'example.test.search_records', risk: 'read' }, { name: 'example.test.getuserinfo', risk: 'read' }] },
    });

    expect(revised.draft.toolNames).toEqual(['example.test.search_records']);
    expect(revised.plan.tools.map((tool) => tool.name)).toEqual(['example.test.search_records']);
    expect(revised.validation.passed).toBe(true);
    expect(fs.existsSync(path.join(revised.draft.adapterDir, 'webcli-generated/tools/getuserinfo.generated.js'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(revised.draft.adapterDir, 'manifest.json'), 'utf8'));
    expect(manifest.support_files).toEqual(['webcli-generated/tools/search_records.generated.js']);
    expect(fs.existsSync(path.join(adapterDir, 'webcli-generated/tools/getuserinfo.generated.js'))).toBe(true);
    expect(revised.writes).toEqual([{ path: 'drop:example.test.getuserinfo', reason: '运行验证反复失败且不可修复' }]);
  });

  it('refuses to drop the last remaining tool and falls back to marking it unverifiable', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-last-store-') });
    const previousRoot = makeTmpDir('webcli-revision-last-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    writeTwoToolDraft(adapterDir);

    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'keep last tool' });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const model = vi.fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'drop_planned_tool',
        arguments: { toolName: 'example.test.getuserinfo', reason: '先剔除一个' },
      })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'drop_planned_tool',
        arguments: { toolName: 'example.test.search_records', reason: '再剔除最后一个' },
      })
      .mockImplementationOnce(async ({ messages }) => {
        const toolResults = messages.filter((message) => message.role === 'tool');
        const lastResult = toolResults.at(-1);
        expect(lastResult.isError).toBe(true);
        expect(String(lastResult.content.error)).toContain('last remaining tool');
        return {
          type: 'tool_call',
          name: 'mark_tool_unverifiable',
          arguments: { toolName: 'example.test.search_records', reason: '唯一工具无法自动验证' },
        };
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'marked unverifiable' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records', 'example.test.getuserinfo'] },
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING', toolName: 'example.test.search_records' }] },
      staticValidator: validateAdapterDraft,
      plan: { tools: [{ name: 'example.test.search_records', risk: 'read' }, { name: 'example.test.getuserinfo', risk: 'read' }] },
    });

    expect(revised.draft.toolNames).toEqual(['example.test.search_records']);
    expect(revised.plan.tools).toHaveLength(1);
    expect(revised.plan.tools[0].unverifiable).toMatchObject({ reason: '唯一工具无法自动验证' });
    expect(fs.existsSync(path.join(revised.draft.adapterDir, 'webcli-generated/tools/search_records.generated.js'))).toBe(true);
    expect(revised.validation.passed).toBe(true);
  });

  it('passes the unverifiable marker through to runtime validation', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-mark-store-') });
    const previousRoot = makeTmpDir('webcli-revision-mark-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    writeTwoToolDraft(adapterDir);

    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'mark and revalidate' });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    const runtimeValidator = vi.fn().mockResolvedValue({ passed: true, validator: 'adapter_runtime_validator_v1', errors: [] });
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_validation_errors', arguments: {} })
      .mockResolvedValueOnce({
        type: 'tool_call',
        name: 'mark_tool_unverifiable',
        arguments: { toolName: 'example.test.getuserinfo', reason: 'fixture 断言无法自动满足' },
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_runtime', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'runtime validation passed with marker' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records', 'example.test.getuserinfo'] },
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING', toolName: 'example.test.getuserinfo' }] },
      staticValidator: validateAdapterDraft,
      runtimeValidator,
      plan: { tools: [{ name: 'example.test.search_records', risk: 'read' }, { name: 'example.test.getuserinfo', risk: 'read' }] },
      memory: { siteKey: 'example.test', listApiCandidates: [] },
    });

    expect(runtimeValidator).toHaveBeenCalledTimes(1);
    const callPlan = runtimeValidator.mock.calls[0][0].plan;
    expect(callPlan.tools.find((tool) => tool.name === 'example.test.getuserinfo').unverifiable)
      .toMatchObject({ reason: 'fixture 断言无法自动满足' });
    expect(revised.runtimeValidation).toMatchObject({ passed: true });
    expect(revised.plan.tools.find((tool) => tool.name === 'example.test.getuserinfo').unverifiable)
      .toMatchObject({ revision: 1 });
  });

  it('reports a blocker note and can review its own run trace', async () => {
    const store = new GenerationRunStore({ rootDir: makeTmpDir('webcli-revision-blocker-store-') });
    const previousRoot = makeTmpDir('webcli-revision-blocker-source-');
    const adapterDir = path.join(previousRoot, 'example.test');
    fs.mkdirSync(adapterDir, { recursive: true });
    fs.writeFileSync(path.join(adapterDir, 'index.js'), 'window.__webmcpRegister({ name: "test", tools: [] });\n');
    fs.writeFileSync(path.join(adapterDir, 'manifest.json'), JSON.stringify({ id: 'example.test', match: ['example.test'], support_files: [] }));

    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'report blocker' });
    run.transition(GENERATION_STATUSES.CONTEXT_READY);
    run.transition(GENERATION_STATUSES.PLANNING);
    run.transition(GENERATION_STATUSES.DRAFTING);
    run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
    run.trace('state_changed', { from: 'static_validating', to: 'revising' });
    const model = vi.fn()
      .mockResolvedValueOnce({ type: 'tool_call', name: 'inspect_run_trace', arguments: { limit: 10 } })
      .mockImplementationOnce(async ({ messages }) => {
        const toolResult = messages.find((message) => message.role === 'tool');
        expect(JSON.stringify(toolResult.content)).toContain('state_changed');
        return {
          type: 'tool_call',
          name: 'report_blocker',
          arguments: { summary: '验证断言与接口实际返回无法对齐', question: '是否允许 get_user 转人工验证？' },
        };
      })
      .mockResolvedValueOnce({ type: 'tool_call', name: 'validate_adapter_draft', arguments: {} })
      .mockResolvedValueOnce({ type: 'final', content: 'blocker reported' });

    const revised = await reviseAdapterDraft({
      run,
      signal: new AbortController().signal,
      store,
      model,
      draft: { revision: 0, rootDir: previousRoot, adapterDir, toolNames: ['example.test.search_records'] },
      validation: { passed: false, validator: 'adapter_runtime_validator_v1', errors: [{ code: 'OUTPUT_TYPE_PATH_MISSING' }] },
      staticValidator: validateAdapterDraft,
    });

    expect(run.snapshot.artifacts.blockerNote).toMatchObject({
      revision: 1,
      question: '是否允许 get_user 转人工验证？',
      remainingTools: ['example.test.search_records'],
    });
    expect(revised.validation.passed).toBe(true);
  });
});
