import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPackageDirectory } from '../adapter-package-files.js';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(source, '..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weworker-shared-browser-'));
const copy = path.join(root, 'webcli');
const extension = path.join(root, 'extension');
const configRoot = path.join(root, 'cli-config');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
let submitted = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/fixture-submit') submitted++;
  res.setHeader('content-type', 'text/html'); res.end('<title>Shared browser fixture</title><button>Example</button>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const env = { ...process.env, WEWORKER_RESOURCES_PATH: root, WEWORKER_BROWSER_HOME: path.join(root, 'browser'),
  WEWORKER_BROWSER_MODE: 'dedicated', WEWORKER_ADAPTER_DATA_DIR: path.join(root, 'data'),
  WEWORKER_BUILTIN_ADAPTERS_DIR: path.join(root, 'adapters'), WEWORKER_USER_ADAPTERS_DIR: path.join(root, 'user'),
  WEBCLI_ADAPTERS_DIR: path.join(root, 'user'), WEBWRIGHT_HOME: path.join(root, 'exploration'),
  WEBWRIGHT_RUNTIME_PATH: path.join(root, 'runtime.json'), WEWORKER_TOOLKIT_RUNTIME_MODE: 'python',
  WEWORKER_TOOLKIT_RUNTIME: path.join(repo, 'components/webwright/.venv/bin/python'), WEBCLI_METRICS_UPLOAD: 'off' };
