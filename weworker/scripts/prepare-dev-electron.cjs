const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function withBundleMetadata(plist, { displayName, bundleId }) {
  for (const [key, value] of Object.entries({ CFBundleDisplayName: displayName, CFBundleName: displayName, CFBundleIdentifier: bundleId })) {
    const escaped = value.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[char])
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, 'g')
    const matches = [...plist.matchAll(pattern)]
    if (matches.length !== 1) throw new Error(`Expected one ${key} string in the development Electron Info.plist`)
    plist = plist.replace(pattern, (_match, start, end) => `${start}${escaped}${end}`)
  }
  return plist
}

function prepareDevElectron({
  platform = process.platform,
  electronPath,
  displayName = 'WeWorker',
  bundleId = 'com.weworker.app.dev',
  cacheDir = path.resolve(__dirname, '../build/dev-electron'),
  iconPath = path.resolve(__dirname, '../asset/icon.icns'),
} = {}) {
  const executable = electronPath || require('electron')
  if (platform !== 'darwin') return executable
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(displayName)) throw new Error('Invalid development app display name')
  const bundle = path.resolve(path.dirname(executable), '../..')
  if (path.basename(bundle) !== 'Electron.app' || path.basename(executable) !== 'Electron') {
    throw new Error('Expected the development Electron.app runtime')
  }
  const plistPath = path.join(bundle, 'Contents', 'Info.plist')
  const original = fs.readFileSync(plistPath, 'utf8')
  const updated = withBundleMetadata(original, { displayName, bundleId })
  const stat = fs.statSync(executable)
  const icon = fs.readFileSync(iconPath)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([1, fs.realpathSync(bundle), stat.size, stat.mtimeMs, updated]))
    .update(icon).digest('hex').slice(0, 16)
  const runtimeDir = path.join(cacheDir, fingerprint)
  const namedBundle = path.join(runtimeDir, `${displayName}.app`)
  const namedExecutable = path.join(namedBundle, 'Contents/MacOS/Electron')
  const readyFile = path.join(runtimeDir, '.ready')
  if (!fs.existsSync(readyFile) || !fs.existsSync(namedExecutable)) {
    fs.mkdirSync(runtimeDir, { recursive: true })
    // A real named bundle and a distinct development ID avoid Dock's cached
    // Electron identity. Clone files when supported; never edit npm's runtime.
    fs.cpSync(bundle, namedBundle, {
      recursive: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    })
    fs.writeFileSync(path.join(namedBundle, 'Contents/Info.plist'), updated)
    fs.copyFileSync(iconPath, path.join(namedBundle, 'Contents/Resources/electron.icns'))
    fs.writeFileSync(readyFile, fingerprint)
  }
  // Keep the executable named Electron: Electron uses it to recognize dev mode.
  return namedExecutable
}

if (require.main === module) {
  try {
    const { build } = require('../package.json')
    console.log(prepareDevElectron({ displayName: build.productName, bundleId: `${build.appId}.dev` }))
  } catch (error) {
    console.error(`[dev] Cannot prepare the application name: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { withBundleMetadata, prepareDevElectron }
