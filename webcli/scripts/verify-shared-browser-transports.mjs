import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrowserArgs, createCdpPipe, findBrowserExecutable } from '../dedicated-browser.js';

// An isolated browser and inert extension: never connects to a user's Bridge.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-dual-cdp-'));
const extension = path.join(root, 'extension');
fs.mkdirSync(extension);
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Shared browser transport probe', version: '1.0.0',
  background: { service_worker: 'worker.js' },
}));
fs.writeFileSync(path.join(extension, 'worker.js'), 'globalThis.transportProbe = true;');
const executable = findBrowserExecutable();
assert.ok(executable, 'Chrome or Edge must be installed');
const profile = path.join(root, 'profile');
const child = spawn(executable.path, [...buildBrowserArgs({ userDataDir: profile }),
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
});
child.stderr.resume();
const exited = new Promise(resolve => child.once('exit', resolve));
const cdp = createCdpPipe(child.stdio[3], child.stdio[4]);
try {
  const version = await cdp.send('Browser.getVersion');
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extension });
  assert.ok(loaded.id);
  let endpoint;
  for (let count = 0; count < 100; count++) {
    try {
      const [port, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
      endpoint = `ws://127.0.0.1:${Number(port)}${browserPath}`;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(endpoint, 'Chrome did not expose a debugging endpoint');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const project = fileURLToPath(new URL('../../components/webwright/', import.meta.url));
  const python = spawn('uv', ['run', '--no-sync', '--project', project, 'python', '-c', `
import asyncio, sys
from importlib.metadata import version
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(sys.argv[1])
        page = browser.contexts[0].pages[0]
        await page.evaluate('globalThis.sharedTransportProbe = 42')
        assert await page.evaluate('sharedTransportProbe') == 42
        print('Playwright ' + version('playwright') + ': CDP connection and page operation passed')
asyncio.run(main())
`, endpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  python.stdout.on('data', data => { output += data; });
  python.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { python.once('exit', resolve); python.once('error', reject); });
  assert.equal(code, 0, output);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const result = await cdp.send('Runtime.evaluate', { expression: 'sharedTransportProbe', returnByValue: true }, sessionId);
  assert.equal(result.result.value, 42);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, browser: version.product,
    extensionLoaded: true, sharedPage: true, playwright: output.trim() }, null, 2));
} finally {
  await cdp.send('Browser.close').catch(() => {});
  const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
  await exited;
  clearTimeout(timer);
  cdp.close();
}
console.log('Owned browser exited; isolated probe files retained in the temporary directory.');
