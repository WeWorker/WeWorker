import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { installAdapter, selectAdapter } from '../adapter-install-store.js';
import { buildRouteCatalog, buildSiteGroups } from '../auto-route-catalog.js';
import { routeRequest } from '../auto-route-decision-tree.js';
import { d3Predict } from '../auto-route-d3-client.js';
import { decisionServiceUrl } from '../decision-service-config.js';
import { completionCandidates } from '../completion.js';

let root, server;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'webcli-route-'));
  for (const [name, value] of Object.entries({ WEWORKER_BUILD_PROFILE: 'public',
    WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin'), WEWORKER_USER_ADAPTERS_DIR: join(root, 'user'),
    WEBCLI_ADAPTERS_DIR: join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: join(root, 'data'), WEBCLI_D3_URL: '' })) vi.stubEnv(name, value);
});
afterEach(async () => {
  vi.useRealTimers();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); server = undefined; }
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function install(name = 'example.com', version = '1.0.0') {
  return installAdapter({ origin: { kind: 'local' }, files: new Map([
    ['manifest.json', JSON.stringify({ schema_version: 2, name, version, description: 'Search or inspect public projects', match: [name],
      commands: ['search', 'detail'].map(id => ({ id, aliases: [id + '-old'], runtime: 'extension',
        module: `extension/commands/${id}.js`, description: id === 'search' ? 'Search projects' : 'Inspect a project',
        schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } })) })],
    ['extension/commands/search.js', 'throw new Error("Route must never execute this module");'],
    ['extension/commands/detail.js', 'throw new Error("Route must never execute this module");'],
  ]) });
}
function prediction(questions, confidence = 0.95) {
  return { answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria);
    return [id, { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) =>
      [k, keys.length === 1 ? 1 : i ? (1 - confidence) / (keys.length - 1) : confidence])) }];
  })) };
}
async function service(respond = body => prediction(body.questions)) {
  const requests = [];
  server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(respond(body)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  vi.stubEnv('WEBCLI_D3_URL', `http://127.0.0.1:${server.address().port}`);
  return requests;
}
function cli(...args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [process.env.WEBCLI_ROUTE_TEST_ENTRY || resolve('index.js'), ...args], { env: { ...process.env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
}

describe('effective route catalog', () => {
  it('keeps only selected canonical commands and exact Adapter identities', () => {
    install(); install('example.org'); install('example.com', '1.1.0');
    const adapters = buildRouteCatalog();
    expect(adapters.map(a => a.id)).toEqual(['example.com', 'example.org']);
    expect(adapters[0].version).toBe('1.1.0');
    expect(adapters[0].commands.map(c => c.name)).toEqual(['example.com.search', 'example.com.detail']);
    selectAdapter('example.com', 'disabled');
    expect(buildRouteCatalog().map(a => a.id)).toEqual(['example.org']);
  });
  it('excludes corrupt packages and never falls back to loose legacy scripts', () => {
    const installed = install();
    writeFileSync(join(installed.executionRoot, 'extension/commands/search.js'), 'changed');
    mkdirSync(join(root, 'user', 'legacy'), { recursive: true });
    writeFileSync(join(root, 'user', 'legacy', 'adapter.json'), '{"name":"legacy"}');
    expect(buildRouteCatalog()).toEqual([]);
  });
  it('balances large catalogs into small groups without loss', () => {
    const sites = Array.from({ length: 70 }, (_, i) => `site${i}.example.com`);
    const groups = buildSiteGroups(sites);
    expect(Math.max(...groups.map(g => g.length))).toBeLessThanOrEqual(9);
    expect(groups.flat().sort()).toEqual(sites.sort());
    expect(buildSiteGroups([])).toEqual([]);
  });
});

describe('routing decisions', () => {
  it('runs all three stages and recommends only the canonical command', async () => {
    install(); install('example.org');
    const predict = vi.fn(async (_state, questions) => prediction(questions));
    const result = await routeRequest('search', { adapters: buildRouteCatalog(), predict });
    expect(result.callCommand).toBe('webcli call example.com.search');
    expect(predict.mock.calls.map(c => Object.keys(c[1])[0])).toEqual(['q_g1r0', 'q_f0', 'q_c0']);
    expect(predict.mock.calls.every(c => c[0] === '用户需求: search')).toBe(true);
  });
  it('keeps a candidate from every site group until the groups can be compared', async () => {
    const adapters = Array.from({ length: 36 }, (_, i) => {
      const id = `site${String(i).padStart(2, '0')}.example.com`;
      return { id, description: id, commands: [{ id: 'search', name: `${id}.search`, description: 'Search' }] };
    });
    const correctSite = adapters[0].id;
    const predict = vi.fn(async (_state, questions) => {
      const [id, question] = Object.entries(questions)[0];
      const keys = Object.keys(question.criteria);
      expect(keys.length).toBeLessThanOrEqual(9);
      const selected = id === 'q_f0' ? correctSite : keys.includes(correctSite) ? correctSite : keys[0];
      const confidence = id === 'q_g1r0' ? 0.6 : 0.95;
      return { answers: { [id]: { type: 'choice', choice: selected, probabilities: Object.fromEntries(keys.map(key =>
        [key, key === selected ? confidence : (1 - confidence) / (keys.length - 1)])) } } };
    });
    const result = await routeRequest('search', { adapters, predict });
    expect(result.callCommand).toBe(`webcli call ${correctSite}.search`);
    expect(predict.mock.calls.find(([, questions]) => 'q_f0' in questions)[1].q_f0.criteria).toHaveProperty(correctSite);
  });
  it('skips site decisions for an exact Adapter ID', async () => {
    install(); const predict = vi.fn(async (_s, q) => prediction(q));
    await routeRequest('search', { adapters: buildRouteCatalog(), knownSite: 'example.com', predict });
    expect(predict).toHaveBeenCalledTimes(1);
  });
  it.each(['site', 'command'])('stops at low-confidence %s selection', async tier => {
    install(); install('example.org');
    const result = await routeRequest('search', { adapters: buildRouteCatalog(),
      predict: async (_s, q) => prediction(q, Object.keys(q)[0] === (tier === 'site' ? 'q_f0' : 'q_c0') ? 0.6 : 0.95) });
    expect(result.kind).toBe('low-confidence'); expect(result.stoppedAt.tier).toBe(tier);
    expect(result.callCommand).toBeUndefined();
  });
  it('rejects invented decision candidates', async () => {
    install();
    await expect(routeRequest('search', { adapters: buildRouteCatalog(), predict: async () =>
      ({ answers: { q_g1r0: { probabilities: { invented: 1 } } } }) })).rejects.toThrow('invalid candidates');
  });
  it('rejects empty or explicitly unavailable catalogs', async () => {
    await expect(routeRequest('search', { adapters: [] })).rejects.toThrow('No available');
    install(); await expect(routeRequest('search', { adapters: buildRouteCatalog(), knownSite: 'missing' })).rejects.toThrow('unavailable');
  });
});

describe('decision transport', () => {
  it('uses the configured System One protocol without authentication', async () => {
    const requests = await service();
    await d3Predict('request', { q: { type: 'choice', criteria: { a: 'A', b: 'B' } } });
    expect(requests[0].url).toBe('/v1/systemone');
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].body.model).toBe('vllm-sr/d3-flash');
    expect(requests[0].body.state).toBe('request');
  });
  it('bypasses the service for one candidate', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await d3Predict('request', { q: { criteria: { a: 'A' } } })).answers.q.choice).toBe('a');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed when the endpoint is missing', async () => {
    await expect(d3Predict('request', { q: { criteria: { a: 'A', b: 'B' } } })).rejects.toThrow('WEBCLI_D3_URL');
  });
  it.each(['ftp://example.com', 'http://user:password@example.com', 'http://example.com?key=placeholder', 'invalid'])('rejects unsafe endpoint %s', value => {
    expect(() => decisionServiceUrl(value, 'WEBCLI_D3_URL')).toThrow('WEBCLI_D3_URL');
  });
  it.each([{ a: 1 }, { a: 1.1, b: 0 }, { a: 0.9, b: 0.1, invented: 0 }])('rejects malformed probabilities %j', async probabilities => {
    await service(() => ({ answers: { q: { type: 'choice', choice: 'a', probabilities } } }));
    await expect(d3Predict('request', { q: { criteria: { a: 'A', b: 'B' } } })).rejects.toThrow('响应无效');
  });
  it.each([
    { choice: 'b', probabilities: { a: 0.95, b: 0.95 } },
    { choice: 'b', probabilities: { a: 0.9, b: 0.1 } },
    { choice: 'a', probabilities: { a: 0.6, b: 0.3 } },
  ])('rejects unnormalized or inconsistent choice responses %j', async answer => {
    await service(() => ({ answers: { q: { type: 'choice', ...answer } } }));
    await expect(d3Predict('request', { q: { criteria: { a: 'A', b: 'B' } } })).rejects.toThrow('响应无效');
  });
  it('blocks redirects and sanitizes invalid JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('private response'); } }));
    await expect(d3Predict('request', { q: { criteria: { a: 'A', b: 'B' } } }, { url: 'http://example.com' })).rejects.toThrow('not valid JSON');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });
  it('reports HTTP failure without disclosing the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(d3Predict('request', { q: { criteria: { a: 'A', b: 'B' } } }, { url: 'http://example.com' })).rejects.toThrow('HTTP 503');
  });
  it('aborts a stalled request at the 30 second deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))));
    const pending = expect(d3Predict('request', { q: { criteria: { a: 'A', b: 'B' } } }, { url: 'http://example.com' })).rejects.toThrow('Aborted');
    await vi.advanceTimersByTimeAsync(30_000); await pending;
  });
});

