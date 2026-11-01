import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(electronDir, 'main.js'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.resolve(electronDir, '../package.json'), 'utf8'))

function resolveIcon(platform) {
  const expression = source.match(/^const appIconPath = (.+)$/m)?.[1]
  assert.ok(expression, 'main process must resolve a shared window/Dock icon')
  return vm.runInNewContext(expression, { path, __dirname: electronDir, process: { platform } })
}

test('macOS runtime icon exists inside the packaged Electron resources', () => {
  const iconPath = resolveIcon('darwin')
  assert.equal(iconPath, path.join(electronDir, 'assets/app-icon-mac.png'))
  assert.ok(manifest.build.files.includes('electron/**'))
  const png = fs.readFileSync(iconPath)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 1024)
  assert.equal(png.readUInt32BE(20), 1024)
  assert.equal(png[25], 6, 'Dock artwork needs an alpha channel for its rounded exterior')
})

test('Windows window and installer share the same packaged ICO resource', () => {
  assert.equal(resolveIcon('win32'), path.resolve(electronDir, '..', manifest.build.win.icon))
  assert.ok(manifest.build.files.includes(manifest.build.win.icon), 'runtime window icon must be included in app.asar')
})

test('Linux retains the original window artwork', () => {
  assert.equal(resolveIcon('linux'), path.resolve(electronDir, '../asset/logo.png'))
})

test('Windows app and tray ICOs provide RGBA representations for standard and scaled displays', () => {
  const appIcon = fs.readFileSync(resolveIcon('win32'))
  const trayIcon = fs.readFileSync(path.join(electronDir, 'assets/tray-icon.ico'))
  assert.notDeepEqual(appIcon, trayIcon, 'the small tray glyph must be distinct from the rounded app tile')
  for (const ico of [appIcon, trayIcon]) {
    assert.equal(ico.readUInt16LE(0), 0)
    assert.equal(ico.readUInt16LE(2), 1)
    const sizes = []
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const entry = 6 + i * 16
      const size = ico[entry] || 256
      assert.equal(ico[entry + 1] || 256, size)
      assert.equal(ico.readUInt16LE(entry + 6), 32)
      const bytes = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      assert.ok(offset >= 6 + ico.readUInt16LE(4) * 16 && offset + bytes <= ico.length)
      const png = ico.subarray(offset, offset + bytes)
      assert.equal(png.subarray(1, 4).toString(), 'PNG')
      assert.equal(png.readUInt32BE(16), size)
      assert.equal(png.readUInt32BE(20), size)
      assert.equal(png[25], 6, 'every ICO frame must retain an alpha channel')
      sizes.push(size)
    }
    assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256])
  }
})

test('Dock applies the selected macOS artwork and skips missing resources', () => {
  const block = source.match(/  \/\/ Use the same rounded artwork[^\n]*\n([\s\S]*?)\n\n  registerIpcHandlers/)?.[1]
  assert.ok(block)
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const exists of [true, false]) {
      const calls = []
      const appIconPath = resolveIcon(platform)
      vm.runInNewContext(block, {
        process: { platform },
        app: { dock: { setIcon: (icon) => calls.push(icon) } },
        fs: { existsSync: () => exists },
        nativeImage: { createFromPath: (file) => ({ file }) },
        appIconPath,
      })
      assert.deepEqual(calls, platform === 'darwin' && exists ? [{ file: appIconPath }] : [])
    }
  }
})

test('macOS bundle icon contains standard and Retina representations', () => {
  const icns = fs.readFileSync(path.resolve(electronDir, '..', manifest.build.mac.icon))
  assert.equal(icns.subarray(0, 4).toString(), 'icns')
  assert.equal(icns.readUInt32BE(4), icns.length)
  const representations = new Set()
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4)
    assert.ok(length >= 8 && offset + length <= icns.length)
    representations.add(icns.subarray(offset, offset + 4).toString())
    offset += length
  }
  for (const type of ['ic04', 'ic05', 'ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) {
    assert.ok(representations.has(type), `missing ICNS representation: ${type}`)
  }
})
