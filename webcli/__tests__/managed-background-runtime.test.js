import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { createManagedBackgroundRuntime } from '../../extension/background/managed-background-runtime.js';
import { extractFlagArgs } from '../index.js';

function fixture({ source, timeoutMs = 1000, failAttach = false, documents = [] } = {}) {
  const manifest = { name: 'demo', match: ['example.com'], commands: [{ id: 'run', runtime: 'extension', safety: 'write',
    module: 'extension/commands/run.js', execution: { type: 'api', runtime: 'background' }, schema: {} }] };
  let url, scope, queue = Promise.resolve(), runtime;
  const events = [], messages = [], request = vi.fn(async (_action, payload, context) => ({ payload, adapterId: context.adapterId }));
  const api = {
    runtime: { id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path, getContexts: async () => documents },
    offscreen: { createDocument: vi.fn(async options => {
      url = options.url; events.push('create');
      scope = vm.createContext({ Map, Error, Object, JSON, chrome: { runtime: { sendMessage: async message => {
        messages.push(message);
        try { return { ok: true, result: await runtime.handleMessage(message, { id: api.runtime.id, url }) }; }
        catch (error) { return { ok: false, error: { message: error.message } }; }
      } } } }); scope.window = scope;
    }), closeDocument: vi.fn(async () => { events.push('close'); }) },
    debugger: { getTargets: async () => [{ id: 'owned', url }], attach: vi.fn(async () => { if (failAttach) throw new Error('Another debugger owns this target'); events.push('attach'); }),
      detach: vi.fn(async () => { events.push('detach'); }), sendCommand: vi.fn(async (_target, _method, options) => {
        expect(options.allowUnsafeEvalBlockedByCSP).toBe(false);
        try { return { result: { value: await vm.runInContext(options.expression, scope) } }; }
        catch { return { exceptionDetails: {} }; }
      }) },
  };
  const bundle = vi.fn(async () => ({ manifest, files: { 'extension/commands/run.js': source || '__webcliRegisterCommand("run", args => args);' } }));
  runtime = createManagedBackgroundRuntime({ api, bundle, request, timeoutMs,
    exclusive(task) { const run = queue.then(task, task); queue = run.catch(() => {}); return run; } });
  const run = (args = { __confirmed: true, count: '007' }) => runtime.execute(manifest, manifest.commands[0], args, { adapterId: 'demo', declaredHosts: ['example.com'] });
  return { api, runtime, run, events, messages, request, bundle, manifest, getScope: () => scope, getUrl: () => url };
}

