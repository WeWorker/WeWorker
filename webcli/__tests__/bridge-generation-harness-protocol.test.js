import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bridge generation harness protocol', () => {
  it('registers start, get and cancel generation-run handlers', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'bridge.js'), 'utf8');
    expect(source).toContain("msg.type === 'start_generation_run'");
    expect(source).toContain("msg.type === 'get_generation_run'");
    expect(source).toContain("msg.type === 'cancel_generation_run'");
    expect(source).toContain("msg.type === 'publish_generation_run'");
    expect(source).toContain("type: 'generation_run_event'");
    expect(source).toContain("type: 'start_generation_run_result'");
    expect(source).toContain("msg.type === 'validate_generation_preview_result'");
    expect(source).toContain('GenerationWorkerController');
    expect(source).not.toContain('new GenerationHarness');
    const workerSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'generation-worker.js'), 'utf8');
    expect(workerSource).toContain("command === 'healthcheck'");
    expect(workerSource).toContain("type: 'extension_request'");
    expect(workerSource).toContain('createGenerationEventTransport(event)');
    expect(workerSource).toContain('LanguageModelWorkerSession');
    expect(workerSource).toContain('modelTransport=persistent-worker');
    const injectorSource = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'extension', 'content', 'injector.js'),
      'utf8',
    );
    expect(injectorSource).toContain('toolDef.generationSource = tool.generationSource');
    expect(source).toContain('buildApiSourceEvidence');
  });

  it('allows the extension service worker to resolve harness responses', () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'extension', 'background', 'service-worker.js'),
      'utf8',
    );
    expect(source).toContain('msg.type === "start_generation_run_result"');
    expect(source).toContain('msg.type === "publish_generation_run_result"');
    expect(source).toContain("msg.type === 'generation_run_event'");
    expect(source).toContain("msg.type === 'validate_generation_preview'");
    expect(source).toContain('validateGenerationPreview');
    expect(source).toContain('callGenerationPreviewTool');
    expect(source).toContain('validateGenerationPreviewOutput');
    expect(source).toContain('function scheduleNativeHeartbeatAckCheck');
    expect(source).toContain('if (lastNativeAckAt < sentAt)');
    expect(source).toContain('function failPendingBridgeRequests');
    expect(source).toContain("clearTimeout(pending.timer)");
    expect(source).toContain('lastBridgeDisconnectReason');
    expect(source).toContain('disconnectReason: lastBridgeDisconnectReason');
    expect(source).toContain('normalizeGenerationPreviewBundle');
    expect(source).toContain('findExtensionIsolatedWorldContext');
    expect(source).toContain('injectGenerationPreviewSourcesWithCdp');
    expect(source).toContain('allowUnsafeEvalBlockedByCSP: true');
    expect(source).toContain("method === 'Runtime.executionContextCreated'");
    const validatorSource = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'extension', 'background', 'generation-output-validator.js'),
      'utf8',
    );
    expect(source).toContain("from './generation-output-validator.js'");
    expect(source).toContain('validateGenerationPreviewOutputV2(output, contract)');
    expect(validatorSource).toContain("contract.kind === 'captured_sample'");
    expect(source).toContain('generationSource: tool.generationSource || null');
    expect(validatorSource).toContain("code: 'OUTPUT_SHAPE_MISMATCH'");
    expect(source).not.toContain('列表工具应返回数组');
    expect(source).not.toContain('now - lastNativeAckAt > NATIVE_ACK_TIMEOUT_MS');
  });

  it('isolates websocket broadcast errors from active generation runs', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'bridge.js'), 'utf8');
    expect(source).toContain('Failed to serialize broadcast');
    expect(source).toContain('client.send(msgStr, (error) =>');
    expect(source).toContain('Broadcast failed');
  });
});
