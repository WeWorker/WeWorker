import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8')
const createWindow = source.slice(source.indexOf('async function createWindow('), source.indexOf('\nif (hasSingleInstanceLock) app.whenReady()'))

async function openWindow(platform) {
  const calls = { menu: 'default', options: null, contextMenu: null, popup: null }
  const context = {
    process: { platform, env: { WEWORKER_E2E: '1' } },
    Menu: {
      buildFromTemplate: items => Object.assign(items, {
        popup: options => { calls.contextMenu = items; calls.popup = options },
      }),
      setApplicationMenu: menu => { calls.menu = menu },
    },
    BrowserWindow: class {
      constructor(options) {
        calls.options = options
        calls.window = this
        this.webContents = new EventEmitter()
        this.webContents.openDevTools = () => {}
      }
      on() {}
      loadURL() {}
    },
    mainWindow: null, isDev: true, devRendererUrl: 'http://localhost:5173',
    __dirname: '/fixtures/electron', appIconPath: '/fixtures/icon.png',
    path, fs: { existsSync: () => false },
  }
  await vm.runInNewContext(`${createWindow}\ncreateWindow()`, context)
  return calls
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} keeps native editing commands while hiding the menu bar`, async () => {
    const { menu, options } = await openWindow(platform)
    assert.equal(menu?.[0]?.role, 'editMenu')
    assert.equal(options.autoHideMenuBar, true)
    assert.equal(options.frame, false)
  })
}

test('macOS retains its default system menu and window controls', async () => {
  const { menu, options } = await openWindow('darwin')
  assert.equal(menu, 'default')
  assert.equal(options.titleBarStyle, 'hiddenInset')
})

const allEditFlags = {
  canUndo: true, canRedo: true, canCut: true, canCopy: true,
  canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false,
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`${platform} opens native editing actions for an editable field in its originating window`, async () => {
    const calls = await openWindow(platform)
    const frame = { id: 'fixture-frame' }
    calls.window.webContents.emit('context-menu', {}, { isEditable: true, editFlags: allEditFlags, frame })
    assert.ok(calls.contextMenu, 'right-click should open an editing menu')
    assert.deepEqual(Array.from(calls.contextMenu.filter(item => item.role), item => item.role),
      ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'])
    assert.equal(calls.popup.window, calls.window)
    assert.equal(calls.popup.frame, frame)
    assert.ok(calls.contextMenu.filter(item => item.role).every(item => item.enabled))
  })
}

test('editing menu follows the current selection, undo history and clipboard capabilities', async () => {
  const calls = await openWindow('win32')
  const flags = { ...allEditFlags, canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false }
  calls.window.webContents.emit('context-menu', {}, { isEditable: true, editFlags: flags, frame: null })
  assert.ok(calls.contextMenu)
  assert.deepEqual(Array.from(calls.contextMenu.filter(item => item.role), item => [item.role, item.enabled]), [
    ['undo', false], ['redo', false], ['cut', false], ['copy', false],
    ['paste', false], ['delete', false], ['selectAll', true],
  ])
  calls.window.webContents.emit('context-menu', {}, { isEditable: true, editFlags: { ...allEditFlags, canSelectAll: false }, frame: null })
  assert.equal(calls.contextMenu.find(item => item.role === 'copy').enabled, true)
  assert.equal(calls.contextMenu.find(item => item.role === 'selectAll').enabled, false)
})

test('right-click outside an editable field leaves existing page menus alone', async () => {
  const calls = await openWindow('win32')
  calls.window.webContents.emit('context-menu', {}, { isEditable: false, editFlags: allEditFlags })
  assert.equal(calls.contextMenu, null)
  assert.equal(calls.popup, null)
})

for (const [platform, redo, deletion] of [
  ['win32', 'Ctrl+Y', 'Delete'],
  ['linux', 'CmdOrCtrl+Shift+Z', 'Delete'],
  ['darwin', 'CmdOrCtrl+Shift+Z', 'Backspace'],
]) {
  test(`${platform} shows editing shortcuts beside context-menu labels`, async () => {
    const calls = await openWindow(platform)
    calls.window.webContents.emit('context-menu', {}, { isEditable: true, editFlags: allEditFlags })
    assert.deepEqual(Array.from(calls.contextMenu.filter(item => item.role), item => [item.role, item.accelerator]), [
      ['undo', 'CmdOrCtrl+Z'], ['redo', redo], ['cut', 'CmdOrCtrl+X'],
      ['copy', 'CmdOrCtrl+C'], ['paste', 'CmdOrCtrl+V'], ['delete', deletion],
      ['selectAll', 'CmdOrCtrl+A'],
    ])
  })
}