describe('real CLI', () => {
  it('completes the top-level route command', async () => {
    expect(await completionCandidates(['rou'], 1, { loadViews: async () => [] })).toEqual(['route']);
  });
  it('shows help without configuration or a Bridge', async () => {
    const result = await cli('route', '--help');
    expect(result.code).toBe(0); expect(result.stdout).toContain('Usage: webcli route'); expect(result.stderr).toBe('');
  });
  it.each([{ args: [] }, { args: ['--unknown'] }, { args: ['example.com'] }])('rejects missing requests or unknown options $args', async ({ args }) => {
    install(); expect((await cli('route', ...args)).code).toBe(2);
  });
  it('returns pure JSON and stderr timings without executing the Adapter', async () => {
    install(); install('example.org'); const requests = await service();
    const result = await cli('route', 'search projects', '--json', '--verbose');
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).callCommand).toBe('webcli call example.com.search');
    expect(result.stderr).toContain('q_c0'); expect(requests).toHaveLength(3);
  });
  it('renders actual required arguments and write safety from command help', async () => {
    install(); await service(); const result = await cli('route', 'example.com', 'search');
    expect(result.code).toBe(0); expect(result.stdout).toContain('--query=<string>'); expect(result.stdout).toContain('Confirmation:');
  });
  it('returns low-confidence candidates without a recommendation', async () => {
    install(); await service(body => prediction(body.questions, 0.6));
    const result = await cli('route', 'example.com', 'search', '--json');
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).kind).toBe('low-confidence');
    expect(JSON.parse(result.stdout).callCommand).toBeUndefined();
  });
  it('fails visibly without configuration and does not invent a route', async () => {
    install(); const result = await cli('route', 'example.com', 'search', '--json');
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('WEBCLI_D3_URL');
  });
  it('accepts literal request flags and the global JSON option', async () => {
    install(); const requests = await service();
    const result = await cli('route', '--output-format', 'json', 'example.com', '--', '--help');
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).kind).toBe('routed');
    expect(requests[0].body.state).toBe('用户需求: --help');
  });
});
