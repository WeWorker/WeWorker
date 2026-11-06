import { createHash, randomUUID } from 'node:crypto';
import { normalizeHostArguments } from './host-cli-arguments.js';

export const CONFIRMATION_TTL_MS = 5 * 60_000;
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const needsConfirmation = command => Boolean(command.pageWrite || command.uiWrite || (command.requires_confirmation ?? command.safety === 'write'));
export const isControlled = command => command?.safety === 'write' || needsConfirmation(command || {});

// This object capability never crosses a process boundary. Wire booleans, IDs,
// environment variables and model-authored "confirmation" objects cannot mint it.
const permits = new WeakMap();
const preflightErrors = new WeakSet();
export function markHostPreflightError(error) { preflightErrors.add(error); return error; }
export function hasExecutionPermit(permit, selected, args) {
  const entry = permit && permits.get(permit);
  return Boolean(entry && entry.active && entry.binding === requestBinding(selected, args));
}
export function requestBinding(selected, args) {
  const business = { ...args }; delete business.__confirmed;
  return fingerprint({ snapshot: selected.snapshot, command: selected.command, args: business });
}
export function businessArguments(args, command) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('WRITE_INVALID_ARGUMENT', 'not_submitted', 'Tool arguments must be an object.');
  const clean = structuredClone(args);
  delete clean.__confirmed; // All legacy spellings are inert, including strings and bare flags.
  const result = normalizeHostArguments(clean, command.schema || { type: 'object' });
  delete result.__confirmed;
  for (const key of command.schema?.required || []) {
    if (key === '__confirmed') continue;
    if (result[key] === undefined || result[key] === null || result[key] === '') throw failure('WRITE_INVALID_ARGUMENT', 'not_submitted', 'Required business arguments are missing.');
  }
  if (command.schema?.additionalProperties === false && Object.keys(result).some(key => !Object.hasOwn(command.schema.properties || {}, key) && key !== 'dry-run')) {
    throw failure('WRITE_INVALID_ARGUMENT', 'not_submitted', 'Unknown business argument. Review the tool help.');
  }
  return result;
}
export function failure(code, state, message, requestId) {
  return Object.assign(new Error(message), { code, execution: { state, requestId, dispatched: state === 'unknown', retryable: state === 'not_submitted' } });
}

/** Ephemeral reviewed requests; no restored pending requests or durable grants. */
export class WriteConfirmationCoordinator {
  constructor({ confirm, now = Date.now, ttlMs = CONFIRMATION_TTL_MS, maxRecords = 256 } = {}) {
    this.confirm = confirm; this.now = now; this.ttlMs = ttlMs; this.maxRecords = maxRecords;
    this.records = new Map();
  }

  run({ selected, args, scope, context, resolve, execute, signal, notify = () => {} }) {
    args = businessArguments(args, selected.command);
    const binding = requestBinding(selected, args), key = fingerprint({ binding, scope });
    for (const [id, record] of this.records) {
      if (record.settled && record.state !== 'unknown' && record.expiresAt <= this.now()) this.records.delete(id);
    }
    const previous = this.records.get(key);
    if (previous) {
      notify({ ...previous.status, deduplicated: true });
      previous.listeners.add(notify);
      return previous.promise.then(async result => {
        if (previous.account !== await context()) throw failure('WRITE_CONTEXT_CHANGED', 'not_submitted', 'Account context changed. The retained result belongs to the earlier account.');
        return result;
      }).finally(() => previous.listeners.delete(notify));
    }
    if (this.records.size >= this.maxRecords) throw failure('WRITE_QUEUE_FULL', 'not_submitted', 'Too many retained write requests; inspect pending or unknown results.');
    const record = { requestId: randomUUID(), expiresAt: this.now() + this.ttlMs, state: 'not_submitted', settled: false, listeners: new Set([notify]) };
    this.records.set(key, record); // Reserve synchronously, before any await.
    const update = state => {
      record.state = state;
      record.status = { requestId: record.requestId, state, expiresAt: record.expiresAt, dispatched: Boolean(record.dispatched), retryable: state === 'not_submitted' };
      for (const listener of record.listeners) listener(record.status);
    };
    record.promise = (async () => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, this.ttlMs); timer.unref?.();
      let permit;
      const check = () => {
        if (this.now() >= record.expiresAt) throw failure('WRITE_CONFIRMATION_EXPIRED', 'not_submitted', 'Confirmation expired. Nothing was submitted.', record.requestId);
        if (signal?.aborted || controller.signal.aborted) throw failure('WRITE_CANCELLED', 'cancelled', 'Operation cancelled before submission.', record.requestId);
        if (requestBinding(resolve(), args) !== binding) throw failure('WRITE_CONTEXT_CHANGED', 'not_submitted', 'Adapter or parameters changed. Start a new reviewed request.', record.requestId);
      };
      try {
        check();
        const account = await context(); record.account = account; check();
        if (needsConfirmation(selected.command)) {
          if (!this.confirm) throw failure('WRITE_CONFIRMATION_UNAVAILABLE', 'not_submitted', 'Open WeWorker and use its host confirmation window. This standalone host has no trusted confirmation interface.', record.requestId);
          update('waiting_confirmation');
          const approved = await this.confirm({ requestId: record.requestId, expiresAt: record.expiresAt,
            tool: `${selected.snapshot.name}.${selected.command.id}`, adapter: selected.snapshot,
            args: structuredClone(args), scope }, controller.signal);
          check();
          if (approved !== true) throw failure('WRITE_CANCELLED', 'cancelled', 'Operation cancelled. Nothing was submitted.', record.requestId);
        }
        check();
        if (account !== await context()) throw failure('WRITE_CONTEXT_CHANGED', 'not_submitted', 'Account or browser context changed. Nothing was submitted.', record.requestId);
        check();
        permit = Object.freeze({}); permits.set(permit, { binding, active: true });
        // No reusable "approved" state: consume and continue this exact closure.
        update('not_submitted');
        const markDispatched = () => {
          check();
          if (record.dispatched) throw failure('WRITE_ALREADY_DISPATCHED', 'unknown', 'Request already dispatched; inspect its result.', record.requestId);
          record.dispatched = true; update('running');
        };
        const result = await execute({ args: structuredClone(args), permit, account, signal: controller.signal, markDispatched });
        if (controller.signal.aborted && record.dispatched) throw failure('WRITE_OUTCOME_UNKNOWN', 'unknown', 'Submission outcome is unknown. Query the target state before any new write.', record.requestId);
        update(result?.ok === false || result?.success === false || result?.error ? 'failed' : 'succeeded');
        return { result, execution: { ...record.status } };
      } catch (error) {
        if (preflightErrors.has(error)) record.dispatched = false;
        const state = record.dispatched ? 'unknown' : (error.execution?.state || 'not_submitted');
        update(state);
        if (record.dispatched) throw failure('WRITE_OUTCOME_UNKNOWN', 'unknown', 'Submission outcome is unknown. Query the target state before any new write.', record.requestId);
        error.execution = { ...record.status };
        throw error;
      } finally {
        if (permit) permits.get(permit).active = false;
        record.settled = true; record.listeners.clear(); clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      }
    })();
    return record.promise;
  }
}
