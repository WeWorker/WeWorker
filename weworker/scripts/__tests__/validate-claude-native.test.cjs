const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { nativeArchitectures, validatePackagedClaude } = require('../validate-claude-native.cjs')
const afterPack = require('../after-pack.cjs')

function pe(machine = 0x8664) {
  const header = Buffer.alloc(512)
  header.write('MZ')
  header.writeUInt32LE(128, 60)
  header.writeUInt32LE(0x4550, 128)
  header.writeUInt16LE(machine, 132)
  return header
}
test('rejects wrapper text, truncated PE and the wrong Windows architecture', () => {
  assert.deepEqual(nativeArchitectures(Buffer.from('echo "Error: native binary not installed"'), 'win32'), [])
  assert.deepEqual(nativeArchitectures(Buffer.from('MZ'), 'win32'), [])
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-native-fixture-'))
  const bin = path.join(root, 'claude-code/bin')
  fs.mkdirSync(bin, { recursive: true })
  assert.throws(() => validatePackagedClaude(root, 'win32', 'x64'), /Missing/)
  fs.writeFileSync(path.join(bin, 'claude.exe'), pe(0xaa64))
  assert.throws(() => validatePackagedClaude(root, 'win32', 'x64'), /not a win32\/x64/)
  fs.writeFileSync(path.join(bin, 'claude.exe'), pe())
  assert.equal(validatePackagedClaude(root, 'win32', 'x64'), path.join(bin, 'claude.exe'))
})
test('recognizes Mach-O target architectures and universal binaries', () => {
  const thin = Buffer.alloc(32)
  thin.writeUInt32BE(0xcffaedfe)
  thin.writeUInt32LE(0x0100000c, 4)
  assert.deepEqual(nativeArchitectures(thin, 'darwin'), ['arm64'])
  const fat = Buffer.alloc(48)
  fat.writeUInt32BE(0xcafebabe)
  fat.writeUInt32BE(2, 4)
  fat.writeUInt32BE(0x01000007, 8)
  fat.writeUInt32BE(0x0100000c, 28)
  assert.deepEqual(nativeArchitectures(fat, 'darwin'), ['x64', 'arm64'])
})
test('Windows packaging cannot skip validation and macOS checks before signing', () => {
  const calls = []
  const context = { arch: 1, electronPlatformName: 'win32', appOutDir: '/fixture', packager: { appInfo: { productFilename: 'WeWorker' } } }
  afterPack(context, () => assert.fail('Windows must not codesign'), (...args) => calls.push(args), (...args) => calls.push(args), (...args) => calls.push(args))
  assert.deepEqual(calls[0], [path.join('/fixture', 'resources'), 'win32', 'x64'])
  assert.deepEqual(calls[1], calls[0])
  assert.deepEqual(calls[2], calls[0])
  assert.throws(() => afterPack({ ...context, electronPlatformName: 'darwin' }, () => assert.fail('Must validate before signing'), () => { throw new Error('invalid native binary') }), /invalid native binary/)
})
