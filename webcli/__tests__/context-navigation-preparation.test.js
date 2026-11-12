import { expect, it, vi } from 'vitest';
import { createHostAdapterRuntime } from '../../extension/background/host-adapter-runtime.js';
import { runContextCall } from '../context-command.js';
import { newState, beginRound, commitRound } from '../context-model.js';

const url = 'https://example.com/items/A';
const manifest = { name: 'example.com', match: ['example.com'], commands: [{ id: 'edit', safety: 'write' }] };
function host(navigate = async () => url) {
  return createHostAdapterRuntime({ bundle: async () => [], prepare: async () => {}, clear: async () => {}, inject: async () => {}, navigate });
}
const navigation = extra => ({ __webcli_navigation: { version: 1, url, resume: false, result: { status: 'prepared' }, ...extra } });

it('reports explicit preparation only after successful host navigation, without replaying a write', async () => {
  const prepared = vi.fn(), operation = vi.fn(async () => navigation({ phase: 'prepare' }));
  const raw = await host().execute(7, manifest, 'https://example.com/', operation, { id: 'edit' }, null, { onPrepared: prepared });
  expect(raw).toEqual({ status: 'prepared' });
  expect(prepared).toHaveBeenCalledOnce(); expect(operation).toHaveBeenCalledOnce();
});
it('a business status or terminal navigation cannot claim preparation', async () => {
  const prepared = vi.fn();
  for (const raw of [{ status: 'prepared', prepared: true, dispatched: false }, navigation({})]) {
    await host().execute(7, manifest, url, async () => raw, { id: 'edit' }, null, { onPrepared: prepared });
  }
  expect(prepared).not.toHaveBeenCalled();
});
it.each([
  [{ phase: 'prepare', resume: true }, 'write'],
  [{ phase: 'prepare' }, 'read'],
  [{ phase: 'unknown' }, 'write'],
])('rejects invalid preparation control %j for %s', async (control, safety) => {
  const policy = { ...manifest, commands: [{ id: 'edit', safety }] }, navigate = vi.fn(async () => url);
  await expect(host(navigate).execute(7, policy, url, async () => navigation(control), { id: 'edit' })).rejects.toThrow(/preparation/i);
  expect(navigate).not.toHaveBeenCalled();
});
it('failed navigation cannot produce a safe-retry receipt', async () => {
  const prepared = vi.fn();
  await expect(host(async () => { throw new Error('navigation failed'); }).execute(7, manifest, url,
    async () => navigation({ phase: 'prepare' }), { id: 'edit' }, null, { onPrepared: prepared })).rejects.toThrow('navigation failed');
  expect(prepared).not.toHaveBeenCalled();
});

function session() {
  const state = newState(1000), args = { id: 'A', text: 'Example content' };
  beginRound(state, 'Edit A', 1000); const roundId = state.activeRound.roundId; commitRound(state);
  state.preparedDecision = { decisionId: 'decision', roundId, executionEligibility: 'write_allowed', steps: [
    { stepId: 'step', tool: 'example.com.edit', args },
  ] };
  const store = { now: () => 1001, transaction: async (_id, fn) => fn(state, { persist: async () => {} }) };
  const catalog = { entries: [{ name: 'example.com.edit', safety: 'write' }], tools: {}, resultBindings: new Map() };
  return { state, call: invoke => runContextCall({ id: 'fixture-session', tool: 'example.com.edit', args, decision: 'decision', step: 'step', invoke }, { store, catalog }) };
}
it.each(['preparation', 'pre-dispatch failure'])('keeps the same bound step callable after proven %s, then blocks actual replay', async mode => {
  const s = session(), invoke = vi.fn().mockResolvedValueOnce(mode === 'preparation'
    ? { raw: { status: 'prepared' }, exitCode: 0, dispatched: false, prepared: true }
    : { raw: { error: 'Not sent' }, exitCode: 1, dispatched: false })
    .mockResolvedValueOnce({ raw: { ok: true }, exitCode: 0, dispatched: true });
  const first = await s.call(invoke);
  expect(first.receipt.toolOutcome).toBe(mode === 'preparation' ? 'prepared' : 'failed');
  expect(first.receipt.retryDisposition).toBe('safe_to_retry_before_dispatch');
  expect(s.state.operationGuards[0].status).toBe('failed');
  expect(s.state.preparedDecision.steps[0].outcome).toBeUndefined();
  expect((await s.call(invoke)).receipt.toolOutcome).toBe('acknowledged');
  await expect(s.call(invoke)).rejects.toThrow('context_stale_step');
  expect(invoke).toHaveBeenCalledTimes(2);
});
it.each([false, true])('never releases a write from untrusted business preparation fields (inconsistent outer receipt=%s)', async outer => {
  const s = session(), invoke = vi.fn(async () => ({ raw: { status: 'prepared', prepared: true, dispatched: false },
    exitCode: 0, dispatched: true, ...(outer ? { prepared: true } : {}) }));
  expect((await s.call(invoke)).receipt.toolOutcome).toBe('unknown');
  expect(s.state.operationGuards[0].status).toBe('unknown');
  await expect(s.call(invoke)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledOnce();
});
