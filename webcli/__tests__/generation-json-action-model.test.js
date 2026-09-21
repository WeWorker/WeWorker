import { describe, expect, it, vi } from 'vitest';
import { createJsonActionModel, parseJsonActionResponse, runToolLoop } from '../generation-harness/index.js';

describe('JSON action model adapter', () => {
  it('delegates the output policy and does not retry exhaustion as a JSON error', async () => {
    const exhausted = Object.assign(new Error('output limit'), { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED' });
    const callModel = vi.fn().mockRejectedValue(exhausted);
    const execute = vi.fn();
    await expect(runToolLoop({
      model: createJsonActionModel({ callModel }),
      tools: [{ name: 'write_draft_file', parameters: { type: 'object' }, execute }],
    })).rejects.toBe(exhausted);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0]).toHaveProperty('purpose', 'adapter_generation');
    expect(callModel.mock.calls[0][0]).not.toHaveProperty('maxTokens');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    '{}',
    'function example(args = {}) { return args; }',
    '```javascript\nfunction example(args = {}) { return args; }\n```',
    '{"type":"tool_call","name":"write_draft_file","arguments":',
    '{"type":"tool_call","name":"write_draft_file","arguments":"bad"}',
    '{"wrapper":{"type":"final","content":"nested"}}',
    'prefix [{"type":"final","content":"nested"}] suffix',
    '{"type":"final","content":"one"}\n{"type":"final","content":"two"}',
  ])('rejects malformed or ambiguous actions without promoting inner objects: %s', (text) => {
    try {
      parseJsonActionResponse(text);
      expect.fail('expected format error');
    } catch (error) {
      expect(error.code).toBe('INVALID_JSON_ACTION');
      expect(error.details.preview).toBe(text);
    }
  });

  it('finds a valid action after unrelated objects, preserving escaped source code', () => {
    const action = { type: 'tool_call', name: 'write_draft_file', arguments: {
      path: 'tool.js', content: 'function example(args = {}) { return "quoted"; }',
    } };
    expect(parseJsonActionResponse(`{}\n${JSON.stringify(action)}`)).toEqual(action);
    expect(parseJsonActionResponse(`\`\`\`javascript\nconst x = {};\n\`\`\`\n\`\`\`json\n${JSON.stringify(action)}\n\`\`\``)).toEqual(action);
    expect(parseJsonActionResponse(JSON.stringify({ type: 'tool_calls', calls: [action] })))
      .toMatchObject({ type: 'tool_calls' });
  });

  it('repairs raw code using the original bounded preview and executes only the repaired call', async () => {
    const rawCode = `function example(args = {}) { return args; }\n${'x'.repeat(2000)}`;
    const execute = vi.fn().mockResolvedValue({ written: true });
    const callModel = vi.fn()
      .mockResolvedValueOnce({ text: rawCode })
      .mockResolvedValueOnce({ text: JSON.stringify({ type: 'tool_call', name: 'write_draft_file', arguments: { content: 'fixed' } }) })
      .mockResolvedValueOnce({ text: '{"type":"final","content":"done"}' });
    const result = await runToolLoop({
      model: createJsonActionModel({ callModel }), messages: [],
      tools: [{ name: 'write_draft_file', description: 'write fixture', parameters: {
        type: 'object', properties: { content: { type: 'string' } }, required: ['content'],
      }, execute }],
    });
    expect(result.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[1][0].prompt).toContain('function example(args = {})');
    expect(callModel.mock.calls[1][0].prompt).not.toContain('x'.repeat(1000));
  });
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
