import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GENERATION_BUDGET,
  GENERATION_STATUSES,
  GENERATION_TRANSITIONS,
  TERMINAL_GENERATION_STATUSES,
} from './constants.js';
import {
  GenerationBudgetExceededError,
  GenerationCancelledError,
  GenerationHarnessError,
} from './errors.js';
import { sanitizeGenerationValue } from './run-store.js';

function normalizeBudget(budget = {}) {
  const result = { ...DEFAULT_GENERATION_BUDGET };
  for (const key of Object.keys(result)) {
    const value = Number(budget[key]);
    if (Number.isFinite(value) && value > 0) result[key] = Math.floor(value);
  }
  return result;
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name || 'Error',
    code: error.code || 'GENERATION_FAILED',
    message: error.message || String(error),
    details: error.details,
    stack: error.stack,
  };
}

export class GenerationRun {
  static create({ store, id = randomUUID(), siteKey, goal, input = {}, budget = {}, onEvent = null }) {
    const now = new Date().toISOString();
    return new GenerationRun({
      store,
      onEvent,
      snapshot: {
        id,
        siteKey: String(siteKey || '').trim(),
        goal: String(goal || '').trim(),
        status: GENERATION_STATUSES.CREATED,
        currentAction: '',
        stepCount: 0,
        modelCallCount: 0,
        revisionCount: 0,
        budget: normalizeBudget(budget),
        input,
        result: null,
        artifacts: {},
        lastError: null,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
      },
    });
  }

  static restore({ store, snapshot, onEvent = null }) {
    return new GenerationRun({ store, snapshot, onEvent, initialize: false });
  }

  constructor({ store, snapshot, onEvent = null, initialize = true }) {
    if (!store) throw new Error('GenerationRun requires a store');
    this.store = store;
    this.snapshot = structuredClone(snapshot);
    this.onEvent = onEvent;
    if (initialize) {
      this.store.save(this.snapshot);
      this.trace('run_created', { siteKey: this.snapshot.siteKey, goal: this.snapshot.goal });
    }
  }

  get id() {
    return this.snapshot.id;
  }

  get status() {
    return this.snapshot.status;
  }

  isTerminal() {
    return TERMINAL_GENERATION_STATUSES.has(this.status);
  }

  assertNotCancelled(signal) {
    if (signal?.aborted || this.status === GENERATION_STATUSES.CANCELLED) {
      throw new GenerationCancelledError();
    }
  }

  assertWithinBudget() {
    const elapsedMs = Date.now() - Date.parse(this.snapshot.startedAt) - (this.snapshot.pausedDurationMs || 0);
    const checks = [
      ['maxSteps', this.snapshot.stepCount],
      ['maxModelCalls', this.snapshot.modelCallCount],
      ['maxRevisions', this.snapshot.revisionCount],
      ['maxDurationMs', elapsedMs],
    ];
    for (const [metric, actual] of checks) {
      const limit = this.snapshot.budget[metric];
      if (actual > limit) throw new GenerationBudgetExceededError(metric, limit, actual);
    }
  }

  transition(nextStatus, data = {}) {
    if (nextStatus === this.status) return this.toJSON();
    const allowed = GENERATION_TRANSITIONS[this.status];
    if (!allowed?.has(nextStatus)) {
      throw new GenerationHarnessError(
        `invalid generation state transition: ${this.status} -> ${nextStatus}`,
        'INVALID_GENERATION_TRANSITION',
        { from: this.status, to: nextStatus },
      );
    }
    const previousStatus = this.status;
    if (previousStatus === GENERATION_STATUSES.NEEDS_USER_INPUT) {
      const pausedAt = Date.parse(this.snapshot.completedAt || this.snapshot.updatedAt);
      if (Number.isFinite(pausedAt)) {
        this.snapshot.pausedDurationMs = (this.snapshot.pausedDurationMs || 0) + Math.max(0, Date.now() - pausedAt);
      }
      this.snapshot.completedAt = null;
    }
    this.snapshot.status = nextStatus;
    this.snapshot.currentAction = String(data.currentAction || '');
    if (TERMINAL_GENERATION_STATUSES.has(nextStatus)) {
      this.snapshot.completedAt = new Date().toISOString();
    }
    this.persist();
    this.trace('state_changed', { from: previousStatus, to: nextStatus, ...data });
    return this.toJSON();
  }

  recordStep(action, data = {}) {
    this.snapshot.stepCount += 1;
    this.snapshot.currentAction = String(action || '');
    this.assertWithinBudget();
    this.persist();
    this.trace('step_recorded', { action, stepCount: this.snapshot.stepCount, ...data });
  }

  recordModelCall(data = {}) {
    this.snapshot.modelCallCount += 1;
    this.assertWithinBudget();
    this.persist();
    this.trace('model_called', { modelCallCount: this.snapshot.modelCallCount, ...data });
  }

  recordRevision(data = {}) {
    this.snapshot.revisionCount += 1;
    this.assertWithinBudget();
    this.persist();
    this.trace('revision_recorded', { revisionCount: this.snapshot.revisionCount, ...data });
  }

  setArtifact(name, value) {
    this.snapshot.artifacts[String(name)] = value;
    this.persist();
    this.trace('artifact_updated', { name, value });
  }

  setResult(result) {
    this.snapshot.result = result;
    this.persist();
    this.trace('result_updated', { result });
  }

  complete(result) {
    this.setResult(result);
    return this.transition(GENERATION_STATUSES.COMPLETED, { result });
  }

  fail(error, status = GENERATION_STATUSES.FAILED) {
    if (this.isTerminal()) return this.toJSON();
    this.snapshot.lastError = serializeError(error);
    this.persist();
    return this.transition(status, { error: this.snapshot.lastError });
  }

  cancel(reason = 'cancelled by user') {
    if (this.isTerminal()) return this.toJSON();
    this.snapshot.lastError = serializeError(new GenerationCancelledError(reason));
    this.persist();
    return this.transition(GENERATION_STATUSES.CANCELLED, { reason });
  }

  trace(type, data = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      runId: this.id,
      type,
      data,
    };
    this.store.appendTrace(this.id, event);
    this.onEvent?.(event, this.toJSON());
    return event;
  }

  persist() {
    this.snapshot.updatedAt = new Date().toISOString();
    this.store.save(this.snapshot);
  }

  toJSON() {
    return structuredClone(sanitizeGenerationValue(this.snapshot));
  }
}
