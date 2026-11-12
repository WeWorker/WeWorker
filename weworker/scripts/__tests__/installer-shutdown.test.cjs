const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const test = require('node:test')

const appRoot = path.resolve(__dirname, '../..')
const script = path.join(appRoot, 'scripts/stop-installed-app.ps1')
const quote = value => `'${value.replaceAll("'", "''")}'`

function runPowerShell(body) {
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-installer-test-')), 'test.ps1')
  fs.writeFileSync(fixture, `. ${quote(script)} -InstallDirectory 'C:\\Example\\WeWorker'\n${body}`, 'utf8')
  return spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture], { encoding: 'utf8', timeout: 15000, windowsHide: true })
}

test('installation checks process shutdown before invoking the previous uninstaller', () => {
  const installer = fs.readFileSync(path.join(appRoot, 'installer.nsh'), 'utf8')
  assert.match(installer, /!macro customCheckAppRunning/)
  assert.match(installer, /-File "\$PLUGINSDIR\\weworker-stop-installed-app\.ps1" -InstallDirectory "\$INSTDIR"/)
  assert.match(installer, /\$R0 != 0[\s\S]*?SetErrorLevel 2[\s\S]*?Quit/)
  // Keep electron-builder's atomic removal and rollback on files still in use.
  assert.doesNotMatch(installer, /!macro customRemoveFiles|RMDir|taskkill/)
})

test('the assisted installer keeps its run-after-finish option enabled', () => {
  const config = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).build
  assert.equal(config.nsis.include, 'installer.nsh')
  assert.notEqual(config.nsis.runAfterFinish, false)
})

test('shutdown is limited to the selected installation and verifies process exit', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(String.raw`
$script:remaining = @(
  [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'C:\Example\WeWorker\WeWorker.exe' },
  [pscustomobject]@{ ProcessId = 102; ExecutablePath = 'C:\Example\WeWorker\resources\webwright\Webwright.exe' },
  [pscustomobject]@{ ProcessId = 103; ExecutablePath = 'C:\Example\WeWorker\resources\runtime\node.exe' },
  [pscustomobject]@{ ProcessId = 104; ExecutablePath = 'C:\Example\WeWorker-other\WeWorker.exe' },
  [pscustomobject]@{ ProcessId = 105; ExecutablePath = 'C:\Other\Webwright.exe' },
  [pscustomobject]@{ ProcessId = 106; ExecutablePath = $null },
  [pscustomobject]@{ ProcessId = 107; ExecutablePath = 'C:\Example\WeWorker\Uninstall WeWorker.exe' }
)
$script:stopped = @()
$script:queries = 0
function Get-CimInstance { $script:queries++; $script:remaining }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction); $script:stopped += $Id }
function Start-Sleep { param($Milliseconds); $script:remaining = @($script:remaining | Where-Object { $_.ProcessId -notin $script:stopped }) }
Stop-WeWorkerInstallation -InstallDirectory 'C:\Example\WeWorker' -TimeoutSeconds 2
@{ stopped = $script:stopped; queries = $script:queries } | ConvertTo-Json -Compress
`)
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.deepEqual(data.stopped, [101, 102, 103])
  assert.ok(data.queries >= 2)
})

test('a first install succeeds when no installed processes exist', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(String.raw`
function Get-CimInstance { @() }
function Stop-Process { throw 'Unexpected process termination' }
Stop-WeWorkerInstallation -InstallDirectory 'C:\Example\WeWorker' -TimeoutSeconds 1
`)
  assert.equal(result.status, 0, result.stderr)
})

test('a process that cannot exit aborts instead of reporting success', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(String.raw`
function Get-CimInstance { [pscustomobject]@{ ProcessId = 101; ExecutablePath = 'C:\Example\WeWorker\WeWorker.exe' } }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) }
try {
  Stop-WeWorkerInstallation -InstallDirectory 'C:\Example\WeWorker' -TimeoutSeconds 0
  exit 99
} catch { Write-Output 'blocked'; exit 2 }
`)
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stdout, /blocked/)
})

test('shutdown refuses a drive root and fails closed when process inspection fails', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(String.raw`
function Get-CimInstance { throw 'Example process inspection failure' }
try { Stop-WeWorkerInstallation -InstallDirectory 'C:\' -TimeoutSeconds 1; exit 99 } catch { }
try { Stop-WeWorkerInstallation -InstallDirectory 'C:\Example\WeWorker' -TimeoutSeconds 1; exit 99 } catch { exit 2 }
`)
  assert.equal(result.status, 2, result.stderr)
})

test('real processes from the installation exit while another installation stays alive', { skip: process.platform !== 'win32' }, async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-installer-process-'))
  const installRoot = path.join(fixtureRoot, "Example Worker's App")
  const runtimeRoot = path.join(installRoot, 'resources', 'runtime')
  const siblingRoot = `${installRoot}-other`
  const children = []
  try {
    for (const directory of [installRoot, runtimeRoot, siblingRoot]) {
      fs.mkdirSync(directory, { recursive: true })
      const executable = path.join(directory, 'WeWorker.exe')
      if (children.length === 0) fs.copyFileSync(process.execPath, executable)
      else fs.linkSync(path.join(installRoot, 'WeWorker.exe'), executable)
      const child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
      children.push(child)
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    }
    const result = runPowerShell(`Stop-WeWorkerInstallation -InstallDirectory ${quote(installRoot)} -TimeoutSeconds 5`)
    assert.equal(result.status, 0, result.stderr)
    for (const child of children.slice(0, 2)) {
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
    }
    assert.doesNotThrow(() => process.kill(children[2].pid, 0))
  } finally {
    for (const child of children) {
      child.kill()
    }
  }
})

const makensis = process.platform === 'win32' && path.join(process.env.LOCALAPPDATA,
  'electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe')

test('shutdown hook compiles in both installer and uninstaller sections', { skip: !makensis || !fs.existsSync(makensis) }, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-installer-compile-'))
  const fixture = path.join(fixtureRoot, 'test.nsi')
  fs.writeFileSync(fixture, `
Unicode true
!include "LogicLib.nsh"
!include "${path.join(appRoot, 'installer.nsh')}"
Name "WeWorker installer test"
OutFile "${path.join(fixtureRoot, 'test-installer.exe')}"
RequestExecutionLevel user
Section
  !insertmacro customCheckAppRunning
  WriteUninstaller "$TEMP\\weworker-test-uninstaller.exe"
SectionEnd
Section "Uninstall"
  !insertmacro customCheckAppRunning
SectionEnd
`, 'utf8')
  const result = spawnSync(makensis, ['/V2', fixture], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
