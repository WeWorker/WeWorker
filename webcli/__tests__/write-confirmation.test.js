import { describe, it, expect, vi } from 'vitest';
import { WriteConfirmationCoordinator, hasExecutionPermit, businessArguments } from '../write-confirmation.js';
import { authorizeHostCliWrite } from '../host-cli-write-authorization.js';
import { extractFlagArgs, resolveCliInvocation } from '../index.js';
import { createParentConfirmationChannel } from '../write-confirmation-channel.js';
import { attachWriteConfirmation } from '../../weworker/electron/write-confirmation.js';
import { writeAccountContext } from '../../extension/background/write-account-context.js';
import { EventEmitter } from 'node:events';
import { webcrypto } from 'node:crypto';

function fixture(overrides = {}) {
  const selected = { snapshot: { name: 'example.com', digest: 'a'.repeat(64), profile: 'public' },
    command: { id: 'submit', safety: 'write', runtime: 'extension', schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } };
  const confirm = vi.fn(async () => true);
  const execute = vi.fn(async ({ permit, args, markDispatched }) => {
    expect(hasExecutionPermit(permit, selected, args)).toBe(true);
    markDispatched(); return { ok: true };
  });
  const coordinator = new WriteConfirmationCoordinator({ confirm, ...overrides });
  const request = { selected, args: { id: '123' }, scope: { profile: 'browser', connection: 'one' },
    context: async () => 'account-one', resolve: () => selected, execute };
  return { selected, confirm, execute, coordinator, request, run: changes => coordinator.run({ ...request, ...changes }) };
}

