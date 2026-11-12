import { expect, it, vi } from 'vitest';
import { newState, beginRound, commitRound } from '../context-model.js';
import { runContextCall } from '../context-command.js';

function fixture() {
  const state = newState(1000), persisted = [];
  const store = { now: () => state.lastInteractionAt + 1, transaction: async (_id, fn) => fn(state, {
    persist: async () => persisted.push(JSON.parse(JSON.stringify(state))),
  }) };
  const catalog = { entries: [{ name: 'example.edit', safety: 'write' }], tools: {}, resultBindings: new Map() };
  const call = (args, invoke, controls = {}) => runContextCall({ id: 'session', tool: 'example.edit', args, invoke, ...controls }, { store, catalog });
  return { state, persisted, call };
}

it('persists dispatch before invoking an arbitrary-ID write and preserves business flags', async () => {
  const f = fixture(), args = { key: 'record-A', yes: false, confirm: 'business-value', execute: false, nested: { __confirmed: 'business' } };
  const invoke = vi.fn(async (_tool, actual) => {
    expect(actual).toEqual(args);
    expect(f.persisted.at(-1).operationGuards[0].status).toBe('dispatching');
    return { raw: { ok: true }, exitCode: 0 };
  });
  const result = await f.call({ ...args, __confirmed: true }, invoke);
  expect(result.receipt.toolOutcome).toBe('acknowledged');
  await expect(f.call(args, invoke)).rejects.toThrow('context_operation_unresolved');
  expect(invoke).toHaveBeenCalledOnce();
});

it.each(['throw', 'failure'])('an unknown %s outcome blocks changed arguments after another round', async mode => {
  const f = fixture(), invoke = vi.fn(async () => {
    if (mode === 'throw') throw new Error('Lost response');
    return { raw: { error: 'Lost response' }, exitCode: 1 };
  });
  expect((await f.call({ attachmentName: 'example.pdf' }, invoke)).receipt.toolOutcome).toBe('unknown');
  beginRound(f.state, 'Fresh request', 1002); commitRound(f.state);
  await expect(f.call({ attachmentName: 'other.pdf' }, invoke)).rejects.toThrow('context_operation_unresolved');
  expect(invoke).toHaveBeenCalledOnce();
});

it('a proven failure before dispatch can be retried', async () => {
  const f = fixture(), invoke = vi.fn()
    .mockResolvedValueOnce({ raw: { error: 'Not sent' }, exitCode: 1, dispatched: false })
    .mockResolvedValueOnce({ raw: { ok: true }, exitCode: 0 });
  expect((await f.call({ value: 7 }, invoke)).receipt.toolOutcome).toBe('failed');
  expect((await f.call({ value: 7 }, invoke)).receipt.toolOutcome).toBe('acknowledged');
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('changed prepared arguments are rejected before dispatch and completed steps cannot replay', async () => {
  const f = fixture();
  beginRound(f.state, 'Explicit edit', 1001); const roundId = f.state.activeRound.roundId; commitRound(f.state);
  f.state.preparedDecision = { decisionId: 'decision', roundId, executionEligibility: 'write_allowed', steps: [
    { stepId: 's1', tool: 'example.edit', args: { key: 'A', yes: false } },
  ] };
  const invoke = vi.fn(async () => ({ raw: { ok: true }, exitCode: 0 })), controls = { decision: 'decision', step: 's1' };
  await expect(f.call({ key: 'B', yes: false }, invoke, controls)).rejects.toThrow('context_stale_step');
  expect(invoke).not.toHaveBeenCalled();
  expect((await f.call({ key: 'A', yes: false }, invoke, controls)).receipt.toolOutcome).toBe('acknowledged');
  await expect(f.call({ key: 'A', yes: false }, invoke, controls)).rejects.toThrow('context_stale_step');
  expect(invoke).toHaveBeenCalledOnce();
});
