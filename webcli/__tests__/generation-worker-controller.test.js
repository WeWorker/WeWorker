import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationWorkerController } from '../generation-worker-controller.js';
import {
  GENERATION_STATUSES,
  GenerationRun,
  GenerationRunStore,
} from '../generation-harness/index.js';

const tmpDirs = [];
const workerSessions = new Set();
const fixtureScript = path.resolve(import.meta.dirname, 'fixtures', 'generation-worker-fixture.js');

function createController(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-generation-controller-'));
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-generation-reports-'));
  tmpDirs.push(rootDir, reportDir);
  const store = new GenerationRunStore({ rootDir });
  const requestExtension = options.requestExtension || vi.fn(async () => ({ passed: true }));
  const controller = new GenerationWorkerController({
    store,
    requestExtension,
    workerScript: fixtureScript,
    reportDir,
  });
  const setWorker = controller.activeWorkers.set.bind(controller.activeWorkers);
  vi.spyOn(controller.activeWorkers, 'set').mockImplementation((runId, session) => {
    workerSessions.add(session);
    return setWorker(runId, session);
  });
  return { store, requestExtension, controller };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
}

afterEach(async () => {
  await Promise.all([...workerSessions].map(async (session) => {
    const timeout = setTimeout(() => {
      session.cancelRequested = true;
      session.child.kill();
    }, 2_000);
    try {
      await session.closedSignal.promise;
    } finally {
      clearTimeout(timeout);
    }
  }));
  workerSessions.clear();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('GenerationWorkerController', () => {
  it('runs generation in a child and proxies extension validation requests', async () => {
    const requestExtension = vi.fn(async () => ({ passed: true, tools: [] }));
    const { controller } = createController({ requestExtension });
    const started = await controller.start({
      siteKey: 'example.test',
      goal: 'generate tools',
      input: { fixtureMode: 'extension' },
    });
    const awaiting = await waitFor(() => {
      const run = controller.get(started.id);
      return run?.status === GENERATION_STATUSES.AWAITING_APPROVAL ? run : null;
    });

    expect(awaiting.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(awaiting.input).toEqual({ tabId: null });
    expect(awaiting.result).toBeNull();
    expect(awaiting.artifacts).not.toHaveProperty('draftHistory');
    expect(requestExtension).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'validate_generation_preview', fixture: true }),
      5_000,
    );
  });

  it('turns a worker crash into a persisted run failure without exiting the controller', async () => {
    const { controller } = createController();
    const started = await controller.start({
      siteKey: 'example.test',
      goal: 'generate tools',
      input: { fixtureMode: 'crash' },
    });
    const failed = await waitFor(() => {
      const run = controller.get(started.id);
      return run?.status === GENERATION_STATUSES.FAILED ? run : null;
    });

    expect(failed.lastError.code).toBe('GENERATION_WORKER_CRASHED');
    expect(failed.lastError.message).toContain('0x00000009');
    expect(controller.get(started.id).status).toBe(GENERATION_STATUSES.FAILED);

    const next = await controller.start({
      siteKey: 'example.test',
      goal: 'generate again after worker crash',
      input: {},
    });
    const nextAwaiting = await waitFor(() => {
      const run = controller.get(next.id);
      return run?.status === GENERATION_STATUSES.AWAITING_APPROVAL ? run : null;
    });
    expect(nextAwaiting.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
  });

  it('returns a failed run even when the worker crashes before acknowledging start', async () => {
    const { controller } = createController();
    const failed = await controller.start({
      siteKey: 'example.test',
      goal: 'crash before start response',
      input: { fixtureMode: 'crashBeforeResponse' },
    });

    expect(failed.status).toBe(GENERATION_STATUSES.FAILED);
    expect(failed.lastError.code).toBe('GENERATION_WORKER_CRASHED');
    expect(failed.lastError.message).toContain('0x0000000a');
  });

  it('cancels an active worker and persists cancellation', async () => {
    const { controller } = createController();
    const started = await controller.start({
      siteKey: 'example.test',
      goal: 'generate tools',
      input: { fixtureMode: 'hang' },
    });
    const cancelled = await controller.cancel(started.id, 'cancelled in test');

    expect(cancelled.status).toBe(GENERATION_STATUSES.CANCELLED);
    expect(cancelled.lastError.message).toBe('cancelled in test');
  });

  it('publishes an awaiting run in a fresh worker', async () => {
    const { controller, store } = createController();
    const run = GenerationRun.create({ store, siteKey: 'example.test', goal: 'publish tools' });
    transitionToAwaitingApproval(run);

    const published = await controller.publish(run.id);

    expect(published.status).toBe(GENERATION_STATUSES.COMPLETED);
    expect(published.result).toEqual({ published: true });
  });
});

function transitionToAwaitingApproval(run) {
  run.transition(GENERATION_STATUSES.CONTEXT_READY);
  run.transition(GENERATION_STATUSES.PLANNING);
  run.transition(GENERATION_STATUSES.DRAFTING);
  run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
  run.transition(GENERATION_STATUSES.AWAITING_APPROVAL);
}
