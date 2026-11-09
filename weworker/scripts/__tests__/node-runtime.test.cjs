const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { PIN, verifyFile, prepareNodeRuntime, validatePackagedNode } = require('../prepare-node-runtime.cjs')
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
test('checksum validation rejects changed executable bytes', t => {
  const dir = fixture(t), file = path.join(dir, 'node.exe'), content = 'fixture runtime'
  fs.writeFileSync(file, content)
  const hash = crypto.createHash('sha256').update(content).digest('hex')
  verifyFile(file, hash)
  fs.appendFileSync(file, 'tampered')
  assert.throws(() => verifyFile(file, hash), /checksum mismatch/)
})
test('corrupt download never gets extracted or published', async t => {
  const root = fixture(t)
  await assert.rejects(prepareNodeRuntime({ root, platform: 'win32', arch: 'x64',
    downloadFile: async (url, file) => {
      assert.equal(url, `https://nodejs.org/dist/v${PIN.version}/${PIN.archive}`)
      fs.writeFileSync(file, 'corrupt archive')
    }, extract: () => assert.fail('Unverified archive must not be extracted'),
  }), /checksum mismatch/)
  assert.deepEqual(fs.readdirSync(path.join(root, 'build')), [])
})
test('missing and unsupported packaged runtimes fail; other platforms are unchanged', t => {
  const root = fixture(t)
  assert.throws(() => validatePackagedNode(root, 'win32', 'x64'), /ENOENT/)
  assert.throws(() => validatePackagedNode(root, 'win32', 'arm64'), /x64 only/)
  validatePackagedNode(root, 'darwin', 'arm64')
})
test('corrupt previous build is rejected without silently downloading a replacement', async t => {
  const root = fixture(t), output = path.join(root, 'build/node-runtime')
  fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'node.exe'), 'corrupt')
  await assert.rejects(prepareNodeRuntime({ root, platform: 'win32', arch: 'x64', downloadFile: () => assert.fail('unexpected download') }), /checksum mismatch/)
})
test('Windows resources include pinned runtime and its license', () => {
  const pkg = require('../../package.json')
  const resource = pkg.build.win.extraResources.find(r => r.to === 'node-runtime')
  assert.ok(resource.filter.includes('node.exe'))
  assert.ok(resource.filter.includes('LICENSE'))
})
