import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runHttpTool } from '../http-runner.js';
import { readPackageDirectory } from '../adapter-package-files.js';
import { validateV2Manifest } from '../adapter-package-validation.js';
import { installAdapter } from '../adapter-install-store.js';
import { resolveAdapterPaths } from '../paths.js';
import { managedAdapterView, managedAdapterSkill } from '../adapter-views.js';
import { ExplorationService } from '../exploration-service.js';
import { resolveAdapterCall } from '../adapter-host.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
async function fixture(source, contract = {}, safety = 'read') {
  const root = mkdtempSync(join(tmpdir(), 'http-adapter-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/items' }); res.end(); return; }
    if (req.url === '/redirect-loop') { res.writeHead(307, { location: '/redirect-loop' }); res.end(); return; }
    if (req.url === '/redirect-denied') { res.writeHead(302, { location: 'https://example.org/items' }); res.end(); return; }
    if (req.url === '/error') { res.writeHead(403); res.end('example-placeholder-secret'); return; }
    if (req.url === '/large') { res.end('x'.repeat(4 * 1024 * 1024 + 1)); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: new URL(req.url, 'http://localhost').searchParams.get('id'), body, cookie: req.headers.cookie || '', csrf: req.headers['x-csrf-token'] || '', items: ['example'] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const spec = { version: 1, strategy: 'PUBLIC_API', origins: [origin], ...contract };
  if (spec.strategy === 'COOKIE_API') spec.cookies = { origin, names: ['example_session', 'example_csrf'], csrf: { cookie: 'example_csrf', header: 'x-csrf-token', decode: true }, ...contract.cookies };
  const manifest = { schema_version: 2, name: 'example-http', version: '1.0.0', description: 'Public example HTTP adapter',
    commands: [{ id: 'read', runtime: 'http', module: 'http/commands/read.js', description: 'Read example', safety, schema: { type: 'object', properties: { id: { type: 'string' } } }, http: spec }] };
  const dir = join(root, 'builtin', manifest.name); mkdirSync(join(dir, 'http/commands'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'http/commands/read.js'), source.replaceAll('ORIGIN', JSON.stringify(origin)));
  const pkg = readPackageDirectory(dir);
  const match = { adapter: { root: dir, digest: pkg.digest }, command: pkg.commands[0] };
  const env = { ...process.env, WEWORKER_BUILD_PROFILE: 'public', WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'builtin'),
    WEWORKER_USER_ADAPTERS_DIR: join(root, 'user'), WEBCLI_ADAPTERS_DIR: join(root, 'user'), WEWORKER_ADAPTER_DATA_DIR: join(root, 'data'), WEBCLI_PROFILE: 'example-offline' };
  return { root, dir, match, manifest, requests, env, origin, pkg };
}

it('executes actual host HTTP through the CLI with no browser/Bridge and preserves string parameters', async () => {
  const f = await fixture(`module.exports = async (args, ctx) => ctx.request({url: ORIGIN + '/items?id=' + encodeURIComponent(args.id)});`);
  const { stdout } = await promisify(execFile)(process.execPath, [process.env.WEBCLI_HTTP_CLI_ENTRY || 'index.js', 'call', 'example-http.read', '--id=007', '--format=json'], { cwd: join(import.meta.dirname, '..'), env: f.env });
  expect(JSON.parse(stdout)).toMatchObject({ id: '007', items: ['example'], cookie: '' });
  expect(f.requests).toHaveLength(1);
  for (const [name, value] of Object.entries(f.env).filter(([name]) => /^(WEBCLI|WEWORKER)_/.test(name))) vi.stubEnv(name, value);
  const view = managedAdapterView('example-http');
  expect(view.adapter_type).toBe('http');
  expect(managedAdapterSkill(view)).toContain('Runs without a browser or desktop.');
});

