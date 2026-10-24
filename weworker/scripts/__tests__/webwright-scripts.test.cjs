const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('path')
const test = require('node:test')
const { COMPONENT_ROOT, ensureWebwright } = require('../ensure-webwright.cjs')
const { validateRuntime } = require('../build-webwright.cjs')
const { buildElectronArgs, buildElectronCommand, createElectronBuilderConfig } = require('../build-electron-current-arch.cjs')
const { mergeMacMetadata } = require('../merge-mac-update-metadata.cjs')
const afterPack = require('../after-pack.cjs')
const packageJson = require('../../package.json')

test('component check treats Webwright as a normal source directory', () => {
  const messages = []
  assert.deepEqual(ensureWebwright({ log: (message) => messages.push(message) }), {
    componentRoot: COMPONENT_ROOT,
  })
  assert.deepEqual(messages, ['[webwright] component ready: components/webwright'])
})

test('runtime validation checks identity and entrypoint', () => {
  const root = path.join(__dirname, 'fixtures', 'runtime')
  const result = validateRuntime({
    runtimeRoot: root,
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal(result.entrypoint, path.join(root, 'Webwright'))
})

test('runtime validation rejects incomplete third-party notices', () => {
  const source = path.join(__dirname, 'fixtures', 'runtime')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-webwright-runtime-'))
  fs.cpSync(source, root, { recursive: true })
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), 'incomplete\n')
  assert.throws(() => validateRuntime({
    runtimeRoot: root,
    platform: 'darwin',
    arch: 'arm64',
  }), /third-party notices missing/)
})

test('runtime validation rejects stale model-management web assets', () => {
  const source = path.join(__dirname, 'fixtures', 'runtime')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-webwright-runtime-'))
  fs.cpSync(source, root, { recursive: true })
  fs.writeFileSync(
    path.join(root, '_internal', 'webwright', 'server', 'web', 'app.js'),
    'import "./components/model_manager.js";\n',
  )
  assert.throws(() => validateRuntime({
    runtimeRoot: root,
    platform: 'darwin',
    arch: 'arm64',
  }), /stale model-management web assets/)
})

test('packaged WebCLI excludes legacy webcli-py wrappers', () => {
  const webcliResource = packageJson.build.extraResources.find((entry) => entry.to === 'webcli')
  assert.equal(webcliResource.filter.includes('webcli-py'), false)
  assert.equal(webcliResource.filter.includes('webcli-py.cmd'), false)
})


test('electron packaging is pinned to the host runtime architecture', () => {
  assert.deepEqual(buildElectronArgs('--mac', 'darwin', 'arm64'), ['--mac', '--arm64'])
  assert.deepEqual(buildElectronArgs('--mac', 'darwin', 'x64'), ['--mac', '--x64'])
  assert.deepEqual(buildElectronArgs('--win', 'win32', 'x64'), ['--win', '--x64'])
  assert.throws(() => buildElectronArgs('--mac', 'darwin', 'ia32'), /Unsupported/)
  assert.throws(() => buildElectronArgs('--win', 'darwin', 'x64'), /must be built on Windows/)
})

test('electron packaging launches the JavaScript CLI without a Windows command shim', () => {
  const command = buildElectronCommand(
    '--win',
    'win32',
    'x64',
    'C:\\Program Files\\nodejs\\node.exe',
    'D:\\workspace\\node_modules\\electron-builder\\cli.js',
  )
  assert.deepEqual(command, {
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\workspace\\node_modules\\electron-builder\\cli.js', '--win', '--x64'],
  })
  assert.doesNotMatch(command.executable, /\.cmd$/i)
})

test('electron packaging derives its publish URL from the GitHub update endpoint', (t) => {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-deployment-')), 'builder.json')
  t.after(() => fs.rmSync(path.dirname(outputPath), { recursive: true, force: true }))
  const configPath = createElectronBuilderConfig({ outputPath })
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'deployment.json'), 'utf8'))
  assert.deepEqual(config.publish, [{ provider: 'generic', url: deployment.githubUrl }])
})

test('macOS packages use a complete ad-hoc signature for internal distribution', () => {
  assert.equal(packageJson.build.afterPack, 'scripts/after-pack.cjs')
  assert.equal(packageJson.build.mac.identity, null)
  assert.equal(packageJson.build.mac.hardenedRuntime, false)

  const calls = []
  afterPack({
    electronPlatformName: 'darwin',
    appOutDir: '/tmp/mac-arm64',
    packager: { appInfo: { productFilename: 'WeWorker' } },
  }, (...args) => calls.push(args), () => {})
  const appPath = path.join('/tmp/mac-arm64', 'WeWorker.app')
  assert.deepEqual(calls.map(([executable, args]) => ({ executable, args })), [
    {
      executable: '/usr/bin/codesign',
      args: ['--force', '--deep', '--sign', '-', appPath],
    },
    {
      executable: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', '--verbose=4', appPath],
    },
  ])
})

function macMetadata(arch, version = '0.2.4', releaseDate = '2026-07-22T00:00:00.000Z') {
  return `version: ${version}\nfiles:\n` +
    `  - url: WeWorker-${version}-mac-${arch}.zip\n    sha512: ${arch}-zip\n    size: 100\n` +
    `  - url: WeWorker-${version}-mac-${arch}.dmg\n    sha512: ${arch}-dmg\n    size: 200\n` +
    `path: WeWorker-${version}-mac-${arch}.zip\nsha512: ${arch}-zip\nreleaseDate: '${releaseDate}'\n`
}

test('macOS update metadata merges both native architectures', () => {
  const merged = mergeMacMetadata(
    macMetadata('arm64', '0.2.4', '2026-07-22T00:00:00.000Z'),
    macMetadata('x64', '0.2.4', '2026-07-22T00:01:00.000Z'),
  )
  assert.match(merged, /WeWorker-0\.2\.4-mac-arm64\.zip/)
  assert.match(merged, /WeWorker-0\.2\.4-mac-x64\.zip/)
  assert.match(merged, /releaseDate: '2026-07-22T00:01:00\.000Z'/)
  assert.doesNotMatch(merged, /^path:/m)
})

test('macOS update metadata rejects mixed versions', () => {
  assert.throws(() => mergeMacMetadata(
    macMetadata('arm64', '0.2.4'),
    macMetadata('x64', '0.2.5'),
  ), /version mismatch/)
})

test('electron packaging uses the generated profile-specific extension', () => {
  const extensionResource = packageJson.build.extraResources.find((entry) => entry.to === 'extension')
  assert.equal(extensionResource.from, 'build/extension-dist/')
  assert.equal(packageJson.build.extraResources.some((entry) => entry.to === 'extension/adapters'), false)
})

test('electron packaging includes the shared deployment configuration', () => {
  assert.ok(packageJson.build.files.includes('deployment.json'))
  assert.ok(packageJson.build.files.includes('deployment-config.cjs'))
})
