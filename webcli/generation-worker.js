import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  GenerationHarness,
  createAdapterGenerationWorkflow,
  createAdapterGenerationResumeWorkflow,
  createAdapterPublisher,
  createJsonActionModel,
  createPreviewRuntimeValidator,
} from './generation-harness/index.js';
import { LanguageModelWorkerSession } from './ai-worker-session.js';
import { createGenerationEventTransport } from './generation-transport.js';

const pendingExtensionRequests = new Map();

function formatWorkerMemory() {
  const memory = process.memoryUsage();
  return `rss=${Math.round(memory.rss / 1024 / 1024)}MB heap=${Math.round(memory.heapUsed / 1024 / 1024)}MB`;
}

function sendToParent(message) {
  if (!process.send || !process.connected) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      process.send(message, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

function readCommandPayload(payloadPath) {
  const filePath = String(payloadPath || '');
  if (!filePath) throw new Error('generation worker payload path is required');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createIpcExtensionRequester() {
  return (message, timeout = 60_000) => new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('Bridge IPC channel is unavailable'));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingExtensionRequests.delete(requestId);
      const error = new Error(`Bridge extension request timed out after ${timeout}ms`);
      error.code = 'GENERATION_EXTENSION_REQUEST_TIMEOUT';
      reject(error);
    }, timeout + 1_000);
    pendingExtensionRequests.set(requestId, { resolve, reject, timer });
    void sendToParent({
      type: 'extension_request',
      requestId,
      request: message,
      timeout,
    }).then((sent) => {
      if (sent) return;
      const pending = pendingExtensionRequests.get(requestId);
      if (!pending) return;
      pendingExtensionRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error('failed to send extension request to Bridge'));
    });
  });
}

function rejectPendingExtensionRequests(reason) {
  for (const pending of pendingExtensionRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  pendingExtensionRequests.clear();
}

function createHarness({ model }) {
  const harness = new GenerationHarness({
    workflow: createAdapterGenerationWorkflow({
      model,
      runtimeValidator: createPreviewRuntimeValidator({
        requestExtension: createIpcExtensionRequester(),
      }),
    }),
    resumeWorkflow: createAdapterGenerationResumeWorkflow({
      model,
      runtimeValidator: createPreviewRuntimeValidator({
        requestExtension: createIpcExtensionRequester(),
      }),
    }),
    publisher: createAdapterPublisher(),
  });
  harness.on('event', (event) => {
    if (event.type === 'state_changed') {
      process.stderr.write(
        `[HarnessWorker] run=${event.runId} state=${event.data?.to || 'unknown'} `
          + `action=${event.data?.currentAction || '-'} ${formatWorkerMemory()}\n`,
      );
    }
    if (event.type === 'draft_phase') {
      const copied = event.data?.phase === 'seed_adapter_completed'
        ? ` files=${Number(event.data?.copiedFiles || 0)} bytes=${Number(event.data?.copiedBytes || 0)}`
        : '';
      process.stderr.write(
        `[HarnessWorker] run=${event.runId} draftPhase=${event.data?.phase || 'unknown'} `
          + `${formatWorkerMemory()}${copied}\n`,
      );
    }
    void sendToParent({ type: 'event', event: createGenerationEventTransport(event) });
  });
  return harness;
}

export async function runGenerationWorker() {
  const modelSession = new LanguageModelWorkerSession();
  let harness = null;
  process.stderr.write(
    `[HarnessWorker] started pid=${process.pid} modelTransport=persistent-worker ${formatWorkerMemory()}\n`,
  );
  let activeOperation = null;
  let activeRunId = null;
  let disconnectingNormally = false;
  const disconnectNormally = () => {
    disconnectingNormally = true;
    if (process.connected) process.disconnect();
  };

  process.on('message', (message) => {
    if (message?.type === 'extension_response') {
      const pending = pendingExtensionRequests.get(message.requestId);
      if (!pending) return;
      pendingExtensionRequests.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok === false) {
        const error = new Error(message.error || 'Bridge extension request failed');
        error.code = message.code || 'GENERATION_EXTENSION_REQUEST_FAILED';
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.type !== 'command') return;
    const { requestId, command } = message;

    if (command === 'healthcheck') {
      void sendToParent({
        type: 'response',
        requestId,
        ok: true,
        capabilities: ['start', 'cancel', 'publish', 'extension_request'],
      }).then(() => {
        disconnectNormally();
      });
      return;
    }

    if (command === 'cancel') {
      void (async () => {
        try {
          if (!harness) throw new Error('generation worker has not started a Harness run');
          const payload = message.payload || {};
          const run = harness.cancel(String(payload.runId || ''), String(payload.reason || 'cancelled by user'));
          if (!run) throw new Error(`generation run not found: ${payload.runId}`);
          await sendToParent({ type: 'response', requestId, ok: true, runId: run.id });
        } catch (error) {
          await sendToParent({ type: 'response', requestId, ok: false, error: error?.message || String(error) });
        }
      })();
      return;
    }

    if (activeOperation) {
      void sendToParent({
        type: 'response',
        requestId,
        ok: false,
        error: `generation worker is already running ${activeOperation}`,
      });
      return;
    }

    activeOperation = command;
    void (async () => {
      try {
        const payload = readCommandPayload(message.payloadPath);
        harness = createHarness({
          model: createJsonActionModel({
            callModel: (input) => modelSession.call(input),
            ...(message.modelConfig ? { config: message.modelConfig } : {}),
          }),
        });
        let run;
        if (command === 'start') {
          run = harness.start(payload);
        } else if (command === 'publish') {
          run = harness.publish(String(payload.runId || ''));
        } else if (command === 'resume') {
          run = harness.resume(String(payload.runId || ''), String(payload.answer || ''));
        } else {
          throw new Error(`unknown generation worker command: ${command}`);
        }
        activeRunId = run.id;
        await sendToParent({ type: 'response', requestId, ok: true, runId: run.id });
        const finished = await harness.wait(run.id);
        process.stderr.write(
          `[HarnessWorker] run=${run.id} finished status=${finished?.status || 'unknown'} ${formatWorkerMemory()}\n`,
        );
        await modelSession.close();
        await sendToParent({ type: 'finished', runId: run.id, status: finished?.status || '' });
        disconnectNormally();
      } catch (error) {
        await modelSession.close();
        await sendToParent({
          type: 'response',
          requestId,
          ok: false,
          error: error?.message || String(error),
          code: error?.code || 'GENERATION_WORKER_REQUEST_FAILED',
        });
        disconnectNormally();
      }
    })();
  });

  process.on('disconnect', () => {
    rejectPendingExtensionRequests('Bridge IPC channel disconnected');
    void modelSession.close();
    if (!disconnectingNormally && activeRunId && harness) {
      try { harness.cancel(activeRunId, 'Bridge IPC channel disconnected'); } catch {}
    }
  });
}
