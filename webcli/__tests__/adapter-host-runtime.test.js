import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { createHostAdapterRuntime, navigateAdapterTab, waitForAdapterPageRecovery } from '../../extension/background/host-adapter-runtime.js';
import { buildV2Bootstrap } from '../../extension/background/v2-loader.js';

const manifest = (digest) => ({ name: 'demo', _hostSnapshot: { profile: 'public', digest } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

describe('managed page execution', () => {
  it('defers script replacement until the command using the previous version finishes', async () => {
    const events = [];
    const started = deferred(), finish = deferred();
    const runtime = createHostAdapterRuntime({
      bundle: async (pkg) => pkg, prepare: async () => {},
      clear: async () => { events.push('clear'); },
      inject: async (_tab, pkg) => { events.push(pkg._hostSnapshot.digest); },
    });
    const first = runtime.execute(7, manifest('first'), 'https://example.com/', async () => {
      events.push('start'); started.resolve(); await finish.promise; events.push('finish'); return 'old result';
    });
    await started.promise;
    const update = runtime.execute(7, manifest('second'), 'https://example.com/');
    await Promise.resolve();
    expect(events).toEqual(['clear', 'first', 'start']);
    finish.resolve();
    expect(await first).toBe('old result');
    await update;
    expect(events).toEqual(['clear', 'first', 'start', 'finish', 'clear', 'second']);
    await runtime.execute(7, manifest('second'), 'https://example.com/');
    expect(events).toHaveLength(6);
  });

  it('does not clear a working page when bundle validation fails and recovers its queue', async () => {
    let clears = 0;
    const runtime = createHostAdapterRuntime({
      bundle: async (pkg) => { if (pkg._hostSnapshot.digest === 'bad') throw new Error('bad package'); return pkg; },
      prepare: async () => {}, clear: async () => { clears++; }, inject: async () => {},
    });
    await runtime.execute(7, manifest('first'), 'https://example.com/');
    await expect(runtime.execute(7, manifest('bad'), 'https://example.com/')).rejects.toThrow('bad package');
    expect(clears).toBe(1);
    expect(await runtime.execute(7, manifest('first'), 'https://example.com/', () => 'healthy')).toBe('healthy');
  });

  it('never marks an old document as injected after navigation', async () => {
    let navigate = true, injected = 0;
    const runtime = createHostAdapterRuntime({
      bundle: async (pkg) => pkg, prepare: async () => {}, clear: async () => {},
      inject: async () => { injected++; if (navigate) runtime.invalidate(7); },
    });
    await expect(runtime.execute(7, manifest('first'), 'https://example.com/')).rejects.toThrow(/document changed/);
    navigate = false;
    await runtime.execute(7, manifest('first'), 'https://example.com/');
    expect(injected).toBe(2);
  });
});

describe('v2 page registration', () => {
  it('allows writes without a second confirmation only when the package opts out', () => {
    const registrations = [];
    const context = vm.createContext({ window: { __webmcpRegister: entry => registrations.push(entry) } });
    vm.runInContext(buildV2Bootstrap({ name: 'demo', match: ['example.com'], commands: [{
      id: 'reserve', runtime: 'extension', safety: 'write', requires_confirmation: false, schema: {}
    }] }), context);
    vm.runInContext('window.__webcliRegisterCommand("reserve", args => args)', context);
    expect(registrations[0].tools[0].handler({ value: 'requested' })).toEqual({ value: 'requested', __confirmed: true });
  });
  it('refreshes definitions after update and enforces the declared write gate', () => {
    const registrations = [];
    const context = vm.createContext({ window: { __webmcpRegister: (entry) => registrations.push(entry) } });
    const pkg = (id, safety) => ({ name: 'demo', match: ['example.com'], commands: [{ id, safety, runtime: 'extension', description: id, schema: {} }] });
    vm.runInContext(buildV2Bootstrap(pkg('old', 'read')), context);
    vm.runInContext('window.__webcliRegisterCommand("old", () => "old result")', context);
    vm.runInContext(buildV2Bootstrap(pkg('new', 'write')), context);
    vm.runInContext('window.__webcliRegisterCommand("new", (args) => args.value)', context);
    expect(registrations[1].tools[0].name).toBe('demo.new');
    expect(() => registrations[1].tools[0].handler({ value: 'blocked' })).toThrow(/confirmation/);
    expect(registrations[1].tools[0].handler({ value: 'approved', __confirmed: true })).toBe('approved');
    expect(() => vm.runInContext('window.__webcliRegisterCommand("old", () => "stale")', context)).toThrow(/unknown command/);
  });
});


describe('legacy confirmation compatibility', () => {
  it('scopes grants to opted-out writes without mutating args or read branches', async () => {
    const registrations = [];
    const scope = vm.createContext({ window: { __webmcpRegister: entry => registrations.push(...entry.tools) } });
    vm.runInContext(buildV2Bootstrap({ name: 'demo', commands: [
      { id: 'write', runtime: 'extension', safety: 'write', requires_confirmation: false },
      { id: 'read', runtime: 'extension', safety: 'read', requires_confirmation: false },
      { id: 'guarded', runtime: 'extension', safety: 'write', requires_confirmation: true },
    ] }), scope);
    vm.runInContext(`
      ['write', 'read', 'guarded'].forEach(id => window.__webcliRegisterCommand(id, async args => {
        await Promise.resolve();
        if (args['dry-run']) return 'preview';
        if (args.__confirmed !== true) throw new Error('legacy confirmation required');
        return { action: args.submit ? 'submit' : 'save', value: args.value };
      }));
    `, scope);
    const [write, read, guarded] = registrations;
    const args = Object.freeze({ value: 'requested' });
    expect(await write.handler(args)).toEqual({ action: 'save', value: 'requested' });
    expect(args).toEqual({ value: 'requested' });
    expect(await write.handler({ 'dry-run': true })).toBe('preview');
    await expect(read.handler({ requires_confirmation: false })).rejects.toThrow('legacy confirmation');
    expect(() => guarded.handler({ requires_confirmation: false })).toThrow('confirmation');
    const results = await Promise.allSettled([write.handler(args), read.handler(args)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  });
});


describe('host-owned page navigation', () => {
  const command = { id: 'list', safety: 'read' };
  const pkg = { name: 'demo', match: ['example.com'], runtime_allowed_hosts: ['login.example.org'], commands: [command] };
  const next = (url = 'https://example.com/results', resume = true) => ({ __webcli_navigation: { version: 1, url, resume } });
  function setup(options = {}) {
    const events = [];
    const runtime = createHostAdapterRuntime({ bundle: async () => { events.push('bundle'); return {}; },
      prepare: async () => {}, clear: async () => {}, inject: async () => { events.push('inject'); },
      navigate: async (_id, url) => { events.push(url); runtime.invalidate(7); return url; }, ...options });
    return { runtime, events };
  }
  it('keeps two navigations and reads in one serialized invocation', async () => {
    const { runtime, events } = setup(); let count = 0;
    const operation = async () => ++count <= 2 ? next('https://example.com/step' + count) : ['final'];
    expect(await runtime.execute(7, pkg, 'https://example.com/', operation, command)).toEqual(['final']);
    expect(events.filter(x => x === 'bundle')).toHaveLength(3);
    expect(events.filter(x => x === 'inject')).toHaveLength(3);
  });
  it('holds the tab queue throughout navigation and recovers injection before executing a handler', async () => {
    const entered = deferred(), finish = deferred(); let injections = 0, calls = 0;
    const { runtime, events } = setup({
      ready: async () => 'https://example.com/current',
      inject: async () => { if (++injections === 1) throw new Error('Adapter target changed'); },
      navigate: async (_id, url) => { entered.resolve(); await finish.promise; return url; },
    });
    const first = runtime.execute(7, pkg, 'https://example.com/stale', () => ++calls === 1 ? next() : 'final', command);
    await entered.promise;
    const second = runtime.execute(7, pkg, 'https://example.com/stale', () => { events.push('second'); return 'second'; }, command);
    await Promise.resolve(); expect(events).not.toContain('second');
    finish.resolve(); expect(await first).toBe('final'); expect(await second).toBe('second');
    expect(calls).toBe(2); expect(injections).toBe(3);
  });
  it('bounds document recovery and never invokes the business handler while injection fails', async () => {
    let injections = 0, calls = 0;
    const { runtime } = setup({ ready: async () => 'https://example.com/', inject: async () => { injections++; throw new Error('Adapter document changed'); } });
    await expect(runtime.execute(7, pkg, 'https://example.com/', () => { calls++; }, command)).rejects.toThrow('Adapter document changed');
    expect(injections).toBe(3); expect(calls).toBe(0);
  });
  it('does not infer continuation from ordinary business status or repeat errors', async () => {
    const { runtime } = setup(); let calls = 0;
    expect(await runtime.execute(7, pkg, 'https://example.com/', () => ({ status: 'navigating' }), command)).toEqual({ status: 'navigating' });
    await expect(runtime.execute(7, pkg, 'https://example.com/', () => { calls++; throw new Error('disconnected'); }, command)).rejects.toThrow('disconnected');
    expect(calls).toBe(1);
  });
  it('rejects undeclared targets, credentials and redirects before reinjection', async () => {
    for (const url of ['https://other.example.org/', 'javascript:void(0)', 'https://user:placeholder@example.com/', 'https://login.example.org/']) {
      const { runtime, events } = setup();
      await expect(runtime.execute(7, pkg, 'https://example.com/', () => next(url), command)).rejects.toThrow(/not allowed/);
      expect(events.filter(x => x.startsWith('https'))).toHaveLength(0);
    }
    const { runtime, events } = setup({ navigate: async () => 'https://other.example.org/' });
    await expect(runtime.execute(7, pkg, 'https://example.com/', () => next(), command)).rejects.toThrow(/not allowed/);
    expect(events.filter(x => x === 'inject')).toHaveLength(1);
  });
  it('uses the pinned write policy and permits terminal login navigation without replay', async () => {
    const writePkg = { ...pkg, commands: [{ id: 'list', safety: 'write', requires_confirmation: false }] };
    const { runtime } = setup(); let calls = 0;
    await expect(runtime.execute(7, writePkg, 'https://example.com/', () => { calls++; return next(); }, command)).rejects.toThrow(/cannot be replayed/);
    expect(calls).toBe(1);
    expect(await runtime.execute(7, writePkg, 'https://example.com/', () => next('https://login.example.org/', false), command)).toMatchObject({ status: 'navigation_complete' });
  });
  it('bounds navigation loops and detects changed packages before continuation', async () => {
    const { runtime } = setup({ maxNavigations: 2 }); let calls = 0;
    await expect(runtime.execute(7, pkg, 'https://example.com/', () => { calls++; return next(); }, command)).rejects.toThrow(/limit/);
    expect(calls).toBe(3);
    let bundles = 0, operations = 0;
    const changed = setup({ bundle: async () => { if (++bundles > 1) throw new Error('package changed'); return {}; } });
    await expect(changed.runtime.execute(7, pkg, 'https://example.com/', () => { operations++; return next(); }, command)).rejects.toThrow('package changed');
    expect(operations).toBe(1);
  });
  it('stops after navigation consumes the overall deadline', async () => {
    let clock = 0, calls = 0;
    const { runtime } = setup({ now: () => clock, timeoutMs: 50, navigate: async (_id, url) => { clock = 51; return url; } });
    await expect(runtime.execute(7, pkg, 'https://example.com/', () => { calls++; return next(); }, command)).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });
  it('waits for a same-URL reload event and removes its listener on failures', async () => {
    let listener, reads = 0, removed = 0;
    const api = { tabs: { onUpdated: { addListener: fn => { listener = fn; }, removeListener: () => { removed++; } },
      get: async () => { if (++reads === 3) listener(7, { status: 'complete' }); return { status: 'complete', url: 'https://example.com/' }; },
      reload: async () => {}, update: async () => {} } };
    expect(await navigateAdapterTab(api, 7, 'https://example.com/', pkg, true, 1000)).toBe('https://example.com/');
    expect(reads).toBeGreaterThanOrEqual(3); expect(removed).toBe(1);
    api.tabs.get = async () => { throw new Error('tab closed'); };
    await expect(navigateAdapterTab(api, 7, 'https://example.com/', pkg, true, 1000)).rejects.toThrow('tab closed');
    expect(removed).toBe(2);
  });
});

describe('read query continuation across document replacement', () => {
  const command = { id: 'search', safety: 'read', pageWorkflow: true };
  const pkg = { name: 'example.com', commands: [command] };
  function setup(result = { ok: true, data: { title: 'Example' } }) {
    const events = [];
    const runtime = createHostAdapterRuntime({ bundle: async () => ({}), prepare: async () => {}, clear: async () => {}, inject: async () => { events.push('inject'); },
      query: async () => { events.push('query'); runtime.invalidate(7); return result; } });
    return { runtime, events };
  }
  it('reinjects after the query and passes a result instead of executing the trigger again', async () => {
    const { runtime, events } = setup();
    const result = await runtime.execute(7, pkg, 'https://example.com/start', async (_remaining, continuation) => {
      events.push(continuation ? 'resume' : 'prepare');
      return continuation ? continuation.result : { __webcli_page_query: { version: 1 } };
    }, command);
    expect(result.data.title).toBe('Example'); expect(events).toEqual(['inject', 'prepare', 'query', 'inject', 'resume']);
  });
  it('never retries query errors, writes, or a handler that emits another action after resumption', async () => {
    const f = setup({ ok: false, error: { code: 'PAGE_QUERY_TIMEOUT' } });
    expect((await f.runtime.execute(7, pkg, 'https://example.com', () => ({ __webcli_page_query: { version: 1 } }), command)).error.code).toBe('PAGE_QUERY_TIMEOUT');
    expect(f.events.filter(e => e === 'query')).toHaveLength(1);
    const g = setup(); await expect(g.runtime.execute(7, pkg, 'https://example.com', () => ({ __webcli_page_query: { version: 1 } }), command)).rejects.toThrow('repeated');
    const write = { ...command, safety: 'write' };
    const h = setup(); await expect(h.runtime.execute(7, { ...pkg, commands: [write] }, 'https://example.com', () => ({ __webcli_page_query: { version: 1 } }), write)).rejects.toThrow('Invalid');
    expect(h.events).not.toContain('query');
  });
});

describe('managed BFCache recovery', () => {
  const read = { id: 'search', safety: 'read' };
  const pkg = { name: 'example.com', match: ['example.com'], commands: [read] };
  const disconnected = () => Object.assign(new Error('BFCache channel closed'), { code: 'ADAPTER_BFCACHE_DISCONNECTED' });
  function setup(overrides = {}) {
    const events = [];
    const runtime = createHostAdapterRuntime({
      bundle: async () => { events.push('bundle'); return {}; },
      prepare: async () => {},
      clear: async () => {},
      inject: async () => { events.push('inject'); },
      ready: async () => 'https://example.com/search',
      recover: async () => { events.push('recover'); },
      ...overrides,
    });
    return { runtime, events };
  }

  it('revalidates and reinjects a read after BFCache restoration', async () => {
    const { runtime, events } = setup();
    let calls = 0;
    expect(await runtime.execute(1, pkg, 'https://example.com/search', () => {
      if (++calls === 1) throw disconnected();
      return ['result'];
    }, read)).toEqual(['result']);
    expect(events).toEqual(['bundle', 'inject', 'recover', 'bundle', 'inject']);
    expect(calls).toBe(2);
  });

  it.each([
    { id: 'search', safety: 'write', requires_confirmation: false },
    { id: 'search', safety: 'write', requires_confirmation: true },
    { id: 'search', safety: 'read', requires_confirmation: true },
    { id: 'search' },
  ])('never retries an unsafe or confirmation-required policy: %j', async policy => {
    const { runtime, events } = setup();
    let calls = 0;
    await expect(runtime.execute(1, { ...pkg, commands: [policy] }, 'https://example.com/search', () => {
      calls++;
      throw disconnected();
    }, read)).rejects.toThrow('BFCache');
    expect(calls).toBe(1);
    expect(events).not.toContain('recover');
  });

  it.each([new Error('bfcache business error'), new Error('channel closed'), new Error('timed out')])('does not retry unclassified errors: %s', async error => {
    const { runtime, events } = setup();
    let calls = 0;
    await expect(runtime.execute(1, pkg, 'https://example.com/search', () => { calls++; throw error; }, read)).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(events).not.toContain('recover');
  });

  it('bounds repeated BFCache losses to two recoveries', async () => {
    const { runtime, events } = setup();
    let calls = 0;
    await expect(runtime.execute(1, pkg, 'https://example.com/search', () => { calls++; throw disconnected(); }, read)).rejects.toThrow('BFCache');
    expect(calls).toBe(3);
    expect(events.filter(event => event === 'recover')).toHaveLength(2);
  });

  it('keeps the queue locked while waiting for restoration', async () => {
    const entered = deferred();
    const finish = deferred();
    let firstCalls = 0;
    let secondCalls = 0;
    const { runtime } = setup({ recover: async () => { entered.resolve(); await finish.promise; } });
    const first = runtime.execute(1, pkg, 'https://example.com/search', () => {
      if (++firstCalls === 1) throw disconnected();
      return 'first';
    }, read);
    await entered.promise;
    const second = runtime.execute(1, pkg, 'https://example.com/search', () => { secondCalls++; return 'second'; }, read);
    await Promise.resolve();
    expect(secondCalls).toBe(0);
    finish.resolve();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
  });

  it('does not reset the deadline or execute after failed recovery', async () => {
    for (const fail of [false, true]) {
      let time = 0;
      let calls = 0;
      const { runtime } = setup({
        now: () => time,
        timeoutMs: 50,
        recover: async (_id, _pkg, url, budget) => {
          expect(url).toBe('https://example.com/search');
          expect(budget).toBe(50);
          if (fail) throw new Error('page did not return');
          time = 51;
        },
      });
      await expect(runtime.execute(1, pkg, 'https://example.com/search', () => { calls++; throw disconnected(); }, read))
        .rejects.toThrow(fail ? 'page did not return' : 'timed out');
      expect(calls).toBe(1);
    }
  });

  it('rejects a changed package before replay', async () => {
    let bundles = 0;
    let calls = 0;
    const { runtime } = setup({ bundle: async () => { if (++bundles > 1) throw new Error('package changed'); return {}; } });
    await expect(runtime.execute(1, pkg, 'https://example.com/search', () => { calls++; throw disconnected(); }, read)).rejects.toThrow('package changed');
    expect(calls).toBe(1);
  });
});

describe('BFCache page restoration wait', () => {
  const pkg = { match: ['example.com'] };
  const url = 'https://example.com/search';
  function fixture(tabs) {
    let time = 0;
    let reads = 0;
    return {
      api: { tabs: { get: async () => tabs[Math.min(reads++, tabs.length - 1)] } },
      clock: { now: () => time, sleep: async ms => { time += ms; } },
    };
  }

  it('waits until the original page is stable', async () => {
    const { api, clock } = fixture([
      { url: 'https://other.example.org/', status: 'complete' },
      { url, status: 'loading' },
      { url, status: 'complete', pendingUrl: 'https://other.example.org/' },
      { url, status: 'complete' },
      { url, status: 'complete' },
    ]);
    expect(await waitForAdapterPageRecovery(api, 1, pkg, url, 1000, clock)).toBe(url);
    expect(clock.now()).toBe(600);
  });

  it('does not accept another allowed page or wait forever', async () => {
    const { api, clock } = fixture([{ url: 'https://example.com/another', status: 'complete' }]);
    await expect(waitForAdapterPageRecovery(api, 1, pkg, url, 300, clock)).rejects.toThrow('return to the original');
    expect(clock.now()).toBe(300);
  });

  it('fails on a closed tab or disallowed starting URL', async () => {
    const { api, clock } = fixture([undefined]);
    await expect(waitForAdapterPageRecovery(api, 1, pkg, url, 300, clock)).rejects.toThrow('closed');
    await expect(waitForAdapterPageRecovery(api, 1, pkg, 'https://other.example.org/', 300, clock)).rejects.toThrow('not allowed');
  });
});