it('supports scoped shared modules, JSON POST and text output', async () => {
  const f = await fixture(`const make = require('../internal/query.js'); module.exports = (args, ctx) => ctx.request({url: ORIGIN + '/items', method: 'POST', json: make(args)});`);
  mkdirSync(join(f.dir, 'http/internal')); writeFileSync(join(f.dir, 'http/internal/query.js'), `module.exports = args => ({query: args.id});`);
  f.match.adapter.digest = readPackageDirectory(f.dir).digest;
  const value = await runHttpTool(f.match, { id: '0009' });
  expect(JSON.parse(value.result.body)).toEqual({ query: '0009' });
  expect(f.requests[0].headers['content-type']).toBe('application/json');
});

it('keeps Node capabilities and cross-realm constructors out of adapter code', async () => {
  const f = await fixture(`module.exports = (args, api) => {
    const tries = [() => api.request.constructor('return process')(), () => args.constructor.constructor('return process')(),
      () => globalThis.constructor.constructor('return process')(), () => new URL('https://example.com').constructor.constructor('return process')()];
    return {blocked: tries.map(fn => { try { fn(); return false; } catch { return true; } }), process: typeof process,
      bridge: typeof bridge, urlBridge: typeof __urlBridge, requireNode: (() => { try { require('node:fs'); return true; } catch { return false; } })()};
  };`);
  expect((await runHttpTool(f.match)).result).toEqual({ blocked: [true, true, true, true], process: 'undefined', bridge: 'undefined', urlBridge: 'undefined', requireNode: false });
});

it('obtains cookies for each request URL, maps CSRF, and redacts echoed credentials', async () => {
  const f = await fixture(`module.exports = (args, ctx) => ctx.request({url: ORIGIN + '/items?id=007'});`, { strategy: 'COOKIE_API' });
  const resolveCookies = vi.fn(async () => [{ name: 'example_session', value: 'example-placeholder-session' }, { name: 'example_csrf', value: 'example%20csrf' }]);
  const { result } = await runHttpTool(f.match, {}, { resolveCookies });
  expect(resolveCookies).toHaveBeenCalledWith({ url: f.origin + '/items?id=007', names: ['example_session', 'example_csrf'] });
  expect(f.requests[0].headers.cookie).toBe('example_session=example-placeholder-session; example_csrf=example%20csrf');
  expect(f.requests[0].headers['x-csrf-token']).toBe('example csrf');
  expect(JSON.stringify(result)).not.toContain('placeholder-session');
  expect(result.csrf).toBe('[REDACTED]');
  await expect(runHttpTool(f.match)).rejects.toMatchObject({ code: 'HTTP_CREDENTIALS_REQUIRED' });
  await expect(runHttpTool(f.match, {}, { resolveCookies: async () => [] })).rejects.toMatchObject({ code: 'HTTP_CREDENTIALS_MISSING' });
  expect(f.requests).toHaveLength(1);
});

it.each([
  [`{url: 'https://example.org/items'}`, 'HTTP_ORIGIN_DENIED'],
  [`{url: ORIGIN + '/redirect-denied'}`, 'HTTP_ORIGIN_DENIED'],
  [`{url: ORIGIN + '/error'}`, 'HTTP_AUTH_REQUIRED'],
  [`{url: ORIGIN + '/large'}`, 'HTTP_RESPONSE_LIMIT'],
  [`{url: ORIGIN + '/items', headers: {Cookie: 'example-placeholder'}}`, 'HTTP_INVALID_HEADERS'],
  [`{url: ORIGIN + '/items', method: 'DELETE'}`, 'HTTP_METHOD_DENIED'],
])('rejects invalid requests without retry: %s', async (input, code) => {
  const f = await fixture(`module.exports = (args, ctx) => ctx.request(${input});`);
  await expect(runHttpTool(f.match)).rejects.toMatchObject({ code });
  expect(f.requests.length).toBeLessThanOrEqual(1);
});

