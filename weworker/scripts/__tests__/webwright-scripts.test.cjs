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
const { configureSharedPlaywrightNode } = require('../shared-playwright-node.cjs')

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

test('runtime validation rejects obsolete server web assets', () => {
  const source = path.join(__dirname, 'fixtures', 'runtime')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-webwright-runtime-'))
  fs.cpSync(source, root, { recursive: true })
  fs.mkdirSync(path.join(root, '_internal', 'webwright', 'server', 'web'), { recursive: true })
  assert.throws(() => validateRuntime({
    runtimeRoot: root,
    platform: 'darwin',
    arch: 'arm64',
  }), /obsolete server web assets/)
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

test('electron packaging derives its publish URL from deployment.json', (t) => {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-deployment-')), 'builder.json')
  t.after(() => fs.rmSync(path.dirname(outputPath), { recursive: true, force: true }))
  const configPath = createElectronBuilderConfig({ outputPath })
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const deployment = require('../../deployment-config.cjs').normalizeDeploymentConfig(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'deployment.json'), 'utf8')),
  )
  assert.deepEqual(config.publish, [{ provider: 'generic', url: deployment.updateSources[0].url }])
})

test('only final Windows packages exclude the duplicate Playwright Node', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-node-config-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const platform of ['win32', 'darwin']) {
    const config = JSON.parse(fs.readFileSync(createElectronBuilderConfig({ platform, outputPath: path.join(root, platform + '.json') }), 'utf8'))
    const resource = config.extraResources.find(r => r.to === 'webwright')
    if (platform === 'win32') assert.deepEqual(resource.filter, ['**/*', '!_internal/playwright/driver/node.exe'])
    else assert.equal(resource.filter, undefined)
  }
  assert.equal(packageJson.build.extraResources.find(r => r.to === 'webwright').filter, undefined)
})

function sharedNodeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-node-package-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of ['node-runtime/node.exe', 'webwright/Webwright.exe', 'webwright/_internal/playwright/driver/package/cli.js']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture')
  }
  fs.writeFileSync(path.join(root, 'webwright/webwright-runtime.json'), JSON.stringify({ mode: 'embedded', platform: 'win32', arch: 'x64', entrypoint: 'Webwright.exe', build_id: 'fixture' }))
  return root
}

test('Windows packaging marks shared Node and probes the actual frozen entry', t => {
  const root = sharedNodeFixture(t)
  let calls = 0
  configureSharedPlaywrightNode(root, 'win32', 'x64', (command, args, options) => {
    calls++
    assert.equal(command, path.join(root, 'webwright/Webwright.exe'))
    assert.equal(args[0], '--internal-script')
    assert.equal(args[2], path.join(root, 'node-runtime/node.exe'))
    assert.match(fs.readFileSync(args[1], 'utf8'), /async_playwright/)
    assert.notEqual(options.env.PLAYWRIGHT_NODEJS_PATH, args[2])
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 30000)
    return 'Shared Node runtime ready\n'
  })
  assert.equal(calls, 1)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'webwright/webwright-runtime.json')))
  assert.equal(manifest.node_runtime, 'shared')
  assert.equal(manifest.build_id, 'fixture')
})

test('duplicate Node and a failed frozen probe stop package acceptance', t => {
  const root = sharedNodeFixture(t)
  assert.throws(() => configureSharedPlaywrightNode(root, 'win32', 'x64', () => { throw new Error('driver failed') }), /driver failed/)
  assert.throws(() => configureSharedPlaywrightNode(root, 'win32', 'x64', () => ''), /did not complete/)
  fs.writeFileSync(path.join(root, 'webwright/_internal/playwright/driver/node.exe'), 'duplicate')
  assert.throws(() => configureSharedPlaywrightNode(root, 'win32', 'x64', () => assert.fail('unexpected probe')), /Duplicate/)
  configureSharedPlaywrightNode('/unused', 'darwin', 'arm64', () => assert.fail('macOS is unchanged'))
})

test('deployment config separates the website, download page, and ordered update sources', () => {
  const deployment = require('../../deployment-config.cjs').normalizeDeploymentConfig(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'deployment.json'), 'utf8')),
  )
  assert.equal(deployment.officialUrl, 'https://www.weworker.cc/')
  assert.equal(deployment.downloadUrl, 'https://www.weworker.cc/download')
  assert.deepEqual(deployment.updateSources, [{
    id: 'github',
    label: 'GitHub latest',
    url: 'https://github.com/WeWorker/WeWorker/releases/latest/download/',
  }])
  assert.equal(`${deployment.updateSources[0].url}latest.yml`, 'https://github.com/WeWorker/WeWorker/releases/latest/download/latest.yml')
  assert.equal(`${deployment.updateSources[0].url}latest-mac.yml`, 'https://github.com/WeWorker/WeWorker/releases/latest/download/latest-mac.yml')
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
