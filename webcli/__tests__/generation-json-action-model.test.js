import { describe, expect, it, vi } from 'vitest';
import { createJsonActionModel, parseJsonActionResponse } from '../generation-harness/index.js';

describe('JSON action model adapter', () => {
  it('parses fenced and plain JSON actions', () => {
    expect(parseJsonActionResponse('```json\n{"type":"final","content":"ok"}\n```')).toEqual({
      type: 'final',
      content: 'ok',
    });
    expect(parseJsonActionResponse('prefix {"type":"tool_call","name":"inspect","arguments":{}} suffix'))
      .toMatchObject({ type: 'tool_call', name: 'inspect' });
    expect(parseJsonActionResponse(
      '{"type":"tool_call","name":"save_generation_plan","arguments":{"summary":"包含 } 字符","tools":[]}}}',
    )).toMatchObject({
      type: 'tool_call',
      name: 'save_generation_plan',
      arguments: { summary: '包含 } 字符', tools: [] },
    });
  });

  it('builds a constrained tool-loop prompt', async () => {
    const callModel = vi.fn().mockResolvedValue({
      text: '{"type":"tool_call","name":"inspect","arguments":{}}',
    });
    const model = createJsonActionModel({ callModel });
    const result = await model({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'start' }],
      tools: [{ name: 'inspect', parameters: { type: 'object' } }],
      step: 1,
    });

    expect(result.name).toBe('inspect');
    expect(callModel.mock.calls[0][0].prompt).toContain('你每次只能输出一个 JSON 对象');
    expect(callModel.mock.calls[0][0].prompt).toContain('inspect');
  });

  it('injects client config only when a request-scoped config is provided', async () => {
    const configuredCall = vi.fn().mockResolvedValue({ text: '{"type":"final","content":"ok"}' });
    const config = {
      provider: 'custom',
      protocol: 'anthropic',
      api_key: 'request-only-secret',
      base_url: 'https://models.example.com/anthropic',
      model: 'client-model',
    };
    const input = {
      systemPrompt: 'system',
      messages: [],
      tools: [],
      step: 1,
    };
    await createJsonActionModel({ callModel: configuredCall, config })(input);
    expect(configuredCall).toHaveBeenCalledWith(expect.objectContaining({ config }));

    const fallbackCall = vi.fn().mockResolvedValue({ text: '{"type":"final","content":"ok"}' });
    await createJsonActionModel({ callModel: fallbackCall })(input);
    expect(fallbackCall.mock.calls[0][0]).not.toHaveProperty('config');
  });

  it('adds a bounded repair instruction after malformed model output', async () => {
    const callModel = vi.fn().mockResolvedValue({ text: '{"type":"final","content":"fixed"}' });
    const model = createJsonActionModel({ callModel });
    await model({
      systemPrompt: 'system',
      messages: [],
      tools: [],
      step: 3,
      repairFeedback: {
        code: 'INVALID_JSON_ACTION',
        preview: '{"type":"final"}}',
      },
    });

    expect(callModel.mock.calls[0][0].prompt).toContain('上一次输出为空、不是合法的单个 JSON action、或缺少必需的 type 信封');
    expect(callModel.mock.calls[0][0].prompt).toContain('必须包含 "type":"tool_call" 或 "type":"final" 信封');
    expect(callModel.mock.calls[0][0].prompt).toContain('{\\"type\\":\\"final\\"}}');
  });
});
