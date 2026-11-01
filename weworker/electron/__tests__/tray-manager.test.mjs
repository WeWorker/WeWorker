import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createTrayManager, resolveTrayIconPath } from '../tray-manager.js'

test('tray assets select a macOS template without changing other platforms', () => {
  assert.equal(path.basename(resolveTrayIconPath('darwin')), 'tray-icon-macTemplate.png')
  assert.equal(path.basename(resolveTrayIconPath('win32')), 'tray-icon.ico')
  assert.equal(path.basename(resolveTrayIconPath('linux')), 'tray-icon.png')
  for (const [suffix, size] of [['', 18], ['@2x', 36]]) {
    const file = resolveTrayIconPath('darwin').replace(/\.png$/, `${suffix}.png`)
    const png = fs.readFileSync(file)
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
    assert.equal(png[25], 6, 'menu bar artwork needs a transparent exterior')
  }
})

function createFixture(platform, empty = false) {
  const templates = []
  const image = {
    isEmpty: () => empty,
    setTemplateImage: (value) => templates.push(value),
    resize: () => { throw new Error('resizing would discard the supplied Retina representation') },
  }
  const manager = createTrayManager({
    platform,
    Tray: class {
      constructor(icon) { this.image = icon }
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    Menu: { buildFromTemplate: (items) => items },
    nativeImage: { createFromPath: () => image, createEmpty: () => image },
    getAgentSummary: async () => ({ total: 0 }),
    getLaunchAtLogin: () => ({ supported: false, enabled: false }),
    handlers: { onOpen() {}, onOpenAgents() {}, onToggleLaunchAtLogin() {}, onQuit() {} },
  })
  return { manager, image, templates }
}

test('macOS uses system tinting and preserves the original multi-resolution image', () => {
  const { manager, image, templates } = createFixture('darwin')
  try {
    assert.equal(manager.create().image, image)
    assert.deepEqual(templates, [true])
  } finally {
    manager.destroy()
  }
})

test('Windows and Linux keep full-color tray icons', () => {
  for (const platform of ['win32', 'linux']) {
    const { manager, image, templates } = createFixture(platform)
    try {
      assert.equal(manager.create().image, image)
      assert.deepEqual(templates, [])
    } finally {
      manager.destroy()
    }
  }
})

test('an empty macOS image does not attempt template conversion', () => {
  const { manager, templates } = createFixture('darwin', true)
  try {
    manager.create()
    assert.deepEqual(templates, [])
  } finally {
    manager.destroy()
  }
})