describe('host-owned write authorization', () => {
  it.each([[], ['--__confirmed'], ['--__confirmed=true'], ['--__confirmed=false'], ['--__confirmed=wrong']].map(flags => [flags]))('legacy flags %j never bypass confirmation', async flags => {
    const f = fixture();
    const { args } = extractFlagArgs(['--id=123', ...flags]);
    const result = await f.run({ args });
    expect(result.execution.state).toBe('succeeded');
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.confirm.mock.calls[0][0].args).toEqual({ id: 123 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(hasExecutionPermit(f.execute.mock.calls[0][0].permit, f.selected, { id: 123 })).toBe(false);
  });
  it('rejects the malformed positional flag before any call', () => {
    expect(() => resolveCliInvocation(['call', 'example.com.submit', '__confirmed=true'])).toThrow(/positional/);
  });
  it('does not trust forged permits, model assertions, or opt-out claims', async () => {
    for (const requiresConfirmation of [true, false]) expect(await authorizeHostCliWrite({ originalConfirmed: true, requiresConfirmation, permit: {}, args: {} })).toBe(false);
    const f = fixture();
    expect(() => businessArguments({ id: 123, confirmation: true }, f.selected.command)).toThrow();
  });
  it('preserves an explicit tool policy opt-out without a popup', async () => {
    const f = fixture(); f.selected.command.requires_confirmation = false;
    await f.run(); expect(f.confirm).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('cannot opt page write protection out', async () => {
    const f = fixture(); f.selected.command.requires_confirmation = false; f.selected.command.pageWrite = {};
    await f.run(); expect(f.confirm).toHaveBeenCalledOnce();
  });
  it('retains the frozen business request when the caller mutates its object', async () => {
    let approve; const f = fixture({ confirm: () => new Promise(resolve => { approve = resolve; }) });
    const promise = f.run(); await vi.waitFor(() => expect(approve).toBeTypeOf('function'));
    f.request.args.id = '999'; approve(true); await promise;
    expect(f.execute.mock.calls[0][0].args).toEqual({ id: 123 });
  });
  it.each(['digest', 'policy', 'account'])('invalidates changed %s', async kind => {
    const f = fixture(); let account = 'one';
    f.confirm.mockImplementation(async () => {
      if (kind === 'digest') f.selected.snapshot.digest = 'b'.repeat(64);
      if (kind === 'policy') f.selected.command.requires_confirmation = false;
      if (kind === 'account') account = 'two';
      return true;
    });
    await expect(f.run({ context: async () => account })).rejects.toMatchObject({ code: 'WRITE_CONTEXT_CHANGED', execution: { state: 'not_submitted' } });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('requires a new review for changed parameters', async () => {
    const f = fixture(); await f.run(); await f.run({ args: { id: 124 } });
    expect(f.confirm).toHaveBeenCalledTimes(2);
  });
  it('does not return an earlier account result to a changed account', async () => {
    const f = fixture(); await f.run();
    await expect(f.run({ context: async () => 'different-account' })).rejects.toMatchObject({ code: 'WRITE_CONTEXT_CHANGED' });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('fans out final states to concurrent observers', async () => {
    const f = fixture(), statuses = [];
    await Promise.all([f.run(), f.run({ notify: status => statuses.push(status.state) })]);
    expect(statuses).toContain('waiting_confirmation');
    expect(statuses.at(-1)).toBe('succeeded');
  });
  it('ignores the reserved legacy field even when an old schema requires it', async () => {
    const f = fixture(); f.selected.command.schema.required.push('__confirmed');
    await f.run(); expect(f.confirm).toHaveBeenCalledOnce();
  });
  it('cancellation never executes and repeated submissions share its result', async () => {
    const f = fixture(); f.confirm.mockResolvedValue(false);
    await expect(f.run()).rejects.toMatchObject({ code: 'WRITE_CANCELLED' });
    await expect(f.run()).rejects.toMatchObject({ code: 'WRITE_CANCELLED' });
    expect(f.confirm).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });
  it('expiry rejects a late real confirmation', async () => {
    let now = 0; const f = fixture({ now: () => now, ttlMs: 10 });
    f.confirm.mockImplementation(async () => { now = 11; return true; });
    await expect(f.run()).rejects.toMatchObject({ code: 'WRITE_CONFIRMATION_EXPIRED' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('client cancellation cannot execute a late decision', async () => {
    const f = fixture(), controller = new AbortController();
    f.confirm.mockImplementation(async () => { controller.abort(); return true; });
    await expect(f.run({ signal: controller.signal })).rejects.toMatchObject({ code: 'WRITE_CANCELLED' });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('coalesces concurrent identical requests and consumes approval once', async () => {
    const f = fixture(); const results = await Promise.all(Array.from({ length: 20 }, () => f.run()));
    expect(new Set(results.map(r => r.execution.requestId)).size).toBe(1);
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
  });
  it('pre-dispatch failure is distinct from unknown and does not auto retry', async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error('validation failed'));
    await expect(f.run()).rejects.toMatchObject({ execution: { state: 'not_submitted', retryable: true } });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('retains unknown outcome tombstones beyond confirmation TTL, without replay', async () => {
    let now = 0; const f = fixture({ now: () => now, ttlMs: 100 });
    f.execute.mockImplementation(async ({ markDispatched }) => { markDispatched(); throw Error('lost response'); });
    await expect(f.run()).rejects.toMatchObject({ code: 'WRITE_OUTCOME_UNKNOWN', execution: { state: 'unknown', retryable: false } });
    now = 1000;
    await expect(f.run()).rejects.toMatchObject({ code: 'WRITE_OUTCOME_UNKNOWN' });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('distinguishes a returned business failure', async () => {
    const f = fixture(); f.execute.mockImplementation(async ({ markDispatched }) => { markDispatched(); return { ok: false }; });
    expect((await f.run()).execution.state).toBe('failed');
  });
  it('a fresh host has no restored approval and standalone hosts fail closed', async () => {
    const f = fixture(); await f.run();
    const restarted = new WriteConfirmationCoordinator();
    await expect(restarted.run(f.request)).rejects.toMatchObject({ code: 'WRITE_CONFIRMATION_UNAVAILABLE', execution: { state: 'not_submitted' } });
    expect(f.execute).toHaveBeenCalledOnce();
  });
});

describe('trusted UI boundary', () => {
  it('accepts decisions only through the private parent channel and revokes on abort', async () => {
    const proc = new EventEmitter(), sent = []; proc.send = msg => sent.push(msg);
    const confirm = createParentConfirmationChannel(proc);
    await expect(confirm({ requestId: 'one' }, new AbortController().signal)).rejects.toMatchObject({ code: 'WRITE_CONFIRMATION_UNAVAILABLE' });
    proc.emit('message', { type: 'write_confirmation_host_ready' });
    const controller = new AbortController(), promise = confirm({ requestId: 'two' }, controller.signal);
    proc.emit('message', { type: 'write_confirmation_decision', requestId: 'forged-id', approved: true });
    controller.abort(); expect(await promise).toBe(false);
    proc.emit('message', { type: 'write_confirmation_decision', requestId: 'two', approved: true });
    expect(sent.at(-1).type).toBe('write_confirmation_cancel');
    expect(createParentConfirmationChannel(new EventEmitter())).toBeUndefined();
  });
  it('native dialog defaults to cancel and refuses late clicks after expiry or child replacement', async () => {
    for (const late of ['expiry', 'replacement', 'cancel']) {
      const child = new EventEmitter(), sent = []; child.connected = true; child.send = msg => sent.push(msg);
      let now = 0, current = true;
      const dialog = { showMessageBox: vi.fn(async options => {
        expect(options.defaultId).toBe(0);
        if (late === 'expiry') now = 20;
        if (late === 'replacement') current = false;
        if (late === 'cancel') child.emit('message', { type: 'write_confirmation_cancel', requestId: 'one' });
        if (late === 'cancel') expect(options.signal.aborted).toBe(true);
        return { response: 1 };
      }) };
      attachWriteConfirmation(child, { dialog, isCurrent: () => current, now: () => now });
      child.emit('message', { type: 'write_confirmation_request', request: { requestId: 'one', tool: 'example.com.submit', expiresAt: 10 } });
      await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledOnce());
      expect(sent.some(msg => msg.approved === true)).toBe(false);
    }
  });
  it('binds cookie value, store and partition without exposing credentials', async () => {
    let value = 'example-placeholder-secret';
    const api = { cookies: { getAllCookieStores: async () => [{ id: 'one' }], getAll: async () => [{ domain: '.example.com', name: 'session', value, path: '/' }] } };
    const first = await writeAccountContext(api, webcrypto); value = 'example-other-secret';
    expect(first.fingerprint).not.toBe((await writeAccountContext(api, webcrypto)).fingerprint);
    expect(JSON.stringify(first)).not.toContain('secret');
  });
  it('refuses oversized review text with an actionable non-submission error', async () => {
    const child = new EventEmitter(), sent = []; child.connected = true; child.send = msg => sent.push(msg);
    const dialog = { showMessageBox: vi.fn() };
    attachWriteConfirmation(child, { dialog, isCurrent: () => true });
    child.emit('message', { type: 'write_confirmation_request', request: { requestId: 'large', tool: 'example.submit', expiresAt: Date.now() + 1000, args: { text: 'x'.repeat(17000) } } });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ approved: false, code: 'WRITE_REVIEW_TOO_LARGE' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