it('follows declared redirects, resolves credentials by each path, converts POST 302 to GET and bounds loops', async () => {
  const f = await fixture(`module.exports = (args, api) => api.request({url: ORIGIN + '/redirect', method: 'POST', json: {id:'example'}});`, {strategy:'COOKIE_API'});
  const resolveCookies = vi.fn(async ({url}) => [{name:'example_session',value:new URL(url).pathname === '/redirect' ? 'example-first-path' : 'example-second-path'}, {name:'example_csrf',value:'example-csrf'}]);
  await runHttpTool(f.match, {}, {resolveCookies});
  expect(f.requests.map(x => x.method)).toEqual(['POST', 'GET']);
  expect(f.requests[1].body).toBe('');
  expect(f.requests[1].headers.cookie).toContain('example-second-path');
  expect(f.requests[1].headers.cookie).not.toContain('example-first-path');
  expect(resolveCookies).toHaveBeenCalledTimes(2);
  const loop = await fixture(`module.exports = (args, api) => api.request({url: ORIGIN + '/redirect-loop'});`);
  await expect(runHttpTool(loop.match)).rejects.toMatchObject({code:'HTTP_REDIRECT'});
  expect(loop.requests).toHaveLength(6);
});

it('terminates CPU loops and hung responses; aborts without replay', async () => {
  const f = await fixture('module.exports = () => { while (true) {} };');
  await expect(runHttpTool(f.match, {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'HTTP_TIMEOUT' });
  const slow = await fixture(`module.exports = (args, ctx) => ctx.request({url: ORIGIN + '/slow'});`);
  await expect(runHttpTool(slow.match, {}, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'HTTP_TIMEOUT' });
  expect(slow.requests).toHaveLength(1);
  const controller = new AbortController(); controller.abort();
  await expect(runHttpTool(slow.match, {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'HTTP_ABORTED' });
  expect(slow.requests).toHaveLength(1);
});

it('checks package snapshots and confirmation before sending a write', async () => {
  const f = await fixture(`module.exports = (args, ctx) => ctx.request({url: ORIGIN + '/items', method: 'POST', json: {id: args.id}});`, {}, 'write');
  await expect(runHttpTool(f.match, { id: 'example' })).rejects.toMatchObject({ code: 'HTTP_CONFIRMATION_REQUIRED' });
  expect(f.requests).toHaveLength(0);
  await runHttpTool(f.match, { id: 'example', __confirmed: true });
  expect(f.requests).toHaveLength(1);
  writeFileSync(join(f.dir, 'http/commands/read.js'), 'module.exports = () => "changed";');
  await expect(runHttpTool(f.match, { __confirmed: true })).rejects.toMatchObject({ code: 'HTTP_STALE_PACKAGE' });
});

it('does not follow write redirects or dispatch a second write request, and rejects unfinished requests', async () => {
  const redirect = await fixture(`module.exports = (args, api) => api.request({url: ORIGIN + '/redirect-loop', method:'PUT', json:{title:'Example'}});`, {}, 'write');
  await expect(runHttpTool(redirect.match, { __confirmed: true })).rejects.toMatchObject({ code: 'HTTP_REDIRECT' });
  expect(redirect.requests).toHaveLength(1);
  const twice = await fixture(`module.exports = async (args, api) => { await api.request({url: ORIGIN + '/items',method:'PUT'}); return api.request({url: ORIGIN + '/items',method:'PUT'}); };`, {}, 'write');
  await expect(runHttpTool(twice.match, { __confirmed: true })).rejects.toMatchObject({ code: 'HTTP_REQUEST_LIMIT' });
  expect(twice.requests).toHaveLength(1);
  const pending = await fixture(`module.exports = (args, api) => { api.request({url: ORIGIN + '/slow',method:'PUT'}); return {ok:true}; };`, {}, 'write');
  await expect(runHttpTool(pending.match, { __confirmed: true })).rejects.toMatchObject({ code: 'HTTP_UNSETTLED_REQUESTS' });
});

it('requires new installation permissions for origins and cookie names', async () => {
  const f = await fixture(`module.exports = () => null;`);
  const paths = resolveAdapterPaths({ home: f.root, env: f.env });
  installAdapter({ files: f.pkg.files, origin: { kind: 'local' } }, { paths });
  const next = structuredClone(f.manifest); next.version = '1.1.0';
  next.commands[0].http = { version: 1, strategy: 'COOKIE_API', origins: [f.origin, 'https://example.com'], cookies: { origin: f.origin, names: ['example_session'] } };
  const files = new Map(f.pkg.files); files.set('manifest.json', JSON.stringify(next));
  expect(() => installAdapter({ files, origin: { kind: 'local' } }, { paths })).toThrow(/permission/i);
  expect(() => installAdapter({ files, origin: { kind: 'local' }, allowPermissionChange: true }, { paths })).not.toThrow();
});

it('rejects invalid or cross-runtime contracts before loading code', async () => {
  const f = await fixture(`module.exports = () => null;`);
  for (const spec of [null, {version: 2}, {version: 1, strategy: 'PUBLIC_API', origins: ['https://example.com/']},
    {version: 1, strategy: 'COOKIE_API', origins: ['https://example.com'], cookies: {origin: 'https://example.org', names: ['example']}}]) {
    const manifest = structuredClone(f.manifest); manifest.commands[0].http = spec;
    expect(() => validateV2Manifest(manifest)).toThrow();
  }
  f.manifest.commands[0].runtime = 'extension';
  expect(() => validateV2Manifest(f.manifest)).toThrow(/HTTP runtime/);
});

it.each(['PUBLIC_API', 'AUTH_API'])('generates %s, verifies every authored case against real HTTP, repairs assertions and installs', async strategy => {
  vi.stubEnv('EXAMPLE_HTTP_GENERATION_KEY', 'example-generation-placeholder');
  const f = await fixture('module.exports = () => null;');
  const auth = strategy === 'AUTH_API' ? { auth: { type: 'bearer', origin: f.origin, env: 'EXAMPLE_HTTP_GENERATION_KEY' } } : {};
  const paths = resolveAdapterPaths({ home: f.root, env: f.env });
  const requestExtension = vi.fn(async msg => {
    if (msg.type === 'exploration_list_tabs') return { tabs: [{ id: 7, url: f.origin + '/' }] };
    if (msg.type === 'exploration_capture_passive') return { network: { entries: [{ url: f.origin + '/api/list?id=example', method: 'GET', status: 200,
      responseContentType: 'application/json', responsePreview: JSON.stringify({ id: 'example', items: ['example'] }) }] } };
    if (msg.type === 'refresh_adapter_tabs') return {};
    throw new Error('No extension execution is permitted for HTTP previews: ' + msg.type);
  });
  const service = new ExplorationService({ paths, rootDir: join(f.root, 'tasks'), requestExtension,
    capabilities: () => ({ connected: true, capabilities: ['passive_exploration_v1', 'strict_output_contract_v1'] }) });
  const started = await service.execute('start', { tabId: 7, goal: 'Read public example items', requestId: 'example-http' });
  expect(started.ok).toBe(true); const taskId = started.data.taskId;
  await service.jobs.get(taskId);
  const generated = await service.execute('generate', { taskId, plan: { tools: [{ name: 'host_items', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0],
    strategy, ...auth, readReason: 'Observed GET list request', strategyNote: { reason: 'Public example endpoint', limitations: 'Validate without browser credentials' } }] } });
  expect(generated).toMatchObject({ ok: true, data: { status: 'draft' } });
  const tool = '127.0.0.1.host-items';
  expect((await service.execute('validate', { taskId })).error.code).toBe('VERIFICATION_REQUIRED');
  const cases = Array.from({ length: 7 }, (_, index) => ({ id: 'example-' + index, args: { id: '00' + index }, expect: { equals: { id: index === 6 ? 'wrong' : '00' + index } } }));
  const saveCases = async () => {
    const before = await service.execute('verification-read', { taskId, tool });
    expect((await service.execute('verification-write', { taskId, tool, cases, expectedHash: before.data.hash })).ok).toBe(true);
  };
  await saveCases(); await service.execute('validate', { taskId }); await service.jobs.get(taskId);
  expect(service.runs.get(taskId).runtimeSummary).toMatchObject({ passed: false, executionSummary: { attempted: 7, passed: 6, failed: 1 } });
  cases[6].expect.equals.id = '006'; await saveCases();
  await service.execute('validate', { taskId }); await service.jobs.get(taskId);
  expect(service.runs.get(taskId).status).toBe('review_ready');
  const review = await service.execute('review', { taskId });
  const install = await service.execute('install', { taskId, reviewId: review.data.reviewId, confirmed: true });
  expect(install.ok).toBe(true); await service.jobs.get(taskId);
  expect(service.runs.get(taskId).status).toBe('installed');
  const match = resolveAdapterCall(tool, { paths });
  expect((await runHttpTool(match, { id: '007' })).result.id).toBe('007');
  expect(f.requests).toHaveLength(15);
  expect(f.requests.every(req => req.headers.authorization === (strategy === 'AUTH_API' ? 'Bearer example-generation-placeholder' : undefined))).toBe(true);
  expect(requestExtension.mock.calls.some(([msg]) => msg.type === 'validate_generation_preview')).toBe(false);

  const repairStart = await service.execute('start', { tabId: 7, goal: 'Repair public example mapping', requestId: 'example-http-repair' });
  const repairId = repairStart.data.taskId; await service.jobs.get(repairId);
  const repaired = await service.execute('repair', { taskId: repairId, site: match.adapter.name, expectedDigest: match.adapter.digest,
    plan: { tools: [{ name: 'host-items', strategy, ...auth, risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [0],
      readReason: 'Observed read-only GET', strategyNote: { reason: 'Repair the same public endpoint' } }] } });
  expect(repaired.ok).toBe(true);
  const repairBefore = await service.execute('verification-read', { taskId: repairId, tool });
  expect((await service.execute('verification-write', { taskId: repairId, tool, expectedHash: repairBefore.data.hash, cases: [cases[0]] })).ok).toBe(true);
  const file = 'http/commands/host-items.js'; const source = await service.execute('draft-read', { taskId: repairId, file });
  expect((await service.execute('draft-write', { taskId: repairId, file, expectedHash: source.data.hash,
    content: source.data.content.replace('return api.request(request);', 'const result = await api.request(request); return {id: result.id, repaired: true};') })).ok).toBe(true);
  await service.execute('validate', { taskId: repairId }); await service.jobs.get(repairId);
  expect(service.runs.get(repairId).status).toBe('review_ready');
  const repairReview = await service.execute('review', { taskId: repairId });
  expect((await service.execute('install', { taskId: repairId, reviewId: repairReview.data.reviewId, confirmed: true })).ok).toBe(true);
  await service.jobs.get(repairId);
  const current = resolveAdapterCall(tool, { paths });
  expect((await runHttpTool(current, { id: '007' })).result).toEqual({ id: '007', repaired: true });
});

it('normalizes declared HTTP numbers for flags and JSON while preserving IDs and invalid input',async()=>{
 const f=await fixture(`module.exports = async args => {if(!Number.isSafeInteger(args.page)||args.page<1)throw Object.assign(Error('invalid page'),{code:'INVALID_ARGS'});return args;}`);
 f.manifest.commands[0].schema.properties={id:{type:'string'},page:{type:'integer'},size:{type:['integer','null']},mixed:{type:['integer','string']},ratio:{type:'number'}};
 writeFileSync(join(f.dir,'manifest.json'),JSON.stringify(f.manifest));
 const args={id:'007',page:2,size:3,mixed:'004',ratio:0.5};
 const cli=process.env.WEBCLI_HTTP_CLI_ENTRY||'index.js';
 const run=async input=>{const {trace_id,...result}=JSON.parse((await promisify(execFile)(process.execPath,[cli,'call','example-http.read',...input,'--output-format=json'],{cwd:join(import.meta.dirname,'..'),env:f.env})).stdout);return result;};
 expect(await run(['--id=007','--page=2','--size=3','--mixed=004','--ratio=0.5'])).toEqual(args);
 expect(await run(['--args',JSON.stringify(args)])).toEqual(args);
 for(const value of ['0','-1','1.5','bad','9007199254740993'])await expect(run(['--page='+value])).rejects.toThrow();
 expect(f.requests).toHaveLength(0);
});
