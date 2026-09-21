import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketBridge } from '../bridge.js';
import { analyzeActionCaptureResult } from '../ai-analyzer.js';

vi.mock('../ai-analyzer.js', async (importOriginal) => ({
  ...await importOriginal(),
  analyzeActionCaptureResult: vi.fn().mockResolvedValue({ analysisSource: 'ai', model: 'glm-5.3' }),
}));

const config = { provider: 'custom', protocol: 'anthropic', model: 'glm-5.3', api_key: 'fake-test-key', base_url: 'https://model.example.com' };
const capture = { tabId: 7, site: 'example.com', actionName: 'like_article', capturedActions: [] };
let bridge;
let ws;
async function start(overrides = {}) {
  await bridge._handleClientRequest({ type: 'client_action_capture_start', id: 'start-1', tabId: 7, siteKey: 'example.com', actionName: 'like_article', modelConfig: config, ...overrides });
  return bridge._send.mock.calls.at(-1)?.[0];
}
async function analyze(analysisContextId, captureResult = capture) {
  await bridge._handleAnalyzeActionCaptureResult({ id: 'analysis-1', analysisContextId, captureResult }, ws);
  return JSON.parse(ws.send.mock.calls.at(-1)[0]);
}

beforeEach(() => {
  vi.spyOn(WebSocketBridge.prototype, '_startServer').mockImplementation(() => {});
  bridge = new WebSocketBridge();
  bridge._extensionCapabilities = ['action_capture_model_context_v1'];
  bridge._send = vi.fn().mockReturnValue(true);
  bridge._broadcast = vi.fn();
  ws = { send: vi.fn() };
  analyzeActionCaptureResult.mockClear();
});
afterEach(() => {
  bridge._clearCaptureModelContexts();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('client capture model context', () => {
  it('keeps credentials local and consumes the selected model exactly once', async () => {
    const forwarded = await start();
    expect(forwarded.type).toBe('exploration_action_capture_start');
    expect(forwarded.analysisContextId).toEqual(expect.any(String));
    expect(forwarded).not.toHaveProperty('modelConfig');
    expect(JSON.stringify(forwarded)).not.toContain(config.api_key);
    expect(await analyze(forwarded.analysisContextId)).toMatchObject({ ok: true });
    expect(analyzeActionCaptureResult).toHaveBeenCalledWith({ captureResult: capture, modelConfig: config });
    expect(bridge._captureModelContexts.size).toBe(0);
    expect(await analyze(forwarded.analysisContextId)).toMatchObject({ ok: false });
    expect(analyzeActionCaptureResult).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ws.send.mock.calls)).not.toContain(config.api_key);
  });

  it('isolates concurrent captures and rejects mismatched evidence without fallback', async () => {
    const first = await start();
    const second = await start({ id: 'start-2', tabId: 8, modelConfig: { ...config, model: 'other-model', api_key: 'fake-other-key' } });
    expect(await analyze(first.analysisContextId, { ...capture, tabId: 8 })).toMatchObject({ ok: false });
    expect(analyzeActionCaptureResult).not.toHaveBeenCalled();
    await analyze(second.analysisContextId, { ...capture, tabId: 8 });
    expect(analyzeActionCaptureResult.mock.calls.at(-1)[0].modelConfig.model).toBe('other-model');
    await analyze(first.analysisContextId);
    expect(analyzeActionCaptureResult.mock.calls.at(-1)[0].modelConfig.model).toBe('glm-5.3');
  });

  it('expires abandoned contexts and fails closed', async () => {
    vi.useFakeTimers();
    const forwarded = await start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(bridge._captureModelContexts.size).toBe(0);
    expect(await analyze(forwarded.analysisContextId)).toMatchObject({ ok: false });
    expect(analyzeActionCaptureResult).not.toHaveBeenCalled();
  });

  it('releases contexts on failed starts, send failures and disconnect cleanup', async () => {
    await start();
    bridge._handleExtensionMessage({ type: 'call_tool_error', id: 'start-1', error: 'fixture failure' });
    expect(bridge._captureModelContexts.size).toBe(0);
    bridge._send.mockReturnValueOnce(false);
    await start();
    expect(bridge._captureModelContexts.size).toBe(0);
    await start();
    bridge._clearCaptureModelContexts();
    expect(bridge._captureModelContexts.size).toBe(0);
  });

  it('bounds retained contexts without evicting a running capture', async () => {
    for (let i = 0; i < 65; i++) await start({ id: `start-${i}` });
    expect(bridge._captureModelContexts.size).toBe(64);
    expect(bridge._send).toHaveBeenCalledTimes(64);
    expect(bridge._broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'call_tool_error' }));
  });

  it('requires a compatible extension instead of silently reverting to standalone config', async () => {
    bridge._extensionCapabilities = ['action_capture_v1'];
    await start();
    expect(bridge._send).not.toHaveBeenCalled();
    expect(bridge._broadcast).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('重载浏览器扩展') }));
  });

  it('preserves standalone calls while rejecting invalid injected config', async () => {
    await start({ modelConfig: null });
    expect(bridge._send).not.toHaveBeenCalled();
    await bridge._handleAnalyzeActionCaptureResult({ id: 'legacy', captureResult: capture }, ws);
    expect(analyzeActionCaptureResult).toHaveBeenCalledWith({ captureResult: capture, modelConfig: undefined });
  });

  it('routes analysis-only retries with a fresh local context and preserves typed exhaustion', async () => {
    bridge._extensionCapabilities.push('action_capture_analysis_retry_v1');
    const forwarded = await start({ type: 'client_action_capture_analyze' });
    expect(forwarded.type).toBe('exploration_action_capture_analyze');
    expect(forwarded).not.toHaveProperty('modelConfig');
    analyzeActionCaptureResult.mockRejectedValueOnce(Object.assign(new Error('fixture output limit'), { code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', details: { outputLimit: 2200, thinking: 'private' } }));
    expect(await analyze(forwarded.analysisContextId)).toMatchObject({ ok: false, code: 'MODEL_OUTPUT_LIMIT_EXCEEDED', details: { outputLimit: 2200 } });
    expect(JSON.stringify(ws.send.mock.calls)).not.toContain('private');
    expect(bridge._captureModelContexts.size).toBe(0);
  });
});