describe('managed background execution lifecycle', () => {
  it('isolates preview source and restores pinned installed source on the next call', async () => {
    const f = fixture();
    const preview = { manifest: structuredClone(f.manifest), files: { 'extension/commands/run.js': '__webcliRegisterCommand("run",()=>"example-preview");' } };
    expect(await f.runtime.execute(f.manifest, f.manifest.commands[0], { __confirmed: true }, { previewNoPage: true, previewDeadline: Date.now() + 1000 }, preview)).toBe('example-preview');
    expect(f.bundle).not.toHaveBeenCalled();
    expect(await f.run()).toEqual({ __confirmed: true, count: '007' });
    expect(f.bundle).toHaveBeenCalledOnce();
    expect(f.events).toEqual(['create', 'attach', 'detach', 'close', 'create', 'attach', 'detach', 'close']);
  });
  it('times out preview code within its budget and closes its owned runner', async () => {
    const f = fixture();
    const preview = { manifest: f.manifest, files: { 'extension/commands/run.js': '__webcliRegisterCommand("run",()=>new Promise(()=>{}));' } };
    await expect(f.runtime.execute(f.manifest, f.manifest.commands[0], { __confirmed: true }, { previewNoPage: true, previewDeadline: Date.now() + 50 }, preview)).rejects.toThrow(/timed out/);
    expect(f.events.slice(-2)).toEqual(['detach', 'close']);
    expect(await f.run()).toEqual({ __confirmed: true, count: '007' });
  });
  it('uses package confirmation policy independently of write classification', async () => {
    const f = fixture();
    await expect(f.run({ requires_confirmation: false })).rejects.toThrow(/confirmation/);
    f.manifest.commands[0].requires_confirmation = false;
    expect(await f.run({ count: '007' })).toEqual({ count: '007', __confirmed: true });
    expect(f.manifest.commands[0].safety).toBe('write');
    f.manifest.commands[0].requires_confirmation = true;
    await expect(f.run({})).rejects.toThrow(/confirmation/);
  });
  it('honors opt-out through the preserved runtime helper', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", args => { __webmcpWecliRuntime.requireConfirmation(args); return args.value; });' });
    f.manifest.commands[0].requires_confirmation = false;
    const args = Object.freeze({ value: 'requested' });
    expect(await f.run(args)).toBe('requested');
    expect(args).toEqual({ value: 'requested' });
    f.manifest.commands[0].safety = 'read';
    await expect(f.run({})).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });
  it('executes the pinned module without argument conversion and cleans up owned resources', async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ __confirmed: true, count: '007' });
    expect(f.events).toEqual(['create', 'attach', 'detach', 'close']);
    expect(f.bundle).toHaveBeenCalledOnce();
    expect(f.api.debugger.detach).toHaveBeenCalledWith({ targetId: 'owned' });
  });
  it('checks confirmation and selected execution metadata before creating a document', async () => {
    const f = fixture(); await expect(f.run({})).rejects.toThrow(/confirmation/);
    delete f.manifest.commands[0].execution;
    await expect(f.run()).rejects.toThrow(/background execution/);
    expect(f.api.offscreen.createDocument).not.toHaveBeenCalled();
  });
  it('validates required and unknown parameters against explicit runtime schemas', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", args => __webmcpWecliRuntime.validateArgs(args, {type:"object",properties:{count:{type:"integer"}},required:["count"],additionalProperties:false}));' });
    await expect(f.run({__confirmed:true})).rejects.toMatchObject({code:'INVALID_ARGS'});
    expect(await f.run({__confirmed:true,count:7})).toEqual({__confirmed:true,count:7});
    await expect(f.run({__confirmed:true,count:7,unknown:true})).rejects.toMatchObject({code:'INVALID_ARGS'});
  });
  it('normalizes CLI numeric flags only when the runtime schema requests numbers', async () => {
    const schema = { type: 'object', properties: {
      pageSize: { type: 'integer', default: 20 }, page: { type: 'integer', default: 1 },
      ratio: { type: 'number' }, id: { type: 'string' }, enabled: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } }, extra: { type: 'object' },
    }, additionalProperties: false };
    const f = fixture({ source: `__webcliRegisterCommand("run", args => __webmcpWecliRuntime.validateArgs(args, ${JSON.stringify(schema)}));` });
    const { args } = extractFlagArgs(['--pageSize=50', '--ratio=0.5', '--id=007', '--enabled=false', '--tags=["one","two"]', '--extra={"count":2}']);
    expect(args.pageSize).toBe('50');
    const input = Object.freeze({ ...args, __confirmed: true });
    expect(await f.run(input)).toEqual({ ...input, pageSize: 50, page: 1, ratio: 0.5 });
    expect(input.pageSize).toBe('50');
    expect(await f.run({ __confirmed: true, pageSize: '0', ratio: '-1.5', id: '007' }))
      .toEqual({ __confirmed: true, pageSize: 0, page: 1, ratio: -1.5, id: '007' });
  });
  it('preserves explicit JSON numbers and validates enums after numeric conversion', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", args => __webmcpWecliRuntime.validateArgs(args, {type:"object",properties:{count:{type:"integer",enum:[0,50]}}}));' });
    const { args } = extractFlagArgs(['--args', '{"count":50}']);
    expect(await f.run({ ...args, __confirmed: true })).toEqual({ count: 50, __confirmed: true });
    expect(await f.run({ count: '0', __confirmed: true })).toEqual({ count: 0, __confirmed: true });
    await expect(f.run({ count: '2', __confirmed: true })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
  it('keeps invalid numeric values rejected instead of truncating or substituting defaults', async () => {
    for (const type of ['integer', 'number']) {
      const f = fixture({ source: `__webcliRegisterCommand("run", args => __webmcpWecliRuntime.validateArgs(args, {type:"object",properties:{count:{type:"${type}",default:20}}}));` });
      for (const count of ['', ' ', 'abc', '50rows', 'NaN', 'Infinity', '1e999', true, null, ...(type === 'integer' ? ['1.5'] : [])]) {
        await expect(f.run({ count, __confirmed: true })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
      }
    }
  });
  it('supports numeric nullable schemas without changing schemas that accept strings', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", args => __webmcpWecliRuntime.validateArgs(args, {type:"object",properties:{count:{type:["integer","null"]},id:{type:["integer","string"]}}}));' });
    expect(await f.run({ count: '50', id: '007', __confirmed: true })).toEqual({ count: 50, id: '007', __confirmed: true });
    expect(await f.run({ count: null, __confirmed: true })).toEqual({ count: null, __confirmed: true });
  });
  it('matches the existing integer-array CLI syntax without splitting string arrays', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", args => __webmcpWecliRuntime.validateArgs(args, {type:"object",properties:{ids:{type:"array",items:{type:"integer"}},names:{type:"array",items:{type:"string"}}}}));' });
    expect(await f.run({ ids: '1, 2,3', __confirmed: true })).toEqual({ ids: [1, 2, 3], __confirmed: true });
    await expect(f.run({ ids: '1,no', __confirmed: true })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
     expect(await f.run({ names: 'one,two', __confirmed: true })).toEqual({ names: ['one,two'], __confirmed: true });
    expect(await f.run({ names: 'single-path.pdf', __confirmed: true })).toEqual({ names: ['single-path.pdf'], __confirmed: true });
    expect(await f.run({ names: '["one","two"]', __confirmed: true })).toEqual({ names: ['one', 'two'], __confirmed: true });
  });
  it('binds helper requests to the active document and immutable call context', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", async () => __webmcpWecliRuntime.requestPrivileged("fixture", { value: "ok" }));' });
    expect(await f.run()).toEqual({ payload: { value: 'ok' }, adapterId: 'demo' });
    expect(f.request).toHaveBeenCalledOnce();
    await expect(f.getScope().__webmcpWecliRuntime.requestPrivileged('fixture')).rejects.toThrow(/context/);
    await expect(f.runtime.handleMessage({ token: 'wrong' }, { id: 'other', url: f.getUrl() })).rejects.toThrow(/context/);
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('serializes versions and starts each call in a fresh document', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", () => { window.fixtureCount = (window.fixtureCount || 0) + 1; return window.fixtureCount; });' });
    expect(await Promise.all([f.run(), f.run()])).toEqual([1, 1]);
    expect(f.events).toEqual(['create', 'attach', 'detach', 'close', 'create', 'attach', 'detach', 'close']);
  });
  it('rejects forged active contexts and settles late helpers before releasing the next call', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", () => { __webmcpWecliRuntime.requestPrivileged("fixture", {}); return "done"; });' });
    let release, notify;
    const started = new Promise(resolve => { notify = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    f.request.mockImplementationOnce(async () => { notify(); await pending; return 'settled'; });
    const first = f.run();
    await started;
    const message = f.messages[0];
    for (const [entry, sender] of [
      [{...message,token:'wrong'}, {id:f.api.runtime.id,url:f.getUrl()}],
      [message,{id:'other-extension',url:f.getUrl()}],
      [message,{id:f.api.runtime.id,url:'https://example.com/'}],
    ]) await expect(f.runtime.handleMessage(entry,sender)).rejects.toThrow(/context/);
    const second = f.run();
    await new Promise(resolve => setTimeout(resolve,10));
    expect(f.api.offscreen.createDocument).toHaveBeenCalledOnce();
    release();
    expect(await first).toBe('done'); expect(await second).toBe('done');
    expect(f.api.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });
  it('does not replace unknown offscreen documents or detach a debugger it does not own', async () => {
    const unknown = fixture({ documents: [{ documentUrl: 'chrome-extension://test-extension/other.html' }] });
    await expect(unknown.run()).rejects.toThrow(/unrelated/);
    expect(unknown.api.offscreen.closeDocument).not.toHaveBeenCalled();
    const occupied = fixture({ failAttach: true });
    await expect(occupied.run()).rejects.toThrow(/Another debugger/);
    expect(occupied.api.debugger.detach).not.toHaveBeenCalled();
    expect(occupied.api.offscreen.closeDocument).toHaveBeenCalledOnce();
    const legacy = fixture({ documents: [{ documentUrl: 'chrome-extension://test-extension/offscreen/direct-runner.html' }] });
    await legacy.run();
    expect(legacy.events).toEqual(['close','create','attach','detach','close']);
  });
  it('preserves a completed call when Chrome has already closed its offscreen document', async () => {
    const f = fixture();
    f.api.offscreen.closeDocument.mockRejectedValueOnce(new Error('No current offscreen document'));
    expect(await f.run()).toEqual({ __confirmed: true, count: '007' });
    expect(await f.run()).toEqual({ __confirmed: true, count: '007' });
    expect(f.api.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });
  it('tolerates a stale document context but preserves other close failures', async () => {
    const stale = fixture({ documents: [{ documentUrl: 'chrome-extension://test-extension/offscreen/direct-runner.html' }] });
    stale.api.offscreen.closeDocument.mockRejectedValueOnce(new Error('No current offscreen document'));
    expect(await stale.run()).toEqual({ __confirmed: true, count: '007' });
    const unexpected = fixture();
    unexpected.api.offscreen.closeDocument.mockRejectedValueOnce(new Error('Offscreen cleanup failed'));
    await expect(unexpected.run()).rejects.toThrow('Offscreen cleanup failed');
  });
  it('cleans up timeout and source failures and leaves the next call usable', async () => {
    const f = fixture({ source: '__webcliRegisterCommand("run", () => new Promise(() => {}));', timeoutMs: 20 });
    await expect(f.run()).rejects.toThrow(/timed out/);
    expect(f.events.at(-1)).toBe('close');
    f.bundle.mockResolvedValueOnce({ manifest: f.manifest, files: { 'extension/commands/run.js': 'throw new Error("private fixture source");' } });
    await expect(f.run()).rejects.toThrow('Adapter background script failed.');
    f.bundle.mockResolvedValueOnce({ manifest: f.manifest, files: { 'extension/commands/run.js': '__webcliRegisterCommand("run", () => "recovered");' } });
    expect(await f.run()).toBe('recovered');
  });
});
