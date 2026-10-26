#!/usr/bin/env node
// Real Chromium + unpacked extension + CLI/Bridge acceptance. No desktop or model.
// Pass --playwright=/absolute/path/to/playwright/index.mjs when not installed locally.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBrowserEvents } from './browser-events-acceptance.mjs';
import { verifyBrowserAx } from './browser-ax-acceptance.mjs';
import { verifyBrowserScreenshots } from './browser-screenshot-acceptance.mjs';
import { verifyBrowserShadow } from './browser-shadow-acceptance.mjs';
import { verifyBrowserCompounds } from './browser-compound-acceptance.mjs';
import { verifyBrowserUploads } from './browser-upload-acceptance.mjs';
import { verifyBrowserProfiles } from './browser-profile-acceptance.mjs';
import { verifyHostHttp } from './http-acceptance.mjs';
import { verifyPageNavigation } from './page-navigation-acceptance.mjs';
import { verifyOriginNavigation } from './origin-navigation-acceptance.mjs';
import { verifyWorkflowControl } from './workflow-control-acceptance.mjs';
import { verifyHashNavigation } from './hash-navigation-acceptance.mjs';
import { verifyQueryNavigation } from './query-navigation-acceptance.mjs';
import { verifyPageWorkflow } from './page-workflow-acceptance.mjs';
import { verifyUiWrites } from './ui-write-acceptance.mjs';
import { verifyExtensionWrites } from './extension-write-acceptance.mjs';
import { verifyPageWriteRepairs } from './page-write-repair-acceptance.mjs';
import { verifyPageSharedRepair } from './page-shared-repair-acceptance.mjs';
import { verifyBackgroundApi } from './background-api-acceptance.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcli-browser-acceptance-'));
const copy = path.join(root, 'webcli');
const extension = path.join(root, 'extension');
const checks = [];
const browserEvents = [];
let browser, bridge, server;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exec = promisify(execFile);
async function unusedPort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function record(name, value) {
  await fs.writeFile(path.join(root, `${name}.json`), JSON.stringify(value, null, 2));
}
function passed(check) { checks.push(check); console.log(`PASS ${check}`); }
console.log(`Artifacts: ${root}`);
try {
  await (async () => {
  const playwrightPath = process.argv.find(arg => arg.startsWith('--playwright='))?.slice(13);
  const executablePath = process.argv.find(arg => arg.startsWith('--chromium='))?.slice(11);
  const { chromium } = await import(playwrightPath ? pathToFileURL(playwrightPath).href : 'playwright');
  await fs.cp(source, copy, { recursive: true, filter: entry => !['node_modules', '__tests__', 'extension', 'adapters', 'e2e-results'].includes(path.basename(entry)) });
  await fs.symlink(path.join(source, 'node_modules'), path.join(copy, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.cp(path.resolve(source, '../weworker/build/extension-dist'), extension, { recursive: true });
  const bridgePort = await unusedPort();
  // Only temporary copies change transport port; production protocol/code stays intact.
  for (const file of [path.join(copy, 'index.js'), path.join(copy, 'bridge.js'), path.join(copy, 'exploration-client.js'), path.join(extension, 'background/service-worker.js')]) {
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll('3711', String(bridgePort)));
  }
  // Daemon PID/log discovery must also stay away from the user's global service.
  let cliEntry = path.join(copy, 'index.js');
  await fs.writeFile(cliEntry, (await fs.readFile(cliEntry, 'utf8')).replaceAll('homedir()', JSON.stringify(path.join(root, 'cli-config-root'))));
  if (process.argv.includes('--bundled-cli')) {
    cliEntry = path.join(copy, 'webcli.cjs');
    await fs.writeFile(cliEntry, (await fs.readFile(path.resolve(source, '../weworker/build/webcli-dist/webcli.cjs'), 'utf8'))
      .replaceAll('3711', String(bridgePort))
      .replace(/\(0, import_os\d+\.homedir\)\(\)|\bimport_(?:node_)?os\d*\.default\.homedir\(\)/g, JSON.stringify(path.join(root, 'cli-config-root'))));
  }
  const env = { ...process.env, WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'), WEBCLI_ADAPTERS_DIR: path.join(root, 'user'),
    WEBCLI_BRIDGE_PORT: String(bridgePort), WEWORKER_WEBCLI_DISTRIBUTION: 'desktop', WEWORKER_BROWSER_MODE: 'system',
    WEWORKER_BROWSER_HOME: path.join(root, 'browser-state'), WEBCLI_METRICS: 'off', WEBCLI_METRICS_UPLOAD: 'off',
    WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'), WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'builtin'), WEWORKER_BUILD_PROFILE: 'public',
    EXAMPLE_HTTP_ACCEPTANCE_KEY: 'example-host-auth-placeholder' };
  delete env.WEWORKER_RESOURCES_PATH;
  await fs.mkdir(env.WEWORKER_BUILTIN_ADAPTERS_DIR);
  await fs.writeFile(path.join(copy, 'acceptance-bridge.mjs'), "import { WebSocketBridge } from './bridge.js'; new WebSocketBridge();\n");
  let bridgeArgs = [path.join(copy, 'acceptance-bridge.mjs')];
  if (process.argv.includes('--bundled-bridge')) {
    const bridgeEntry = path.join(copy, 'bridge.cjs');
    await fs.writeFile(bridgeEntry, (await fs.readFile(path.resolve(source, '../weworker/build/bridge-dist/bridge.cjs'), 'utf8'))
      .replaceAll('3711', String(bridgePort))
      .replace(/\(0, import_os\d+\.homedir\)\(\)|\bimport_(?:node_)?os\d*\.default\.homedir\(\)/g, JSON.stringify(path.join(root, 'cli-config-root'))));
    bridgeArgs = [bridgeEntry, '--service'];
  }
  async function startBridge() {
    const log = await fs.open(path.join(root, 'bridge.log'), 'a');
    bridge = spawn(process.execPath, bridgeArgs, { env, stdio: ['ignore', log.fd, log.fd] });
    await log.close();
    for (let i = 0; i < 50; i++) {
      const ready = await new Promise(resolve => { const socket = net.connect(bridgePort, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); });
      if (ready) return;
      assert.equal(bridge.exitCode, null, 'Bridge exited during startup');
      await delay(100);
    }
    throw new Error('Bridge did not listen');
  }
  // A first-use CLI must keep daemon startup messages out of its JSONL stdout.
  // This temp config is new and owns the daemon PID written by this invocation.
  try {
    let firstUse;
    try { firstUse = await exec(process.execPath, [cliEntry, 'call', 'browser.console', '--session=example-first-use', '--follow', '--durationMs=1000'], {env,timeout:15000}); }
    catch (error) { firstUse = error; }
    const lines = firstUse.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length,1); assert.equal(lines[0].event,'error');
    assert.ok(firstUse.stderr.includes('Bridge not running'));
    passed('first-use daemon startup preserves JSONL stdout');
  } finally {
    const pid = Number(await fs.readFile(path.join(root, 'cli-config-root/.webcli/service.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid,'SIGTERM');
    for(let i=0;i<50;i++) {
      try { process.kill(pid,0); } catch { break; }
      await delay(100);
    }
  }
  await startBridge();
  async function cli(command, args = {}, expectedOk = true) {
    let result;
    try { result = await exec(process.execPath, [cliEntry, 'call', command, '--args', JSON.stringify(args), '--output-format=json'], { env, timeout: 95000, maxBuffer: 3_000_000 }); }
    catch (error) { if (expectedOk) throw error; result = error; }
    const output = JSON.parse(result.stdout);
    if (command.startsWith('exploration.') || command.startsWith('browser.')) assert.equal(output.ok, expectedOk, JSON.stringify(output));
    return output;
  }
  const html = `<!doctype html><title>Example inventory</title><h1>Example inventory</h1>
    <form role="search"><input id="query" type="search" placeholder="Search items" aria-label="Search items"><button type="submit">Search</button></form>
    <button id="next" aria-label="Next page">Next page</button><pre id="items"></pre>
    <label><input id="checked" type="checkbox">Example checkbox</label>
    <select id="options"><option value="one">One</option><option value="two">Two</option></select>
    <button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
    <input id="upload" type="file" style="display:none"><button id="trusted" onclick="window.exampleTrusted=event.isTrusted">Trusted click</button>
    <div id="drag" style="display:inline-block;width:60px;height:40px;background:lightblue">Drag</div>
    <div id="drop" style="display:inline-block;width:60px;height:40px;background:lightgreen">Drop</div>
    <script>document.querySelector('#drag').onpointerdown=()=>window.exampleDragging=true;document.querySelector('#drop').onpointerup=()=>window.exampleDropped=window.exampleDragging;</script>
    <script>let page=1; async function load(){const response=await fetch('/api/items?q='+encodeURIComponent(document.querySelector('#query').value)+'&page='+page+'&limit=2');document.querySelector('#items').textContent=JSON.stringify(await response.json());}
    document.querySelector('form').onsubmit=e=>{e.preventDefault();page=1;load()};document.querySelector('#next').onclick=()=>{page++;load()};load();
    fetch('/api/post-search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyword:'Example'})});
    fetch('/api/form-query',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'keyword=Example'});
    fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query Items { items { id } }',variables:{keyword:'Example'}})});
    </script>`;
  const apiRequests = [];
  const postRequests = [];
  const detailRequests = [];
  const signedRequests = [];
  const queryProofs = new Set();
  let failApi = false;
  let renamedItemField = false;
  let renamedPageField = false;
  let fallbackUnavailable = false, fallbackRequests = 0;
  const downloadResponses = new Map(), downloadRequests = [];
  const downloadBody = 'Public example download\n';
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const port = server.address().port;
    if (url.pathname === '/download-page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Example downloads</title><a id="quick-download" href="/downloads/example.txt">Download example</a><a id="slow-download" href="/downloads/slow.txt">Slow download</a><a id="cancel-download" href="/downloads/cancel.txt">Interrupted download</a><iframe src="http://localhost:${port}/download-frame"></iframe>`);
    } else if (url.pathname === '/download-frame') {
      res.writeHead(200, { 'content-type': 'text/html' });res.end('<!doctype html><title>Example download frame</title><a id="frame-download" href="/downloads/frame.txt">Frame download</a><a id="frame-download-native" href="/downloads/frame-native.txt">Native frame download</a>');
    } else if (url.pathname.startsWith('/downloads/')) {
      downloadRequests.push(url.pathname);
      // Explicit MIME prevents a tiny held response waiting for Chrome's text sniffing before a download exists.
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="example-${url.pathname.split('/').at(-1)}"`, 'content-length': Buffer.byteLength(downloadBody) });
      if (['/downloads/slow.txt', '/downloads/cancel.txt'].includes(url.pathname)) { res.write(downloadBody.slice(0, 7)); downloadResponses.set(url.pathname, res); }
      else res.end(downloadBody);
    } else if (url.pathname === '/frame-host') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Example frame host</title><style>iframe{width:450px;height:360px;border:12px solid gray;margin:30px;transform:scale(.85) rotate(3deg)}</style><button id="frame-button">Main</button><iframe name="example-first" src="http://localhost:${port}/frame-child"></iframe><iframe name="example-second" src="http://localhost:${port}/frame-child"></iframe>`);
    } else if (url.pathname === '/frame-child' || url.pathname === '/frame-inner') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'self'; object-src 'none'" });
      res.end(`<!doctype html><title>Example ${url.pathname === '/frame-child' ? 'child' : 'nested'} frame</title><h1>Example frame content</h1><button id="frame-button">Frame button</button><input id="frame-input" aria-label="Frame input"><div id="frame-drag" style="display:inline-block;width:80px;height:25px;background:lightblue">Drag</div><div id="frame-drop" style="display:inline-block;width:80px;height:25px;background:lightgreen">Drop</div><script src="/frame-script.js"></script>${url.pathname === '/frame-child' ? `<iframe name="example-inner" style="height:250px;border:8px solid gray;transform:scale(.9)" src="http://127.0.0.1:${port}/frame-inner"></iframe><iframe name="example-same" src="/frame-inner"></iframe>` : ''}`);
    } else if (url.pathname === '/frame-script.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('window.exampleFrameCount=0;document.querySelector("#frame-button").onclick=e=>{window.exampleFrameCount++;window.exampleFrameTrusted=e.isTrusted};document.querySelector("#frame-button").onpointerover=e=>window.exampleHoverTrusted=e.isTrusted;document.querySelector("#frame-button").ondblclick=e=>window.exampleDoubleTrusted=e.isTrusted;document.querySelector("#frame-drag").onpointerdown=e=>window.exampleDragging=e.isTrusted;document.querySelector("#frame-drop").onpointerup=e=>window.exampleDropped=window.exampleDragging&&e.isTrusted;Object.getOwnPropertyDescriptor=()=>{window.exampleProbeHooked=true;throw new Error("Example page hook must not run during frame selection")};');
    } else if (url.pathname === '/fallback-only') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Example fallback</title><article class="fallback-row"><h3>Example stable visible item</h3></article><script>fetch("/api/fallback-list").then(r=>r.json());fetch("/api/telemetry/search").then(r=>r.json())</script>');
    } else if (url.pathname === '/api/fallback-list') {
      fallbackRequests++;
      res.writeHead(fallbackUnavailable ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(fallbackUnavailable ? { error: 'Example API unavailable' } : { data: { items: [{ id: 'example-row', title: 'Example stable visible item' }] } }));
    } else if (url.pathname === '/api/telemetry/search') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"events":[{"name":"example-event"}]}');
    } else if (['/query-start', '/query-results'].includes(url.pathname)) {
      const keyword = url.searchParams.get('q') || 'Initial example';
      const escaped = keyword.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>Example document query</title><form action="/query-results" method="get"><input id="page-query" type="search" name="q" aria-label="Search public items" value="${escaped}"><button id="page-submit">Search</button></form><article class="query-row"><h3>${escaped}</h3></article>
        <script>document.querySelector('form').onsubmit=()=>{const queries=JSON.parse(sessionStorage.getItem('exampleQuerySubmissions')||'[]');queries.push(document.querySelector('#page-query').value);sessionStorage.setItem('exampleQuerySubmissions',JSON.stringify(queries))};</script>`);
    } else if (url.pathname === '/intercept-only') {
      const seed = crypto.randomUUID();
      for (let i = 1; i <= 100; i++) queryProofs.add(seed + ':' + i);
      const apiOrigin = `http://localhost:${server.address().port}`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Example signed query</title>
        <form id="signed-get"><input id="signed-query" type="search" aria-label="Search example items"><button id="signed-submit">Search</button></form>
        <form id="signed-post"><input id="signed-post-query" type="search" aria-label="Search example POST items"><button id="signed-post-submit">Search</button></form><pre id="result"></pre>
        <script>(()=>{let n=0;const seed=${JSON.stringify(seed)};
          async function query(method,keyword){
            if(keyword==='example-navigation'){location.href='/intercept-only?reload=1';return;}
            if(keyword==='example-timeout')return;
            const run=async(q)=>fetch(${JSON.stringify(apiOrigin)}+'/api/signed-search'+(method==='GET'?'?q='+encodeURIComponent(q):''),{method,
              headers:{'x-example-proof':seed+':'+(++n),...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify({keyword:q})}:{})}).then(r=>r.json());
            const response=await run(keyword); document.querySelector('#result').textContent=JSON.stringify(response);
            if(keyword==='example-duplicate')await run(keyword);
            history.replaceState(null,'','?q='+encodeURIComponent(keyword));
          }
          document.querySelector('#signed-get').onsubmit=e=>{e.preventDefault();query('GET',document.querySelector('#signed-query').value)};
          document.querySelector('#signed-post').onsubmit=e=>{e.preventDefault();query('POST',document.querySelector('#signed-post-query').value)};
          query('GET','Example initial');query('POST','Example initial POST');
        })();</script>`);
    } else if (url.pathname === '/api/signed-search') {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-example-proof,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        const valid = queryProofs.delete(req.headers['x-example-proof']);
        const keyword = req.method === 'POST' ? JSON.parse(body || '{}').keyword : url.searchParams.get('q');
        signedRequests.push({ valid, keyword, method: req.method });
        res.writeHead(!valid ? 403 : keyword === 'example-http-error' ? 503 : 200, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(valid ? { data: { keyword, method: req.method, items: [{ title: keyword }] } } : { error: 'Example page proof required' }));
      });
    } else if (/^\/api\/groups\/[^/]+\/items\/[^/]+(?:\/query)?$/.test(url.pathname)) {
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        const parts = url.pathname.split('/').map(decodeURIComponent);
        const payload = body ? JSON.parse(body) : {};
        const data = { groupId: parts[3], itemId: parts[5], lang: url.searchParams.get('lang'), term: payload.term || url.searchParams.get('term') };
        detailRequests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: payload });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data }));
      });
    } else if (url.pathname === '/page-only') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>Example static inventory</title><h1>Static inventory</h1>
        <ul id="rows"><li class="item"><a class="${renamedPageField ? 'heading' : 'title'}" href="/items/1">Example first</a></li><li class="item"><a class="${renamedPageField ? 'heading' : 'title'}" href="/items/2">Example second</a></li></ul><p id="empty" hidden>No items</p>
        <script>window.examplePageState={items:[{id:'example-1',title:'Example first'},{id:'example-2',title:'Example second'}]};</script>
        <script id="json-data" type="application/json">{"items":[{"id":"example-json","title":"Example JSON item"}]}</script>`);
    } else if (['/api/post-search', '/api/form-query', '/graphql'].includes(url.pathname)) {
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        const data = url.pathname === '/api/form-query' ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
        postRequests.push({ path: url.pathname, data });
        const valid = url.pathname === '/graphql' ? /^query/.test(data.query || '') : typeof data.keyword === 'string';
        res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(valid ? { data: { items: [{ id: 'example-post', title: data.keyword || data.variables?.keyword || 'Example' }] } } : { error: 'Expected authored query parameters' }));
      });
    } else if (url.pathname === '/api/items') {
      const q = url.searchParams.get('q') || ''; const page = Number(url.searchParams.get('page') || 1);
      apiRequests.push({ q, page });
      const unavailable = failApi || q === 'example-http-error';
      res.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(unavailable ? { error: 'Example service unavailable' }
        : { data: { items: q === 'example-empty' ? [] : [{ id: `example-${page}`, [renamedItemField ? 'title' : 'name']: q || 'Example item' }], page, total: 4 } }));
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function launchContext(profile, options = {}) {
    const viaCdp = process.argv.includes('--cdp-extension');
    const context = await chromium.launchPersistentContext(path.join(root, profile), { channel: 'chromium', executablePath,
      ignoreDefaultArgs: ['--disable-extensions'], headless: true, ...options,
      args: [...(viaCdp ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]),
        '--host-resolver-rules=MAP shared-repair.example.org 127.0.0.1,MAP background.example.org 127.0.0.1', '--no-proxy-server'] });
    // Chrome 137+ needs CDP loading. Do not combine it with legacy extension
    // allowlist flags: they can leave a loaded extension without a running worker.
    if (viaCdp) {
      try {
        const cdp = await context.browser().newBrowserCDPSession();
        await cdp.send('Extensions.loadUnpacked', { path: extension });
        await cdp.detach();
      } catch (error) { await context.close(); throw error; }
    }
    return context;
  }
  browser = await launchContext('browser-profile', { acceptDownloads: true, downloadsPath: path.join(root, 'downloads') });
  browser.on('console', message => {
    if (message.location().url.startsWith('chrome-extension://') && browserEvents.length < 2000)
      browserEvents.push({ type: 'extension-console', level: message.type(), message: message.text() });
  });
  browser.on('page', current => {
    current.on('framenavigated', frame => { if (frame === current.mainFrame()) browserEvents.push({ at: Date.now(), type: 'navigation', url: frame.url() }); });
    current.on('pageerror', error => browserEvents.push({ type: 'error', message: error.message }));
  });
  const page = await browser.newPage();
  page.on('dialog', () => {}); // The extension handles dialogs; disable Playwright's automatic dismissal.
  await page.goto(origin);
  async function connected() {
    for (let i = 0; i < 30; i++) {
      const status = await cli('profile.list');
      if (status.data.profiles.some(item => item.online)) return;
      await delay(500);
    }
    throw new Error('Extension did not connect');
  }
  await connected(); passed('standalone extension connected');
  const backgroundApi = () => verifyBackgroundApi({ browser, cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--background-only')) { await backgroundApi(); return; }
  const profiles = () => verifyBrowserProfiles({ browser, cliEntry, env, record, passed,
    launchSecond: () => launchContext('browser-profile-second'),
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--profiles-only')) { await profiles(); return; }
  const hostHttp = () => verifyHostHttp({ browser, cliEntry, env, root, record, passed,
    launchSecond: () => launchContext('http-profile-second'),
  });
  if (process.argv.includes('--http-only')) { await hostHttp(); return; }
  const hashNavigation = () => verifyHashNavigation({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  const workflowControl = () => verifyWorkflowControl({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  const originNavigation = () => verifyOriginNavigation({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--origins-only')) { await originNavigation(); return; }
  if (process.argv.includes('--control-only')) { await workflowControl(); return; }
  if (process.argv.includes('--hash-only')) { await hashNavigation(); return; }
  if (process.argv.includes('--navigation-only')) { await verifyPageNavigation({ cli, record, passed }); await verifyQueryNavigation({ cli, record, passed }); return; }
  const pageWorkflow = () => verifyPageWorkflow({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--workflow-only')) { await pageWorkflow(); return; }
  const pageWrites = () => verifyExtensionWrites({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  const uiWrites = () => verifyUiWrites({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--ui-write-only')) { await uiWrites(); return; }
  if (process.argv.includes('--page-write-only')) { await pageWrites(); return; }
  const pageRepairs = () => verifyPageWriteRepairs({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--page-repair-only')) { await pageRepairs(); return; }
  const sharedRepair = () => verifyPageSharedRepair({ cli, record, passed,
    stopBridge: async () => { const closed = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await closed; },
    startBridge: async () => { await startBridge(); await connected(); },
  });
  if (process.argv.includes('--shared-repair-only')) { await sharedRepair(); return; }
  if (process.argv.includes('--origins-shared-only')) { await originNavigation(); await sharedRepair(); return; }

  const tabs = (await cli('exploration.tabs')).data.tabs;
  const tabId = tabs.find(tab => tab.url === origin + '/').id;
  assert.equal((await cli('browser.doctor')).data.ready, true);
  await cli('browser.bind', { session: 'acceptance', tabId });
  const browserCall = (command, args = {}, expectedOk = true) => cli(`browser.${command}`, { session: 'acceptance', ...args }, expectedOk);
  await browserCall('eval', { expression: "fetch('/api/items?q=example-monitor').then(r=>r.json()).then(()=>true)" });
  // The default business filter classifies URLs containing monitor as telemetry.
  // Explicit detail lookup must still resolve keys returned by an all listing.
  const monitorEntry = (await browserCall('network', { all: true, match: 'example-monitor' })).data.entries[0];
  assert.ok(monitorEntry);
  assert.equal((await browserCall('network', { match: 'example-monitor' })).data.entries.length, 0);
  const monitorDetail = await browserCall('network', { detail: monitorEntry.key });
  assert.ok(monitorDetail.data.entry.response.data.items.length);
  assert.equal((await browserCall('network', { detail: 'example-missing-request' }, false)).error.code, 'NETWORK_ENTRY_EXPIRED');
  passed('all-traffic request key resolves detail without the default business filter; missing keys remain rejected');
  if (process.argv.includes('--network-detail-only')) return;
  if(!['--downloads-only','--events-only','--ax-only','--screenshots-only','--shadow-only','--compounds-only'].some(flag=>process.argv.includes(flag)))await verifyBrowserUploads({cli,root,record,passed});
  if(process.argv.includes('--uploads-only'))return;
  if(!['--downloads-only','--events-only','--ax-only','--screenshots-only','--shadow-only'].some(flag=>process.argv.includes(flag)))await verifyBrowserCompounds({cli,root,record,passed});
  if(process.argv.includes('--compounds-only'))return;
  if(!['--downloads-only','--events-only','--ax-only','--screenshots-only'].some(flag=>process.argv.includes(flag)))await verifyBrowserShadow({cli,record,passed});
  if(process.argv.includes('--shadow-only'))return;
  if (!['--downloads-only','--events-only','--ax-only'].some(flag=>process.argv.includes(flag))) {
    await verifyBrowserScreenshots({cli,root,record,passed,setZoom:(tabId,zoom)=>browser.serviceWorkers()[0].evaluate(({tabId,zoom})=>chrome.tabs.setZoom(tabId,zoom),{tabId,zoom})});
  }
  if(process.argv.includes('--screenshots-only'))return;
  if (!process.argv.includes('--downloads-only') && !process.argv.includes('--events-only')) {
    await verifyBrowserAx({cli,record,passed});
  }
  if (process.argv.includes('--ax-only')) return;
  if (!process.argv.includes('--downloads-only')) {
    await verifyBrowserEvents({cli,cliEntry,env,record,passed,
      stopBridge:async()=>{const closed=new Promise(resolve=>bridge.once('exit',resolve));bridge.kill('SIGTERM');await closed;},
      startBridge:async()=>{await startBridge();await connected();},
      detach:async tabId=>{await browser.serviceWorkers()[0].evaluate(tabId=>chrome.debugger.detach({tabId}),tabId);await delay(100);},
    });
  }
  if (process.argv.includes('--events-only')) return;
  if (!process.argv.includes('--downloads-only')) {
  await browserCall('network');
  const state = (await browserCall('state')).data;
  assert.ok(state.elements.some(element => element.role === 'searchbox'));
  const staleRef = state.elements[0].ref;
  await browserCall('find', { selector: '#query' });
  assert.equal((await browserCall('click', { ref: staleRef }, false)).error.code, 'STALE_REF');
  assert.equal((await browserCall('click', { selector: '.duplicate' }, false)).error.code, 'AMBIGUOUS_TARGET');
  await browserCall('fill', { role: 'searchbox', name: 'Search items', value: 'Example browser' });
  await browserCall('type', { selector: '#query', value: ' append' });
  assert.equal((await browserCall('get', { selector: '#query', property: 'value' })).data.value, 'Example browser append');
  await browserCall('check', { selector: '#checked' }); await browserCall('uncheck', { selector: '#checked' });
  await browserCall('select', { selector: '#options', value: 'Two' });
  assert.equal((await browserCall('get', { selector: '#options', property: 'value' })).data.value, 'two');
  await browserCall('focus', { selector: '#query' }); await browserCall('keys', { key: 'Enter' });
  await browserCall('wait', { kind: 'xhr', value: '/api/items' });
  const browserNetwork = (await browserCall('network')).data;
  const entry = browserNetwork.entries.find(entry => new URL(entry.url).pathname === '/api/items');
  assert.ok(entry);
  assert.ok((await browserCall('network', { detail: entry.key })).data.entry.response.data.items.length);
  assert.ok((await browserCall('extract')).data.text.includes('Example inventory'));
  assert.ok((await browserCall('frames')).data.frames.some(frame => frame.frameId === 0));
  assert.equal((await browserCall('eval', { expression: 'document.title' })).data.value, 'Example inventory');
  assert.ok((await browserCall('screenshot')).data.data.length > 100);
  await browserCall('hover', { selector: '#next' }); await browserCall('scroll', { direction: 'down' });
  await browserCall('click', { selector: '#trusted' });
  assert.equal((await browserCall('eval', { expression: 'window.exampleTrusted' })).data.value, true);
  await browserCall('drag', { selector: '#drag', toSelector: '#drop' });
  assert.equal((await browserCall('eval', { expression: 'window.exampleDropped' })).data.value, true);
  const uploadPath = path.join(root, 'example-upload.txt'); await fs.writeFile(uploadPath, 'Public example upload');
  await browserCall('upload', { selector: '#upload', paths: [uploadPath] });
  assert.equal((await browserCall('eval', { expression: "document.querySelector('#upload').files[0].name" })).data.value, 'example-upload.txt');
  await browserCall('eval', { expression: "console.info('Example console message'); true" });
  assert.ok((await browserCall('console', { level: 'info' })).data.entries.some(entry => entry.text === 'Example console message'));
  const pendingPrompt = browserCall('eval', { expression: "window.exampleDialog=prompt('Example prompt')" });
  // Reply through a second CLI process while the first still owns the session.
  let dialog;
  for (let i = 0; i < 20; i++) { dialog = (await browserCall('dialog')).data.dialog; if (dialog) break; await delay(100); }
  assert.equal(dialog?.type, 'prompt');
  await browserCall('dialog', { action: 'accept', text: 'Example answer' });
  assert.equal((await pendingPrompt).data.value, 'Example answer');
  assert.equal((await browserCall('eval', { expression: 'window.exampleDialog' })).data.value, 'Example answer');
  await browserCall('eval', { expression: "document.body.style.minHeight='2200px';true" });
  const screenshot = Buffer.from((await browserCall('screenshot', { fullPage: true })).data.data, 'base64');
  assert.ok(screenshot.readUInt32BE(20) >= 2200, 'Full-page PNG covers page height');
  await browserCall('eval', { expression: "document.body.style.minHeight='';true" });
  assert.ok((await browserCall('network', { match: '/api/items' })).data.entries.every(entry => entry.url.includes('/api/items')));
  assert.equal((await browserCall('open', { url: origin }, false)).error.code, 'BOUND_TAB_NAVIGATION');
  await browserCall('close'); assert.equal(page.isClosed(), false);
  await cli('browser.open', { session: 'owned', url: origin });
  assert.equal((await cli('browser.state', { session: 'owned' })).data.title, 'Example inventory');
  assert.equal((await cli('browser.close', { session: 'owned' })).data.tabClosed, true);
  passed('browser sessions, trusted pointer and drag, upload, dialogs, console, locators, forms, keyboard, network, frames, eval and full-page screenshot');
  await cli('browser.open', { session: 'frame-acceptance', url: origin + '/frame-host' });
  const frameCall = (command, args = {}, ok = true) => cli(`browser.${command}`, { session: 'frame-acceptance', ...args }, ok);
  const frameList = (await frameCall('frames')).data.frames;
  await record('browser-frames', frameList);
  const children = frameList.filter(frame => new URL(frame.url).pathname === '/frame-child');
  const nested = frameList.filter(frame => new URL(frame.url).pathname === '/frame-inner');
  assert.equal(children.length, 2); assert.equal(nested.length, 4);
  const selectFrame = frame => ({ frameId: frame.frameId, documentId: frame.documentId });
  const names = [];
  for (const child of children) {
    const selected = selectFrame(child);
    const name = (await frameCall('eval', { ...selected, expression: 'Promise.resolve(window.name)' })).data.value; names.push(name); child.name = name;
    assert.equal((await frameCall('eval', { ...selected, expression: '++window.exampleFrameCount' })).data.value, 1);
    await frameCall('fill', { ...selected, selector: '#frame-input', value: name });
    assert.equal((await frameCall('get', { ...selected, selector: '#frame-input', property: 'value' })).data.value, name);
    assert.equal((await frameCall('click', { ...selected, selector: '#frame-button' })).data.trusted, true);
    assert.equal((await frameCall('eval', { ...selected, expression: 'window.exampleFrameCount' })).data.value, 2);
    assert.equal((await frameCall('eval', { ...selected, expression: 'window.exampleFrameTrusted' })).data.value, true);
    assert.equal((await frameCall('eval', { ...selected, expression: 'window.exampleProbeHooked === true' })).data.value, false);
    assert.ok((await frameCall('state', selected)).data.text.includes('Example frame content'));
  }
  assert.deepEqual(names.sort(), ['example-first', 'example-second']);
  for (const inner of nested) {
    assert.ok(['example-inner', 'example-same'].includes((await frameCall('eval', { ...selectFrame(inner), expression: 'window.name' })).data.value));
    await frameCall('click', { ...selectFrame(inner), selector: '#frame-button' });
    assert.equal((await frameCall('eval', { ...selectFrame(inner), expression: 'window.exampleFrameTrusted' })).data.value, true);
    await frameCall('hover', { ...selectFrame(inner), selector: '#frame-button' });
    await frameCall('dblclick', { ...selectFrame(inner), selector: '#frame-button' });
    await frameCall('drag', { ...selectFrame(inner), selector: '#frame-drag', toSelector: '#frame-drop' });
    assert.deepEqual((await frameCall('eval', { ...selectFrame(inner), expression: '({hover:window.exampleHoverTrusted,double:window.exampleDoubleTrusted,drag:window.exampleDropped})' })).data.value, {hover:true,double:true,drag:true});
  }
  for (const child of children) await frameCall('eval', { ...selectFrame(child), expression: 'const cover=document.createElement("div");cover.id="child-cover";cover.style="position:fixed;inset:0;background:white;z-index:2147483647";document.body.append(cover);true' });
  assert.equal((await frameCall('click', { ...selectFrame(nested[0]), selector: '#frame-button' }, false)).error.code, 'ELEMENT_OBSCURED');
  for (const child of children) await frameCall('eval', { ...selectFrame(child), expression: 'document.querySelector("#child-cover").remove();true' });
  await frameCall('hover', { ...selectFrame(children[1]), selector: '#frame-input' });
  await frameCall('eval', { ...selectFrame(children[1]), expression: 'document.querySelector("#frame-button").onpointerover=e=>{e.currentTarget.style.marginLeft="80px"};true' });
  assert.equal((await frameCall('click', { ...selectFrame(children[1]), selector: '#frame-button' }, false)).error.code, 'POINTER_TARGET_CHANGED');
  assert.equal((await frameCall('eval', { ...selectFrame(children[1]), expression: 'window.exampleFrameCount' })).data.value, 2);
  await frameCall('eval', { ...selectFrame(children[1]), expression: 'const button=document.querySelector("#frame-button");button.onpointerover=null;button.style.marginLeft="";true' });
  await frameCall('eval', { expression: 'const cover=document.createElement("div");cover.id="pointer-cover";cover.style="position:fixed;inset:0;background:white;z-index:2147483647";document.body.append(cover);true' });
  assert.equal((await frameCall('click', { ...selectFrame(children[0]), selector: '#frame-button' }, false)).error.code, 'ELEMENT_OBSCURED');
  await frameCall('eval', { expression: 'document.querySelector("#pointer-cover").remove();true' });
  assert.equal((await frameCall('click', { ...selectFrame(children[0]), documentId: children[1].documentId, selector: '#frame-button' }, false)).error.code, 'FRAME_DOCUMENT_CHANGED');
  assert.equal((await frameCall('eval', { ...selectFrame(children[0]), documentId: children[1].documentId, expression: 'window.exampleWrongTarget=true' }, false)).error.code, 'FRAME_DOCUMENT_CHANGED');
  await frameCall('eval', { ...selectFrame(children[0]), expression: 'document.querySelector("#frame-button").onpointerover=()=>{location.href="/frame-inner?pointer-navigation=1"};true' });
  const movedOnHover=await frameCall('click', { ...selectFrame(children[0]), selector: '#frame-button' }, false);
  assert.ok(['FRAME_DOCUMENT_CHANGED','POINTER_OPERATION_INTERRUPTED','POINTER_TARGET_CHANGED'].includes(movedOnHover.error.code),JSON.stringify(movedOnHover));
  passed('native frame click/hover/double-click/drag across scaled rotated and nested same/cross-origin frames; ancestor overlays and navigation rejected');
  assert.equal((await frameCall('eval', { expression: 'window.exampleFrameCount ?? null' })).data.value, null);
  const liveChild = children[1];
  const thrown = await frameCall('eval', { ...selectFrame(liveChild), expression: 'throw new Error("Example frame failure")' }, false);
  assert.equal(thrown.error.code, 'EVALUATION_FAILED');
  assert.equal((await frameCall('eval', { ...selectFrame(liveChild), expression: 'Promise.reject(new Error("Example async failure"))' }, false)).error.code, 'EVALUATION_FAILED');
  assert.equal((await frameCall('eval', { ...selectFrame(liveChild), expression: 'new Promise(() => {})' }, false)).error.code, 'FRAME_EVALUATION_INTERRUPTED');
  assert.equal((await frameCall('eval', { expression: 'document.title' })).data.value, 'Example frame host');
  await frameCall('eval', { expression: `document.querySelector(${JSON.stringify(`iframe[name="${children[0].name}"]`)}).src="/frame-inner?changed=1";true` });
  await delay(300);
  const staleFrame = await frameCall('eval', { ...selectFrame(children[0]), expression: 'window.exampleWrongTarget=true' }, false);
  assert.equal(staleFrame.error.code, 'FRAME_UNAVAILABLE');
  const changedFrames = (await frameCall('frames')).data.frames;
  for (const frame of changedFrames) {
    const probe = (await frameCall('eval', { ...selectFrame(frame), expression: '({wrong:window.exampleWrongTarget===true,markers:Object.getOwnPropertyNames(window).filter(k=>k.startsWith("__weworkerFrame_")).length})' })).data.value;
    assert.deepEqual(probe, { markers: 0, wrong: false });
  }
  await frameCall('close');
  passed('duplicate-URL and nested cross-origin frame eval under CSP, document guards, frame forms and stale-navigation rejection');
  }

  await cli('browser.open', { session: 'download-acceptance', url: origin + '/download-page' });
  const downloadCall = (command, args = {}, ok = true) => cli(`browser.${command}`, { session: 'download-acceptance', ...args }, ok);
  const initialDownloads = (await downloadCall('downloads')).data;
  const pendingDownload = downloadCall('wait', { kind: 'download', value: 'example-example.txt', after: initialDownloads.cursor, timeoutMs: 10000 });
  await delay(100);
  await downloadCall('click', { selector: '#quick-download' });
  const completedDownload = (await pendingDownload).data;
  assert.equal(completedDownload.downloaded, true); assert.equal(completedDownload.state, 'complete');
  assert.equal(completedDownload.suggestedFilename, 'example-example.txt');
  assert.equal(completedDownload.fileResolved, true); assert.equal(await fs.readFile(completedDownload.filename, 'utf8'), downloadBody);
  const afterFirstDownload = (await downloadCall('downloads')).data.cursor;
  assert.equal((await downloadCall('wait', { kind: 'download', after: afterFirstDownload, timeoutMs: 0 }, false)).error.details.state, 'not_seen');
  await cli('browser.open', { session: 'download-other', url: origin + '/download-page' });
  await cli('browser.click', { session: 'download-other', selector: '#quick-download' });
  assert.equal((await cli('browser.wait', { session: 'download-other', kind: 'download', value: 'example-example.txt' })).data.downloaded, true);
  assert.equal((await downloadCall('wait', { kind: 'download', after: afterFirstDownload, timeoutMs: 0 }, false)).error.code, 'DOWNLOAD_TIMEOUT');
  await cli('browser.close', { session: 'download-other' });
  await downloadCall('click', { selector: '#slow-download' });
  const pendingSlow = await downloadCall('wait', { kind: 'download', value: 'example-slow.txt', timeoutMs: 300 }, false);
  await record('download-progress', { pendingSlow, requests: downloadRequests, observed: (await downloadCall('downloads')).data,
    chrome: await browser.serviceWorkers()[0].evaluate(() => chrome.downloads.search({ urlRegex: '/downloads/slow\\.txt$' })) });
  assert.equal(pendingSlow.error.details.state, 'in_progress');
  const slowId = pendingSlow.error.details.download.downloadId;
  const downloadBridgeExited = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await downloadBridgeExited;
  await startBridge(); await connected();
  assert.equal((await downloadCall('downloads', { downloadId: slowId })).data.downloads[0].state, 'in_progress');
  downloadResponses.get('/downloads/slow.txt').end(downloadBody.slice(7));
  assert.equal((await downloadCall('wait', { kind: 'download', downloadId: slowId })).data.downloaded, true);
  assert.equal(downloadRequests.filter(item => item === '/downloads/slow.txt').length, 1, 'Waiting must not trigger a second download');
  await downloadCall('click', { selector: '#cancel-download' });
  const pendingCancel = await downloadCall('wait', { kind: 'download', value: 'example-cancel.txt', timeoutMs: 300 }, false);
  assert.equal(pendingCancel.error.details.state, 'in_progress');
  // External user cancellation is the stimulus; observation still runs through CLI.
  const extensionWorker = browser.serviceWorkers()[0];
  await extensionWorker.evaluate(async () => { const items = await chrome.downloads.search({ urlRegex: '/downloads/cancel\\.txt$', state: 'in_progress' }); if (items.length !== 1) throw Error('Expected one example pending download'); await chrome.downloads.cancel(items[0].id); });
  downloadResponses.get('/downloads/cancel.txt').destroy();
  assert.equal((await downloadCall('wait', { kind: 'download', downloadId: pendingCancel.error.details.download.downloadId }, false)).error.code, 'DOWNLOAD_INTERRUPTED');
  const downloadFrame = (await downloadCall('frames')).data.frames.find(frame => frame.url.endsWith('/download-frame'));
  await downloadCall('click', { frameId: downloadFrame.frameId, documentId: downloadFrame.documentId, selector: '#frame-download' });
  await record('download-frame', { requests: downloadRequests, observed: (await downloadCall('downloads')).data,
    chrome: await browser.serviceWorkers()[0].evaluate(() => chrome.downloads.search({ urlRegex: '/downloads/frame\\.txt$' })) });
  assert.equal((await downloadCall('wait', { kind: 'download', value: 'example-frame.txt' })).data.downloaded, true);
  // Daily Chrome may require user activation; exercise the native keyboard path too.
  await downloadCall('focus', { frameId: downloadFrame.frameId, documentId: downloadFrame.documentId, selector: '#frame-download-native' });
  await downloadCall('keys', { key: 'Enter' });
  assert.equal((await downloadCall('wait', { kind: 'download', value: 'example-frame-native.txt' })).data.downloaded, true);
  const duplicateCursor = (await downloadCall('downloads')).data.cursor;
  await downloadCall('click', { selector: '#quick-download' });await downloadCall('click', { selector: '#quick-download' });
  const ambiguousDownload = await downloadCall('wait', { kind: 'download', after: duplicateCursor, value: 'example-example.txt' }, false);
  assert.equal(ambiguousDownload.error.code, 'DOWNLOAD_AMBIGUOUS');
  assert.equal(ambiguousDownload.error.details.matches.length, 2);
  await record('browser-download', completedDownload);
  await downloadCall('close');
  passed('tab-scoped downloads: cursor, concurrent trigger, exact saved bytes, progress/resume across Bridge restart, cancellation, cross-frame and ambiguity');
  if (process.argv.includes('--browser-only') || process.argv.includes('--downloads-only')) return;
  const args = { tabId, goal: '查询示例列表，支持关键词和分页', requestId: 'example-browser-acceptance' };
  const start = await cli('exploration.start', args); const taskId = start.data.taskId;
  assert.equal((await cli('exploration.start', args)).data.taskId, taskId);
  passed('idempotent CLI start');
  async function settle(id = taskId) {
    for (let i = 0; i < 90; i++) {
      const state = (await cli('exploration.get', { taskId: id })).data;
      if (!['collecting', 'validating', 'installing'].includes(state.status)) { await record('latest-state', state); return state; }
      await delay(1000);
    }
    throw new Error('Task did not settle');
  }
  assert.equal((await settle()).status, 'evidence_ready');
  const actions = (await cli('exploration.actions', { taskId })).data;
  await record('actions', actions);
  const search = actions.candidates.find(action => action.kind === 'search');
  assert.ok(search, 'Search control discovered');
  await cli('exploration.probe', { taskId, candidateId: search.id, value: 'Example search' });
  assert.equal((await settle()).status, 'evidence_ready');
  assert.ok(apiRequests.some(request => request.q === 'Example search'));
  passed('safe search probe triggers real API');
  await cli('exploration.collect', { taskId }); await settle();
  const evidence = (await cli('exploration.evidence', { taskId })).data;
  await record('evidence', evidence);
  assert.ok(!JSON.stringify(evidence).includes('Example search'));
  const sourceIndex = evidence.candidates.findIndex(candidate => new URL(candidate.url).pathname === '/api/items');
  assert.ok(sourceIndex >= 0);
  assert.equal(evidence.candidates[sourceIndex].responseHints.listPath, 'data.items');
  passed('capture and collect preserve structure without values');
  const generated = await cli('exploration.generate', { taskId, plan: { tools: [{ name: 'search_items', purpose: '查询示例列表与分页', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [sourceIndex] }] } });
  await record('generated', generated);
  const files = (await cli('exploration.draft-read', { taskId })).data.files;
  for (const file of files) await record(`draft-${file.replaceAll('/', '_')}`, (await cli('exploration.draft-read', { taskId, file })).data);
  const manifest = (await cli('exploration.draft-read', { taskId, file: 'manifest.json' })).data;
  const stale = await cli('exploration.draft-write', { taskId, file: 'manifest.json', expectedHash: 'stale', content: manifest.content }, false);
  assert.equal(stale.error.code, 'STALE_DRAFT');
  // Exercise the same hash-guarded authoring interface used by any calling agent.
  const authored = JSON.parse(manifest.content); authored.description = 'Example inventory read queries';
  await cli('exploration.draft-write', { taskId, file: 'manifest.json', expectedHash: manifest.hash, content: JSON.stringify(authored, null, 2) + '\n' });
  passed('agent draft read/write and stale hash rejection');
  const moduleFile = authored.commands.find(command => command.id === 'search-items').module;
  const module = (await cli('exploration.draft-read', { taskId, file: moduleFile })).data;
  await cli('exploration.draft-write', { taskId, file: moduleFile, expectedHash: module.hash, content: module.content + '\n{' });
  await cli('exploration.validate', { taskId });
  const failed = await settle();
  assert.equal(failed.status, 'draft'); assert.equal(failed.validation.passed, false);
  const broken = (await cli('exploration.draft-read', { taskId, file: moduleFile })).data;
  const authoredCode = module.content.replace('...{},', 'page: 1, limit: 2,');
  assert.notEqual(authoredCode, module.content);
  await cli('exploration.draft-write', { taskId, file: moduleFile, expectedHash: broken.hash, content: authoredCode });
  passed('invalid JavaScript rejected and repaired through CLI');
  failApi = true;
  await cli('exploration.validate', { taskId });
  const runtimeFailure = await settle(); await record('runtime-failure', runtimeFailure);
  assert.equal(runtimeFailure.status, 'draft');
  assert.equal(runtimeFailure.runtimeValidation.passed, false);
  assert.equal(runtimeFailure.runtimeValidation.executionSummary.failed, 1);
  assert.ok(runtimeFailure.runtimeValidation.errors.length > 0);
  assert.equal((await cli('exploration.review', { taskId }, false)).error.code, 'VALIDATION_REQUIRED');
  failApi = false;
  passed('runtime HTTP failure blocks review until successful revalidation');
  await cli('exploration.validate', { taskId });
  const validated = await settle(); await record('validation', validated);
  assert.equal(validated.status, 'review_ready', JSON.stringify(validated));
  assert.deepEqual(validated.runtimeValidation.executionSummary, { attempted: 1, passed: 1, skipped: 0, failed: 0 });
  passed('real browser preview validation');
  const verificationTool = generated.data.toolNames[0];
  const verificationCases = Array.from({ length: 6 }, (_, index) => ({ id: `page-${index + 1}`,
    args: { q: 'Example verified query', page: index + 1, limit: 2 },
    expect: { requiredPaths: ['data.data.items.*.id'], types: { 'data.data.items.*.name': 'string' },
      patterns: { 'data.data.items.*.id': '^example-[0-9]+$' }, notEmpty: ['data.data.items.*.name'],
      equals: { 'data.data.page': index + 1 }, rowCount: { path: 'data.data.items', min: 1, max: 2 } } }));
  async function setVerification(cases) {
    const current = (await cli('exploration.verification-read', { taskId, tool: verificationTool })).data;
    return cli('exploration.verification-write', { taskId, tool: verificationTool, expectedHash: current.hash, cases });
  }
  const badCases = structuredClone(verificationCases); badCases[5].expect.equals['data.data.page'] = 99;
  await setVerification(badCases); await cli('exploration.validate', { taskId });
  const wrongExpectation = await settle();
  assert.equal(wrongExpectation.status, 'draft');
  assert.deepEqual(wrongExpectation.runtimeValidation.executionSummary, { attempted: 6, passed: 5, skipped: 0, failed: 1 });
  assert.ok(wrongExpectation.runtimeValidation.errors.some(error => error.code === 'OUTPUT_VALUE_MISMATCH' && error.caseId === 'page-6'));
  await setVerification(verificationCases); await cli('exploration.validate', { taskId });
  const verifiedCases = await settle(); assert.equal(verifiedCases.status, 'review_ready');
  assert.deepEqual(verifiedCases.runtimeValidation.executionSummary, { attempted: 6, passed: 6, skipped: 0, failed: 0 });
  passed('six authored verification cases execute in batches; semantic failure blocks installation until repaired');
  const review = (await cli('exploration.review', { taskId })).data; await record('review', review);
  assert.equal((await cli('exploration.install', { taskId, reviewId: review.reviewId }, false)).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await cli('exploration.install', { taskId, reviewId: 'stale', confirmed: true }, false)).error.code, 'STALE_REVIEW');
  await cli('exploration.install', { taskId, reviewId: review.reviewId, confirmed: true });
  assert.equal((await settle()).status, 'installed');
  passed('review-bound installation into isolated adapter root');
  const savedKnowledge = (await cli('exploration.knowledge-read', { site: review.name })).data;
  await cli('exploration.knowledge-save', { taskId, expectedHash: savedKnowledge.hash,
    fields: { 'items.id': { meaning: 'Example item identifier', source: 'Observed public example list' } }, notes: 'Keyword and six pages verified through ordinary read queries.' });
  const knowledge = (await cli('exploration.knowledge-read', { site: review.name })).data;
  assert.equal(knowledge.stale, false);
  assert.equal(knowledge.knowledge.commands[verificationTool].cases.length, 6);
  assert.equal((await cli('exploration.verification-read', { taskId, tool: verificationTool })).data.cases.length, 6);
  passed('verified endpoint, field and authored cases persist as site knowledge after installation');
  const output = await cli(generated.data.toolNames[0], { q: 'Example final', page: 2, limit: 2 });
  await record('ordinary-call', output);
  assert.ok(apiRequests.some(request => request.q === 'Example final' && request.page === 2), JSON.stringify(output));
  assert.ok(JSON.stringify(output).includes('example-2'), JSON.stringify(output));
  passed('ordinary webcli call executes installed search and pagination');
  const empty = await cli(generated.data.toolNames[0], { q: 'example-empty' });
  assert.equal(empty.ok, true); assert.deepEqual(empty.data.data.items, []);
  const unavailable = await cli(generated.data.toolNames[0], { q: 'example-http-error' }, false);
  assert.equal(unavailable.ok, false); assert.equal(unavailable.status, 503);
  passed('ordinary calls handle empty data and HTTP errors');
  const events = (await cli('exploration.events', { taskId, cursor: 0 })).data;
  assert.ok(events.events.some(event => event.status === 'installed'));
  passed('persisted event history');
  const incrementalId = (await cli('exploration.start', { ...args, requestId: 'example-incremental' })).data.taskId;
  assert.equal((await settle(incrementalId)).status, 'evidence_ready');
  const incrementalEvidence = (await cli('exploration.evidence', { taskId: incrementalId })).data;
  const incrementalIndex = incrementalEvidence.candidates.findIndex(candidate => new URL(candidate.url).pathname === '/api/items');
  const incremental = await cli('exploration.generate', { taskId: incrementalId, plan: { tools: [{ name: 'list_items', purpose: '列出示例项目', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [incrementalIndex] }] } });
  assert.equal((await cli('exploration.draft-read', { taskId: incrementalId, file: moduleFile })).data.content, authoredCode);
  await cli('exploration.validate', { taskId: incrementalId });
  const incrementalValidation = await settle(incrementalId);
  assert.equal(incrementalValidation.status, 'review_ready', JSON.stringify(incrementalValidation));
  assert.deepEqual(incrementalValidation.runtimeValidation.executionSummary, { attempted: 1, passed: 1, skipped: 0, failed: 0 });
  const incrementalReview = (await cli('exploration.review', { taskId: incrementalId })).data;
  assert.ok(incrementalReview.currentVersion);
  await cli('exploration.install', { taskId: incrementalId, reviewId: incrementalReview.reviewId, confirmed: true });
  assert.equal((await settle(incrementalId)).status, 'installed');
  assert.equal((await cli(generated.data.toolNames[0], { q: 'Example retained', page: 2 })).ok, true);
  assert.equal((await cli(incremental.data.toolNames[0], { page: 1 })).ok, true);
  passed('incremental generation preserves authored tool and both installed commands run');

  const postTaskId = (await cli('exploration.start', { ...args, requestId: 'example-post-queries' })).data.taskId;
  await settle(postTaskId);
  const postEvidence = (await cli('exploration.evidence', { taskId: postTaskId })).data.candidates;
  const postPaths = ['/api/post-search', '/api/form-query', '/graphql'];
  const postTools = postPaths.map((pathname, i) => {
    const sourceIndex = postEvidence.findIndex(candidate => new URL(candidate.url).pathname === pathname);
    assert.ok(sourceIndex >= 0, `Captured ${pathname}`);
    return { name: `post_query_${i}`, purpose: 'Read example inventory', risk: 'read', readReason: 'Observed inventory query with no mutation operation.', sourceApiKind: 'list', sourceApiIndexes: [sourceIndex] };
  });
  const postDraft = (await cli('exploration.generate', { taskId: postTaskId, plan: { tools: postTools } })).data;
  await cli('exploration.draft-add', { taskId: postTaskId, file: 'extension/internal/example-query-helper.js', content: 'window.exampleQueryHelper = value => value;' });
  for (const [i] of postPaths.entries()) {
    const file = `extension/commands/post-query-${i}.js`;
    const current = (await cli('exploration.draft-read', { taskId: postTaskId, file })).data;
    const defaults = i === 2 ? 'query: "query Items { items { id } }", variables: {keyword: "Example authored"},' : 'keyword: "Example authored",';
    await cli('exploration.draft-write', { taskId: postTaskId, file, expectedHash: current.hash, content: current.content.replace('...{},', defaults) });
  }
  await cli('exploration.validate', { taskId: postTaskId });
  const postValidation = await settle(postTaskId);
  assert.equal(postValidation.status, 'review_ready', JSON.stringify(postValidation));
  assert.deepEqual(postValidation.runtimeValidation.executionSummary, { attempted: 3, passed: 3, failed: 0, skipped: 0 });
  const postReview = (await cli('exploration.review', { taskId: postTaskId })).data;
  await cli('exploration.install', { taskId: postTaskId, reviewId: postReview.reviewId, confirmed: true }); await settle(postTaskId);
  for (const tool of postDraft.toolNames) assert.equal((await cli(tool)).ok, true);
  assert.ok(postRequests.some(entry => entry.path === '/api/post-search' && entry.data.keyword === 'Example authored'));
  assert.ok(postRequests.some(entry => entry.path === '/api/form-query' && entry.data.keyword === 'Example authored'));
  assert.ok(postRequests.some(entry => entry.path === '/graphql' && entry.data.variables?.keyword === 'Example authored'));
  assert.equal((await cli('exploration.trace', { taskId: postTaskId })).data.structuralOnly, true);
  passed('three authored JSON/form/GraphQL read queries, new helper, real validation, installation and ordinary calls');

  const dynamicTaskId = (await cli('exploration.start', { ...args, requestId: 'example-dynamic-paths' })).data.taskId;
  await settle(dynamicTaskId);
  await cli('browser.bind', { session: 'acceptance', tabId });
  await browserCall('eval', { expression: "Promise.all([fetch('/api/groups/101/items/201?lang=en&term=Example'),fetch('/api/groups/101/items/201/query?lang=en',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({term:'Example'})})]).then(responses=>Promise.all(responses.map(response=>response.json()))).then(()=>true)" });
  // Network response metadata can arrive before CDP finishes capturing its body.
  // Only reread evidence; never replay the requests to fill a capture race.
  let dynamicEvidence;
  for (let attempt = 0; attempt < 20; attempt++) {
    await cli('exploration.collect', { taskId: dynamicTaskId }); await settle(dynamicTaskId);
    dynamicEvidence = (await cli('exploration.evidence', { taskId: dynamicTaskId })).data.candidates;
    if (['GET', 'POST'].every(method => dynamicEvidence.some(item => item.method === method && item.url.includes('/api/groups/:id/items/:id') && item.responseEvidence?.bodyKind === 'json'))) break;
    await delay(100);
  }
  assert.ok(['GET', 'POST'].every(method => dynamicEvidence.some(item => item.method === method && item.url.includes('/api/groups/:id/items/:id') && item.responseEvidence?.bodyKind === 'json')), 'Captured complete dynamic GET/POST response evidence');
  const pathParameters = [{ segmentIndex: 2, name: 'groupId', description: 'Public group identifier' }, { segmentIndex: 4, name: 'itemId', description: 'Public item identifier' }];
  const dynamicPlan = { tools: ['GET', 'POST'].map((method, i) => ({ name: `detail_query_${i}`, risk: 'read', sourceApiKind: 'list',
    sourceApiIndexes: [dynamicEvidence.findIndex(item => item.method === method && item.url.includes('/api/groups/:id/items/:id'))], pathParameters, readReason: 'Queries public item details; no mutation.' })) };
  assert.ok(dynamicPlan.tools.every(tool => tool.sourceApiIndexes[0] >= 0));
  const dynamicDraft = (await cli('exploration.generate', { taskId: dynamicTaskId, plan: dynamicPlan })).data;
  assert.equal((await cli('exploration.validate', { taskId: dynamicTaskId }, false)).error.code, 'VERIFICATION_REQUIRED');
  const dynamicCases = [{ id: 'one', args: { groupId: '000101', itemId: 'example one?#', lang: 'en', term: 'Example first' } },
    { id: 'two', args: { groupId: '000102', itemId: 'example-中文', lang: 'zh', term: 'Example second' } }].map(item => ({ ...item,
      expect: { equals: Object.fromEntries(Object.entries(item.args).map(([key, value]) => ['data.data.' + key, value])) } }));
  for (const tool of dynamicDraft.toolNames) {
    const current = (await cli('exploration.verification-read', { taskId: dynamicTaskId, tool })).data;
    await cli('exploration.verification-write', { taskId: dynamicTaskId, tool, expectedHash: current.hash, cases: dynamicCases });
  }
  await cli('exploration.validate', { taskId: dynamicTaskId });
  const dynamicValidation = await settle(dynamicTaskId);
  assert.equal(dynamicValidation.status, 'review_ready', JSON.stringify(dynamicValidation));
  assert.deepEqual(dynamicValidation.runtimeValidation.executionSummary, { attempted: 4, passed: 4, failed: 0, skipped: 0 });
  const dynamicReview = (await cli('exploration.review', { taskId: dynamicTaskId })).data;
  await cli('exploration.install', { taskId: dynamicTaskId, reviewId: dynamicReview.reviewId, confirmed: true });
  assert.equal((await settle(dynamicTaskId)).status, 'installed');
  for (const tool of dynamicDraft.toolNames) for (const test of dynamicCases) {
    const result = await cli(tool, test.args);
    assert.deepEqual(result.data.data, test.args);
  }
  const beforeInvalid = detailRequests.length;
  const unsafePath = await cli(dynamicDraft.toolNames[0], { ...dynamicCases[0].args, itemId: '../delete' }, false);
  assert.equal(unsafePath.ok, false); assert.equal(unsafePath.error.code, 'INVALID_PATH_PARAMETER');
  assert.equal(detailRequests.length, beforeInvalid);
  for (const request of detailRequests.slice(2)) {
    assert.ok(!Object.hasOwn(request.query, 'itemId') && !Object.hasOwn(request.query, 'groupId'));
    assert.ok(!Object.hasOwn(request.body, 'itemId') && !Object.hasOwn(request.body, 'groupId') && !Object.hasOwn(request.body, 'lang'));
  }
  await record('dynamic-path-validation', dynamicValidation);
  passed('GET/POST dynamic paths preserve leading zeros and Unicode, separate query/body fields, execute varying IDs and reject traversal without requests');

  // A real response-schema change makes the installed command's historical
  // output contract fail. Repair its mapping without changing any sibling.
  renamedItemField = true;
  const repairInfo = (await cli('exploration.repair-info', { site: review.name })).data;
  const repairId = (await cli('exploration.start', { ...args, requestId: 'example-installed-repair' })).data.taskId;
  await settle(repairId);
  const repairEvidence = (await cli('exploration.evidence', { taskId: repairId })).data.candidates;
  const repairIndex = repairEvidence.findIndex(candidate => new URL(candidate.url).pathname === '/api/items');
  const repairPlan = { tools: [{ name: 'search-items', purpose: 'Repair renamed response field', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [repairIndex] }] };
  assert.equal((await cli('exploration.repair', { taskId: repairId, site: review.name, expectedDigest: 'stale', plan: repairPlan }, false)).error.code, 'ADAPTER_BASE_CHANGED');
  const repairedDraft = (await cli('exploration.repair', { taskId: repairId, site: review.name, expectedDigest: repairInfo.digest, plan: repairPlan })).data;
  assert.equal(repairedDraft.repair.knowledge.stale, true);
  assert.deepEqual(repairedDraft.repair.knowledge.importedTools, [verificationTool]);
  const repairFiles = (await cli('exploration.draft-read', { taskId: repairId })).data;
  const protectedContents = {};
  for (const file of repairFiles.files.filter(file => !repairFiles.editableFiles.includes(file))) protectedContents[file] = (await cli('exploration.draft-read', { taskId: repairId, file })).data;
  const protectedFile = Object.keys(protectedContents)[0];
  assert.equal((await cli('exploration.draft-write', { taskId: repairId, file: protectedFile, expectedHash: protectedContents[protectedFile].hash, content: 'changed' }, false)).error.code, 'REPAIR_SCOPE_CHANGED');
  await cli('exploration.validate', { taskId: repairId });
  const brokenInstalled = await settle(repairId);
  assert.equal(brokenInstalled.status, 'draft');
  assert.equal(brokenInstalled.runtimeValidation.executionSummary.failed, 6);
  assert.equal((await cli('exploration.review', { taskId: repairId }, false)).error.code, 'VALIDATION_REQUIRED');
  const repairFile = (await cli('exploration.draft-read', { taskId: repairId, file: moduleFile })).data;
  const repairedSource = `(function () { window.__webcliRegisterCommand('search-items', async function (args = {}) {
    const url = new URL('/api/items', location.href);
    for (const [key, value] of Object.entries({ page: 1, limit: 2, ...args })) url.searchParams.set(key, String(value));
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return { ok: false, error: 'Example query failed' };
    const payload = await response.json();
    return { ok: true, data: { ...payload, data: { ...payload.data, items: payload.data.items.map(row => ({ ...row, name: row.title })) } } };
  }); })();`;
  await cli('exploration.draft-write', { taskId: repairId, file: moduleFile, expectedHash: repairFile.hash, content: repairedSource });
  await cli('exploration.validate', { taskId: repairId });
  const repairValidation = await settle(repairId);
  assert.equal(repairValidation.status, 'review_ready', JSON.stringify(repairValidation));
  assert.deepEqual(repairValidation.runtimeValidation.executionSummary, { attempted: 6, passed: 6, skipped: 0, failed: 0 });
  const repairReview = (await cli('exploration.review', { taskId: repairId })).data;
  assert.deepEqual(repairReview.repair.commandIds, ['search-items']);
  assert.deepEqual(repairReview.addedPermissions, []);
  await cli('exploration.install', { taskId: repairId, reviewId: repairReview.reviewId, confirmed: true });
  assert.equal((await settle(repairId)).status, 'installed');
  const repairedCall = await cli(verificationTool, { q: 'Example repaired', page: 2 });
  assert.equal(repairedCall.data.data.items[0].name, 'Example repaired');
  assert.equal(repairedCall.data.data.page, 2);
  for (const [file, prior] of Object.entries(protectedContents)) assert.equal((await cli('exploration.draft-read', { taskId: repairId, file })).data.hash, prior.hash);
  for (const tool of [incremental.data.toolNames[0], ...postDraft.toolNames]) assert.equal((await cli(tool)).ok, true);
  await record('installed-repair-validation', repairValidation);
  passed('installed command repaired after real response drift; six imported cases revalidated, protected files preserved and sibling commands still run');

  const pageOnlyTab = (await cli('browser.open', { session: 'page-only', url: origin + '/page-only' })).data.tabId;
  const pageTaskId = (await cli('exploration.start', { tabId: pageOnlyTab, goal: 'Read static DOM, page state and JSON script data', requestId: 'example-page-sources' })).data.taskId;
  assert.equal((await settle(pageTaskId)).status, 'evidence_ready');
  // The HTML document itself may be observed by the network recorder; this
  // page exposes no JSON API request to use as generation evidence.
  assert.ok((await cli('exploration.evidence', { taskId: pageTaskId })).data.candidates.every(item => item.responseEvidence.bodyKind !== 'json'));
  const pageSources = [
    { strategy: 'UI_SELECTOR', selector: '#rows .item', emptySelector: '#empty', fields: { title: { selector: '.title' }, url: { selector: '.title', attribute: 'href' } } },
    { strategy: 'DOM_STATE', path: ['examplePageState', 'items'] },
    { strategy: 'DOM_STATE', jsonSelector: '#json-data', path: ['items'] },
  ];
  for (const source of pageSources) {
    await cli('exploration.observe', { taskId: pageTaskId, source, reason: 'Observed public static data, no API endpoint or side effect.' });
    assert.equal((await settle(pageTaskId)).status, 'evidence_ready');
  }
  const pageEvidence = (await cli('exploration.evidence', { taskId: pageTaskId })).data;
  assert.equal(pageEvidence.pageSources.length, 3);
  assert.ok(!JSON.stringify(pageEvidence).includes('Example first'));
  const pagePlan = { tools: pageEvidence.pageSources.map((source, i) => ({ name: ['read_dom', 'read_state', 'read_json'][i], risk: 'read', strategy: source.source.strategy,
    sourcePageId: source.id, purpose: 'Read public page data', readReason: 'Declarative data read, no mutation.' })) };
  const pageDraft = (await cli('exploration.generate', { taskId: pageTaskId, plan: pagePlan })).data;
  assert.equal((await cli('exploration.validate', { taskId: pageTaskId }, false)).error.code, 'VERIFICATION_REQUIRED');
  for (const [i, tool] of pageDraft.toolNames.entries()) {
    const current = (await cli('exploration.verification-read', { taskId: pageTaskId, tool })).data;
    await cli('exploration.verification-write', { taskId: pageTaskId, tool, expectedHash: current.hash,
      cases: [{ id: 'read-data', args: {}, expect: { rowCount: { path: i === 0 ? 'data.items' : 'data', min: i === 2 ? 1 : 2, max: i === 2 ? 1 : 2 },
        types: { [i === 0 ? 'data.items.*.title' : 'data.*.title']: 'string' }, equals: { [i === 0 ? 'data.items.0.title' : 'data.0.title']: i === 2 ? 'Example JSON item' : 'Example first' } } }] });
  }
  await cli('exploration.validate', { taskId: pageTaskId });
  const pageValidation = await settle(pageTaskId);
  assert.equal(pageValidation.status, 'review_ready', JSON.stringify(pageValidation));
  assert.deepEqual(pageValidation.runtimeValidation.executionSummary, { attempted: 3, passed: 3, failed: 0, skipped: 0 });
  const pageReview = (await cli('exploration.review', { taskId: pageTaskId })).data;
  await cli('exploration.install', { taskId: pageTaskId, reviewId: pageReview.reviewId, confirmed: true });
  assert.equal((await settle(pageTaskId)).status, 'installed');
  for (const tool of pageDraft.toolNames) {
    const result = await cli(tool, {}, false);
    await record('installed-' + tool, result);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  const currentKnowledge = (await cli('exploration.knowledge-read', { site: pageReview.name })).data;
  await cli('exploration.knowledge-save', { taskId: pageTaskId, expectedHash: currentKnowledge.hash });
  assert.equal((await cli('exploration.knowledge-read', { site: pageReview.name })).data.knowledge.pages.length, 3);
  await cli('browser.eval', { session: 'page-only', expression: "document.querySelectorAll('#rows .title')[1].remove();true" });
  const missingField = await cli(pageDraft.toolNames[0], {}, false);
  assert.equal(missingField.ok, false);
  await cli('browser.eval', { session: 'page-only', expression: "document.querySelector('#rows').replaceChildren();document.querySelector('#empty').hidden=false;true" });
  assert.equal((await cli(pageDraft.toolNames[0])).data.items.length, 0);
  await record('page-source-validation', pageValidation);
  passed('API-free DOM, MAIN-world state and JSON script observation, generation, strict verification, installation, calls, knowledge and explicit empty state');
  renamedPageField = true;
  const pageRepairInfo = (await cli('exploration.repair-info', { site: pageReview.name })).data;
  const pageRepairId = (await cli('exploration.start', { tabId: pageOnlyTab, goal: 'Repair changed DOM selector', requestId: 'example-page-repair' })).data.taskId;
  await settle(pageRepairId);
  await cli('exploration.observe', { taskId: pageRepairId, source: { ...pageSources[0], fields: { title: { selector: '.heading' }, url: { selector: '.heading', attribute: 'href' } } }, reason: 'Public row links now use heading class.' });
  await settle(pageRepairId);
  const newPageSource = (await cli('exploration.evidence', { taskId: pageRepairId })).data.pageSources[0];
  const pageRepair = (await cli('exploration.repair', { taskId: pageRepairId, site: pageReview.name, expectedDigest: pageRepairInfo.digest,
    plan: { tools: [{ name: 'read-dom', risk: 'read', strategy: 'UI_SELECTOR', sourcePageId: newPageSource.id, purpose: 'Repair public DOM query', readReason: 'Public row read only.' }] } })).data;
  assert.deepEqual(pageRepair.repair.knowledge.importedTools, [pageDraft.toolNames[0]]);
  await cli('exploration.validate', { taskId: pageRepairId });
  assert.equal((await settle(pageRepairId)).status, 'draft');
  const domModule = (await cli('exploration.draft-read', { taskId: pageRepairId, file: 'extension/commands/read-dom.js' })).data;
  await cli('exploration.draft-write', { taskId: pageRepairId, file: 'extension/commands/read-dom.js', expectedHash: domModule.hash, content: domModule.content.replaceAll('.title', '.heading') });
  await cli('exploration.validate', { taskId: pageRepairId });
  const repairedPageValidation = await settle(pageRepairId);
  assert.equal(repairedPageValidation.status, 'review_ready', JSON.stringify(repairedPageValidation));
  const repairedPageReview = (await cli('exploration.review', { taskId: pageRepairId })).data;
  await cli('exploration.install', { taskId: pageRepairId, reviewId: repairedPageReview.reviewId, confirmed: true });
  assert.equal((await settle(pageRepairId)).status, 'installed');
  assert.equal((await cli(pageDraft.toolNames[0])).data.items[0].title, 'Example first');
  for (const tool of pageDraft.toolNames.slice(1)) assert.equal((await cli(tool)).ok, true);
  const repairedKnowledge = (await cli('exploration.knowledge-read', { site: pageReview.name })).data;
  await cli('exploration.knowledge-save', { taskId: pageRepairId, expectedHash: repairedKnowledge.hash });
  await record('page-repair-validation', repairedPageValidation);
  passed('page selector drift fails imported cases; scoped CLI repair revalidates and preserves sibling page commands');
  await cli('browser.close', { session: 'page-only' });
  assert.equal((await cli(pageDraft.toolNames[0], {}, false)).error.code, 'PAGE_SOURCE_ROUTE_MISSING');

  const interceptTab = (await cli('browser.open', { session: 'intercept-only', url: origin + '/intercept-only' })).data.tabId;
  const signedOrigin = `http://localhost:${server.address().port}`;
  const interceptTask = (await cli('exploration.start', { tabId: interceptTab, allowedOrigins: [signedOrigin], goal: 'Read a query using page-generated request proof', requestId: 'example-intercept' })).data.taskId;
  assert.equal((await settle(interceptTask)).status, 'evidence_ready');
  const signedCandidates = (await cli('exploration.evidence', { taskId: interceptTask })).data.candidates;
  assert.equal((await fetch(signedOrigin + '/api/signed-search?q=Example')).status, 403);
  for (const method of ['GET', 'POST']) {
    const sourceApiIndex = signedCandidates.findIndex(item => new URL(item.url).pathname === '/api/signed-search' && item.method === method && item.status === 200);
    assert.ok(sourceApiIndex >= 0, JSON.stringify(signedCandidates));
    await cli('exploration.intercept', { taskId: interceptTask, source: { sourceApiIndex,
      trigger: { kind: 'search', selector: method === 'GET' ? '#signed-query' : '#signed-post-query', submitSelector: method === 'GET' ? '#signed-submit' : '#signed-post-submit', parameter: 'keyword', description: 'Public search term' },
      ...(method === 'GET' ? { matchQuery: { q: 'keyword' } } : { matchBody: { keyword: 'keyword' } }), timeoutMs: 2000 },
      values: { keyword: 'Example observation ' + method }, reason: 'Public search only; the page generates an ephemeral request proof.' });
    const observedIntercept = await settle(interceptTask);
    assert.equal(observedIntercept.status, 'evidence_ready', JSON.stringify(observedIntercept));
  }
  const interceptEvidence = (await cli('exploration.evidence', { taskId: interceptTask })).data;
  assert.equal(interceptEvidence.pageSources.length, 2);
  assert.ok(!JSON.stringify(interceptEvidence).includes('Example observation'));
  const interceptDraft = (await cli('exploration.generate', { taskId: interceptTask, plan: { tools: interceptEvidence.pageSources.map((item, i) => ({ name: ['signed_get', 'signed_post'][i], strategy: 'INTERCEPT', sourcePageId: item.id, risk: 'read', purpose: 'Read signed search through UI', readReason: 'Observed search controls only.' })) } })).data;
  for (const tool of interceptDraft.toolNames) {
    const current = (await cli('exploration.verification-read', { taskId: interceptTask, tool })).data;
    await cli('exploration.verification-write', { taskId: interceptTask, tool, expectedHash: current.hash, cases: ['Example first query', 'Example second query'].map((keyword, i) => ({ id: 'query-' + i, args: { keyword }, expect: { equals: { 'data.data.keyword': keyword }, rowCount: { path: 'data.data.items', min: 1, max: 1 } } })) });
  }
  await cli('exploration.validate', { taskId: interceptTask });
  const interceptValidation = await settle(interceptTask);
  assert.equal(interceptValidation.status, 'review_ready', JSON.stringify(interceptValidation));
  assert.deepEqual(interceptValidation.runtimeValidation.executionSummary, { attempted: 4, passed: 4, failed: 0, skipped: 0 });
  const interceptReview = (await cli('exploration.review', { taskId: interceptTask })).data;
  await cli('exploration.install', { taskId: interceptTask, reviewId: interceptReview.reviewId, confirmed: true });
  assert.equal((await settle(interceptTask)).status, 'installed');
  for (const tool of interceptDraft.toolNames) {
    const result = await cli(tool, { keyword: 'Example installed query' });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.data.keyword, 'Example installed query');
  }
  for (const [keyword, code] of [['example-timeout', 'INTERCEPT_TIMEOUT'], ['example-duplicate', 'INTERCEPT_AMBIGUOUS'], ['example-http-error', 'INTERCEPT_HTTP_ERROR']]) {
    const result = await cli(interceptDraft.toolNames[0], { keyword }, false);
    assert.equal(result.ok, false); assert.equal(result.error.code, code, JSON.stringify(result));
  }
  const beforeInvalidQuery = signedRequests.length;
  assert.equal((await cli(interceptDraft.toolNames[0], { keyword: '' }, false)).ok, false);
  // Catalog refreshes can finish reloading this fixture after installation.
  // Its two boot requests are not the rejected query; reject every other new request.
  const duringInvalidQuery = signedRequests.slice(beforeInvalidQuery);
  assert.ok(duringInvalidQuery.every(request => request.valid && (
    (request.method === 'GET' && request.keyword === 'Example initial')
    || (request.method === 'POST' && request.keyword === 'Example initial POST'))), JSON.stringify(duringInvalidQuery));
  await record('invalid-intercept-query-background-requests', duringInvalidQuery);
  const interceptKnowledge = (await cli('exploration.knowledge-read', { site: interceptReview.name })).data;
  await cli('exploration.knowledge-save', { taskId: interceptTask, expectedHash: interceptKnowledge.hash });
  // Navigation invalidates a single-document query, even with unchanged pathname.
  const navigationTask = (await cli('exploration.start', { tabId: interceptTab, allowedOrigins: [signedOrigin], goal: 'Verify navigation failure', requestId: 'example-intercept-navigation' })).data.taskId;
  await settle(navigationTask);
  const navigationCandidates = (await cli('exploration.evidence', { taskId: navigationTask })).data.candidates;
  await cli('exploration.intercept', { taskId: navigationTask, source: { sourceApiIndex: navigationCandidates.findIndex(item => item.method === 'GET' && new URL(item.url).pathname === '/api/signed-search'),
    trigger: { kind: 'search', selector: '#signed-query', submitSelector: '#signed-submit', parameter: 'keyword', description: 'Public query term' }, matchQuery: { q: 'keyword' }, timeoutMs: 2000 }, values: { keyword: 'example-navigation' }, reason: 'Verify a full page navigation is not accepted as query evidence.' });
  assert.equal((await settle(navigationTask)).error.code, 'INTERCEPT_DOCUMENT_CHANGED');
  await record('intercept-validation', interceptValidation);
  passed('cross-origin page-signed GET/POST INTERCEPT: direct replay fails, two changing queries each pass preview and installed calls, timeout/duplicate/HTTP errors are explicit');

  const queryTab = (await cli('browser.open', { session: 'page-query', url: origin + '/query-start' })).data.tabId;
  const queryTask = (await cli('exploration.start', { tabId: queryTab, goal: 'Search across full document navigation', requestId: 'example-page-query' })).data.taskId;
  await settle(queryTask);
  const querySource = { trigger: { kind: 'search', selector: '#page-query', submitSelector: '#page-submit', parameter: 'keyword', description: 'Public item query' },
    result: { strategy: 'UI_SELECTOR', selector: '.query-row', fields: { title: { selector: 'h3' } } }, resultPathname: '/query-results', matchQuery: { q: 'keyword' } };
  await cli('exploration.query', { taskId: queryTask, source: querySource, values: { keyword: 'Example observation only' }, reason: 'Search form navigates to a new result document.' });
  const queryObserved = await settle(queryTask);
  assert.equal(queryObserved.status, 'evidence_ready', JSON.stringify(queryObserved));
  const queryEvidence = (await cli('exploration.evidence', { taskId: queryTask })).data;
  assert.ok(!JSON.stringify(queryEvidence).includes('Example observation only'));
  const queryDraft = (await cli('exploration.generate', { taskId: queryTask, plan: { tools: [{ name: 'page_search', strategy: 'UI_SELECTOR', sourcePageId: queryEvidence.pageSources[0].id, risk: 'read', readReason: 'Read-only form query', purpose: 'Search and read the new document' }] } })).data;
  const queryTool = queryDraft.toolNames[0];
  const queryCases = (await cli('exploration.verification-read', { taskId: queryTask, tool: queryTool })).data;
  await cli('exploration.verification-write', { taskId: queryTask, tool: queryTool, expectedHash: queryCases.hash, cases: ['Example query first', 'Example query second'].map((keyword, i) => ({ id: 'document-' + i, args: { keyword }, expect: { equals: { 'data.items.0.title': keyword }, rowCount: { path: 'data.items', min: 1, max: 1 } } })) });
  await cli('exploration.validate', { taskId: queryTask });
  const queryValidation = await settle(queryTask);
  assert.equal(queryValidation.status, 'review_ready', JSON.stringify(queryValidation));
  assert.deepEqual(queryValidation.runtimeValidation.executionSummary, { attempted: 2, passed: 2, failed: 0, skipped: 0 });
  const queryReview = (await cli('exploration.review', { taskId: queryTask })).data;
  await cli('exploration.install', { taskId: queryTask, reviewId: queryReview.reviewId, confirmed: true });
  assert.equal((await settle(queryTask)).status, 'installed');
  for (const keyword of ['Example installed first', 'Example installed second']) {
    const result = await cli(queryTool, { keyword }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.items[0].title, keyword);
  }
  assert.deepEqual((await cli('browser.eval', { session: 'page-query', expression: "JSON.parse(sessionStorage.getItem('exampleQuerySubmissions'))" })).data.value,
    ['Example observation only', 'Example query first', 'Example query second', 'Example installed first', 'Example installed second']);
  const queryKnowledge = (await cli('exploration.knowledge-read', { site: queryReview.name })).data;
  await cli('exploration.knowledge-save', { taskId: queryTask, expectedHash: queryKnowledge.hash });
  await record('page-query-validation', queryValidation);
  passed('full-document search survives navigation in observation, two strict preview cases, installation and repeated ordinary calls on the result route');
  await verifyPageNavigation({ cli, record, passed });
  await verifyQueryNavigation({ cli, record, passed });
  await hashNavigation();
  await pageWorkflow();
  await workflowControl();
  await originNavigation();

  const fallbackTab = (await cli('browser.open', { session: 'fallback', url: origin + '/fallback-only' })).data.tabId;
  const fallbackTask = (await cli('exploration.start', { tabId: fallbackTab, goal: 'Read public items despite an unstable API', requestId: 'example-strategy-fallback' })).data.taskId;
  await settle(fallbackTask);
  const analysis = (await cli('exploration.analyze', { taskId: fallbackTask })).data;
  const api = analysis.candidates.find(item => new URL(item.url).pathname === '/api/fallback-list');
  assert.equal(api.verdict, 'likely_data');
  assert.equal(analysis.candidates.find(item => new URL(item.url).pathname === '/api/telemetry/search').verdict, 'noise');
  const fallbackPlan = { tools: [{ name: 'read_fallback_items', risk: 'read', sourceApiKind: 'list', sourceApiIndexes: [api.sourceApiIndex], strategy: 'PAGE_FETCH',
    strategyNote: { reason: 'Inspect the observed item query', alternatives: 'The visible rows are also available; compare this endpoint with exact public item assertions.', limitations: 'Internal endpoint; reconsider if it becomes unavailable.' } }] };
  const firstDraft = (await cli('exploration.generate', { taskId: fallbackTask, plan: fallbackPlan })).data;
  fallbackUnavailable = true;
  await cli('exploration.validate', { taskId: fallbackTask });
  const failedAttempt = await settle(fallbackTask); assert.equal(failedAttempt.runtimeValidation.passed, false);
  const requestCount = fallbackRequests;
  const failedAnalysis = (await cli('exploration.analyze', { taskId: fallbackTask })).data;
  assert.ok(failedAnalysis.nextActions.some(item => item.action === 'exploration.replan'));
  assert.equal(fallbackRequests, requestCount, 'analysis must not replay a failed query');
  const oldManifest = (await cli('exploration.draft-read', { taskId: fallbackTask, file: 'manifest.json' })).data;
  const snapshot = (await cli('exploration.draft-read', { taskId: fallbackTask })).data;
  await cli('exploration.replan', { taskId: fallbackTask, expectedDraftHash: snapshot.draftHash, reason: 'API now returns 503; the authorized visible rows retain the required titles.' });
  assert.equal((await cli('exploration.revision-read', { taskId: fallbackTask, revision: 1, file: 'manifest.json' })).data.content, oldManifest.content);
  await cli('exploration.observe', { taskId: fallbackTask, source: { strategy: 'UI_SELECTOR', selector: '.fallback-row', fields: { title: { selector: 'h3' } } }, reason: 'Visible item headings remain present.' });
  await settle(fallbackTask);
  const fallbackEvidence = (await cli('exploration.evidence', { taskId: fallbackTask })).data;
  const secondDraft = (await cli('exploration.generate', { taskId: fallbackTask, plan: { tools: [{ name: 'read_fallback_items', risk: 'read', strategy: 'UI_SELECTOR', sourcePageId: fallbackEvidence.pageSources[0].id,
    readReason: 'Read visible public headings', strategyNote: { reason: 'Visible headings expose the requested content without the unavailable endpoint', limitations: 'Only currently rendered rows' } }] } })).data;
  assert.deepEqual(secondDraft.toolNames, firstDraft.toolNames);
  const fallbackTool = secondDraft.toolNames[0];
  const emptyCases = (await cli('exploration.verification-read', { taskId: fallbackTask, tool: fallbackTool })).data; assert.deepEqual(emptyCases.cases, []);
  await cli('exploration.verification-write', { taskId: fallbackTask, tool: fallbackTool, expectedHash: emptyCases.hash,
    cases: [{ id: 'visible-item', args: {}, expect: { equals: { 'data.items.0.title': 'Example stable visible item' }, rowCount: { path: 'data.items', min: 1, max: 1 } } }] });
  await cli('exploration.validate', { taskId: fallbackTask }); assert.equal((await settle(fallbackTask)).status, 'review_ready');
  const fallbackReview = (await cli('exploration.review', { taskId: fallbackTask })).data;
  await cli('exploration.install', { taskId: fallbackTask, reviewId: fallbackReview.reviewId, confirmed: true }); await settle(fallbackTask);
  assert.equal((await cli(fallbackTool)).data.items[0].title, 'Example stable visible item');
  const fallbackKnowledge = (await cli('exploration.knowledge-read', { site: fallbackReview.name })).data;
  await cli('exploration.knowledge-save', { taskId: fallbackTask, expectedHash: fallbackKnowledge.hash });
  assert.equal((await cli('exploration.knowledge-read', { site: fallbackReview.name })).data.knowledge.commands[fallbackTool].strategy, 'UI_SELECTOR');
  await record('fallback-analysis', failedAnalysis);
  passed('API failure analyzed without replay; preserved revision switches to observed DOM, fresh cases/validation/install and ordinary call pass');

  const cancelledId = (await cli('exploration.start', { ...args, requestId: 'example-cancel' })).data.taskId;
  await cli('exploration.cancel', { taskId: cancelledId });
  await delay(5000);
  const cancelled = (await cli('exploration.get', { taskId: cancelledId })).data;
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.candidateCount, 0);
  passed('cancel discards late real browser capture');

  const interruptedId = (await cli('exploration.start', { ...args, requestId: 'example-restart' })).data.taskId;
  const exited = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await exited;
  await startBridge(); await connected();
  assert.equal((await cli('exploration.get', { taskId: interruptedId })).data.status, 'interrupted');
  assert.equal((await cli('exploration.start', { ...args, requestId: 'example-restart' })).data.taskId, interruptedId);
  assert.equal((await cli('exploration.get', { taskId })).data.status, 'installed');
  assert.equal((await cli('exploration.get', { taskId: cancelledId })).data.status, 'cancelled');
  const restoredKnowledge = (await cli('exploration.knowledge-read', { site: review.name })).data;
  assert.equal(restoredKnowledge.knowledge.commands[verificationTool].cases.length, 6);
  assert.equal(restoredKnowledge.stale, false);
  assert.equal(restoredKnowledge.knowledge.pages.length, 21);
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'navigate' && page.source.hashNavigation).length, 3);
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'workflow' && page.source.steps.some(step => step.query.hashNavigation)).length, 1);
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'navigate' && page.source.queryParameters?.length === 2).length, 3);
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'workflow' && page.source.steps.some(step => step.query.queryParameters?.length === 2)).length, 3);
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'navigate' && page.source.resultOrigin).length, 2);
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'workflow' && page.source.steps.some(step => step.query.resultOrigin)).length, 2);
  assert.ok(restoredKnowledge.knowledge.pages.some(page => page.source.mode === 'navigate'));
  assert.equal(restoredKnowledge.knowledge.pages.filter(page => page.source.mode === 'workflow' && page.source.steps.some(step => step.repeat)).length, 1);
  assert.ok(restoredKnowledge.knowledge.pages.some(page => page.source.mode === 'workflow'));
  const restoredAttempt = (await cli('exploration.revision-read', { taskId: fallbackTask, revision: 1 })).data;
  assert.equal(restoredAttempt.runtimeValidation.passed, false);
  assert.equal((await cli('exploration.revision-read', { taskId: fallbackTask, revision: 1, file: 'manifest.json' })).data.content, oldManifest.content);
  // Allow the extension's already-dispatched capture to finish before explicit resumption.
  await delay(5000);
  await cli('exploration.collect', { taskId: interruptedId });
  assert.equal((await settle(interruptedId)).status, 'evidence_ready');
  assert.equal((await cli(generated.data.toolNames[0], { page: 2 })).ok, true);
  passed('Bridge restart restores tasks, marks interruption and permits explicit resumption');
  await profiles();
  await hostHttp();
  await pageWrites();
  await uiWrites();
  await pageRepairs();
  await sharedRepair();
  await backgroundApi();
  })();
} catch (error) {
  await record('failure', { message: error.message, stack: error.stack, browserEvents });
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close();
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) { const exited = new Promise(resolve => bridge.once('exit', resolve)); bridge.kill('SIGTERM'); await exited; }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await record('report', { passed: !process.exitCode, bundledCli: process.argv.includes('--bundled-cli'), bundledBridge: process.argv.includes('--bundled-bridge'), checks, artifacts: root });
}
