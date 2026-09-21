import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attributeGenerationFailure,
  buildPreviousFailureContext,
  normalizePreviousFailureInput,
} from '../generation-harness/failure-attribution.js';
import { buildContextSections } from '../generation-harness/adapter-generation-workflow.js';
import { createGenerationRunTransportSnapshot } from '../generation-transport.js';

const webcliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIME_FAILED_RUN = {
  id: 'run-1',
  siteKey: 'example.test',
  status: 'failed',
  completedAt: '2026-09-14T03:00:00.000Z',
  lastError: { code: 'RUNTIME_VALIDATION_FAILED', message: 'adapter draft failed runtime validation (3 errors)' },
  revisionCount: 1,
  modelCallCount: 10,
  stepCount: 11,
  artifacts: {
    plan: { tools: [{ name: 'example.test.search_records' }, { name: 'example.test.get_user' }] },
    staticValidation: { passed: true, errors: [] },
    runtimeValidation: {
      passed: false,
      errors: [
        { code: 'OUTPUT_TYPE_PATH_MISSING', message: '无法验证字段类型，路径不存在: data.list.*.id', path: 'data.list.*.id', toolName: 'example.test.get_user' },
        { code: 'OUTPUT_FIELD_TYPE_MISMATCH', message: '字段应为 string', path: 'data.list.*.name', toolName: 'example.test.get_user' },
      ],
    },
  },
};

