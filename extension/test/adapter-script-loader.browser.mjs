/**
 * Real MV3 acceptance probe using a fresh test-only browser profile.
 * Run: WEWORKER_TEST_BROWSER=<browser executable> node --test <this file>
 * No user browser, accounts, live site, Bridge port or repository Adapter is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { installAdapter } from '../../webcli/adapter-install-store.js';
import { describeAdapterCatalog, readAdapterBundle } from '../../webcli/adapter-host.js';
import { resolveAdapterPaths } from '../../webcli/paths.js';
import { handleBackendRuntimeFetch } from '../../webcli/bridge.js';
import { writeAdapterPackageFromSiteMemory } from '../../webcli/adapter-scaffold.js';
import { packageDraftBundle } from '../../webcli/generation-harness/package-inspection.js';
import { validateAdapterDraft } from '../../webcli/generation-harness/static-validator.js';

test('real MV3 external Adapter injection, update, navigation and cleanup', {
  skip: !process.env.WEWORKER_TEST_BROWSER, timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'weworker-adapter-browser-'));
  const extension = join(root, 'extension');
  const profile = join(root, 'profile');
  await mkdir(extension);
  const paths = resolveAdapterPaths({ home: root, env: { WEWORKER_BUILTIN_ADAPTERS_DIR: join(root, 'empty-builtin') } });
  const installFixture = (version) => installAdapter({ files: new Map([
    ['manifest.json', JSON.stringify({ schema_version: 2, name: 'fixture', version, description: 'Browser fixture', match: ['127.0.0.1'], commands: [
      { id: 'list', runtime: 'extension', module: 'extension/commands/list.js', description: 'Read fixture', schema: {} },
      { id: 'write', aliases: ['write_item'], runtime: 'extension', module: 'extension/commands/write.js', description: 'Return fixture value', safety: 'write', schema: {} },
      { id: 'background', runtime: 'extension', module: 'extension/commands/background.js', description: 'Background fixture', safety: 'write', execution: { type: 'api', runtime: 'background' }, schema: {} },
    ] })],
    ['extension/commands/list.js', '__webcliRegisterCommand("list", async () => ' + JSON.stringify(version) + ');'],
    ['extension/commands/write.js', '__webcliRegisterCommand("write", async () => "fixture-only");'],
    ['extension/commands/background.js', '__webcliRegisterCommand("background", async args => { if (args.fail) throw new Error("fixture failure"); window.fixtureCalls = (window.fixtureCalls || 0) + 1; return __webmcpWecliRuntime.fetchJson(__webmcpWecliRuntime.getContext().fixtureUrl, {method:"POST",body:JSON.stringify({count: args.count, calls: window.fixtureCalls, version: ' + JSON.stringify(version) + '})}); });'],
  ]), origin: { kind: 'local' } }, { paths });
  installFixture('1.0.0');
  const secret = randomUUID();
  let resolveResult;
  const completion = new Promise((resolve) => { resolveResult = resolve; });
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/redirect-fixture') {
      res.writeHead(Number(requestUrl.searchParams.get('code') || 302), {
        Location: 'http://' + (requestUrl.searchParams.get('host') || '127.0.0.1') + ':' + server.address().port + '/redirect-target',
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      });
      res.end(); return;
    }
    if (requestUrl.pathname === '/redirect-target') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() })); return;
    }
    if (req.url === '/api-generation') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ title: 'Fixture item' }] }));
      return;
    }
    if (req.url === '/host/' + secret && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      try {
        const result = message.type === 'background_fixture_request' ? await handleBackendRuntimeFetch(message.payload)
          : message.type === 'adapter_catalog' ? describeAdapterCatalog({ paths })
          : message.type === 'fixture_update' ? installFixture('1.1.0') : readAdapterBundle(message.payload, { paths });
        res.end(JSON.stringify({ ok: true, result: message.type === 'fixture_update' ? {} : result }));
      } catch (error) { res.end(JSON.stringify({ ok: false, error: error.message })); }
      return;
    }
    if (req.url === '/api-fixture' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.setHeader('Content-Type', 'application/json');
      res.end(Buffer.concat(chunks));
      return;
    }
    if (req.url === '/result/' + secret && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      resolveResult(JSON.parse(Buffer.concat(chunks).toString()));
      res.end('ok');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self' http://localhost:*");
    res.end('<!doctype html><title>Adapter fixture</title><p>Local fixture</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/fixture';
  const draft = writeAdapterPackageFromSiteMemory({
    siteKey: '127.0.0.1', siteHost: '127.0.0.1', siteOrigin: new URL(url).origin,
    canonicalEntryUrl: url, listApiCandidates: [{ method: 'GET', url: url.replace('/fixture', '/api-generation') }],
  }, { outputRoot: join(root, 'drafts'), adapterPaths: paths, plan: { tools: [{ name: 'read_items', risk: 'read', sourceApiIndexes: [0] }] } });
  assert.equal(validateAdapterDraft({ adapterDir: draft.adapterDir, expectedToolNames: draft.toolNames }).passed, true);
  const generatedScripts = packageDraftBundle(draft.adapterDir).scripts;
  // Copy the production helper functions verbatim; do not start the product
  // service worker, which would connect to the user's fixed Bridge port.
  const serviceWorker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const helperNames = ['normalizeRouteHosts', 'normalizeRuntimeBrowserFetchHeaders', 'runRuntimeBrowserFetch',
    'assertRuntimeUrlAllowed', 'isRuntimeHelperHostAllowed', 'createRuntimeHelperError'];
  const helperSource = helperNames.map(name => {
    const pattern = new RegExp('^(?:async )?function ' + name + '\\(', 'm');
    const start = serviceWorker.search(pattern);
    assert.ok(start >= 0, 'Missing production helper: ' + name);
    const end = serviceWorker.indexOf('\n}', start) + 2;
    assert.ok(end > start, 'Missing helper terminator: ' + name);
    return serviceWorker.slice(start, end);
  }).join('\n') + '\nexport { runRuntimeBrowserFetch };';
  await writeFile(join(extension, 'runtime-fetch-fixture.js'), helperSource);
  const messageFunctions = ['requestBridge', 'handleNativeMessageInternal', 'handleNativeMessage'].map(name => {
    const start = serviceWorker.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
    assert.ok(start >= 0);
    const end = serviceWorker.indexOf('\n}', start) + 2;
    assert.ok(end > start);
    return serviceWorker.slice(start, end);
  }).join('\n');
  await writeFile(join(extension, 'host-response-fixture.js'), `
export function createDispatchedRequest(transport) {
  const pendingWriteRequests = new Map();
  const ws = { readyState: 1 }, WebSocket = { OPEN: 1 };
  function sendToNative(message) {
    transport(message).then(response => handleNativeMessage({ ...response, id: message.id, type: message.type + '_result' }));
  }
  ${messageFunctions}
  return message => requestBridge(message, 1000);
}`);
  const worker = `
import { createDispatchedRequest } from './host-response-fixture.js';
import { runRuntimeBrowserFetch } from './runtime-fetch-fixture.js';
import { injectAdapterSources } from './adapter-script-loader.js';
import { scopedGenerationPreviewScripts } from './generation-preview-bundle.js';
import { createHostAdapterClient } from './host-adapter-client.js';
import { createHostAdapterRuntime } from './host-adapter-runtime.js';
import { createManagedBackgroundRuntime } from './managed-background-runtime.js';
import { buildV2Bootstrap, v2InjectionFiles } from './v2-loader.js';
const url = ${JSON.stringify(url)};
const checks = [];
function check(value, label) { if (!value) throw new Error(label); checks.push(label); }
async function loaded(tabId, expectedUrl = url) {
  for (let i = 0; i < 200; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url === expectedUrl) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Fixture tab did not load');
}
async function read(tabId) {
  return (await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
    func: () => globalThis.__adapterFixture?.list(),
  }))[0].result;
}
async function run() {
  let tab = await chrome.tabs.create({ url });
  await loaded(tab.id);
  tab = await chrome.tabs.get(tab.id);
  for (const code of [301, 302, 307, 308]) {
    const response = await runRuntimeBrowserFetch(tab, { url: url.replace('/fixture', '/redirect-fixture?code=' + code) }, []);
    check(response.redirected && response.status === 200 && response.url.endsWith('/redirect-target'), 'same-host redirect ' + code);
  }
  const crossUrl = url.replace('/fixture', '/redirect-fixture?host=localhost&code=302');
  let crossDenied = false;
  try { await runRuntimeBrowserFetch(tab, { url: crossUrl }, []); }
  catch (error) { crossDenied = error.code === 'HOST_NOT_ALLOWED'; }
  check(crossDenied, 'ungranted redirected response is rejected');
  const allowed = await runRuntimeBrowserFetch(tab, { url: crossUrl }, ['localhost']);
  check(allowed.ok && new URL(allowed.url).hostname === 'localhost', 'granted cross-host redirected response succeeds');
  let initialDenied = false;
  try { await runRuntimeBrowserFetch(tab, { url: crossUrl.replace('127.0.0.1', 'localhost') }, []); }
  catch (error) { initialDenied = error.code === 'HOST_NOT_ALLOWED'; }
  check(initialDenied, 'ungranted initial URL is rejected');
  const post = await runRuntimeBrowserFetch(tab, { url: url.replace('/fixture', '/redirect-fixture?code=307'), options: { method: 'POST', body: 'fixture=007' } }, []);
  check(JSON.parse(post.body).method === 'POST' && JSON.parse(post.body).body === 'fixture=007', '307 preserves method and request body');
  let redirectError = false;
  try { await runRuntimeBrowserFetch(tab, { url: crossUrl, options: { redirect: 'error' } }, ['localhost']); }
  catch (error) { redirectError = error.code === 'BROWSER_FETCH_ERROR'; }
  check(redirectError, 'explicit redirect error fails without returning a body');
  const source = (version) => [{ path: 'extension/commands/list.js',
    source: 'globalThis.__adapterFixture = {list: () => ' + JSON.stringify(version) + '};' }];
  let rejected = false;
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, code: '1' }); }
  catch { rejected = true; }
  check(rejected, 'Chrome rejects the legacy code field');
  await injectAdapterSources({ tabId: tab.id, scripts: source('builtin'), expectedUrl: url });
  check(await read(tab.id) === 'builtin', 'builtin source executes');
  await injectAdapterSources({ tabId: tab.id, scripts: source('user'), expectedUrl: url });
  check(await read(tab.id) === 'user', 'user update replaces the test registration');
  const page = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
    func: () => typeof globalThis.__adapterFixture });
  check(page[0].result === 'undefined', 'page cannot see the extension world registration');
  await chrome.tabs.update(tab.id, { url: url + '?navigation=1' });
  await loaded(tab.id, url + '?navigation=1');
  check(await read(tab.id) == null, 'navigation discards the previous registration');
  await injectAdapterSources({ tabId: tab.id, scripts: source('navigated'), expectedUrl: url + '?navigation=1' });
  check(await read(tab.id) === 'navigated', 'navigation supports reinjection');
  await injectAdapterSources({ tabId: tab.id, scripts: [{
    path: 'extension/internal/cleanup.js', source: 'delete globalThis.__adapterFixture;',
  }] });
  check(await read(tab.id) == null, 'removal clears the test registration');
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  await chrome.debugger.detach({ tabId: tab.id });
  check(true, 'owned debugger session is released');
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/injector.js'], world: 'ISOLATED' });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/preview-registry.js'], world: 'ISOLATED' });
  await injectAdapterSources({ tabId: tab.id, scripts: [{ path: 'fixture.js', source: 'window.__webmcpGeneratedSupport = { installed: true }; window.__webmcpRegister({tools:[{name:"127.0.0.1.read-items",handler:()=>"installed-fixture"}]});' }] });
  const previewToken = crypto.randomUUID();
  check((await chrome.tabs.sendMessage(tab.id, { type: 'begin_generation_preview', token: previewToken, siteKey: '127.0.0.1' })).ok, 'task preview session opens');
  check(!(await chrome.tabs.sendMessage(tab.id, { type: 'begin_generation_preview', token: crypto.randomUUID(), siteKey: '127.0.0.1' })).ok, 'concurrent preview on the same document is rejected');
  await injectAdapterSources({ tabId: tab.id, scripts: scopedGenerationPreviewScripts(${JSON.stringify(generatedScripts)}, previewToken) });
  const generated = await chrome.tabs.sendMessage(tab.id, { type: 'call_generation_preview', token: previewToken, toolName: '127.0.0.1.read-items', args: {} });
  check(generated.result?.data?.data?.[0]?.title === 'Fixture item', 'scoped v2 draft calls loopback API');
  check((await chrome.tabs.sendMessage(tab.id, { type: 'call_tool', toolName: '127.0.0.1.read-items', args: {} })).result === 'installed-fixture', 'normal same-name handler stays active during preview');
  check(Boolean((await chrome.tabs.sendMessage(tab.id, { type: 'call_generation_preview', token: crypto.randomUUID(), toolName: '127.0.0.1.read-items', args: {} })).error), 'wrong task token cannot call preview');
  const globals = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => window.__webmcpGeneratedSupport });
  check(JSON.stringify(globals[0].result) === '{"installed":true}', 'preview runtime leaves installed package globals untouched');
  await chrome.tabs.sendMessage(tab.id, { type: 'end_generation_preview', token: previewToken });
  check(Boolean((await chrome.tabs.sendMessage(tab.id, { type: 'call_generation_preview', token: previewToken, toolName: '127.0.0.1.read-items', args: {} })).error), 'ended task loses preview handlers');
  check((await chrome.tabs.sendMessage(tab.id, { type: 'call_tool', toolName: '127.0.0.1.read-items', args: {} })).result === 'installed-fixture', 'cleanup preserves normal handler without reinjection');
  await chrome.tabs.sendMessage(tab.id, { type: 'clear_tools' });
  const request = async (message) => (await fetch(${JSON.stringify(url.replace('/fixture', '/host/' + secret))}, {
    method: 'POST', body: JSON.stringify(message),
  })).json();
  const client = createHostAdapterClient(createDispatchedRequest(request));
  const runtime = createHostAdapterRuntime({
    bundle: (manifest) => client.bundle(manifest),
    prepare: (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ['content/injector.js'], world: 'ISOLATED' }),
    clear: (tabId) => chrome.tabs.sendMessage(tabId, { type: 'clear_tools' }),
    inject: async (tabId, manifest, expectedUrl, bundle) => {
      const { internal, commands } = v2InjectionFiles(bundle.manifest, Object.keys(bundle.files));
      return injectAdapterSources({ tabId, expectedUrl, scripts: [
        { path: 'bootstrap.js', source: buildV2Bootstrap(bundle.manifest) },
        ...[...internal, ...commands].map((path) => ({ path, source: bundle.files[path] })),
      ] });
    },
  });
  const invoke = (name, args = {}) => chrome.tabs.sendMessage(tab.id, { type: 'call_tool', toolName: 'fixture.' + name, args });
  const first = (await client.manifest('fixture')).manifest;
  check(!!first?._hostSnapshot?.digest, 'production message dispatcher resolves the host catalog response');
  await runtime.execute(tab.id, first, url + '?navigation=1');
  check((await invoke('list')).result === '1.0.0', 'installed snapshot executes through the actual content injector');
  await request({ type: 'fixture_update' });
  let staleRejected = false;
  try { await client.bundle(first); } catch { staleRejected = true; }
  check(staleRejected, 'host rejects stale metadata after update');
  const second = (await client.manifest('fixture')).manifest;
  await runtime.execute(tab.id, second, url + '?navigation=1');
  check((await invoke('list')).result === '1.1.0', 'updated digest replaces registered command implementations');
  check((await invoke('write')).error?.includes('confirmation'), 'manifest write command requires confirmation');
  check((await invoke('write', { __confirmed: true })).result === 'fixture-only', 'confirmed fixture write uses the registered handler');
  const alias = await client.tool('fixture.write_item');
  check(alias.command.id === 'write' && (await invoke(alias.command.id)).error?.includes('confirmation'), 'alias resolves to the canonical handler and write gate');
  check((await invoke(alias.command.id, { __confirmed: true })).result === 'fixture-only', 'confirmed alias uses the current registered implementation');
  await chrome.tabs.sendMessage(tab.id, { type: 'clear_tools' });
  check(Boolean((await invoke('list')).error), 'clearing actual injector removes old command handlers');
  let backgroundQueue = Promise.resolve();
  const background = createManagedBackgroundRuntime({
    bundle: manifest => client.bundle(manifest),
    request: async (action, payload, context) => {
      if (action !== 'backend_fetch' || context.adapterId !== 'fixture' || payload.url !== context.fixtureUrl) throw new Error('Unexpected runtime context');
      const response = await request({type:'background_fixture_request',payload});
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
    exclusive(task) { const run = backgroundQueue.then(task, task); backgroundQueue = run.catch(() => {}); return run; },
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'managed_adapter_runtime_request') return;
    background.handleMessage(message, sender).then(result => respond({ok:true,result}), error => respond({ok:false,error:{message:error.message}}));
    return true;
  });
  const command = second.commands.find(command => command.id === 'background');
  const runBackground = args => background.execute(second, command, args, {adapterId:'fixture',fixtureUrl:url.replace('/fixture','/api-fixture')});
  const outputs = await Promise.all([runBackground({__confirmed:true,count:'007'}), runBackground({__confirmed:true,count:'008'})]);
  check(outputs[0].version === '1.1.0' && outputs[0].count === '007', 'background snapshot reaches the real Bridge HTTP helper without argument conversion');
  check(outputs.every(result => result.calls === 1), 'concurrent background calls use separate document lifecycles');
  let backgroundDenied = false;
  try { await runBackground({}); } catch (error) { backgroundDenied = error.message.includes('confirmation'); }
  check(backgroundDenied, 'background write requires confirmation before loading');
  let backgroundFailed = false;
  try { await runBackground({__confirmed:true,fail:true}); } catch (error) { backgroundFailed = error.message.includes('fixture failure'); }
  check(backgroundFailed && (await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length === 0, 'background failure closes its owned document');
  await chrome.tabs.remove(tab.id);
}
run().then(() => ({ ok: true, checks })).catch((error) => ({ ok: false, message: error.message, checks }))
  .then((result) => fetch(${JSON.stringify(url.replace('/fixture', '/result/' + secret))}, {
    method: 'POST', body: JSON.stringify(result),
  }));
`;
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Adapter local acceptance fixture', version: '1.0.0',
    permissions: ['debugger', 'scripting', 'tabs', 'offscreen'],
    host_permissions: ['http://127.0.0.1/*'],
    background: { service_worker: 'worker.js', type: 'module' },
  }));
  await writeFile(join(extension, 'worker.js'), worker);
  await copyFile(fileURLToPath(new URL('../background/adapter-script-loader.js', import.meta.url)), join(extension, 'adapter-script-loader.js'));
  for (const name of ['generation-preview-bundle.js', 'host-adapter-client.js', 'host-adapter-runtime.js', 'managed-background-runtime.js', 'v2-loader.js']) {
    await copyFile(fileURLToPath(new URL('../background/' + name, import.meta.url)), join(extension, name));
  }
  await mkdir(join(extension, 'content'));
  await mkdir(join(extension, 'offscreen'));
  await copyFile(fileURLToPath(new URL('../offscreen/managed-runner.html', import.meta.url)), join(extension, 'offscreen/managed-runner.html'));
  await copyFile(fileURLToPath(new URL('../content/injector.js', import.meta.url)), join(extension, 'content/injector.js'));
  await copyFile(fileURLToPath(new URL('../content/preview-registry.js', import.meta.url)), join(extension, 'content/preview-registry.js'));
  const child = spawn(process.env.WEWORKER_TEST_BROWSER, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + extension, '--load-extension=' + extension,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let timer;
  try {
    const result = await Promise.race([
      completion,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser extension probe timed out (extension loading may be disabled by this browser build).')), 45000); }),
      new Promise((_, reject) => { child.once('error', reject); child.once('exit', (code) => reject(new Error('Test browser exited: ' + code))); }),
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.checks.length, 38);
    console.log('Real MV3 checks:', result.checks.join('; '));
  } finally {
    clearTimeout(timer);
    try {
      const [port, endpoint] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const ws = new WebSocket('ws://127.0.0.1:' + port + endpoint);
      await Promise.race([once(ws, 'open'), new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 1500))]);
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.close();
    } catch { if (child.exitCode === null) child.kill(); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
