import { test } from 'vitest';
import assert from 'node:assert/strict';
import { invokeHostCli } from '../host-cli-runtime.js';
import { executeHostCli } from '../host-cli-provider.js';
import { authorizeHostCliWrite } from '../host-cli-write-authorization.js';
import { usesBackgroundExecution as hostBranch } from '../conditional-execution.js';
import { usesBackgroundExecution as extensionBranch } from '../../extension/background/conditional-execution.js';
import { readFileSync } from 'node:fs';

function fixture(overrides = {}) {
  const ws = {}, controller = new AbortController();
  const snapshot = { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' };
  const selected = { snapshot, adapter: { source: 'builtin' }, command: { id: 'list', safety: 'read', runtime: 'extension', execution: { type: 'api', runtime: 'background' } } };
  const pending = { ws, controller, hostCall: { toolName: 'example.com.list', snapshot } };
  const pendingRequests = new Map([['invocation', pending]]);
  const call = { parentId: 'invocation', ws, payload: { args: { product: 'one' } }, pendingRequests,
    resolveAdapterCall: () => selected, execute: async ({ args }) => args, credentials: async () => [], ...overrides };
  return { call, pending, selected, controller, pendingRequests };
}

test('only the host-resolved selected identity and command reach the provider', async () => {
  let context;
  const { call } = fixture({ execute: async value => { context = value; return { ok: true }; } });
  assert.deepEqual(await invokeHostCli(call), { ok: true });
  assert.deepEqual(context.adapter, { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' });
  assert.deepEqual(context.command, { id: 'list', safety: 'read' });
  assert.deepEqual(context.args, { product: 'one' });
});

test('rejects forged connections, extra authority fields and unknown or changed snapshots', async () => {
  let f = fixture();
  await assert.rejects(invokeHostCli({ ...f.call, ws: {} }), { code: 'HOST_CLI_CONTEXT_INVALID' });
  f = fixture();
  await assert.rejects(invokeHostCli({ ...f.call, payload: { args: {}, path: 'ignored' } }), { code: 'HOST_CLI_INVALID_ARGUMENT' });
  f = fixture(); f.selected.snapshot = { ...f.selected.snapshot, digest: 'b'.repeat(64) };
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_CONTEXT_INVALID' });
  f = fixture(); f.selected.adapter.source = 'user';
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_CONTEXT_INVALID' });
  f = fixture(); f.selected.command.safety = 'invalid';
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_CONTEXT_INVALID' });
});

test('reserves the invocation before executing, including when provider fails', async () => {
  let count = 0;
  const { call } = fixture({ execute: async () => { count++; throw new Error('failure'); } });
  await assert.rejects(invokeHostCli(call));
  await assert.rejects(invokeHostCli(call), { code: 'HOST_CLI_ALREADY_CALLED' });
  assert.equal(count, 1);
});

test('cancellation blocks late credentials and late results', async () => {
  let resolveCredentials, credentialCalled;
  const { call, controller } = fixture({
    credentials: () => new Promise(resolve => { resolveCredentials = resolve; }),
    execute: async ({ credentials }) => { credentialCalled = true; return credentials.cookies({ url: 'https://example.com', names: ['session'] }); },
  });
  const pending = invokeHostCli(call);
  assert.equal(credentialCalled, true);
  controller.abort();
  resolveCredentials([]);
  await assert.rejects(pending, { code: 'HOST_CLI_CONTEXT_INVALID' });
});

test('helper deadline aborts the provider and rejects late results', async () => {
  const { call, controller } = fixture({ timeoutMs: 10, execute: async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { late: true };
  } });
  // Keep the test process alive while the production deadline uses an unref timer.
  const guard = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(invokeHostCli(call), { code: 'HOST_CLI_CONTEXT_INVALID' }); }
  finally { clearTimeout(guard); }
});

test('the public provider is unavailable by default', async () => {
  await assert.rejects(executeHostCli(), { code: 'HOST_CLI_UNAVAILABLE' });
});

test('write uses the original Bridge confirmation and ignores a forged Adapter helper flag', async () => {
  assert.equal(await authorizeHostCliWrite({ requiresConfirmation: true, originalConfirmed: true }), true);
  let calls = 0;
  const f = fixture({ execute: async () => { calls++; }, authorizeWrite: authorizeHostCliWrite });
  f.selected.command.safety = 'write';
  f.pending.hostCall.originalArgs = { product: 'one', __confirmed: false };
  f.call.payload.args = { product: 'one', __confirmed: true };
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_CONFIRMATION_REQUIRED' });
  assert.equal(calls, 0);
});

test('write authorization cannot approve changed or nested-tampered arguments', async () => {
  for (const changed of [{ product: 'two', nested: { __confirmed: true } }, { product: 'one', nested: { __confirmed: false } }]) {
    let approvals = 0;
    const f = fixture({ authorizeWrite: async () => { approvals++; return true; } });
    f.selected.command.safety = 'write';
    f.pending.hostCall.originalArgs = { product: 'one', nested: { __confirmed: true }, __confirmed: true };
    f.call.payload.args = changed;
    await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_INVALID_ARGUMENT' });
    assert.equal(approvals, 0);
  }
});

test('host authorization receives original call identity and arguments', async () => {
  let approval;
  const f = fixture({ authorizeWrite: async input => { approval = input; return true; },
    execute: async ({ markWriteDispatched }) => { markWriteDispatched(); return { done: true }; } });
  f.selected.command.safety = 'write';
  f.pending.hostCall.originalArgs = { product: 'one', __confirmed: true };
  assert.deepEqual(await invokeHostCli(f.call), { done: true });
  assert.equal(approval.invocationId, 'invocation');
  assert.equal(approval.connection, f.call.ws);
  assert.deepEqual(approval.adapter, f.selected.snapshot);
  assert.deepEqual(approval.command, { id: 'list', safety: 'write' });
  assert.deepEqual(approval.args, { product: 'one' });
  assert.equal(approval.requiresConfirmation, true);
  assert.equal(approval.originalConfirmed, true);
  assert.equal(f.pending.hostWriteDispatched, true);
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_ALREADY_CALLED' });
});

test('write honors a selected command confirmation opt-out without trusting helper args', async () => {
  const f = fixture({ authorizeWrite: authorizeHostCliWrite, execute: async ({ markWriteDispatched }) => {
    markWriteDispatched(); return { done: true };
  } });
  f.selected.command.safety = 'write'; f.selected.command.requires_confirmation = false;
  f.pending.hostCall.originalArgs = { product: 'one' };
  assert.deepEqual(await invokeHostCli(f.call), { done: true });
});

test('write can execute when the original Bridge invocation was confirmed', async () => {
  const f = fixture({ authorizeWrite: authorizeHostCliWrite, execute: async ({ markWriteDispatched }) => {
    markWriteDispatched(); return { done: true };
  } });
  f.selected.command.safety = 'write';
  f.pending.hostCall.originalArgs = { product: 'one', __confirmed: true };
  f.call.payload.args = { product: 'one', __confirmed: false };
  assert.deepEqual(await invokeHostCli(f.call), { done: true });
});

test('a dispatched write with an abort or exception is reported as outcome unknown', async () => {
  const f = fixture({ authorizeWrite: async () => true, execute: async ({ markWriteDispatched }) => {
    markWriteDispatched(); throw new Error('response unavailable');
  } });
  f.selected.command.safety = 'write'; f.pending.hostCall.originalArgs = { product: 'one' };
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_OUTCOME_UNKNOWN' });
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_ALREADY_CALLED' });
});

test('a disconnected invocation aborts a dispatched provider without retrying', async () => {
  let executions = 0;
  const f = fixture({ authorizeWrite: async () => true, execute: async ({ markWriteDispatched, signal }) => {
    executions++; markWriteDispatched();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { late: true };
  } });
  f.selected.command.safety = 'write'; f.pending.hostCall.originalArgs = { product: 'one' };
  const running = invokeHostCli(f.call);
  await new Promise(resolve => setImmediate(resolve));
  f.pendingRequests.delete('invocation'); f.controller.abort();
  await assert.rejects(running, { code: 'HOST_CLI_OUTCOME_UNKNOWN' });
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_CONTEXT_INVALID' });
  assert.equal(executions, 1);
});

test('conditional branch is identical in host and extension distributions and fails closed for supplied invalid product values', async () => {
  assert.equal(readFileSync(new URL('../conditional-execution.js', import.meta.url), 'utf8'), readFileSync(new URL('../../extension/background/conditional-execution.js', import.meta.url), 'utf8'));
  const command = { execution: { type: 'api', runtime: 'background', pageWhenAbsent: 'productId' } };
  for (const args of [{}, { submitForReview: true }, { reviewData: {} }, { productId: null }, { productId: 0 }, { productId: '' }, { productId: '123' }, { productId: '123', submitForReview: true }]) {
    assert.equal(hostBranch(command, args), Object.hasOwn(args, 'productId'));
    assert.equal(extensionBranch(command, args), hostBranch(command, args));
  }
});

test('conditional page invocation cannot acquire host CLI even by forging helper arguments', async () => {
  let executions = 0;
  const f = fixture({ execute: async () => { executions++; } });
  f.selected.command.safety = 'write';
  f.selected.command.execution.pageWhenAbsent = 'productId';
  f.pending.hostCall.originalArgs = { title: 'example' };
  f.call.payload.args = { title: 'example', productId: '123' };
  await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_CONTEXT_INVALID' });
  assert.equal(executions, 0);
});

test('conditional background invocation binds full original arguments before dispatch', async () => {
  for (const altered of [{ productId: '124', title: 'example' }, { title: 'example' }, { productId: '123', title: 'different' }]) {
    let executions = 0;
    const f = fixture({ authorizeWrite: async () => true, execute: async () => { executions++; } });
    f.selected.command.safety = 'write'; f.selected.command.execution.pageWhenAbsent = 'productId';
    f.pending.hostCall.originalArgs = { productId: '123', title: 'example' };
    f.call.payload.args = altered;
    await assert.rejects(invokeHostCli(f.call), { code: 'HOST_CLI_INVALID_ARGUMENT' });
    assert.equal(executions, 0);
  }
});
