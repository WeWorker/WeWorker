import { EventEmitter } from 'node:events';
import { GENERATION_STATUSES, TERMINAL_GENERATION_STATUSES } from './constants.js';
import { GenerationRun } from './generation-run.js';
import { GenerationBudgetExceededError, isAbortLikeError } from './errors.js';
import { GenerationRunStore, sanitizeGenerationValue } from './run-store.js';

const INTERRUPTIBLE_PERSISTED_STATUSES = new Set([
  GENERATION_STATUSES.CREATED,
  GENERATION_STATUSES.CONTEXT_READY,
  GENERATION_STATUSES.PLANNING,
  GENERATION_STATUSES.DRAFTING,
  GENERATION_STATUSES.STATIC_VALIDATING,
  GENERATION_STATUSES.REVISING,
  GENERATION_STATUSES.RUNTIME_VALIDATING,
  GENERATION_STATUSES.PUBLISHING,
]);

export class GenerationHarness extends EventEmitter {
  constructor({ store = new GenerationRunStore(), workflow, resumeWorkflow = null, publisher = null }) {
    super();
    if (typeof workflow !== 'function') throw new Error('GenerationHarness requires a workflow function');
    this.store = store;
    this.workflow = workflow;
    this.resumeWorkflow = resumeWorkflow;
    this.publisher = publisher;
    this.activeRuns = new Map();
  }

  start({ runId, siteKey, goal, input = {}, budget = {} }) {
    if (!String(siteKey || '').trim()) throw new Error('siteKey is required');
    if (!String(goal || '').trim()) throw new Error('goal is required');

    const run = GenerationRun.create({
      store: this.store,
      id: runId,
      siteKey,
      goal,
      input,
      budget,
      onEvent: (event, snapshot) => {
        this.#emitRunEvent(event, snapshot);
      },
    });
    const abortController = new AbortController();
    const promise = this.#execute(run, abortController.signal);
    this.activeRuns.set(run.id, { run, abortController, promise });
    void promise.then(
      () => this.activeRuns.delete(run.id),
      () => this.activeRuns.delete(run.id),
    );
    return run.toJSON();
  }

  get(runId) {
    const active = this.activeRuns.get(runId);
    if (active) return active.run.toJSON();
    const snapshot = this.store.load(runId);
    if (!snapshot) return null;
    if (!INTERRUPTIBLE_PERSISTED_STATUSES.has(snapshot.status)) {
      return sanitizeGenerationValue(snapshot, { rootDir: this.store.rootDir });
    }

    const run = this.#restoreRun(snapshot);
    const error = new Error('generation run was interrupted because its Harness worker is no longer running');
    error.code = 'GENERATION_RUN_INTERRUPTED';
    return run.fail(error);
  }

  getTrace(runId) {
    return this.store.readTrace(runId);
  }

  cancel(runId, reason = 'cancelled by user') {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.abortController.abort(reason);
      return active.run.cancel(reason);
    }
    const snapshot = this.store.load(runId);
    if (!snapshot) return null;
    if (TERMINAL_GENERATION_STATUSES.has(snapshot.status)) {
      return sanitizeGenerationValue(snapshot, { rootDir: this.store.rootDir });
    }
    return this.#restoreRun(snapshot).cancel(reason);
  }

  async wait(runId) {
    const active = this.activeRuns.get(runId);
    if (active) await active.promise;
    return this.get(runId);
  }

  publish(runId) {
    if (typeof this.publisher !== 'function') throw new Error('generation harness publisher is not configured');
    if (this.activeRuns.has(runId)) throw new Error(`generation run is still active: ${runId}`);
    const snapshot = this.store.load(runId);
    if (!snapshot) throw new Error(`generation run not found: ${runId}`);
    if (snapshot.status !== GENERATION_STATUSES.AWAITING_APPROVAL) {
      throw new Error(`generation run is not awaiting approval: ${snapshot.status}`);
    }
    const run = this.#restoreRun(snapshot);
    const abortController = new AbortController();
    const promise = this.#publish(run, abortController.signal);
    this.activeRuns.set(run.id, { run, abortController, promise });
    void promise.then(
      () => this.activeRuns.delete(run.id),
      () => this.activeRuns.delete(run.id),
    );
    return run.toJSON();
  }

  async resume(runId, answer) {
    if (typeof this.resumeWorkflow !== 'function') throw new Error('generation harness resume workflow is not configured');
    const snapshot = this.store.load(runId);
    if (!snapshot) throw new Error(`generation run not found: ${runId}`);
    if (snapshot.status !== GENERATION_STATUSES.NEEDS_USER_INPUT) {
      throw new Error(`generation run is not awaiting user input: ${snapshot.status}`);
    }
    const run = this.#restoreRun(snapshot);
    run.snapshot.completedAt = null;
    const abortController = new AbortController();
    const promise = this.#executeResume(run, abortController.signal, answer);
    this.activeRuns.set(run.id, { run, abortController, promise });
    void promise.then(
      () => this.activeRuns.delete(run.id),
      () => this.activeRuns.delete(run.id),
    );
    return run.toJSON();
  }

  async #executeResume(run, signal, answer) {
    try {
      const result = await this.resumeWorkflow({ run, signal, store: this.store, answer });
      if (result?.pause) {
        run.setResult(result);
      } else if (!run.isTerminal()) {
        run.complete(result);
      }
    } catch (error) {
      if (run.isTerminal()) return;
      if (isAbortLikeError(error) || signal.aborted) {
        run.cancel(signal.reason || error?.message || 'cancelled');
      } else if (error instanceof GenerationBudgetExceededError) {
        run.fail(error, GENERATION_STATUSES.BUDGET_EXCEEDED);
      } else {
        run.fail(error);
      }
    }
  }

  async #execute(run, signal) {
    try {
      const result = await this.workflow({ run, signal, store: this.store });
      if (result?.pause) {
        run.setResult(result);
      } else if (!run.isTerminal()) {
        run.complete(result);
      }
    } catch (error) {
      if (run.isTerminal()) return;
      if (isAbortLikeError(error) || signal.aborted) {
        run.cancel(signal.reason || error?.message || 'cancelled');
      } else if (error instanceof GenerationBudgetExceededError) {
        run.fail(error, GENERATION_STATUSES.BUDGET_EXCEEDED);
      } else {
        run.fail(error);
      }
    }
  }

  #restoreRun(snapshot) {
    return GenerationRun.restore({
      store: this.store,
      snapshot,
      onEvent: (event, nextSnapshot) => {
        this.#emitRunEvent(event, nextSnapshot);
      },
    });
  }

  #emitRunEvent(event, snapshot) {
    try {
      this.emit('event', event, snapshot);
      this.emit(event.type, event, snapshot);
    } catch {
      // Observers are diagnostic/UI integrations and must never fail a run.
    }
  }

  async #publish(run, signal) {
    try {
      run.assertNotCancelled(signal);
      run.transition(GENERATION_STATUSES.PUBLISHING, { currentAction: 'publish_adapter' });
      const result = await this.publisher({ run, signal, store: this.store });
      run.complete(result);
    } catch (error) {
      if (run.isTerminal()) return;
      if (isAbortLikeError(error) || signal.aborted) run.cancel(signal.reason || error?.message || 'cancelled');
      else run.fail(error);
    }
  }
}
