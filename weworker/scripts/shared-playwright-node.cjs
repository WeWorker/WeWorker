const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// Exercise the frozen bootstrap and real driver in the final resource layout.
// No browser, external network, credentials or model configuration is needed.
const PROBE = `import asyncio, sys
from pathlib import Path
from playwright._impl._driver import compute_driver_executable
from playwright.async_api import async_playwright
expected = Path(sys.argv[1]).resolve()
selected, driver = compute_driver_executable()
assert Path(selected).resolve() == expected, 'Frozen entry did not select the shared Node'
assert not (Path(driver).parent.parent / 'node.exe').exists(), 'Duplicate Node was packaged'
async def check():
    manager = await async_playwright().start()
    await manager.stop()
asyncio.run(check())
print('Shared Node runtime ready')
`

function configureSharedPlaywrightNode(resourcesPath, platform, arch, run = execFileSync) {
  if (platform !== 'win32') return
  if (arch !== 'x64') throw new Error('Shared Node runtime requires Windows x64')
  const runtime = path.join(resourcesPath, 'webwright')
  const manifestPath = path.join(runtime, 'webwright-runtime.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.mode !== 'embedded' || manifest.platform !== platform || manifest.arch !== arch
      || manifest.entrypoint !== 'Webwright.exe') throw new Error('Invalid shared Node runtime layout')
  const node = path.join(resourcesPath, 'node-runtime', 'node.exe')
  for (const file of [node, path.join(runtime, 'Webwright.exe'), path.join(runtime, '_internal/playwright/driver/package/cli.js')]) {
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Missing shared Node runtime resource')
  }
  if (fs.existsSync(path.join(runtime, '_internal/playwright/driver/node.exe'))) {
    throw new Error('Duplicate Playwright Node must be excluded from the Windows package')
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, node_runtime: 'shared' }, null, 2) + '\n')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-shared-node-'))
  try {
    const probe = path.join(temp, 'probe.py')
    fs.writeFileSync(probe, PROBE)
    const env = { ...process.env, PLAYWRIGHT_NODEJS_PATH: path.join(temp, 'must-not-be-used.exe') }
    delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.ELECTRON_RUN_AS_NODE
    const output = run(path.join(runtime, 'Webwright.exe'), ['--internal-script', probe, node], {
      env, windowsHide: true, encoding: 'utf8', timeout: 30000,
    })
    if (!String(output).includes('Shared Node runtime ready')) throw new Error('Shared Node runtime probe did not complete')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

module.exports = { configureSharedPlaywrightNode }
