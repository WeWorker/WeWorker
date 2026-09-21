import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { analyzeActionCaptureResult, resolveActionCaptureModelConfig, analyzeExplorationResult, analyzeScaffoldSemantics, generateAdapterWithAI, generateSkillMd, testAiConfig } from '../ai-analyzer.js';

// No local WebCLI config exists, regardless of the developer machine's settings.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: (file) => /[\\/]\.webcli[\\/]config\.json$/.test(String(file)) ? false : actual.existsSync(file) };
});
afterEach(() => vi.unstubAllEnvs());

it.each([['anthropic', 'direct'], ['openai', 'direct'], ['anthropic', 'worker'], ['openai', 'worker']])('uses injected glm-5.3 via %s / %s without a standalone configuration', async (protocol, transport) => {
  vi.stubEnv('WEBCLI_AI_DIRECT', transport === 'direct' ? '1' : '0');
  const previousEntry = process.argv[1];
  process.argv[1] = path.resolve(import.meta.dirname, '../index.js');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ body: JSON.parse(body), headers: req.headers });
    const content = JSON.stringify({ summary: 'fixture analysis', actionKind: 'write', candidateAnalyses: [] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(protocol === 'anthropic' ? {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'glm-5.3',
      content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 10 },
    } : { choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 10 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const modelConfig = { provider: 'custom', protocol, model: 'glm-5.3', api_key: 'fake-test-key', base_url: `http://127.0.0.1:${server.address().port}` };
    const result = await analyzeActionCaptureResult({ captureResult: { site: 'example.com', capturedActions: [] }, modelConfig });
    expect(result).toMatchObject({ analysisSource: 'ai', model: 'glm-5.3', summary: 'fixture analysis' });
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe('glm-5.3');
    expect(requests[0].body.max_tokens).toBe(16384);
    expect(requests[0].headers[protocol === 'anthropic' ? 'x-api-key' : 'authorization']).toContain('fake-test-key');
    expect(JSON.stringify(result)).not.toContain('fake-test-key');
  } finally {
    process.argv[1] = previousEntry;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it('detects truncation without format retries, then reanalyzes the same evidence using configured limits', async () => {
  vi.stubEnv('WEBCLI_AI_DIRECT', '1');
  const budgets = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    budgets.push(JSON.parse(body).max_tokens);
    const truncated = budgets.length === 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: truncated ? [{ type: 'thinking', thinking: 'fixture-private-reasoning' }] : [{ type: 'text', text: '{"summary":"complete","candidateAnalyses":[]}' }], stop_reason: truncated ? 'max_tokens' : 'end_turn', usage: { output_tokens: 2200 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const modelConfig = { provider: 'custom', protocol: 'anthropic', model: 'glm-5.3', api_key: 'fake-test-key', base_url: `http://127.0.0.1:${server.address().port}`, max_output_tokens: 2200 };
    const captureResult = { site: 'example.com', capturedActions: [] };
    await expect(analyzeActionCaptureResult({ captureResult, modelConfig })).rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', details: { outputLimit: 2200 } });
    expect(budgets).toEqual([2200]);
    const result = await analyzeActionCaptureResult({ captureResult, modelConfig: { ...modelConfig, max_output_tokens: 20000, model_max_output_tokens: 18000 } });
    expect(budgets).toEqual([2200, 18000]);
    expect(result.summary).toBe('complete');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it('all exploration-related entry points honor the shared policy rather than hardcoded prompt budgets', async () => {
  vi.stubEnv('WEBCLI_AI_DIRECT', '1');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const text = requests.length === 4 ? 'window.__webmcpRegister({ name: "example.test.list" });' : '{}';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const modelConfig = { provider: 'custom', protocol: 'openai', model: 'glm-5.3', api_key: 'fake-test-key', base_url: `http://127.0.0.1:${server.address().port}`, max_output_tokens: 21000 };
    await analyzeExplorationResult({ siteKey: 'example.test', explorationResult: {}, heuristicVerdict: {}, modelConfig });
    await analyzeScaffoldSemantics({ memory: { siteKey: 'example.test' }, modelConfig });
    await testAiConfig(modelConfig);
    await generateAdapterWithAI({ siteKey: 'example.test', apiEntries: [], modelConfig });
    await generateSkillMd({ siteKey: 'example.test', adapterCode: '', toolNames: [], modelConfig });
    expect(requests.map((request) => request.max_tokens)).toEqual([21000, 21000, 21000, 21000, 21000]);
    const source = readFileSync(path.resolve(import.meta.dirname, '../ai-analyzer.js'), 'utf8');
    expect(source.match(/await callLanguageModel\(/g)).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it.each([null, {}, { api_key: 'fake-test-key', protocol: 'openai', model: '', base_url: 'https://example.com' }])('rejects invalid injection without consulting standalone settings: %j', (modelConfig) => {
  expect(() => resolveActionCaptureModelConfig(modelConfig)).toThrow('客户端模型配置不完整');
});

it('retains standalone config behavior only when no model config was injected', () => {
  expect(() => resolveActionCaptureModelConfig(undefined)).toThrow('未找到配置文件');
});
