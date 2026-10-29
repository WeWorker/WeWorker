const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { REPO_ROOT, COMPONENT_ROOT, ensureWebwright } = require('./ensure-webwright.cjs')

const OUTPUT_ROOT = path.join(REPO_ROOT, 'weworker', 'build', 'webwright-dist')
const RUNTIME_ROOT = path.join(OUTPUT_ROOT, 'dist', 'Webwright')

function expectedPlatform() {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  throw new Error(`Unsupported Webwright build platform: ${process.platform}`)
}

function expectedArch() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  throw new Error(`Unsupported Webwright build architecture: ${process.arch}`)
}

function validateRuntime({ runtimeRoot, platform = expectedPlatform(), arch = expectedArch() }) {
  const manifestPath = path.join(runtimeRoot, 'webwright-runtime.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing Webwright runtime manifest: ${manifestPath}`)

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid Webwright runtime manifest: ${error.message}`)
  }

  const expected = {
    platform,
    arch,
    mode: 'embedded',
  }
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) {
      throw new Error(`Webwright runtime ${key} mismatch: expected ${value}, got ${manifest[key]}`)
    }
  }
  if (typeof manifest.webwright_version !== 'string' || !manifest.webwright_version) {
    throw new Error('Webwright runtime manifest has no webwright_version')
  }
  const expectedEntrypoint = platform === 'win32' ? 'Webwright.exe' : 'Webwright'
  if (manifest.entrypoint !== expectedEntrypoint) {
    throw new Error(`Webwright runtime entrypoint mismatch: expected ${expectedEntrypoint}, got ${manifest.entrypoint}`)
  }
  const entrypoint = path.join(runtimeRoot, expectedEntrypoint)
  if (!fs.existsSync(entrypoint)) throw new Error(`Missing Webwright runtime entrypoint: ${entrypoint}`)
  const requiredResources = [
    'LICENSE.webwright',
    'THIRD_PARTY_NOTICES.txt',
    path.join('licenses', 'CPython-3.14.6', 'LICENSE.txt'),
    path.join('licenses', 'webwright-0.1.0', 'webwright-0.1.0.dist-info', 'licenses', 'LICENSE'),
    path.join('licenses', 'playwright-1.60.0', 'playwright', 'driver', 'package', 'NOTICE'),
    path.join('licenses', 'certifi-2026.6.17', 'certifi-2026.6.17.dist-info', 'licenses', 'LICENSE'),
    path.join('licenses', 'pyinstaller-6.21.0', 'pyinstaller-6.21.0.dist-info', 'licenses', 'COPYING.txt'),
    path.join('_internal', 'webwright', 'tool_runtime', 'toolkit_runtime.py'),
    path.join('_internal', 'playwright', 'driver', 'package', 'cli.js'),
  ]
  for (const relativePath of requiredResources) {
    if (!fs.existsSync(path.join(runtimeRoot, relativePath))) {
      throw new Error(`Missing Webwright runtime resource: ${relativePath}`)
    }
  }
  const notices = fs.readFileSync(path.join(runtimeRoot, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
  const requiredNoticeFragments = [
    'modified software derived from Microsoft Webwright',
    'CPython==3.14.6',
    'playwright==1.60.0',
    'pyinstaller==6.21.0',
    'GPL-2.0-or-later WITH Bootloader-exception',
    'certifi==2026.6.17',
    'certifi Source Code Form',
    'https://pypi.org/project/certifi/2026.6.17/#files',
  ]
  for (const fragment of requiredNoticeFragments) {
    if (!notices.includes(fragment)) {
      throw new Error(`Webwright runtime third-party notices missing: ${fragment}`)
    }
  }
  const webRoot = path.join(runtimeRoot, '_internal', 'webwright', 'server', 'web')
  if (fs.existsSync(webRoot)) {
    throw new Error('Webwright runtime contains obsolete server web assets')
  }
  return { manifest, entrypoint }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return String(result.stdout || '').trim()
}

function verifyInternalWorkerError(entrypoint) {
  const result = spawnSync(entrypoint, ['--internal-worker', 'invalid-weworker-check'], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  })
  if (result.error) throw result.error
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.status === 0 || !output.includes('Unsupported internal worker: invalid-weworker-check')) {
    throw new Error('Webwright internal worker error-path check failed')
  }
}

function buildWebwright() {
  ensureWebwright()
  const builder = path.join(COMPONENT_ROOT, 'distribution', 'scripts', 'build.py')
  runChecked('uv', [
    'run',
    '--project', path.join(COMPONENT_ROOT, 'distribution'),
    'python', builder,
    '--mode', 'embedded',
    '--output-root', OUTPUT_ROOT,
  ], { inherit: true })

  const validated = validateRuntime({
    runtimeRoot: RUNTIME_ROOT,
  })
  runChecked(validated.entrypoint, ['--help'])
  verifyInternalWorkerError(validated.entrypoint)
  console.log(`[webwright] embedded runtime ready: ${RUNTIME_ROOT}`)
  return validated
}

if (require.main === module) {
  try {
    buildWebwright()
  } catch (error) {
    console.error(`[webwright] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  OUTPUT_ROOT,
  RUNTIME_ROOT,
  buildWebwright,
  expectedArch,
  expectedPlatform,
  validateRuntime,
  verifyInternalWorkerError,
}
