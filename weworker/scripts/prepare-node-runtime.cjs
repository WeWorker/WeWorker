const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

// Official Node distribution, pinned independently of the build machine's Node.
const PIN = Object.freeze({
  version: '24.20.0',
  archive: 'node-v24.20.0-win-x64.zip',
  archiveSha256: '6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba',
  executableSha256: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
})
function verifyFile(file, expected) {
  if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()
      || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) {
    throw new Error('Bundled Node runtime checksum mismatch: ' + path.basename(file))
  }
}
function validatePackagedNode(resourcesPath, platform, arch) {
  if (platform !== 'win32') return
  if (arch !== 'x64') throw new Error('Bundled Node runtime supports Windows x64 only')
  const dir = path.join(resourcesPath, 'node-runtime')
  verifyFile(path.join(dir, 'node.exe'), PIN.executableSha256)
  if (!fs.statSync(path.join(dir, 'LICENSE')).isFile()) throw new Error('Missing Node runtime license')
}
async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error('Cannot download pinned Node runtime: HTTP ' + response.status)
  let size = 0
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length
      callback(size > 128 * 1024 * 1024 ? new Error('Node archive exceeds size limit') : null, chunk)
    },
  }), fs.createWriteStream(target, { flags: 'wx' }))
}
async function prepareNodeRuntime({ root = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch,
  downloadFile = download, extract = (archive, dir) => execFileSync('tar', ['-xf', archive, '-C', dir], { windowsHide: true }),
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('Node runtime preparation requires Windows x64')
  const build = path.join(root, 'build')
  const output = path.join(build, 'node-runtime')
  if (fs.existsSync(output)) {
    validatePackagedNode(build, platform, arch)
    return output
  }
  fs.mkdirSync(build, { recursive: true })
  const temp = fs.mkdtempSync(path.join(build, '.node-runtime-'))
  try {
    const archive = path.join(temp, PIN.archive)
    await downloadFile(`https://nodejs.org/dist/v${PIN.version}/${PIN.archive}`, archive)
    verifyFile(archive, PIN.archiveSha256)
    extract(archive, temp)
    const source = path.join(temp, `node-v${PIN.version}-win-x64`)
    verifyFile(path.join(source, 'node.exe'), PIN.executableSha256)
    const ready = path.join(temp, 'node-runtime')
    fs.mkdirSync(ready)
    for (const file of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(source, file), path.join(ready, file))
    fs.writeFileSync(path.join(ready, 'provenance.json'), JSON.stringify(PIN, null, 2) + '\n')
    validatePackagedNode(temp, platform, arch)
    fs.renameSync(ready, output)
    return output
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
if (require.main === module) prepareNodeRuntime().then(dir => console.log('Pinned Node runtime ready: ' + dir)).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
module.exports = { PIN, verifyFile, prepareNodeRuntime, validatePackagedNode }