const embedded = process.argv.find(arg => arg.startsWith('--runtime='))?.slice(10);
if (embedded) { env.WEWORKER_TOOLKIT_RUNTIME = embedded; env.WEWORKER_TOOLKIT_RUNTIME_MODE = 'embedded'; }
let client;
console.log(`Isolated artifacts: ${root}`);
try {
  await fs.cp(source, copy, { recursive: true, filter: file => !['node_modules', '__tests__', 'extension', 'adapters', 'e2e-results'].includes(path.basename(file)) });
  await fs.symlink(path.join(source, 'node_modules'), path.join(copy, 'node_modules'));
  await fs.cp(path.join(repo, 'extension'), extension, { recursive: true });
  for (const file of ['index.js', 'bridge.js', 'exploration-client.js', 'shared-browser-client.js']) {
    const target = path.join(copy, file);
    let content = (await fs.readFile(target, 'utf8')).replaceAll('3711', String(port));
    if (file === 'index.js') content = content.replaceAll('homedir()', JSON.stringify(configRoot));
    await fs.writeFile(target, content);
  }
  const worker = path.join(extension, 'background/service-worker.js');
  await fs.writeFile(worker, (await fs.readFile(worker, 'utf8')).replaceAll('3711', String(port)));
  let entry = path.join(copy, 'index.js');
  if (process.argv.includes('--bundled')) {
    entry = path.join(copy, 'webcli.cjs');
    await fs.writeFile(entry, (await fs.readFile(path.join(repo, 'weworker/build/webcli-dist/webcli.cjs'), 'utf8'))
      .replaceAll('3711', String(port))
      .replace(/\(0, import_os\d*\.homedir\)\(\)|\bimport_(?:node_)?os\d*\.default\.homedir\(\)/g, JSON.stringify(configRoot)));
  }
  const adapter = path.join(env.WEWORKER_BUILTIN_ADAPTERS_DIR, 'shared-fixture');
  await fs.mkdir(path.join(adapter, 'wewright/commands'), { recursive: true });
  await fs.mkdir(path.join(adapter, 'extension/commands'), { recursive: true });
  await fs.mkdir(env.WEWORKER_USER_ADAPTERS_DIR);
  await fs.writeFile(path.join(adapter, 'manifest.json'), JSON.stringify({ schema_version: 2, name: 'shared-fixture',
    version: '1.0.0', description: 'Shared browser fixture', match: ['127.0.0.1'], commands: [{ id: 'read', runtime: 'wewright',
      module: 'wewright/commands/read.py', description: 'Read fixture', safety: 'read', schema: { type: 'object', properties: { delay: { type: 'integer' } } } },
      { id: 'page', runtime: 'extension', module: 'extension/commands/page.js', description: 'Read page', schema: { type: 'object', properties: {} } },
      { id: 'background', runtime: 'extension', module: 'extension/commands/background.js', description: 'Background read',
        execution: { type: 'api', runtime: 'background' }, schema: { type: 'object', properties: {} } }] }));
  await fs.writeFile(path.join(adapter, 'extension/commands/page.js'), "window.__webcliRegisterCommand('page', async () => ({title: document.title}));");
  await fs.writeFile(path.join(adapter, 'extension/commands/background.js'), "window.__webcliRegisterCommand('background', async () => ({background: true}));");
  await fs.writeFile(path.join(adapter, 'wewright/commands/read.py'), `import asyncio, json, sys
from pathlib import Path
from webwright.tool_runtime.toolkit_runtime import PublishedToolkitRunner, target_id_for_page
async def read(ctx, delay=0):
    if delay: await ctx.page.evaluate("fetch('/fixture-submit', {method: 'POST'}).then(r => r.text())")
    await asyncio.sleep(delay)
    return {'title': await ctx.page.title(), 'targetId': await target_id_for_page(ctx.browser_context, ctx.page)}
runner = PublishedToolkitRunner(toolkit_id='shared-fixture', skill_dir=Path(__file__).parent, allowed_domains=['127.0.0.1'],
    tool_specs={'read': {'start_url': ${JSON.stringify(pageUrl)}, 'parameters_schema': {'type': 'object'}, 'result_schema': {'type': 'object'}}}, tool_functions={'read': read})
result = asyncio.run(runner.run(tool_id='read', parameters=json.load(sys.stdin)))
print(json.dumps(result))
sys.exit(0 if result['ok'] else 1)
`);
  await fs.writeFile(path.join(env.WEWORKER_BUILTIN_ADAPTERS_DIR, '.profile.json'), JSON.stringify({ schema_version: 1,
    profile: 'public', adapters: [{ name: 'shared-fixture', version: '1.0.0', digest: readPackageDirectory(adapter).digest }] }));
  const cli = async args => JSON.parse((await exec(process.execPath, [entry, ...args], { env, timeout: 65000, maxBuffer: 1024 * 1024 })).stdout);
  const starts = await Promise.allSettled([cli(['call', 'shared-fixture.read', '--output-format=json']), cli(['call', 'shared-fixture.read', '--output-format=json'])]);
  const first = starts.find(result => result.status === 'fulfilled')?.value;
  assert.ok(first, JSON.stringify(starts));
  for (const result of starts) if (result.status === 'rejected') assert.match(result.reason.stdout, /BROWSER_BUSY/);
  assert.equal(first.ok, true, JSON.stringify(first));
  const { connectSharedBrowser } = await import(pathToFileURL(path.join(copy, 'shared-browser-client.js')));
  client = await connectSharedBrowser({ url: `ws://127.0.0.1:${port}` });
  const initial = await client.request('status');
  const startupLog = await fs.readFile(path.join(configRoot, '.webcli/service.log'), 'utf8');
  assert.equal((startupLog.match(/\[browser\] .* ready \(/g) || []).length, 1, 'Concurrent first calls launch only one browser');
  assert.ok(initial.cdpReady);
  const second = await cli(['call', 'shared-fixture.read', '--output-format=json']);
  assert.equal(second.data.targetId, first.data.targetId, 'Sequential Toolkit commands reuse their page');
  assert.equal((await client.request('status')).instanceId, initial.instanceId);
  // Exercise the Bridge's internal Toolkit dispatch, separately from CLI short-circuiting.
  const internal = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Internal Toolkit dispatch timed out')); }, 30000);
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'call_tool', id: 'fixture-internal', toolName: 'shared-fixture.read', args: {} })));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.id !== 'fixture-internal') return;
      clearTimeout(timer); socket.close();
      if (message.error) reject(new Error(message.error)); else resolve(message.result);
    });
  });
  assert.equal(internal.data.targetId, first.data.targetId);
  const lease = await client.request('acquire');
  await client.request('claim', { leaseId: lease.leaseId, targetId: first.data.targetId });
  const rejected = await exec(process.execPath, [entry, 'call', 'shared-fixture.read', '--output-format=json'], { env, timeout: 15000 }).catch(error => error);
  assert.match(rejected.stdout, /TAB_BUSY/);
  const extensionBusy = await exec(process.execPath, [entry, 'call', 'shared-fixture.page', '--output-format=json'], { env, timeout: 35000 }).catch(error => error);
  assert.match(extensionBusy.stdout + extensionBusy.stderr, /TAB_BUSY|页面正在/);
  await client.request('release', { leaseId: lease.leaseId });
  const extensionResult = await cli(['call', 'shared-fixture.page', '--output-format=json']);
  assert.match(JSON.stringify(extensionResult), /Shared browser fixture/);
  const python = `import asyncio
from pathlib import Path
from webwright.server.browser import browser_status, browser_tabs
from webwright.environments.local_browser import LocalBrowserEnvironment
assert browser_status()['available']
env = LocalBrowserEnvironment(output_dir=${JSON.stringify(path.join(root, 'task'))}, browser_mode='local_cdp', local_cdp_url='http://127.0.0.1:1', local_cdp_auto_start=False)
try:
    env.prepare(task='fixture', task_id='fixture', start_url=${JSON.stringify(pageUrl)})
    assert env._page_target_id != ${JSON.stringify(first.data.targetId)}
finally:
    env.close()
from webwright.run.local_cdp_replay import run_replay
steps = Path(${JSON.stringify(path.join(root, 'task/steps'))})
steps.mkdir(parents=True, exist_ok=True)
(steps / 'step_0001.py').write_text('print(await page.title())', encoding='utf-8')
assert run_replay({'task_output_dir': str(steps.parent), 'replay_output_dir': ${JSON.stringify(path.join(root, 'replay'))},
    'task_id': 'fixture', 'from_step': 1, 'to_step': 1, 'new_tab': True,
    'cdp_url': 'http://127.0.0.1:1', 'start_url': ${JSON.stringify(pageUrl)}}) == 0
from webwright.run.tool_debug import run_debug
result_path = Path(${JSON.stringify(path.join(root, 'debug/result.json'))})
result_path.parent.mkdir(parents=True, exist_ok=True)
debug = asyncio.run(run_debug({'channel': 'formal', 'toolkit_id': 'shared-fixture', 'toolkit_root': ${JSON.stringify(path.join(root, 'toolkits'))},
    'adapter_root': ${JSON.stringify(adapter)}, 'distribution_hash': ${JSON.stringify(readPackageDirectory(adapter).digest)},
    'tool_id': 'read', 'parameters': {}, 'profile': 'public', 'result_path': str(result_path),
    'screenshot_path': str(result_path.parent / 'shot.png'), 'cdp_url': 'http://127.0.0.1:1'}))
assert debug['ok'], debug
print('exploration shared instance passed')
`;
  const probePath = path.join(root, 'exploration-probe.py');
  await fs.writeFile(probePath, python);
  const explored = await exec(env.WEWORKER_TOOLKIT_RUNTIME, [...(embedded ? ['--internal-script'] : []), probePath], { env: { ...env,
    WEWORKER_WEBCLI_NODE: process.execPath, WEWORKER_WEBCLI_ENTRY: entry }, timeout: 60000 });
  assert.match(explored.stdout, /passed/);
  assert.equal((await client.request('status')).instanceId, initial.instanceId);
  await fs.writeFile(probePath, `import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(${JSON.stringify(initial.cdpUrl)})
        for page in browser.contexts[0].pages:
            if page.url.startswith(${JSON.stringify(pageUrl)}): await page.close()
asyncio.run(main())
`);
  await exec(env.WEWORKER_TOOLKIT_RUNTIME, [...(embedded ? ['--internal-script'] : []), probePath], { env, timeout: 20000 });
  const background = await cli(['call', 'shared-fixture.background', '--output-format=json']);
  assert.match(JSON.stringify(background), /"background":true/);
  const origin = new URL(initial.cdpUrl); origin.protocol = 'http:'; origin.pathname = '/json/list';
  assert.equal((await (await fetch(origin)).json()).some(target => target.url.startsWith(pageUrl)), false);
  // Cancel a real running command. Only its lease/connection should end.
  const slow = spawn(process.execPath, [entry, 'call', 'shared-fixture.read', '--args', '{"delay":20}', '--output-format=json'], { env, stdio: 'ignore' });
  const slowExited = new Promise(resolve => slow.once('exit', resolve));
  try {
    for (let i = 0; i < 100 && !(await client.request('status')).activeTasks; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok((await client.request('status')).activeTasks);
    const busyStop = await exec(process.execPath, [entry, 'browser', 'stop', '--json'], { env, timeout: 10000 }).catch(error => error);
    assert.match(busyStop.stdout, /正在执行/);
  } finally { slow.kill('SIGTERM'); await slowExited; }
  for (let i = 0; i < 100 && (await client.request('status')).activeTasks; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await client.request('status')).activeTasks, 0);
  assert.equal((await client.request('status')).instanceId, initial.instanceId);
  await cli(['browser', 'restart', '--json']);
  const restarted = await client.request('status');
  assert.notEqual(restarted.instanceId, initial.instanceId);
  assert.notEqual(restarted.cdpUrl, initial.cdpUrl);
  const afterRestart = await cli(['call', 'shared-fixture.read', '--output-format=json']);
  assert.notEqual(afterRestart.data.targetId, first.data.targetId);
  const beforeCrash = submitted;
  const interrupted = spawn(process.execPath, [entry, 'call', 'shared-fixture.read', '--args', '{"delay":20}', '--output-format=json'], { env, stdio: 'ignore' });
  const interruptedExit = new Promise(resolve => interrupted.once('exit', resolve));
  try {
    for (let i = 0; i < 100 && submitted === beforeCrash; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(submitted, beforeCrash + 1);
    const pid = Number(await fs.readFile(path.join(configRoot, '.webcli/service.pid'), 'utf8'));
    process.kill(pid, 'SIGKILL'); // Only this probe's isolated Bridge.
    const code = await interruptedExit;
    assert.notEqual(code, 0);
    const endpoint = new URL(restarted.cdpUrl); endpoint.protocol = 'http:'; endpoint.pathname = '/json/version';
    let closed = false;
    for (let i = 0; i < 100 && !closed; i++) {
      closed = await fetch(endpoint, { signal: AbortSignal.timeout(500) }).then(() => false, () => true);
      if (!closed) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(closed, 'Closing the Bridge pipe must stop its browser');
    assert.equal(submitted, beforeCrash + 1, 'A submitted operation must not be replayed');
    client.close();
    await cli(['call', 'shared-fixture.read', '--output-format=json']);
    client = await connectSharedBrowser({ url: `ws://127.0.0.1:${port}` });
    assert.notEqual((await client.request('status')).instanceId, restarted.instanceId);
    assert.equal(submitted, beforeCrash + 1);
  } finally { if (interrupted.exitCode === null && interrupted.signalCode === null) interrupted.kill('SIGTERM'); }
  console.log('PASS concurrent startup; CLI and Bridge Toolkit dispatch; page reuse; Toolkit/Extension conflict; exploration, formal debug and replay with stale endpoint; background without business pages; cancellation and busy stop; fresh instance after restart; Bridge crash cleanup and no replay.');
} finally {
  client?.close();
  try {
    const pid = Number(await fs.readFile(path.join(configRoot, '.webcli/service.pid'), 'utf8'));
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {}
  await new Promise(resolve => server.close(resolve));
}
