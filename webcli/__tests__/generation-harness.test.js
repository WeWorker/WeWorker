import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERATION_STATUSES,
  GenerationHarness,
  GenerationRun,
  GenerationRunStore,
} from '../generation-harness/index.js';

const tmpDirs = [];

function createStore() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcli-generation-harness-'));
  tmpDirs.push(rootDir);
  return new GenerationRunStore({ rootDir });
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('GenerationHarness', () => {
  it('runs a workflow and persists the completed result', async () => {
    const harness = new GenerationHarness({
      store: createStore(),
      workflow: async ({ run }) => {
        run.transition(GENERATION_STATUSES.CONTEXT_READY);
        run.transition(GENERATION_STATUSES.PLANNING);
        run.recordStep('create_plan');
        run.transition(GENERATION_STATUSES.DRAFTING);
        run.setArtifact('draftDir', '/tmp/draft');
        run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
        run.transition(GENERATION_STATUSES.AWAITING_APPROVAL);
        run.transition(GENERATION_STATUSES.PUBLISHING);
        return { toolNames: ['example.test.search_records'] };
      },
    });

    const started = harness.start({
      siteKey: 'example.test',
      goal: 'generate query tools',
    });
    const completed = await harness.wait(started.id);

    expect(completed.status).toBe(GENERATION_STATUSES.COMPLETED);
    expect(completed.result.toolNames).toEqual(['example.test.search_records']);
    expect(harness.getTrace(started.id).some((event) => event.type === 'state_changed')).toBe(true);
  });

  it('cancels an active workflow', async () => {
    const harness = new GenerationHarness({
      store: createStore(),
      workflow: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    });

    const started = harness.start({ siteKey: 'example.test', goal: 'generate query tools' });
    harness.cancel(started.id);
    const cancelled = await harness.wait(started.id);
    expect(cancelled.status).toBe(GENERATION_STATUSES.CANCELLED);
  });

  it('resumes an awaiting-approval run through the publisher', async () => {
    const published = [];
    const harness = new GenerationHarness({
      store: createStore(),
      workflow: async ({ run }) => {
        run.transition(GENERATION_STATUSES.CONTEXT_READY);
        run.transition(GENERATION_STATUSES.PLANNING);
        run.transition(GENERATION_STATUSES.DRAFTING);
        run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
        run.transition(GENERATION_STATUSES.AWAITING_APPROVAL);
        return { pause: true, draftReady: true };
      },
      publisher: async ({ run }) => {
        published.push(run.id);
        return { adapterDir: '/tmp/published-adapter' };
      },
    });

    const started = harness.start({ siteKey: 'example.test', goal: 'generate query tools' });
    const awaiting = await harness.wait(started.id);
    expect(awaiting.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);

    harness.publish(started.id);
    const completed = await harness.wait(started.id);
    expect(completed.status).toBe(GENERATION_STATUSES.COMPLETED);
    expect(completed.result.adapterDir).toBe('[path-redacted]');
    expect(JSON.stringify(completed)).not.toContain('/tmp/published-adapter');
    expect(published).toEqual([started.id]);
  });

  it('can cancel an active publisher', async () => {
    const store = createStore();
    const harness = new GenerationHarness({
      store,
      workflow: async ({ run }) => {
        run.transition(GENERATION_STATUSES.CONTEXT_READY);
        run.transition(GENERATION_STATUSES.PLANNING);
        run.transition(GENERATION_STATUSES.DRAFTING);
        run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
        run.transition(GENERATION_STATUSES.AWAITING_APPROVAL);
        return { pause: true };
      },
      publisher: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    });
    const started = harness.start({ siteKey: 'example.test', goal: 'publish tools' });
    await harness.wait(started.id);

    harness.publish(started.id);
    const cancelled = harness.cancel(started.id, 'cancel publishing');
    await harness.wait(started.id);

    expect(cancelled.status).toBe(GENERATION_STATUSES.CANCELLED);
    expect(store.load(started.id).status).toBe(GENERATION_STATUSES.CANCELLED);
  });

  it('marks a persisted in-progress run as interrupted after its worker disappears', () => {
    const store = createStore();
    const orphan = GenerationRun.create({ store, siteKey: 'example.test', goal: 'generate query tools' });
    orphan.transition(GENERATION_STATUSES.CONTEXT_READY);
    orphan.transition(GENERATION_STATUSES.PLANNING);

    const restartedHarness = new GenerationHarness({ store, workflow: async () => ({}) });
    const reconciled = restartedHarness.get(orphan.id);

    expect(reconciled.status).toBe(GENERATION_STATUSES.FAILED);
    expect(reconciled.lastError.code).toBe('GENERATION_RUN_INTERRUPTED');
    expect(store.load(orphan.id).status).toBe(GENERATION_STATUSES.FAILED);
  });

  it('can cancel a persisted run that is no longer active in memory', () => {
    const store = createStore();
    const orphan = GenerationRun.create({ store, siteKey: 'example.test', goal: 'generate query tools' });
    orphan.transition(GENERATION_STATUSES.CONTEXT_READY);
    orphan.transition(GENERATION_STATUSES.PLANNING);

    const restartedHarness = new GenerationHarness({ store, workflow: async () => ({}) });
    const cancelled = restartedHarness.cancel(orphan.id, 'cancelled after reopen');

    expect(cancelled.status).toBe(GENERATION_STATUSES.CANCELLED);
    expect(cancelled.lastError.code).toBe('GENERATION_CANCELLED');
    expect(store.load(orphan.id).status).toBe(GENERATION_STATUSES.CANCELLED);
  });

  it('keeps an awaiting-approval run restorable across Bridge restarts', async () => {
    const store = createStore();
    const harness = new GenerationHarness({
      store,
      workflow: async ({ run }) => {
        run.transition(GENERATION_STATUSES.CONTEXT_READY);
        run.transition(GENERATION_STATUSES.PLANNING);
        run.transition(GENERATION_STATUSES.DRAFTING);
        run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
        run.transition(GENERATION_STATUSES.AWAITING_APPROVAL);
        return { pause: true };
      },
    });
    const started = harness.start({ siteKey: 'example.test', goal: 'generate query tools' });
    await harness.wait(started.id);

    const restartedHarness = new GenerationHarness({ store, workflow: async () => ({}) });
    expect(restartedHarness.get(started.id).status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
  });

  it('does not let a failing event observer abort generation', async () => {
    const store = createStore();
    const harness = new GenerationHarness({
      store,
      workflow: async ({ run }) => {
        run.transition(GENERATION_STATUSES.CONTEXT_READY);
        run.transition(GENERATION_STATUSES.PLANNING);
        run.transition(GENERATION_STATUSES.DRAFTING);
        run.transition(GENERATION_STATUSES.STATIC_VALIDATING);
        run.transition(GENERATION_STATUSES.AWAITING_APPROVAL);
        return { pause: true, ok: true };
      },
    });
    harness.on('event', () => {
      throw new Error('websocket observer failed');
    });

    const started = harness.start({ siteKey: 'example.test', goal: 'generate query tools' });
    const completed = await harness.wait(started.id);

    expect(completed.status).toBe(GENERATION_STATUSES.AWAITING_APPROVAL);
    expect(completed.result).toEqual({ pause: true, ok: true });
  });
});
