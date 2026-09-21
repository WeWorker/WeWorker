import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import path from 'node:path';
import { normalizeAiConfig, callConfiguredLanguageModel, runLanguageModelWorker } from '../ai-analyzer.js';
import { LanguageModelWorkerSession } from '../ai-worker-session.js';
import { resolveModelOutputLimit, modelOutputErrorDetails } from '../generation-harness/model-output-policy.js';

afterEach(() => vi.unstubAllEnvs());

describe('model output policy', () => {
  it('uses task fallbacks, explicit model config, environment defaults and model ceilings', () => {
    const resolve = (options) => resolveModelOutputLimit({ env: {}, ...options });
    expect(resolve({ purpose: 'adapter_generation' })).toBe(16384);
    expect(resolve({})).toBe(16384);
    expect(resolve({ env: { WEBCLI_ANALYSIS_MAX_OUTPUT_TOKENS: '20000', WEBCLI_MAX_OUTPUT_TOKENS: '18000' } })).toBe(20000);
    expect(resolve({ env: { WEBCLI_MAX_OUTPUT_TOKENS: '18000' } })).toBe(18000);
    expect(resolve({ config: { max_output_tokens: 25000, model_max_output_tokens: 12000 }, env: { WEBCLI_ANALYSIS_MAX_OUTPUT_TOKENS: '20000' } })).toBe(12000);
    expect(resolve({ purpose: 'adapter_generation', env: { WEBCLI_GENERATION_MAX_OUTPUT_TOKENS: '24000' } })).toBe(24000);
    expect(resolve({ config: { max_output_tokens: 28000 }, requested: 20000 })).toBe(20000);
    expect(resolve({ config: { max_output_tokens: 28000, model_max_output_tokens: 12000 } })).toBe(12000);
    expect(resolve({ purpose: 'adapter_generation', config: { max_output_tokens: 9000 }, env: { WEBCLI_GENERATION_MAX_OUTPUT_TOKENS: '24000' } })).toBe(9000);
    expect(resolve({ purpose: 'adapter_generation', env: { WEBCLI_MODEL_MAX_OUTPUT_TOKENS: '4096' } })).toBe(4096);
    expect(normalizeAiConfig({ max_output_tokens: 24000 })).toMatchObject({ max_output_tokens: 24000 });
  });

  it.each([0, -1, 1.5, null, false, '', 'NaN', Infinity, 1048577])('rejects invalid configuration: %s', (value) => {
    expect(() => normalizeAiConfig({ max_output_tokens: value })).toThrow(expect.objectContaining({ code: 'INVALID_MODEL_OUTPUT_CONFIG' }));
    expect(() => resolveModelOutputLimit({ purpose: 'adapter_generation', env: { WEBCLI_GENERATION_MAX_OUTPUT_TOKENS: value } }))
      .toThrow(expect.objectContaining({ code: 'INVALID_MODEL_OUTPUT_CONFIG' }));
  });

  it('only transports allowlisted numerical diagnostics, never provider bodies or reasoning', () => {
    expect(modelOutputErrorDetails({ stopReason: 'length', outputLimit: 24000, inputUnits: -1, outputUnits: 'secret', thinking: 'private', api_key: 'fake-key' }))
      .toEqual({ stopReason: 'length', outputLimit: 24000 });
  });
});

async function withProvider(protocol, fn, empty = false) {
  const requests = [];
  let truncated = true;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const text = empty && truncated ? '' : '{"type":"final","content":"complete-looking but truncated"}';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(protocol === 'anthropic' ? {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [{ type: 'thinking', thinking: 'private-fixture-reasoning' }, ...(text ? [{ type: 'text', text }] : [])],
      stop_reason: truncated ? 'max_tokens' : 'end_turn', usage: { input_tokens: 25, output_tokens: 4000 },
    } : {
      choices: [{ message: { content: text }, finish_reason: truncated ? 'length' : 'stop' }],
      usage: { prompt_tokens: 25, completion_tokens: 4000 },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({
      config: { provider: protocol === 'anthropic' ? 'custom' : 'openai', protocol, api_key: 'fake-test-key', model: 'fixture-model', base_url: `http://127.0.0.1:${server.address().port}` },
      requests, finish: () => { truncated = false; },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('provider and worker output exhaustion', () => {
  it.each([['anthropic', false], ['anthropic', true], ['openai', false], ['openai', true]])('detects %s truncation (empty text: %s) before parsing actions', async (protocol, empty) => {
    vi.stubEnv('WEBCLI_AI_DIRECT', '1');
    await withProvider(protocol, async ({ config, requests, finish }) => {
      const input = { prompt: 'fixture', purpose: 'adapter_generation', config: { ...config, max_output_tokens: 24000, model_max_output_tokens: 12000 } };
      await expect(callConfiguredLanguageModel(input)).rejects.toMatchObject({
        code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', details: { outputLimit: 12000, inputUnits: 25, outputUnits: 4000 },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0][protocol === 'anthropic' ? 'max_tokens' : 'max_completion_tokens']).toBe(12000);
      finish();
      expect((await callConfiguredLanguageModel(input)).text).toContain('final');
    }, empty);
  });

  it.each(['one-shot', 'persistent'])('preserves exhaustion diagnostics across the real %s subprocess without retry', async (transport) => {
    await withProvider('openai', async ({ config, requests, finish }) => {
      const workerScript = path.resolve(import.meta.dirname, '../index.js');
      const session = transport === 'persistent' ? new LanguageModelWorkerSession({ workerScript }) : null;
      const input = { prompt: 'fixture', taskLabel: 'output policy fixture', maxTokens: 4000, config };
      try {
        const call = () => session ? session.call(input) : runLanguageModelWorker({ ...input, workerScript });
        await expect(call()).rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', details: { outputLimit: 4000, stopReason: 'length', outputUnits: 4000 } });
        expect(requests).toHaveLength(1);
        finish();
        const result = await call();
        expect(typeof result === 'string' ? result : result.text).toContain('final');
      } finally { await session?.close(); }
    });
  });
});
