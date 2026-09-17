import { describe, expect, it, vi } from 'vitest';
import { runToolLoop, ToolRegistry } from '../generation-harness/index.js';

describe('generation tool loop', () => {
  it('executes domain tools until the model returns final', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        id: 'call-1',
        name: 'inspect_context',
        arguments: { section: 'apis' },
      })
      .mockResolvedValueOnce({
        type: 'tool_call',
        id: 'call-2',
        name: 'save_plan',
        arguments: { tools: ['example.test.search_records'] },
      })
      .mockResolvedValueOnce({ type: 'final', content: 'plan ready', data: { planId: 'plan-1' } });

    const savedPlans = [];
    const result = await runToolLoop({
      model,
      messages: [{ role: 'user', content: 'generate adapter' }],
      tools: [
        {
          name: 'inspect_context',
          description: 'Inspect captured APIs',
          parameters: {
            type: 'object',
            properties: { section: { type: 'string' } },
            required: ['section'],
            additionalProperties: false,
          },
          execute: async ({ section }) => ({ section, count: 2 }),
        },
        {
          name: 'save_plan',
          description: 'Save a generation plan',
          parameters: {
            type: 'object',
            properties: {
              tools: { type: 'array', items: { type: 'string' } },
            },
            required: ['tools'],
            additionalProperties: false,
          },
          execute: async (plan) => {
            savedPlans.push(plan);
            return { planId: 'plan-1' };
          },
        },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.steps).toBe(3);
    expect(savedPlans).toEqual([{ tools: ['example.test.search_records'] }]);
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
  });

  it('returns tool errors to the model so it can recover', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({
        type: 'tool_call',
        id: 'call-1',
        name: 'missing_tool',
        arguments: {},
      })
      .mockImplementationOnce(async ({ messages }) => {
        const toolResult = messages.find((message) => message.role === 'tool');
        expect(toolResult.isError).toBe(true);
        expect(toolResult.content.code).toBe('UNKNOWN_GENERATION_TOOL');
        return { type: 'final', content: 'recovered' };
      });

    const result = await runToolLoop({ model, tools: [] });
    expect(result.content).toBe('recovered');
  });

  it('retries one malformed JSON action and reports the retry as a model call', async () => {
    const malformed = Object.assign(new Error('invalid JSON action'), {
      code: 'INVALID_JSON_ACTION',
      details: { preview: '{"type":"final"}}' },
    });
    const model = vi.fn()
      .mockRejectedValueOnce(malformed)
      .mockImplementationOnce(async ({ repairFeedback }) => {
        expect(repairFeedback).toEqual({
          code: 'INVALID_JSON_ACTION',
          preview: '{"type":"final"}}',
          attempt: 2,
        });
        return { type: 'final', content: 'repaired' };
      });
    const events = [];

    const result = await runToolLoop({
      model,
      tools: [],
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe('repaired');
    expect(events.filter((event) => event.type === 'model_started')).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_format_retry',
      attempt: 2,
    }));
  });

  it('recovers when the model returns empty output twice before succeeding', async () => {
    const empty = (preview) => Object.assign(new Error('model did not return a valid JSON action'), {
      code: 'INVALID_JSON_ACTION',
      details: { preview },
    });
    const model = vi.fn()
      .mockRejectedValueOnce(empty(''))
      .mockRejectedValueOnce(empty(''))
      .mockResolvedValueOnce({ type: 'final', content: 'recovered after empty outputs' });
    const events = [];

    const result = await runToolLoop({
      model,
      tools: [],
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe('recovered after empty outputs');
    expect(model).toHaveBeenCalledTimes(3);
    const retries = events.filter((event) => event.type === 'model_format_retry');
    expect(retries.map((event) => event.attempt)).toEqual([2, 3]);
  });

  it('still fails when empty model output persists beyond both repair attempts', async () => {
    const empty = Object.assign(new Error('model did not return a valid JSON action'), {
      code: 'INVALID_JSON_ACTION',
      details: { preview: '' },
    });
    const model = vi.fn().mockRejectedValue(empty);

    await expect(runToolLoop({ model, tools: [] }))
      .rejects.toMatchObject({ code: 'INVALID_JSON_ACTION' });
    expect(model).toHaveBeenCalledTimes(3);
  });
  it('recovers from chained empty-then-bare-envelope failures within the step budget', async () => {
    const empty = Object.assign(new Error('model did not return a valid JSON action'), {
      code: 'INVALID_JSON_ACTION',
      details: { preview: '' },
    });
    const bare = Object.assign(new Error('unsupported model response type: unknown'), {
      code: 'INVALID_MODEL_RESPONSE',
      details: { response: { name: 'read_draft_files' } },
    });
    const model = vi.fn()
      .mockRejectedValueOnce(empty)
      .mockRejectedValueOnce(bare)
      .mockResolvedValueOnce({ type: 'final', content: 'recovered from chained format errors' });

    const result = await runToolLoop({ model, tools: [] });

    expect(result.content).toBe('recovered from chained format errors');
    expect(model).toHaveBeenCalledTimes(3);
  });
  it('recovers when the model emits valid JSON without the action envelope', async () => {
    const model = vi.fn()
      .mockResolvedValueOnce({
        name: 'save_generation_plan',
        purpose: '查询站点页面菜单列表',
        risk: 'read',
        sourceApiIndexes: [0],
      })
      .mockImplementationOnce(async ({ repairFeedback }) => {
        expect(repairFeedback.code).toBe('INVALID_MODEL_RESPONSE');
        expect(repairFeedback.preview).toContain('save_generation_plan');
        return { type: 'final', content: 'repaired' };
      });
    const events = [];

    const result = await runToolLoop({
      model,
      tools: [],
      onEvent: (event) => events.push(event),
    });

    expect(result.content).toBe('repaired');
    expect(events.filter((event) => event.type === 'model_started')).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_format_retry',
      attempt: 2,
      code: 'INVALID_MODEL_RESPONSE',
    }));
  });

  it('still fails with INVALID_MODEL_RESPONSE when the repair keeps the bad shape', async () => {
    const model = vi.fn().mockResolvedValue({ name: 'save_generation_plan', risk: 'read' });

    await expect(runToolLoop({ model, tools: [] }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_RESPONSE' });
    expect(model).toHaveBeenCalledTimes(3);
  });

  it('validates tool arguments before execution', async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry([{
      name: 'save_plan',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      execute,
    }]);

    await expect(registry.execute({ name: 'save_plan', arguments: { title: 42 } }))
      .rejects.toMatchObject({ code: 'INVALID_TOOL_ARGUMENTS' });
    expect(execute).not.toHaveBeenCalled();
  });
});