describe('generation failure attribution', () => {
  it.each(['MODEL_OUTPUT_LIMIT_EXCEEDED', 'INVALID_MODEL_OUTPUT_CONFIG'])('provides configuration guidance for %s instead of identical retries', (code) => {
    const result = attributeGenerationFailure({ status: 'failed', lastError: { code } });
    expect(result.category).toBe('harness');
    expect(result.recommendedAction).toBe('adjust_model_output_config');
    expect(result.summary).toContain('不建议原样重复请求');
  });

  it('attributes runtime contract mismatches to the draft category with retry guidance', () => {
    const attribution = attributeGenerationFailure(RUNTIME_FAILED_RUN);
    expect(attribution.category).toBe('draft');
    expect(attribution.categoryLabel).toBe('草稿未通过验证');
    expect(attribution.recommendedAction).toBe('retry_with_context');
    expect(attribution.summary).toContain('页面运行验证');
    expect(attribution.summary).toContain('example.test.get_user');
    expect(attribution.errorCodes).toContain('OUTPUT_TYPE_PATH_MISSING');
    expect(attribution.toolErrors).toHaveLength(2);
  });

  it('attributes page environment errors to the site category', () => {
    const attribution = attributeGenerationFailure({
      status: 'failed',
      lastError: { code: 'TARGET_TAB_NOT_FOUND', message: 'tab gone' },
    });
    expect(attribution.category).toBe('site');
    expect(attribution.recommendedAction).toBe('reopen_and_retry');
    expect(attribution.summary).toContain('打开并登录目标页面');
  });

  it('attributes harness protocol and budget errors to the harness category', () => {
    for (const code of ['TOOL_LOOP_MAX_STEPS', 'INVALID_MODEL_RESPONSE', 'BUDGET_EXCEEDED']) {
      const attribution = attributeGenerationFailure({ status: 'failed', lastError: { code } });
      expect(attribution.category).toBe('harness');
      expect(attribution.recommendedAction).toBe('retry_with_context');
    }
  });

  it('returns null for non-failure statuses', () => {
    expect(attributeGenerationFailure({ status: 'awaiting_approval' })).toBeNull();
    expect(attributeGenerationFailure({ status: 'completed' })).toBeNull();
    expect(attributeGenerationFailure(null)).toBeNull();
  });

  it('builds a compact, path-free previous failure context for planning', () => {
    const context = buildPreviousFailureContext(RUNTIME_FAILED_RUN);
    expect(context.previousRunId).toBe('run-1');
    expect(context.category).toBe('draft');
    expect(context.plannedTools).toEqual(['example.test.search_records', 'example.test.get_user']);
    expect(context.failedTools).toEqual(['example.test.get_user']);
    expect(context.toolErrors[0]).toMatchObject({
      toolName: 'example.test.get_user',
      code: 'OUTPUT_TYPE_PATH_MISSING',
      path: 'data.list.*.id',
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toMatch(/[A-Z]:\\\\|\/home\/|\/Users\//);
    expect(buildPreviousFailureContext({ status: 'completed' })).toBeNull();
  });

  it('normalizes arbitrary previous failure input defensively', () => {
    expect(normalizePreviousFailureInput(null)).toBeNull();
    expect(normalizePreviousFailureInput({ category: 'draft' })).toBeNull();
    const normalized = normalizePreviousFailureInput({
      previousRunId: ' run-1 ',
      category: 'draft',
      plannedTools: ['ok', 42, ''],
      toolErrors: [{ toolName: 't', code: 'c', path: 'p' }, { toolName: '' }, 'junk'],
      revisionCount: '3',
    });
    expect(normalized.previousRunId).toBe('run-1');
    expect(normalized.plannedTools).toEqual(['ok']);
    expect(normalized.toolErrors).toHaveLength(1);
    expect(normalized.revisionCount).toBe(3);
  });

  it('exposes previous failure through the planning context sections', () => {
    const memory = { siteKey: 'example.test', siteHost: 'example.test' };
    const previousFailure = normalizePreviousFailureInput(buildPreviousFailureContext(RUNTIME_FAILED_RUN));
    const sections = buildContextSections(memory, previousFailure);
    expect(sections.overview.previousFailurePresent).toBe(true);
    expect(sections.previous_failure.previousRunId).toBe('run-1');
    expect(sections.previous_failure.toolErrors).toHaveLength(2);

    const bare = buildContextSections(memory, null);
    expect(bare.overview.previousFailurePresent).toBe(false);
    expect(bare.previous_failure).toBeNull();
  });

  it('attaches failure attribution to failed transport snapshots only', () => {
    const failed = createGenerationRunTransportSnapshot(structuredClone(RUNTIME_FAILED_RUN));
    expect(failed.failureAttribution.category).toBe('draft');
    expect(failed.failureAttribution.summary).toContain('example.test.get_user');
    const awaiting = createGenerationRunTransportSnapshot({ ...RUNTIME_FAILED_RUN, status: 'awaiting_approval' });
    expect(awaiting.failureAttribution).toBeUndefined();
  });

  it('surfaces the revision blocker note in attribution and retry context', () => {
    const runWithBlocker = {
      ...structuredClone(RUNTIME_FAILED_RUN),
      artifacts: {
        ...RUNTIME_FAILED_RUN.artifacts,
        blockerNote: { revision: 1, summary: '验证断言与接口实际返回无法对齐', question: '是否允许 get_user 转人工验证？' },
      },
    };
    const attribution = attributeGenerationFailure(runWithBlocker);
    expect(attribution.summary).toContain('修订智能体报告');
    expect(attribution.summary).toContain('转人工验证');
    const context = buildPreviousFailureContext(runWithBlocker);
    expect(context.blocker).toEqual({
      summary: '验证断言与接口实际返回无法对齐',
      question: '是否允许 get_user 转人工验证？',
    });
    const normalized = normalizePreviousFailureInput(context);
    expect(normalized.blocker.question).toContain('get_user');
    expect(normalizePreviousFailureInput({ ...context, blocker: 'junk' }).blocker).toBeNull();
  });

  it('wires previousRunId and previousFailure through the bridge start handler', () => {
    const bridgeSource = fs.readFileSync(path.join(webcliRoot, 'bridge.js'), 'utf8');
    expect(bridgeSource).toContain('previousRunId');
    expect(bridgeSource).toContain('buildPreviousFailureContext');
    expect(bridgeSource).toContain("['failed', 'budget_exceeded'].includes(previous.status)");
    expect(bridgeSource).toContain('previousFailure ? { previousFailure } : {}');
    const transportSource = fs.readFileSync(path.join(webcliRoot, 'generation-transport.js'), 'utf8');
    expect(transportSource).toContain('attributeGenerationFailure(snapshot)');
  });
});
