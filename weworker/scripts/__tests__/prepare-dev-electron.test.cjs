const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { withBundleMetadata, prepareDevElectron } = require('../prepare-dev-electron.cjs')
const { startDevElectron } = require('../start-dev-electron.cjs')
const metadata = { displayName: 'WeWorker', bundleId: 'com.weworker.app.dev' }

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
</dict></plist>`

test('development bundle has a distinct identity and retains the Electron executable', () => {
  const updated = withBundleMetadata(fixture, metadata)
  assert.match(updated, /<key>CFBundleDisplayName<\/key><string>WeWorker<\/string>/)
  assert.match(updated, /<key>CFBundleName<\/key><string>WeWorker<\/string>/)
  for (const [key, value] of [['CFBundleExecutable', 'Electron'], ['CFBundleIdentifier', metadata.bundleId], ['CFBundleIconFile', 'electron.icns']]) {
    assert.ok(updated.includes(`<key>${key}</key><string>${value}</string>`))
  }
  assert.equal(withBundleMetadata(updated, metadata), updated)
})

test('names are XML escaped and missing metadata fails explicitly', () => {
  assert.ok(withBundleMetadata(fixture, { ...metadata, displayName: 'A&B <App>' }).includes('<string>A&amp;B &lt;App&gt;</string>'))
  assert.throws(() => withBundleMetadata('<plist/>', metadata), /Expected one CFBundleDisplayName/)
})

test('macOS clones a named app, preserves framework symlinks and reuses the prepared runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weworker-dev-name-'))
  try {
    const contents = path.join(root, 'Electron.app', 'Contents')
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true })
    const file = path.join(contents, 'Info.plist')
    fs.writeFileSync(file, fixture)
    const electronPath = path.join(contents, 'MacOS', 'Electron')
    fs.writeFileSync(electronPath, 'electron-runtime')
    fs.chmodSync(electronPath, 0o755)
    fs.symlinkSync('../MacOS/Electron', path.join(contents, 'Resources', 'fixture-link'))
    const iconPath = path.join(root, 'icon.icns')
    fs.writeFileSync(iconPath, 'icon-fixture')
    const options = { platform: 'darwin', electronPath, cacheDir: path.join(root, 'cache'), iconPath }
    const output = prepareDevElectron(options)
    const namedContents = path.resolve(path.dirname(output), '..')
    assert.equal(path.basename(path.dirname(namedContents)), 'WeWorker.app')
    assert.equal(fs.readFileSync(path.join(namedContents, 'Info.plist'), 'utf8'), withBundleMetadata(fixture, metadata))
    assert.equal(fs.readFileSync(file, 'utf8'), fixture)
    assert.equal(fs.readlinkSync(path.join(namedContents, 'Resources/fixture-link')), '../MacOS/Electron')
    assert.equal(fs.readFileSync(path.join(namedContents, 'Resources/electron.icns'), 'utf8'), 'icon-fixture')
    assert.ok(fs.statSync(output).mode & 0o111)
    const mtime = fs.statSync(output).mtimeMs
    assert.equal(prepareDevElectron(options), output)
    assert.equal(fs.statSync(output).mtimeMs, mtime)
    fs.writeFileSync(iconPath, 'updated-icon-fixture')
    assert.notEqual(prepareDevElectron(options), output)
    fs.writeFileSync(electronPath, 'new-electron-runtime')
    assert.notEqual(prepareDevElectron(options), output)
    fs.writeFileSync(file, '<plist/>')
    assert.throws(() => prepareDevElectron(options), /Expected one/)
    assert.equal(fs.readFileSync(file, 'utf8'), '<plist/>')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows and Linux skip macOS metadata; packaged apps are rejected', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(prepareDevElectron({ platform, electronPath: '/nonexistent/electron' }), '/nonexistent/electron')
  }
  assert.throws(() => prepareDevElectron({ platform: 'darwin', electronPath: '/Applications/WeWorker.app/Contents/MacOS/WeWorker' }), /development Electron.app/)
})

test('normal development startup prepares the name before launching Electron', () => {
  const { scripts, build } = require('../../package.json')
  assert.equal(build.productName, 'WeWorker')
  assert.ok(scripts['dev:electron'].startsWith('wait-on '))
  assert.ok(scripts['dev:electron'].endsWith('cross-env NODE_ENV=development node scripts/start-dev-electron.cjs'))
})

test('development launcher passes arguments, forwards signals and propagates exit status', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const host = new EventEmitter()
    const child = new EventEmitter()
    const killed = []
    child.kill = (value) => killed.push(value)
    startDevElectron({ executable: '/fixture/WeWorker.app/Contents/MacOS/Electron', args: ['--example'], host, spawnProcess: (executable, args, options) => {
      assert.ok(executable.endsWith('WeWorker.app/Contents/MacOS/Electron'))
      assert.deepEqual(args, ['.', '--example'])
      assert.equal(options.stdio, 'inherit')
      assert.equal(options.cwd, path.resolve(__dirname, '../..'))
      return child
    } })
    host.emit(signal)
    assert.deepEqual(killed, [signal])
    child.emit('close', 7)
    assert.equal(host.exitCode, 7)
    assert.equal(host.listenerCount(signal), 0)
  }
})
